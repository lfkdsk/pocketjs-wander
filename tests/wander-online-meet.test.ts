// tests/wander-online-meet.test.ts — the D-phase realm meeting features on
// the shared arena and the loopback server: safe spawn slots (32 players at
// once never share or block a tile), realm pins and invites (same realm,
// explicit full/invalid/expired refusals, no account data on the wire),
// the coarse far-player band (octant + band only, no coordinates) and the
// preset emotes (AOI-only, rate-limited, never persisted, no text form).
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  COMMAND,
  EMOTE_BYTES,
  FAR_PLAYERS_ROW_BYTES,
  MSG,
  WORLD_PROTOCOL_VERSION,
  WORLD_STATE_VERSION,
  decodeEmote,
  decodeFarPlayers,
  decodeState4,
  decodeWelcome4,
  encodeCommand,
  encodeEmote,
  encodeFarPlayers,
} from "../examples/wander-online/net/protocol.ts";
import { EMOTE, EMOTE_COUNT, EMOTE_MIN_INTERVAL_MS, EMOTE_SHOW_MS, EMOTE_TABLE, isEmoteId } from "../examples/wander-online/net/emote.ts";
import { FAR_BANDS, FAR_DIR_NAMES, farBand, farDir, farRowsFor, farVector } from "../examples/wander-online/net/far.ts";
import { SPAWN_RING_RADIUS, pickSpawn, spawnHash, spawnRing } from "../examples/wander-online/net/spawn.ts";
import {
  INVITE_CODE_LEN,
  INVITE_MAX_LIVE,
  INVITE_TTL_SEC,
  InviteTable,
  REALM_CLOSE_REASON,
  formatInviteToken,
  inviteCodeWellFormed,
  parseInviteToken,
  realmJoinUrl,
} from "../examples/wander-online/shared/invite.ts";
import { REALM_PLAYER_CAP, RealmArena, type RealmPlayer } from "../examples/wander-online/server/realm-area.ts";
import { realmStart } from "../examples/wander-online/net/realm-world.ts";
import { regionOf } from "../examples/wander/world.ts";
import { startServer, type ServerHandle } from "../examples/wander-online/server/server.ts";
import { OnlineClient } from "../examples/wander-online/net/client.ts";
import { bunSocketFactory } from "./lib/bun-pocket-socket.ts";
import { connect, type TestSocket } from "./lib/ws-helper.ts";

