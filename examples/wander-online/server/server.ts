// examples/wander-online/server/server.ts — Bun area server: authoritative
// reducer + AOI broadcast.
//
// One process owns one Arena (a frozen wander window). Clients connect over
// WebSocket, send JOIN once, then INPUT at their reference-tick rate (one
// per predicted tick, each carrying a sequence number). The server queues
// each player's inputs and folds them through the kit's stepSession at the
// host rate (20 Hz folds 3 reference ticks per frame), and broadcasts each
// player their interest set (Chebyshev radius) as full idempotent snapshots
// at broadcastHz. Every snapshot carries ackSeq: the last INPUT sequence
// applied for that recipient, which is the client's reconciliation
// watermark. PING/PONG measures RTT.
//
// The server binds 127.0.0.1 only: this demo never listens on a
// non-loopback interface (asserted by the tests).
//
//   bun run examples/wander-online/server/server.ts --port 8080 --seed 2654435769 \
//       --hz 20 --broadcast-hz 10 --aoi 16 --sim-latency 0
//
// --sim-latency delays every message by N ms in each direction in-process
// (inbound handling and outbound sends), so RTT grows by 2N — the same
// shape as netem on both ends — without root. SIGINT exits 0.

import { join } from "node:path";
import { type ServerWebSocket } from "bun";
import { Arena } from "./area.ts";
import { REALM_PLAYER_CAP, RealmArena, type RealmPlayer } from "./realm-area.ts";
import { DevAuth } from "./dev-auth.ts";
import { entityFor, snapshotFor, snapshotForRealm } from "../shared/snapshot.ts";
import {
  MSG,
  REGION_STATE_FLAG_INITIAL,
  WORLD_PROTOCOL_VERSION,
  WORLD_STATE_VERSION,
  decodeCommand,
  decodeInput,
  decodeInputBatch,
  encodeBye,
  encodeEmote,
  encodeFarPlayers,
  encodePong,
  encodePlayerJourney,
  encodePlayerProgress,
  encodeRegionState,
  encodeRoster,
  encodeWelcome,
  encodeWelcome4,
  gridFromWindow,
} from "../net/protocol.ts";
import { AUTH_PROTOCOL_VERSION } from "../shared/auth.ts";
import { SlidingWindow } from "../shared/limits.ts";
import { FAR_INTERVAL_SEC } from "../net/far.ts";
import {
  INVITE_ISSUE_PER_MIN,
  INVITE_TTL_SEC,
  InviteTable,
  REALM_CLOSE_REASON,
  inviteCodeWellFormed,
} from "../shared/invite.ts";
export interface ServerOpts {
  port: number;
  seed: number;
  hz: number;
  broadcastHz: number;
  aoi: number;
  simLatency: number;
  /** Optional static web root (the prototype served its canvas client here;
   *  the PocketJS web build is served separately by tools/web.ts). */
  webRoot: string;
  /** Local-dev switch: accept JOINs with no GitHub token or ticket. OFF by
   *  default; the hosted Worker has no equivalent (asserted by its tests).
   *  Only for the loopback demo and tests. */
  allowGuests: boolean;
  /** GitHub API base for the dev auth exchange. Defaults to the real
   *  api.github.com; tests point it at a fake endpoint. */
  githubApiBase?: string;
  /** Local realm admission cap. It may be lowered for a small deployment or
   * tests, but RealmArena never permits a value above its safe hard cap. */
  realmPlayerCap?: number;
  /** Deterministic restart hook for tests; production creates a fresh epoch. */
  realmEpoch?: number;
}

interface Conn {
  ws: ServerWebSocket<ConnData>;
  realm: boolean;
  playerId: number;
  githubId: number;
  sid: string;
  bytesIn: number;
  bytesOut: number;
  drops: number;
  /** Invites this connection minted (per-player issue limit). */
  inviteWindow: SlidingWindow | null;
}

interface ConnData {
  conn: Conn | null;
  realm: boolean;
  /** A pinned-realm admission decided at upgrade time (unknown realm,
   *  bad invite): the socket is closed with this 1008 token on open. */
  reject: string | null;
}