const SEED = 0x5eed_0001;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("far-player band: octant and band only", () => {
  test("octants are the eight compass cones, clockwise from north", () => {
    expect(FAR_DIR_NAMES[farDir(0, -10)]).toBe("N");
    expect(FAR_DIR_NAMES[farDir(10, -10)]).toBe("NE");
    expect(FAR_DIR_NAMES[farDir(10, 0)]).toBe("E");
    expect(FAR_DIR_NAMES[farDir(10, 10)]).toBe("SE");
    expect(FAR_DIR_NAMES[farDir(0, 10)]).toBe("S");
    expect(FAR_DIR_NAMES[farDir(-10, 10)]).toBe("SW");
    expect(FAR_DIR_NAMES[farDir(-10, 0)]).toBe("W");
    expect(FAR_DIR_NAMES[farDir(-10, -10)]).toBe("NW");
    // Cone edges: 22.5 degrees either side of a compass direction.
    expect(FAR_DIR_NAMES[farDir(3, -10)]).toBe("N");
    expect(FAR_DIR_NAMES[farDir(6, -10)]).toBe("NE");
    for (let d = 0; d < 8; d++) {
      const v = farVector(d);
      expect(Math.hypot(v.x, v.y)).toBeCloseTo(1, 6);
      expect(farDir(Math.round(v.x * 100), Math.round(v.y * 100))).toBe(d);
    }
  });

  test("bands are coarse Chebyshev shells", () => {
    expect(FAR_BANDS).toEqual([64, 256, 1024]);
    expect(farBand(17)).toBe(0);
    expect(farBand(64)).toBe(0);
    expect(farBand(65)).toBe(1);
    expect(farBand(256)).toBe(1);
    expect(farBand(1000)).toBe(2);
    expect(farBand(5000)).toBe(3);
  });

  test("rows cover exactly the players outside the AOI and never a coordinate", () => {
    const others = [
      { id: 2, tx: 16, ty: 0 }, // on the AOI edge: in STATE4, no row
      { id: 3, tx: 17, ty: 0 }, // just outside: east, near
      { id: 4, tx: -300, ty: -300 }, // north-west, band 2
      { id: 5, tx: 0, ty: 2000 }, // south, band 3
    ];
    const rows = farRowsFor(0, 0, 1, [{ id: 1, tx: 0, ty: 0 }, ...others], 16);
    expect(rows).toEqual([
      { id: 3, dir: 2, band: 0 },
      { id: 4, dir: 7, band: 2 },
      { id: 5, dir: 4, band: 3 },
    ]);
    const wire = encodeFarPlayers(rows);
    expect(wire.byteLength).toBe(2 + rows.length * FAR_PLAYERS_ROW_BYTES);
    expect(decodeFarPlayers(wire)).toEqual(rows);
    // Every row is 6 bytes: a u32 id, a u8 octant, a u8 band. A tile
    // coordinate (i32) does not fit; the row has no field for one.
    expect(FAR_PLAYERS_ROW_BYTES).toBe(6);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(["band", "dir", "id"]);
    }
    // Strict decoding: truncation, trailing bytes, bad octant/band, duplicates.
    expect(decodeFarPlayers(wire.slice(0, wire.byteLength - 1))).toBeNull();
    const longer = new Uint8Array(wire.byteLength + 1);
    longer.set(new Uint8Array(wire));
    expect(decodeFarPlayers(longer)).toBeNull();
    const badDir = new Uint8Array(wire);
    badDir[2 + 4] = 8;
    expect(decodeFarPlayers(badDir)).toBeNull();
    const badBand = new Uint8Array(wire);
    badBand[2 + 5] = 4;
    expect(decodeFarPlayers(badBand)).toBeNull();
    expect(() => encodeFarPlayers([{ id: 1, dir: 0, band: 0 }, { id: 1, dir: 1, band: 1 }])).toThrow();
    expect(decodeFarPlayers(encodeFarPlayers([]))).toEqual([]);
  });
});

describe("preset emotes: one byte, no text", () => {
  test("the table has five ASCII presets and the codec is six strict bytes", () => {
    expect(EMOTE_TABLE.map((e) => e.id)).toEqual([1, 2, 3, 4, 5]);
    expect(EMOTE_COUNT).toBe(5);
    for (const e of EMOTE_TABLE) {
      expect(isEmoteId(e.id)).toBe(true);
      // ASCII glyphs render in every font slot of every host.
      for (const ch of e.glyph) expect(ch.charCodeAt(0)).toBeLessThan(128);
    }
    expect(isEmoteId(0)).toBe(false);
    expect(isEmoteId(6)).toBe(false);
    const wire = encodeEmote({ id: 7, emote: EMOTE.wave });
    expect(wire.byteLength).toBe(EMOTE_BYTES);
    expect(decodeEmote(wire)).toEqual({ id: 7, emote: EMOTE.wave });
    const bad = new Uint8Array(wire);
    bad[5] = 6;
    expect(decodeEmote(bad)).toBeNull();
    expect(decodeEmote(wire.slice(0, 5))).toBeNull();
    expect(() => encodeEmote({ id: 7, emote: 9 })).toThrow();
    // The command that requests one carries the id in the u8 extra and
    // nothing else: there is no field a string could travel in.
    const cmd = encodeCommand({ kind: COMMAND.emote, rx: 0, ry: 0, extra: EMOTE.gather });
    expect(cmd.byteLength).toBe(11);
    expect(EMOTE_SHOW_MS).toBe(5000);
    expect(EMOTE_MIN_INTERVAL_MS).toBe(1000);
  });

  test("the arena accepts a known id once per second and tells only the sender's AOI", () => {
    const clock = { now: 1_000_000 };
    const arena = new RealmArena({ seed: SEED, hz: 20, now: () => clock.now, epoch: 1 });
    const a = arena.add("a", 1, 0);
    const b = arena.add("b", 2, 0);
    const start = realmStart(SEED);
    // c stands 40 tiles east: outside a 16-tile AOI, inside a 48-tile one.
    const c = arena.add("c", 3, 0, { tx: start.tx + 40, ty: start.ty });
    const region = { rx: regionOf(a.state.move.tx), ry: regionOf(a.state.move.ty) };
    expect(arena.applyCommand(a, { kind: COMMAND.emote, extra: EMOTE.wave, ...region }, clock.now)).toBeNull();
    const first = arena.drainEmotes();
    expect(first).toEqual([{ from: a, emote: EMOTE.wave }]);
    expect(arena.emoteRecipients(a, 16).map((p) => p.id).sort()).toEqual([a.id, b.id].sort());
    expect(arena.emoteRecipients(a, 48).map((p) => p.id).sort()).toEqual([a.id, b.id, c.id].sort());
    // Rate limit: five more within the second are all dropped.
    for (let i = 0; i < 5; i++) {
      clock.now += 100;
      arena.applyCommand(a, { kind: COMMAND.emote, extra: EMOTE.cheer, ...region }, clock.now);
    }
    expect(arena.drainEmotes()).toEqual([]);
    clock.now += EMOTE_MIN_INTERVAL_MS;
    arena.applyCommand(a, { kind: COMMAND.emote, extra: EMOTE.cheer, ...region }, clock.now);
    expect(arena.drainEmotes()).toEqual([{ from: a, emote: EMOTE.cheer }]);
    // Unknown ids and a wrong region are refused; the journey is untouched.
    clock.now += EMOTE_MIN_INTERVAL_MS;
    expect(arena.applyEmote(a, 0, clock.now)).toBe(false);
    expect(arena.applyEmote(a, 6, clock.now)).toBe(false);
    arena.applyCommand(a, { kind: COMMAND.emote, extra: EMOTE.wave, rx: region.rx + 5, ry: region.ry }, clock.now);
    expect(arena.drainEmotes()).toEqual([]);
    expect(a.journeyDirty).toBe(false);
    expect(a.progressDirty).toBe(false);
    expect(a.event.seq).toBe(0);
  });
});