export interface ServerHandle {
  url: string;
  port: number;
  /** The address the socket is bound to; always loopback for this demo. */
  hostname: string;
  arena: Arena;
  realmArena: RealmArena;
  close: () => void;
}

const BACKPRESSURE_LIMIT = 256 * 1024; // bytes buffered before we drop a snapshot

export function startServer(opts: ServerOpts): ServerHandle {
  const arena = new Arena({ seed: opts.seed, hz: opts.hz });
  const realmArena = new RealmArena({
    seed: opts.seed,
    hz: opts.hz,
    realmId: "local",
    epoch: opts.realmEpoch ?? crypto.getRandomValues(new Uint32Array(1))[0]!,
    maxPlayers: opts.realmPlayerCap,
  });
  const grid = gridFromWindow(arena.world.window);
  const conns = new Map<number, Conn>();
  const realmConns = new Map<number, Conn>();
  const frameMod = Math.max(1, Math.round(opts.hz / opts.broadcastHz));
  const farMod = Math.max(1, Math.round(opts.hz * FAR_INTERVAL_SEC));
  // Realm invites: codes only, in memory (the loopback server is ephemeral).
  const invites = new InviteTable(() => Date.now(), Math.random);

  const stats = {
    ticks: 0,
    bytesIn: 0,
    bytesOut: 0,
    drops: 0,
    snapshots: 0,
  };

  function send(conn: Conn, buf: ArrayBuffer): void {
    if (conn.ws.getBufferedAmount() > BACKPRESSURE_LIMIT) {
      conn.drops++;
      stats.drops++;
      return;
    }
    conn.ws.send(buf);
    conn.bytesOut += buf.byteLength;
    stats.bytesOut += buf.byteLength;
  }

  function emit(conn: Conn, buf: ArrayBuffer): void {
    if (opts.simLatency > 0) setTimeout(() => send(conn, buf), opts.simLatency);
    else send(conn, buf);
  }

  function broadcast(): void {
    arena.indexPlayers();
    const online = arena.players.size;
    for (const p of arena.players.values()) {
      const conn = conns.get(p.id);
      if (!conn) continue;
      stats.snapshots++;
      // The local Bun server owns one room, so room and service population
      // are the same. Hosted multi-room servers pass their aggregate second.
      emit(conn, snapshotFor(arena, p, opts.aoi, online, online));
    }
    realmArena.indexPlayers();
    const realmOnline = realmArena.players.size;
    const far = realmArena.frame % farMod === 0;
    for (const p of realmArena.players.values()) {
      const conn = realmConns.get(p.id);
      if (!conn) continue;
      stats.snapshots++;
      // Reliable WebSocket ordering makes the current region facts visible
      // before the movement snapshot that was simulated from them.
      emit(conn, encodeRegionState(realmArena.regionSnapshotFor(p, 0)));
      flushPrivate(p, conn);
      emit(conn, snapshotForRealm(realmArena, p, opts.aoi, realmOnline, realmOnline));
      // Once a second: the coarse direction band for everyone out of AOI.
      // Nothing is sent when nobody is far; the client expires stale rows.
      if (far) {
        const rows = realmArena.farRowsFor(p, opts.aoi);
        if (rows.length > 0) emit(conn, encodeFarPlayers(rows));
      }
    }
  }

  /** Accepted emotes go to every player whose AOI holds the sender, the
   *  sender included, at once (an emote is an event, not a snapshot). */
  function flushEmotes(): void {
    for (const pending of realmArena.drainEmotes()) {
      const message = encodeEmote({ id: pending.from.id, emote: pending.emote });
      for (const p of realmArena.emoteRecipients(pending.from, opts.aoi)) {
        const conn = realmConns.get(p.id);
        if (conn) emit(conn, message);
      }
    }
  }

  /** Recipient-only journey/progress snapshots, sent whenever the arena
   *  changed them (a confirmed command, an arrival, a landmark sighting). */
  function flushPrivate(p: RealmPlayer, conn: Conn): void {
    if (p.progressDirty) {
      p.progressDirty = false;
      emit(conn, encodePlayerProgress(realmArena.progressMessage(p)));
    }
    if (p.journeyDirty) {
      p.journeyDirty = false;
      emit(conn, encodePlayerJourney(realmArena.journeyMessage(p)));
    }
  }

  /** Shared rows a journey changed (improvements, landmark firsts) go to
   *  everyone at once rather than waiting for the periodic snapshot. */
  function flushChangedRows(): void {
    const rows = realmArena.drainChangedRows();
    if (rows.length === 0) return;
    const message = encodeRegionState({ flags: 0, realmRevision: realmArena.realmRevision, serverTimeMs: Date.now(), rows });
    for (const conn of realmConns.values()) emit(conn, message);
  }

  const tickTimer = setInterval(() => {
    arena.step();
    realmArena.step();
    stats.ticks++;
    flushChangedRows();
    if (arena.frame % frameMod === 0) broadcast();
  }, 1000 / opts.hz);

  // The dev auth (in-memory). Created lazily so a guest-only demo never
  // pays for it; the first authenticated JOIN awaits it.
  let auth: DevAuth | null = null;
  const authReady = DevAuth.create(opts.githubApiBase ?? "https://api.github.com").then((a) => {
    auth = a;
    return a;
  });

  function onMessage(ws: ServerWebSocket<ConnData>, msg: string | Buffer<ArrayBuffer>): void {
    // A delayed (--sim-latency) message may land after the socket closed.
    if (ws.readyState !== 1) return;
    if (typeof msg === "string") {
      void handleText(ws, msg);
      return;
    }
    const conn = ws.data.conn;
    if (!conn) return;
    conn.bytesIn += msg.byteLength;
    stats.bytesIn += msg.byteLength;
    const activeArena = conn.realm ? realmArena : arena;
    const v = new DataView(msg.buffer, msg.byteOffset, msg.byteLength);
    const kind = v.getUint8(0);
    if (kind === MSG.input) {
      const p = activeArena.players.get(conn.playerId);
      if (p) {
        const inp = decodeInput(msg);
        activeArena.pushInput(p as never, inp.seq, inp.buttons);
      }
    } else if (kind === MSG.inputBatch) {
      // v2: one message carrying up to BATCH_SIZE consecutive reference
      // ticks; expand into the same per-tick queue as plain INPUT.
      const p = activeArena.players.get(conn.playerId);
      const batch = decodeInputBatch(msg);
      if (p && batch) {
        for (let i = 0; i < batch.buttons.length; i++) {
          activeArena.pushInput(p as never, batch.firstSeq + i, batch.buttons[i]!);
        }
      }
    } else if (kind === MSG.command) {
      const p = conn.realm ? realmArena.players.get(conn.playerId) : undefined;
      const cmd = decodeCommand(msg);
      if (p && cmd) {
        // The arena validates against its own mover and clock; a refused
        // command is simply dropped. Confirmations ride the next flush.
        realmArena.applyCommand(p, cmd);
        flushChangedRows();
        flushPrivate(p, conn);
        flushEmotes();
      }
    } else if (kind === MSG.ping) {
      emit(conn, encodePong(v.getUint32(1, true), v.getUint32(5, true)));
    }
  }

  /** Text messages: the auth handshake (JOIN/CREATE/LINKR on an unjoined
   *  socket; LINKQ/DELETE on a joined one). Mirrors the Worker's RoomDO. */
  async function handleText(ws: ServerWebSocket<ConnData>, msg: string): Promise<void> {
    let m: Record<string, unknown> & { type?: string; v?: number };
    try {
      m = JSON.parse(msg);
    } catch {
      return;
    }
    if (typeof m.type !== "string") return;
    const joined = ws.data.conn !== null;
    const ip = "127.0.0.1"; // loopback server: every connection is local
    try {
      switch (m.type) {
        case "join":
          if (joined) return;
          await handleJoin(ws, m, ip);
          return;
        case "create":
          if (joined) return;
          await handleCreate(ws, m);
          return;
        case "linkr":
          if (joined) return;
          await handleLinkRedeem(ws, m, ip);
          return;
        case "inviteq": {
          // A joined realm player mints an invite to its own realm. The
          // reply carries the code, the realm name and the lifetime: no
          // account, name or position.
          const conn = ws.data.conn;
          if (!conn || !conn.realm) return;
          conn.inviteWindow ??= new SlidingWindow(INVITE_ISSUE_PER_MIN, 60_000, () => Date.now());
          if (!conn.inviteWindow.hit()) {
            ws.send(JSON.stringify({ type: "inviteError", reason: "invite-rate" }));
            return;
          }
          const issued = invites.issue();
          ws.send(JSON.stringify({ type: "invite", code: issued.code, realm: realmArena.realmId, expiresIn: INVITE_TTL_SEC }));
          return;
        }
        case "linkq": {
          if (!joined) return;
          const a = await authReady;
          const ticket = String((m as { ticket?: string }).ticket ?? "");
          const res = await a.linkIssue(ticket);
          if (res.ok) ws.send(JSON.stringify({ type: "linkCode", code: res.code, expiresIn: res.expiresIn }));
          else ws.send(JSON.stringify({ type: "linkError", reason: res.reason ?? "link-bad-code" }));
          return;
        }
        case "delete": {
          if (!joined) return;
          const a = await authReady;
          const ticket = String((m as { ticket?: string }).ticket ?? "");
          const ok = await a.deleteProfile(ticket);
          // Only a confirmed delete is reported as done; a refusal keeps
          // the client signed in (same contract as the Worker RoomDO).
          if (ok) {
            ws.send(JSON.stringify({ type: "deleted" }));
            ws.close(1008, "ticket");
          } else {
            ws.send(JSON.stringify({ type: "deleteError", reason: "delete-refused" }));
          }
          return;
        }
        default:
          return;
      }
    } catch {
      try {
        ws.close(1008, "auth");
      } catch {
        // already closed
      }
    }
  }

  async function handleJoin(ws: ServerWebSocket<ConnData>, m: Record<string, unknown>, ip: string): Promise<void> {
    if (ws.data.reject) return;
    const expected = ws.data.realm ? WORLD_PROTOCOL_VERSION : AUTH_PROTOCOL_VERSION;
    const generatorOk = Array.isArray(m.supportedGeneratorVersions)
      && m.supportedGeneratorVersions.includes(1);
    const worldStateOk = m.worldStateVersion === WORLD_STATE_VERSION;
    if (m.v !== expected || (ws.data.realm && (!generatorOk || !worldStateOk))) {
      ws.close(1008, ws.data.realm ? "upgrade-required" : "version");
      return;
    }
    if (ws.data.realm && realmArena.players.size >= realmArena.maxPlayers) {
      ws.close(1008, "full");
      return;
    }
    const sid = `s${Math.random().toString(36).slice(2)}`;
    const github = typeof m.github === "string" ? m.github : null;
    const ticket = typeof m.ticket === "string" ? m.ticket : null;
    if (!github && !ticket) {
      if (!opts.allowGuests) {
        ws.close(1008, "auth");
        return;
      }
      // Guest (--allow-guests): name/colour from the JOIN, no account.
      const name = String(m.name ?? "anon").slice(0, 16);
      const color = (Number(m.color) | 0) & 0x0f;
      const look = (Number(m.look) | 0) & 0x3f;
      admit(ws, name, color, look, 0, sid);
      return;
    }
    const a = await authReady;
    const room = ws.data.realm ? "v4:local" : "local";
    const res = await a.join(github ? "github" : "ticket", (github ?? ticket)!, room, sid, ip);
    if (res.needCreate) {
      ws.send(JSON.stringify({ type: "needCreate", login: res.login, ticket: res.ticket }));
      return;
    }
    if (!res.ok) {
      ws.close(1008, res.reason ?? "auth");
      return;
    }
    admit(ws, res.profile!.name, res.profile!.look & 0x0f, res.profile!.look, res.githubId ?? 0, sid);
    ws.send(JSON.stringify({ type: "ready", ticket: res.ticket }));
  }

  async function handleCreate(ws: ServerWebSocket<ConnData>, m: Record<string, unknown>): Promise<void> {
    const a = await authReady;
    const res = await a.create(String(m.ticket ?? ""), String(m.name ?? ""), m.look);
    if (res.ok) ws.send(JSON.stringify({ type: "createOk" }));
    else ws.send(JSON.stringify({ type: "createError", reason: res.reason ?? "name-empty" }));
  }

  async function handleLinkRedeem(ws: ServerWebSocket<ConnData>, m: Record<string, unknown>, ip: string): Promise<void> {
    const a = await authReady;
    const res = await a.linkRedeem(String(m.code ?? ""), ip);
    if (res.ok) {
      ws.send(JSON.stringify({ type: "linked", ticket: res.ticket, hasProfile: res.hasProfile, login: res.login }));
    } else {
      ws.send(JSON.stringify({ type: "linkError", reason: res.reason ?? "link-bad-code" }));
    }
  }

  /** A verified player enters the arena. */
  function admit(ws: ServerWebSocket<ConnData>, name: string, color: number, look: number, githubId: number, sid: string): void {
    const activeArena = ws.data.realm ? realmArena : arena;
    const activeConns = ws.data.realm ? realmConns : conns;
    // Guests have no account: the spawn-slot hash takes the connection's
    // sid, so two guests with one name still spread over the ring.
    const p = ws.data.realm
      ? realmArena.tryAdd(name, color, look, undefined, undefined, githubId > 0 ? String(githubId) : `${name}:${sid}`)
      : arena.add(name, color, look);
    if (!p) {
      if (githubId > 0 && auth) auth.sessionRelease(githubId, "v4:local", sid);
      ws.close(1008, "full");
      return;
    }
    const conn: Conn = { ws, realm: ws.data.realm, playerId: p.id, githubId, sid, bytesIn: 0, bytesOut: 0, drops: 0, inviteWindow: null };
    ws.data.conn = conn;
    activeConns.set(p.id, conn);
    if (ws.data.realm) {
      const { id: _id, color: _color, ...mover } = entityFor(p);
      const initial = realmArena.regionSnapshotFor(p as RealmPlayer, REGION_STATE_FLAG_INITIAL);
      emit(conn, encodeWelcome4({
        you: p.id,
        seed: realmArena.seed,
        generatorVersion: 1,
        epoch: realmArena.epoch,
        realmId: realmArena.realmId,
        realmRevision: initial.realmRevision,
        serverTimeMs: initial.serverTimeMs,
        mover,
      }));
      emit(conn, encodeRegionState(initial));
      // Local auth has no persisted private log: the journey starts empty
      // and lives in the arena for the connection's lifetime.
      const rp = p as RealmPlayer;
      rp.progressDirty = false;
      rp.journeyDirty = false;
      emit(conn, encodePlayerProgress(realmArena.progressMessage(rp)));
      emit(conn, encodePlayerJourney(realmArena.journeyMessage(rp)));
    } else {
      emit(conn, encodeWelcome(p.id, arena.seed, arena.x0, arena.y0, grid));
    }
    // ROSTER: the full roster to the newcomer, the one new entry to others.
    const roster = [...activeArena.players.values()].map((q) => ({ id: q.id, name: q.name, look: q.look }));
    emit(conn, encodeRoster(roster));
    const mine = encodeRoster([{ id: p.id, name, look }]);
    for (const other of activeConns.values()) {
      if (other !== conn && other.ws.readyState === 1) {
        try {
          other.ws.send(mine);
        } catch {
          // closed between enumeration and send
        }
      }
    }
  }

  const server = Bun.serve<ConnData>({
    // Localhost-only by design: the demo never accepts non-loopback
    // connections (hard constraint of the task).
    hostname: "127.0.0.1",
    port: opts.port,
    fetch(req: Request, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/ws" || url.pathname === "/ws/v4") {
        const realm = url.pathname === "/ws/v4";
        // A pinned realm (`?realm=`, a reconnect or an invite) must be this
        // server's one realm; an invite code must be live. Either failure
        // is an explicit 1008 token on open, never a silent fallback.
        let reject: string | null = null;
        if (realm) {
          const pin = url.searchParams.get("realm");
          const invite = url.searchParams.get("invite");
          if (pin !== null && pin !== realmArena.realmId) reject = REALM_CLOSE_REASON.realm;
          else if (invite !== null && !(inviteCodeWellFormed(invite.toUpperCase()) && invites.valid(invite.toUpperCase()))) {
            reject = REALM_CLOSE_REASON.invite;
          }
        }
        const ok = srv.upgrade(req, { data: { conn: null, realm, reject } satisfies ConnData });
        if (ok) return undefined as never;
        return new Response("upgrade failed", { status: 400 });
      }
      if (!opts.webRoot) return new Response("not found", { status: 404 });
      // Static web client (optional; the PocketJS web build is served
      // separately by tools/web.ts).
      const rel = url.pathname === "/" ? "/index.html" : url.pathname;
      const resolved = join(opts.webRoot, rel);
      if (!resolved.startsWith(opts.webRoot)) return new Response("forbidden", { status: 403 });
      const file = Bun.file(resolved);
      return file.size > 0 ? new Response(file) : new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws: ServerWebSocket<ConnData>) {
        // Nothing until JOIN, unless the upgrade already refused the pin.
        if (ws.data.reject) ws.close(1008, ws.data.reject);
      },
      message(ws: ServerWebSocket<ConnData>, msg: string | Buffer<ArrayBuffer>) {
        if (opts.simLatency > 0) {
          const copy = typeof msg === "string" ? msg : Buffer.from(msg);
          setTimeout(() => onMessage(ws, copy), opts.simLatency);
        } else onMessage(ws, msg);
      },
      close(ws: ServerWebSocket<ConnData>) {
        const conn = ws.data.conn;
        if (!conn) return;
        const id = conn.playerId;
        const activeArena = conn.realm ? realmArena : arena;
        const activeConns = conn.realm ? realmConns : conns;
        activeArena.remove(id);
        activeConns.delete(id);
        if (conn.githubId > 0 && auth) auth.sessionRelease(conn.githubId, conn.realm ? "v4:local" : "local", conn.sid);
        for (const other of activeConns.values()) emit(other, encodeBye(id));
      },
    },
  });

  const handle: ServerHandle = {
    url: `ws://localhost:${server.port}/ws`,
    port: server.port ?? opts.port,
    hostname: server.hostname ?? "127.0.0.1",
    arena,
    realmArena,
    close() {
      clearInterval(tickTimer);
      server.stop(true);
    },
  };

  const shutdown = () => {
    handle.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.log(`wander-online server on ${handle.hostname}:${server.port} (seed 0x${(opts.seed >>> 0).toString(16)}, hz ${opts.hz}, aoi ${opts.aoi}, sim-latency ${opts.simLatency}ms)`);
  return handle;
}

// CLI entry.
if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (name: string, def: string): string => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? (args[i + 1] ?? def) : def;
  };
  const hasFlag = (name: string): boolean => args.includes(`--${name}`);
  startServer({
    port: Number(flag("port", "8080")),
    seed: Number(flag("seed", String(0x5eed_0001))),
    hz: Number(flag("hz", "20")),
    broadcastHz: Number(flag("broadcast-hz", "10")),
    aoi: Number(flag("aoi", "16")),
    simLatency: Number(flag("sim-latency", "0")),
    webRoot: flag("web", ""),
    allowGuests: hasFlag("allow-guests"),
    githubApiBase: flag("github-api", "https://api.github.com"),
    realmPlayerCap: Number(flag("realm-cap", String(REALM_PLAYER_CAP))),
  });
}