describe("safe spawn slots", () => {
  test("ring walk order, radius and the stable hash", () => {
    expect(spawnRing(0)).toEqual([{ dx: 0, dy: 0 }]);
    expect(spawnRing(1)).toHaveLength(8);
    expect(spawnRing(2)).toHaveLength(16);
    const cells = spawnRing(3);
    expect(cells).toHaveLength(24);
    expect(new Set(cells.map((c) => `${c.dx},${c.dy}`)).size).toBe(24);
    for (const c of cells) expect(Math.max(Math.abs(c.dx), Math.abs(c.dy))).toBe(3);
    expect(SPAWN_RING_RADIUS).toBe(6);
    expect(spawnHash("1001")).toBe(spawnHash("1001"));
    expect(spawnHash("1001")).not.toBe(spawnHash("1002"));
    // The walk starts at the hash offset and takes the first free tile.
    const blocked = new Set(["0,0", "-1,-1"]);
    const pick = pickSpawn({ tx: 0, ty: 0 }, 0, (x, y) => !blocked.has(`${x},${y}`));
    expect(pick).toEqual({ tx: 0, ty: -1, ring: 1 });
    expect(pickSpawn({ tx: 0, ty: 0 }, 0, () => false, 2)).toBeNull();
    expect(pickSpawn({ tx: 5, ty: 5 }, 123, () => true)).toEqual({ tx: 5, ty: 5, ring: 0 });
  });

  test("32 players admitted together stand on 32 distinct open tiles near the starter hub", () => {
    const arena = new RealmArena({ seed: SEED, hz: 20, now: () => 1_000_000, epoch: 1 });
    const players: RealmPlayer[] = [];
    for (let i = 0; i < REALM_PLAYER_CAP; i++) players.push(arena.add(`p${i}`, i & 15, 0, undefined, undefined, `acct-${1000 + i}`));
    const start = realmStart(SEED);
    const tiles = new Set<string>();
    for (const p of players) {
      const { tx, ty } = p.state.move;
      tiles.add(`${tx},${ty}`);
      const collision = arena.world.collisionAt(tx, ty);
      expect(collision.ready).toBe(true);
      expect(collision.blocked).toBe(false);
      expect(Math.max(Math.abs(tx - start.tx), Math.abs(ty - start.ty))).toBeLessThanOrEqual(SPAWN_RING_RADIUS);
      expect(p.spawn.ring).toBeGreaterThanOrEqual(0);
    }
    expect(tiles.size).toBe(REALM_PLAYER_CAP);
    // The hub itself is one player's tile and nobody shares it.
    expect(arena.tryAdd("one-too-many", 0, 0)).toBeNull();
  });

  test("a returning player keeps its checkpoint tile when free, moves off it when taken or blocked", () => {
    const arena = new RealmArena({ seed: SEED, hz: 20, now: () => 1_000_000, epoch: 1 });
    const start = realmStart(SEED);
    const back = arena.add("back", 1, 0, { tx: start.tx + 3, ty: start.ty + 2, facing: 2 }, undefined, "acct-back");
    expect(back.state.move).toMatchObject({ tx: start.tx + 3, ty: start.ty + 2, facing: 2 });
    expect(back.spawn.ring).toBe(0);
    // Same checkpoint, second session: the tile is occupied, so the next
    // free ring tile is used and the two never overlap.
    const twin = arena.add("twin", 2, 0, { tx: start.tx + 3, ty: start.ty + 2 }, undefined, "acct-back");
    expect(twin.spawn.ring).toBe(1);
    expect(`${twin.state.move.tx},${twin.state.move.ty}`).not.toBe(`${back.state.move.tx},${back.state.move.ty}`);
    expect(arena.world.collisionAt(twin.state.move.tx, twin.state.move.ty).blocked).toBe(false);
    // A checkpoint on a blocked tile (find one near the hub) is not honoured.
    let blockedTile: { tx: number; ty: number } | null = null;
    for (let dy = -40; dy <= 40 && !blockedTile; dy++) for (let dx = -40; dx <= 40; dx++) {
      const c = arena.world.collisionAt(start.tx + dx, start.ty + dy);
      if (c.ready && c.blocked) { blockedTile = { tx: start.tx + dx, ty: start.ty + dy }; break; }
    }
    if (!blockedTile) throw new Error("no blocked tile within 40 tiles of the hub");
    const stuck = arena.add("stuck", 3, 0, blockedTile, undefined, "acct-stuck");
    expect(`${stuck.state.move.tx},${stuck.state.move.ty}`).not.toBe(`${blockedTile.tx},${blockedTile.ty}`);
    expect(arena.world.collisionAt(stuck.state.move.tx, stuck.state.move.ty).blocked).toBe(false);
    expect(stuck.spawn.ring).toBeGreaterThan(0);
  });
});

describe("invites: pure", () => {
  test("tokens carry a realm name and a code, nothing else; the table bounds and expires", () => {
    expect(INVITE_TTL_SEC).toBe(3600);
    expect(INVITE_CODE_LEN).toBe(8);
    const clock = { now: 10_000 };
    let n = 0;
    const table = new InviteTable(() => clock.now, () => ((n++ * 7919) % 1000) / 1000);
    const issued = table.issue();
    expect(inviteCodeWellFormed(issued.code)).toBe(true);
    expect(issued.expiresAtMs).toBe(10_000 + INVITE_TTL_SEC * 1000);
    expect(table.valid(issued.code)).toBe(true);
    expect(table.valid(issued.code.toLowerCase())).toBe(false);
    expect(table.valid("NOPE")).toBe(false);
    clock.now = issued.expiresAtMs; // expiry is exclusive
    expect(table.valid(issued.code)).toBe(false);
    clock.now = 20_000;
    for (let i = 0; i < INVITE_MAX_LIVE + 10; i++) table.issue();
    expect(table.size).toBe(INVITE_MAX_LIVE);
    const token = formatInviteToken("plaza-1", issued.code);
    expect(token).toBe(`plaza-1.${issued.code}`);
    expect(parseInviteToken(token)).toEqual({ realm: "plaza-1", code: issued.code });
    expect(parseInviteToken(token.toLowerCase())).toEqual({ realm: "plaza-1", code: issued.code });
    expect(parseInviteToken("plaza-1")).toBeNull();
    expect(parseInviteToken(".ABCDEFGH")).toBeNull();
    expect(parseInviteToken("plaza-1.ABC")).toBeNull();
    expect(parseInviteToken("pla za.ABCDEFGH")).toBeNull();
    expect(realmJoinUrl("ws://h/ws/v4", null, null)).toBe("ws://h/ws/v4");
    expect(realmJoinUrl("ws://h/ws/v4", "plaza-1", null)).toBe("ws://h/ws/v4?realm=plaza-1");
    expect(realmJoinUrl("ws://h/ws/v4?x=1", "plaza-1", "ABCDEFGH")).toBe("ws://h/ws/v4?x=1&realm=plaza-1&invite=ABCDEFGH");
  });
});

describe("loopback server: pins, invites, far band and emotes", () => {
  let server: ServerHandle;
  let port: number;
  const live: OnlineClient[] = [];
  const sockets: TestSocket[] = [];
  let driver: ReturnType<typeof setInterval> | undefined;

  beforeAll(async () => {
    server = startServer({ port: 0, seed: SEED, hz: 20, broadcastHz: 10, aoi: 16, simLatency: 0, webRoot: "", allowGuests: true, realmEpoch: 0x1234 });
    port = server.port;
    await sleep(100);
  });
  afterAll(() => {
    if (driver) clearInterval(driver);
    for (const c of live.splice(0)) c.stop();
    for (const s of sockets.splice(0)) s.close();
    server.close();
  });
  afterEach(() => {
    if (driver) clearInterval(driver);
    driver = undefined;
    for (const c of live.splice(0)) c.stop();
    for (const s of sockets.splice(0)) s.close();
  });

  const waitFor = async (pred: () => boolean, what: string, timeoutMs = 10_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (pred()) return;
      await sleep(25);
    }
    throw new Error(`timeout waiting for ${what}`);
  };
  const startDriver = (buttons = () => 0) => {
    driver = setInterval(() => {
      for (const c of live) c.onFrame(buttons(), 60, 0);
    }, 16);
  };
  const mk = (name: string, opts: { realm?: string | null; invite?: string | null } = {}): OnlineClient => {
    const client = new OnlineClient(`ws://127.0.0.1:${port}/ws`, {
      name, color: 1, auth: { kind: "guest" },
      realm: opts.realm ?? null,
      invite: opts.invite ?? null,
      socketFactory: (u) => bunSocketFactory(u),
    });
    live.push(client);
    return client;
  };
  const rawJoin = async (name: string, query = ""): Promise<TestSocket> => {
    const s = await connect(`ws://127.0.0.1:${port}/ws/v4${query}`);
    sockets.push(s);
    s.send(JSON.stringify({ type: "join", v: WORLD_PROTOCOL_VERSION, supportedGeneratorVersions: [1], worldStateVersion: WORLD_STATE_VERSION, name, color: 1 }));
    return s;
  };
  const nextOfKind = async (s: TestSocket, kind: number, timeoutMs = 3000): Promise<ArrayBuffer | null> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const m = await s.nextMessage(Math.max(1, deadline - Date.now()));
      if (m === undefined) return null;
      if (typeof m !== "string" && new Uint8Array(m)[0] === kind) return m;
    }
    return null;
  };
  const nextText = async (s: TestSocket, types: string | string[], timeoutMs = 3000): Promise<Record<string, unknown> | null> => {
    const wanted = Array.isArray(types) ? types : [types];
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const m = await s.nextMessage(Math.max(1, deadline - Date.now()));
      if (m === undefined) return null;
      if (typeof m === "string") {
        const parsed = JSON.parse(m) as Record<string, unknown>;
        if (wanted.includes(String(parsed.type))) return parsed;
      }
    }
    return null;
  };

  test("the inviter and the invitee land in the same realm; the reply holds no account data", async () => {
    startDriver();
    const host = mk("host");
    await waitFor(() => host.status === "joined", "host joined");
    expect(host.realmPin).toBe("local");
    let reply: Record<string, unknown> | null = null;
    host.requestInvite((r) => { reply = r; });
    await waitFor(() => reply !== null, "invite reply");
    expect(Object.keys(reply!).sort()).toEqual(["code", "expiresIn", "realm", "type"]);
    expect(reply!).toMatchObject({ type: "invite", realm: "local", expiresIn: INVITE_TTL_SEC });
    const token = host.inviteToken;
    expect(token).toBe(`local.${String(reply!.code)}`);
    expect(JSON.stringify(reply)).not.toContain("host");
    const parsed = parseInviteToken(token!)!;
    const guest = mk("guest", { realm: parsed.realm, invite: parsed.code });
    await waitFor(() => guest.status === "joined", "guest joined through the invite");
    expect(guest.realmId).toBe(host.realmId);
    expect(guest.realmPin).toBe("local");
    // The invite is consumed by the client after admission; a later
    // reconnect pins the realm alone.
    expect(guest.invite).toBeNull();
    expect(guest.connectUrl()).toBe(`ws://127.0.0.1:${port}/ws/v4?realm=local`);
  }, 20_000);

  test("an unknown, malformed or expired invite is refused with 1008 invite; a wrong realm with 1008 realm", async () => {
    const bad = await connect(`ws://127.0.0.1:${port}/ws/v4?realm=local&invite=ZZZZZZZZ`);
    sockets.push(bad);
    expect(await bad.nextClose(3000)).toEqual({ code: 1008, reason: REALM_CLOSE_REASON.invite });
    const malformed = await connect(`ws://127.0.0.1:${port}/ws/v4?realm=local&invite=abc`);
    sockets.push(malformed);
    expect(await malformed.nextClose(3000)).toEqual({ code: 1008, reason: REALM_CLOSE_REASON.invite });
    const wrongRealm = await connect(`ws://127.0.0.1:${port}/ws/v4?realm=plaza-9`);
    sockets.push(wrongRealm);
    expect(await wrongRealm.nextClose(3000)).toEqual({ code: 1008, reason: REALM_CLOSE_REASON.realm });
    // Expiry: mint a code, age the table past its TTL, redeem.
    startDriver();
    const host = mk("host2");
    await waitFor(() => host.status === "joined", "host joined");
    let token: string | null = null;
    host.requestInvite(() => { token = host.inviteToken; });
    await waitFor(() => token !== null, "invite minted");
    const realDate = Date.now;
    const skew = INVITE_TTL_SEC * 1000 + 1;
    Date.now = () => realDate() + skew;
    try {
      const expired = await connect(`ws://127.0.0.1:${port}/ws/v4?realm=local&invite=${parseInviteToken(token!)!.code}`);
      sockets.push(expired);
      expect(await expired.nextClose(3000)).toEqual({ code: 1008, reason: REALM_CLOSE_REASON.invite });
    } finally {
      Date.now = realDate;
    }
    // The client shows the refusal and does not retry on its own.
    const refused = mk("refused", { realm: "local", invite: "ZZZZZZZZ" });
    await waitFor(() => refused.status === "rejected", "invite refused client");
    expect(refused.hud().rejectText).toBe("INVITE INVALID OR EXPIRED");
    // "Any world" clears the pin and reconnects without it.
    refused.leaveRealm();
    await waitFor(() => refused.status === "joined", "refused client joined after dropping the pin");
    expect(refused.realmPin).toBe("local");
  }, 30_000);

  test("a full pinned realm says so explicitly", async () => {
    const small = startServer({ port: 0, seed: SEED, hz: 20, broadcastHz: 10, aoi: 16, simLatency: 0, webRoot: "", allowGuests: true, realmPlayerCap: 1, realmEpoch: 7 });
    try {
      const first = await connect(`ws://127.0.0.1:${small.port}/ws/v4`);
      first.send(JSON.stringify({ type: "join", v: WORLD_PROTOCOL_VERSION, supportedGeneratorVersions: [1], worldStateVersion: WORLD_STATE_VERSION, name: "one", color: 1 }));
      expect(await nextOfKind(first, MSG.welcome4)).not.toBeNull();
      const pinned = new OnlineClient(`ws://127.0.0.1:${small.port}/ws`, {
        name: "two", color: 1, auth: { kind: "guest" }, realm: "local", socketFactory: (u) => bunSocketFactory(u),
      });
      live.push(pinned);
      startDriver();
      await waitFor(() => pinned.status === "retrying", "pinned client told the world is full");
      expect(pinned.hud().rejectText).toBe("WORLD FULL");
      expect(pinned.rejectReason).toBe("full");
      first.close();
    } finally {
      small.close();
    }
  }, 20_000);

  test("invite minting is rate-limited per player and the reply is the only new text message", async () => {
    const s = await rawJoin("minter");
    expect(await nextOfKind(s, MSG.welcome4)).not.toBeNull();
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      s.send(JSON.stringify({ type: "inviteq", v: WORLD_PROTOCOL_VERSION }));
      const reply = await nextText(s, ["invite", "inviteError"], 1000);
      seen.push(String(reply?.type));
    }
    expect(seen).toEqual(["invite", "invite", "invite", "inviteError"]);
    // No free-text entry point: a chat-shaped message gets no reply and
    // nothing reaches anyone.
    const other = await rawJoin("listener");
    expect(await nextOfKind(other, MSG.welcome4)).not.toBeNull();
    s.send(JSON.stringify({ type: "chat", text: "hello" }));
    s.send(JSON.stringify({ type: "say", text: "hello" }));
    expect(await nextText(s, "chat", 300)).toBeNull();
    const deadline = Date.now() + 400;
    while (Date.now() < deadline) {
      const m = await other.nextMessage(100);
      if (m === undefined) continue;
      if (typeof m === "string") expect(JSON.parse(m).type).not.toMatch(/chat|say/);
    }
  }, 20_000);

  test("emotes reach the AOI once, are rate-limited, and are never replayed to a late joiner", async () => {
    const a = await rawJoin("ema");
    const wa = decodeWelcome4((await nextOfKind(a, MSG.welcome4))!)!;
    const b = await rawJoin("emb");
    expect(await nextOfKind(b, MSG.welcome4)).not.toBeNull();
    const region = { rx: regionOf(wa.mover.tx), ry: regionOf(wa.mover.ty) };
    // Five emotes in a burst: exactly one EMOTE frame reaches b (and a).
    for (let i = 0; i < 5; i++) a.send(encodeCommand({ kind: COMMAND.emote, extra: EMOTE.wave, ...region }));
    const gotB = decodeEmote((await nextOfKind(b, MSG.emote))!);
    expect(gotB).toEqual({ id: wa.you, emote: EMOTE.wave });
    const gotA = decodeEmote((await nextOfKind(a, MSG.emote))!);
    expect(gotA).toEqual({ id: wa.you, emote: EMOTE.wave });
    expect(await nextOfKind(b, MSG.emote, 400)).toBeNull();
    // A joiner after the fact never receives it: nothing was stored.
    const late = await rawJoin("late");
    expect(await nextOfKind(late, MSG.welcome4)).not.toBeNull();
    expect(await nextOfKind(late, MSG.emote, 400)).toBeNull();
    // Out-of-range ids are dropped silently (no close, no frame).
    a.send(encodeCommand({ kind: COMMAND.emote, extra: 9, ...region }));
    expect(await nextOfKind(b, MSG.emote, 400)).toBeNull();
    expect(await b.nextClose(50)).toBeUndefined();
  }, 20_000);

  test("a player outside the AOI is a far row (octant + band), never an entity; inside it is the reverse", async () => {
    // A dedicated manual server keeps the real socket/broadcast path but
    // advances simulation cadence by frame count, independent of host load.
    const manual = startServer({ port: 0, seed: SEED, hz: 20, broadcastHz: 10, aoi: 16, simLatency: 0, webRoot: "", allowGuests: true, realmEpoch: 0x1234, manualTick: true });
    const localSockets: TestSocket[] = [];
    const join = async (name: string): Promise<TestSocket> => {
      const socket = await connect(`ws://127.0.0.1:${manual.port}/ws/v4`);
      localSockets.push(socket);
      socket.send(JSON.stringify({ type: "join", v: WORLD_PROTOCOL_VERSION, supportedGeneratorVersions: [1], worldStateVersion: WORLD_STATE_VERSION, name, color: 1 }));
      return socket;
    };
    const stateAt = async (socket: TestSocket, frame: number): Promise<NonNullable<ReturnType<typeof decodeState4>>> => {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const message = await socket.nextMessage(Math.max(1, deadline - Date.now()));
        if (message === undefined) break;
        if (typeof message === "string" || new Uint8Array(message)[0] !== MSG.state4) continue;
        const state = decodeState4(message);
        if (state?.frame === frame) return state;
      }
      throw new Error(`no STATE4 for authoritative frame ${frame}`);
    };

    try {
      const near = await join("near");
      const wn = decodeWelcome4((await nextOfKind(near, MSG.welcome4))!)!;
      const walker = await join("walker");
      const ww = decodeWelcome4((await nextOfKind(walker, MSG.welcome4))!)!;

      // The first 10 Hz snapshot proves the inside half of the contract.
      manual.advance(2);
      const inside = await stateAt(near, 2);
      expect(inside.entities.map((e) => e.id)).toEqual([wn.you, ww.you]);

      // Positioning is test setup, not movement coverage: guest spawn is
      // intentionally random and a straight path through real terrain may
      // be blocked. Put the authoritative walker exactly one tile past AOI.
      const nearPlayer = manual.realmArena.players.get(wn.you)!;
      const walkerPlayer = manual.realmArena.players.get(ww.you)!;
      const tx = nearPlayer.state.move.tx + 17;
      const ty = nearPlayer.state.move.ty;
      walkerPlayer.state = {
        ...walkerPlayer.state,
        move: { ...walkerPlayer.state.move, tx, ty, px: tx * 16, py: ty * 16, phase: 0, moving: false, walking: false },
      };
      walkerPlayer.buttons = 0;
      walkerPlayer.queue.length = 0;

      // Frame 20 is both a 10 Hz snapshot boundary and the one-second FAR
      // boundary. The state and far row therefore describe the same frame.
      manual.advance(18);
      const outside = await stateAt(near, 20);
      expect(outside.entities.map((e) => e.id)).toEqual([wn.you]);
      const farWire = await nextOfKind(near, MSG.farPlayers);
      expect(farWire).not.toBeNull();
      expect(farWire!.byteLength).toBe(8);
      expect(FAR_PLAYERS_ROW_BYTES).toBe(6);
      expect(decodeFarPlayers(farWire!)).toEqual([{ id: ww.you, dir: 2, band: 0 }]);
    } finally {
      for (const socket of localSockets) socket.close();
      manual.close();
    }
  }, 30_000);
});
