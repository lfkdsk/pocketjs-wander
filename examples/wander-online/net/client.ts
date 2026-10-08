// examples/wander-online/net/client.ts — the PocketJS net client: socket
// lifecycle, client-side prediction, snapshot reconciliation, remote
// interpolation, RTT, reconnect and the 2-second snapshot freeze.
//
// One OnlineClient owns one PocketSocket. The view calls onFrame() once per
// host frame with the held buttons; the client predicts one reference tick
// per INPUT (60/hz per frame) and packs every BATCH_SIZE ticks into one
// INPUT_BATCH message (20 Hz wire rate at any host rate), each carrying the
// first tick's sequence number. It reconciles against every STATE snapshot.
// Socket callbacks fire during the framework's service pump (inside the
// host's frame loop), so all of this runs on one thread with no races.
//
// Recovery model (after open-strike's CROSSPLAY.md):
//   - onClose: backoff (1s, 2s, 4s, ... 10s cap) and reconnect. A server
//     restart looks the same: connect retries until the server is back.
//   - a close carrying a hosted-server reason (1008 + token) changes the
//     policy: "full"/"rest" retry on a SLOW backoff (the condition clears in
//     minutes, not seconds); "rate"/"ip"/"origin" do not reconnect at all
//     (retrying would just be rejected again); "idle" reconnects normally.
//   - 2 s without a STATE snapshot: freeze local gameplay (stop predicting
//     and sending), then start a fresh join. The server is authoritative;
//     a frozen client cannot diverge.
//   - every JOIN is a fresh epoch: the predictor, the input queue and the
//     interpolation buffer all reset (a previous session's snapshots can
//     never mix with the new one's).

import { openSocket, type PocketSocket } from "@pocketjs/framework/socket";
import {
  BTN,
  BATCH_SIZE,
  MSG,
  REGION_STATE_FLAG_INITIAL,
  WORLD_PROTOCOL_VERSION,
  WORLD_STATE_VERSION,
  decodePlayerProgress,
  decodeRegionState,
  decodeRoster,
  decodeState,
  decodeState4,
  decodeWelcome,
  decodeWelcome4,
  encodeInputBatch,
  encodePing,
  type RosterEntry,
} from "./protocol.ts";
import { Predictor, type AuthoritativeMover } from "./predict.ts";
import { RealmPredictor } from "./realm-predict.ts";
import { GENERATOR_VERSION } from "./realm-world.ts";
import { Interpolator } from "./interpolate.ts";
import { AUTH_PROTOCOL_VERSION } from "../shared/auth.ts";
import { regionOf } from "../../wander/world.ts";

export type ConnStatus = "connecting" | "joined" | "reconnecting" | "retrying" | "rejected" | "frozen";

const FREEZE_MS = 2000;
const PING_MS = 2000;
const BACKOFF_MAX_MS = 10_000;
/** Slow backoff for capacity/budget rejections: the room frees up or the
 *  month rolls over on a timescale of minutes, so wait longer between
 *  retries (15 s, 30 s, 60 s cap). */
const SLOW_BACKOFF_START_MS = 15_000;
const SLOW_BACKOFF_MAX_MS = 60_000;
/** D-pad bits the arena understands. */
const DPAD = BTN.up | BTN.right | BTN.down | BTN.left;

/** Human-readable HUD text per hosted-server close token. Kept short so
 *  the HUD plate never truncates. */
export const REJECT_TEXT: Record<string, string> = {
  full: "ROOM FULL",
  rest: "CLOSED FOR THE MONTH",
  rate: "RATE LIMITED",
  ip: "TOO MANY CONNECTIONS",
  origin: "ORIGIN DENIED",
  idle: "IDLE DISCONNECT",
  version: "SERVER UPGRADED",
  "upgrade-required": "WORLD UPDATE REQUIRED",
  auth: "SIGN IN REQUIRED",
  ghauth: "GITHUB SIGN-IN FAILED",
  ticket: "SIGN-IN EXPIRED",
  taken: "SIGNED IN ELSEWHERE",
};

/** Reconnect policy per close token. Unknown tokens use the normal path. */
function policyFor(reason: string): "slow" | "never" | "normal" {
  if (reason === "full" || reason === "rest") return "slow";
  if (
    reason === "rate" ||
    reason === "ip" ||
    reason === "origin" ||
    reason === "version" ||
    reason === "upgrade-required" ||
    reason === "auth" ||
    reason === "ghauth" ||
    reason === "ticket" ||
    reason === "taken"
  ) {
    return "never";
  }
  return "normal";
}

/** Opens one PocketSocket. Injected by tests so the client lifecycle can be
 *  exercised without a PocketJS host; production code uses openSocket. */
export type SocketFactory = (url: string, opts: { timeoutMs: number }) => PocketSocket;

/** New clients use the realm route while committed configs keep the stable
 * service base `/ws`. Already-versioned URLs are left unchanged. */
export function realmEndpoint(url: string): string {
  const query = url.search(/[?#]/);
  const base = query < 0 ? url : url.slice(0, query);
  const tail = query < 0 ? "" : url.slice(query);
  return base.endsWith("/ws") ? `${base}/v4${tail}` : url;
}

/** How the client authenticates. A GitHub token is presented once (the
 *  first JOIN); the server exchanges it for a ticket and the client uses
 *  the ticket for every later JOIN/reconnect. "guest" is the local Bun
 *  server's --allow-guests dev mode only. "link" redeems a device-link
 *  code (desktop): the client sends LINKR on open, then JOINs with the
 *  ticket it gets back. */
export type AuthCredential =
  | { kind: "github"; token: string }
  | { kind: "ticket"; ticket: string }
  | { kind: "guest"; name?: string; color?: number }
  | { kind: "link"; code: string };

export interface OnlineClientOpts {
  /** Clock for the reconnect/freeze timers (tests inject a virtual one). */
  now?: () => number;
  /** Socket factory (tests inject an in-process transport). */
  socketFactory?: SocketFactory;
  /** Auth credential. Defaults to "guest" (local dev server). */
  auth?: AuthCredential;
  /** Guest display name (--allow-guests dev mode only). */
  name?: string;
  /** Guest colour (--allow-guests dev mode only). */
  color?: number;
  /** The account has no profile yet: create a character. */
  onNeedCreate?: (login: string, ticket: string) => void;
  /** A fresh/redeemed ticket from an auth reply. The host can persist it
   *  before character creation or the next reconnect needs it. */
  onTicket?: (ticket: string, source: "ready" | "linked" | "needCreate") => void;
  /** ROSTER update (id -> name, look). Reconciled by id. */
  onRoster?: (entries: RosterEntry[]) => void;
  /** Any other server text message (linkCode, linked, deleted, errors). */
  onText?: (msg: Record<string, unknown>) => void;
}

export interface OnlineHud {
  status: ConnStatus;
  myId: number;
  /** Players in this room. Kept as `online` for the existing diagnostics
   *  and web-check contract. */
  online: number;
  /** Players across every room. Equals `online` with a legacy server. */
  allOnline: number;
  rtt: number;
  corrections: number;
  unacked: number;
  /** v4 realm identity and generator; empty/zero only on legacy fallback. */
  realmId: string;
  generatorVersion: number;
  /** Display name of the latest nearby landmark first finder, if present. */
  landmarkFirstName: string;
  /** Private progress is delivered only on this player's socket. */
  progressCount: number;
  progressKeys: readonly string[];
  /** Shared improvement applied to the player's current v4 region. */
  improvementLevel: number;
  /** Hosted-server rejection token ("full", "rate", ...) when the last
   *  close was a 1008 policy rejection, else null. */
  rejectReason: string | null;
  /** Human-readable rejection text for the HUD, null when not rejected. */
  rejectText: string | null;
  /** Milliseconds until the next reconnect attempt (0 when not waiting). */
  retryIn: number;
}

export class OnlineClient {
  readonly url: string;
  readonly name: string;
  readonly color: number;
  /** The auth credential in use. A GitHub token is swapped for a ticket
   *  after the first exchange; the ticket is what reconnects use. */
  auth: AuthCredential;
  status: ConnStatus = "connecting";
  myId = 0;
  /** Players in this room (the historical public field). */
  online = 0;
  /** Players across every room; legacy snapshots fall back to `online`. */
  allOnline = 0;
  rtt = 0;
  corrections = 0;
  realmId = "";
  generatorVersion = 0;
  epoch = 0;
  realmRevision = 0;
  landmarkFirstName = "";
  progressRevision = 0;
  readonly progressLandmarks = new Set<string>();
  /** Classified window grid (WINDOW*WINDOW), null until WELCOME. */
  grid: Uint8Array | null = null;
  predictor: Predictor | RealmPredictor | null = null;
  readonly interp = new Interpolator();
  /** Last 1008 rejection token, if any (cleared on a successful join). */
  rejectReason: string | null = null;
  /** id -> name/look from the last ROSTER. */
  roster: Map<number, RosterEntry> = new Map();

  private socket: PocketSocket | null = null;
  private seq = 0;
  private lastStateAt = 0;
  private lastPingAt = 0;
  private pingId = 0;
  private backoffMs = 1000;
  private slowBackoffMs = SLOW_BACKOFF_START_MS;
  private reconnectAt = 0;
  private frozen = false;
  private worldStateReady = false;
  private progressKeyList: string[] = [];
  private serverClockMs = 0;
  private serverClockLocalMs = 0;
  private stopped = false;
  /** Predicted ticks waiting to be packed into the next INPUT_BATCH. */
  private pending: { seq: number; buttons: number }[] = [];
  private now: () => number;
  private readonly socketFactory: SocketFactory;
  private readonly onNeedCreate?: OnlineClientOpts["onNeedCreate"];
  private readonly onTicket?: OnlineClientOpts["onTicket"];
  private readonly onRoster?: OnlineClientOpts["onRoster"];
  private readonly onText?: OnlineClientOpts["onText"];

  constructor(url: string, opts: OnlineClientOpts = {}) {
    this.url = realmEndpoint(url);
    this.name = opts.name ?? "guest";
    this.color = (opts.color ?? 0) & 0x0f;
    this.auth = opts.auth ?? { kind: "guest" };
    this.onNeedCreate = opts.onNeedCreate;
    this.onTicket = opts.onTicket;
    this.onRoster = opts.onRoster;
    this.onText = opts.onText;
    this.now = opts.now ?? (() => (globalThis.performance ? globalThis.performance.now() : Date.now()));
    this.socketFactory = opts.socketFactory ?? ((u, o) => openSocket(u, o));
    this.connect();
  }

  /** Store the ticket the server issued (after a GitHub exchange or a
   *  link-code redeem), so reconnects use it instead of the GitHub token. */
  setTicket(ticket: string): void {
    this.auth = { kind: "ticket", ticket };
  }

  private connect(): void {
    this.status = this.myId === 0 ? "connecting" : "reconnecting";
    let sock: PocketSocket;
    try {
      sock = this.socketFactory(this.url, { timeoutMs: 5000 });
    } catch {
      // openSocket throws (e.g. unavailable): retry after backoff.
      this.scheduleReconnect();
      return;
    }
    this.socket = sock;
    sock.onOpen = () => {
      this.backoffMs = 1000;
      if (this.auth.kind === "link") {
        // Desktop device-link: redeem the code, then JOIN with the ticket.
        sock.send(JSON.stringify({ type: "linkr", v: AUTH_PROTOCOL_VERSION, code: this.auth.code }));
      } else {
        sock.send(JSON.stringify(this.joinMessage()));
      }
    };
    sock.onMessage = (data) => this.onMessage(data);
    sock.onClose = (ev) => {
      this.socket = null;
      this.predictor = null;
      this.grid = null;
      this.myId = 0;
      this.online = 0;
      this.allOnline = 0;
      this.realmId = "";
      this.generatorVersion = 0;
      this.epoch = 0;
      this.realmRevision = 0;
      this.landmarkFirstName = "";
      this.progressRevision = 0;
      this.progressLandmarks.clear();
      this.progressKeyList = [];
      this.worldStateReady = false;
      this.serverClockMs = 0;
      this.serverClockLocalMs = 0;
      this.pending.length = 0;
      // Drop the previous epoch's remote entities so they cannot render
      // (or interpolate against the next epoch's snapshots) while away.
      this.interp.reset();
      this.handleClose(ev?.code ?? 0, ev?.reason ?? "");
    };
    sock.onError = () => { /* onClose follows; the reconnect lives there */ };
  }

  /** The v4 realm JOIN for the current credential. A GitHub token is sent once;
   *  every reconnect uses the ticket the server issued. */
  private joinMessage(): Record<string, unknown> {
    const base = {
      type: "join",
      v: WORLD_PROTOCOL_VERSION,
      clientBuild: "pocketjs-wander",
      supportedGeneratorVersions: [GENERATOR_VERSION],
      worldStateVersion: WORLD_STATE_VERSION,
    };
    if (this.auth.kind === "github") return { ...base, github: this.auth.token };
    if (this.auth.kind === "ticket") return { ...base, ticket: this.auth.ticket };
    // Guest: the local Bun server's --allow-guests dev mode only. The
    // hosted Worker has no guest path and refuses with 1008 "auth".
    return { ...base, name: this.name, color: this.color };
  }

  /** Apply the reconnect policy for a close. A 1008 + token is a hosted
   *  server's deliberate rejection: capacity/budget retries slowly,
   *  policy violations do not retry, anything else reconnects normally. */
  private handleClose(code: number, reason: string): void {
    const token = code === 1008 && REJECT_TEXT[reason] ? reason : "";
    if (token) this.rejectReason = token;
    switch (policyFor(token)) {
      case "never":
        this.status = "rejected";
        this.reconnectAt = 0;
        return;
      case "slow":
        this.status = "retrying";
        this.reconnectAt = this.now() + this.slowBackoffMs;
        this.slowBackoffMs = Math.min(SLOW_BACKOFF_MAX_MS, this.slowBackoffMs * 2);
        return;
      case "normal":
        this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.status = "reconnecting";
    this.reconnectAt = this.now() + this.backoffMs;
    this.backoffMs = Math.min(BACKOFF_MAX_MS, this.backoffMs * 2);
  }

  /** Stop the client: close the socket and do not reconnect. Tests and
   *  orderly shutdowns use this; the demo hosts kill the process instead. */
  stop(): void {
    this.stopped = true;
    this.reconnectAt = 0;
    this.socket?.close(1000, "client stop");
    this.socket = null;
    this.predictor = null;
    this.grid = null;
    this.interp.reset();
  }

  private onMessage(data: string | Uint8Array): void {
    if (this.stopped) return;
    if (typeof data === "string") {
      // Server text replies: needCreate, ready, createError, linkCode,
      // linked, linkError, deleted. Each is a one-shot JSON object.
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }
      if (msg.type === "needCreate" && typeof msg.ticket === "string") {
        this.setTicket(msg.ticket);
        this.onTicket?.(msg.ticket, "needCreate");
        this.onNeedCreate?.(String(msg.login ?? ""), msg.ticket);
        return;
      }
      if (msg.type === "ready" && typeof msg.ticket === "string") {
        this.setTicket(msg.ticket);
        this.onTicket?.(msg.ticket, "ready");
      }
      if (msg.type === "linked" && typeof msg.ticket === "string") {
        this.setTicket(msg.ticket);
        this.onTicket?.(msg.ticket, "linked");
        // Now JOIN with the redeemed ticket.
        this.socket?.send(JSON.stringify(this.joinMessage()));
      }
      if (msg.type === "linkError") {
        this.onText?.(msg);
        // A bad/expired code: stop reconnecting (the user re-enters).
        this.status = "rejected";
        this.rejectReason = "auth";
        this.reconnectAt = 0;
        this.stopped = true;
        this.socket?.close(1000, "link failed");
        return;
      }
      this.onText?.(msg);
      return;
    }
    const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const kind = v.getUint8(0);
    if (kind === MSG.welcome) {
      const w = decodeWelcome(data);
      this.myId = w.you;
      this.grid = w.grid;
      this.predictor = new Predictor(w.seed);
      this.realmId = "legacy";
      this.generatorVersion = 0;
      this.epoch = 0;
      this.seq = 0;
      this.frozen = false;
      this.status = "joined";
      // WELCOME means this client has been admitted. Count the local player
      // immediately instead of showing ONLINE 0 until the first STATE.
      this.online = 1;
      this.allOnline = 1;
      this.rejectReason = null;
      this.slowBackoffMs = SLOW_BACKOFF_START_MS;
      this.lastStateAt = this.now();
      // Fresh epoch: the interpolation buffer must not hold the previous
      // session's entities (push([]) alone would keep them until TTL).
      this.interp.reset();
      return;
    }
    if (kind === MSG.welcome4) {
      const welcome = decodeWelcome4(data);
      if (!welcome || welcome.generatorVersion !== GENERATOR_VERSION) {
        this.rejectReason = "upgrade-required";
        this.status = "rejected";
        this.socket?.close(1008, "upgrade-required");
        return;
      }
      this.myId = welcome.you;
      this.grid = null;
      this.predictor = new RealmPredictor(welcome);
      this.realmId = welcome.realmId;
      this.generatorVersion = welcome.generatorVersion;
      this.epoch = welcome.epoch;
      this.realmRevision = welcome.realmRevision;
      this.observeServerClock(welcome.serverTimeMs);
      this.seq = 0;
      this.frozen = false;
      this.worldStateReady = false;
      this.status = "connecting";
      this.online = 1;
      this.allOnline = 1;
      this.rejectReason = null;
      this.slowBackoffMs = SLOW_BACKOFF_START_MS;
      this.lastStateAt = this.now();
      this.interp.reset();
      return;
    }
    if (kind === MSG.regionState) {
      const message = decodeRegionState(data);
      const predictor = this.predictor;
      if (!message || !(predictor instanceof RealmPredictor)) return;
      this.observeServerClock(message.serverTimeMs);
      predictor.world.applyRegionState(message);
      this.realmRevision = Math.max(this.realmRevision, message.realmRevision);
      for (const row of message.rows) {
        if (row.landmarkFirstName) this.landmarkFirstName = row.landmarkFirstName;
      }
      if ((message.flags & REGION_STATE_FLAG_INITIAL) !== 0) {
        this.worldStateReady = true;
        this.status = "joined";
        this.lastStateAt = this.now();
      }
      return;
    }
    if (kind === MSG.playerProgress) {
      const message = decodePlayerProgress(data);
      if (!message || message.revision < this.progressRevision) return;
      this.progressRevision = message.revision;
      this.progressLandmarks.clear();
      for (const row of message.landmarks) this.progressLandmarks.add(`${row.rx},${row.ry}`);
      this.progressKeyList = [...this.progressLandmarks];
      return;
    }
    if (kind === MSG.roster) {
      const entries = decodeRoster(data);
      if (entries) {
        for (const e of entries) this.roster.set(e.id, e);
        this.onRoster?.(entries);
      }
      return;
    }
    if (kind === MSG.state) {
      const st = decodeState(data);
      const at = this.now();
      this.lastStateAt = at;
      // Reconcile the local player against the authoritative mover.
      if (this.predictor instanceof Predictor) {
        const me = st.entities.find((e) => e.id === this.myId);
        if (me) {
          const auth: AuthoritativeMover = {
            tx: me.tx, ty: me.ty,
            px: me.tx * 16 + me.px, py: me.ty * 16 + me.py,
            facing: me.dir, phase: me.phase, stepDir: me.stepDir,
            moving: me.moving, walking: me.walking,
          };
          if (this.predictor.reconcile(st.ackSeq, auth)) this.corrections++;
        }
      }
      // Remote entities (everyone but me) go to the interpolator.
      const remote = st.entities.filter((e) => e.id !== this.myId);
      // The server normally includes us in every AOI snapshot. Derive the
      // HUD count explicitly as local + remote so it cannot regress to the
      // remote-only interpolation count (and a missing/duplicate self row
      // cannot make the HUD omit or double-count the local player).
      const visibleOnline = (this.myId === 0 ? 0 : 1) + remote.length;
      // Population is an optional tail after the counted entity rows. Old
      // servers omit it, so retain the pre-extension AOI-derived behaviour
      // and use that same value for ALL. A new server can report a room
      // count larger than the AOI as well as a cross-room service count.
      this.online = st.roomOnline === null ? visibleOnline : Math.max(visibleOnline, st.roomOnline);
      this.allOnline = st.allOnline === null ? this.online : Math.max(this.online, st.allOnline);
      this.interp.push(remote, at);
      return;
    }
    if (kind === MSG.state4) {
      const st = decodeState4(data);
      if (!st) return;
      const at = this.now();
      this.lastStateAt = at;
      const predictor = this.predictor;
      if (predictor instanceof RealmPredictor) {
        const me = st.entities.find((e) => e.id === this.myId);
        if (me) {
          const auth: AuthoritativeMover = {
            tx: me.tx, ty: me.ty,
            px: me.tx * 16 + me.px, py: me.ty * 16 + me.py,
            facing: me.dir, phase: me.phase, stepDir: me.stepDir,
            moving: me.moving, walking: me.walking,
          };
          const result = predictor.reconcile(st.epoch, st.ackSeq, auth);
          if (result === "corrected") this.corrections++;
          else if (result === "rebase-required") {
            this.frozen = true;
            this.status = "frozen";
            this.socket?.close(1012, "prediction rebase");
            return;
          }
        }
      }
      const remote = st.entities.filter((e) => e.id !== this.myId);
      const visibleOnline = (this.myId === 0 ? 0 : 1) + remote.length;
      this.online = st.roomOnline === null ? visibleOnline : Math.max(visibleOnline, st.roomOnline);
      this.allOnline = st.allOnline === null ? this.online : Math.max(this.online, st.allOnline);
      this.interp.push(remote, at);
      return;
    }
    if (kind === MSG.pong) {
      this.rtt = Math.max(0, Math.round(this.now() - v.getUint32(5, true)));
      return;
    }
    // BYE: the interpolator drops the entity on its TTL.
  }

  /** One host frame. `buttons` is the held button mask; `hz` is the host
   *  rate. Returns the held mask actually applied (for the view's input
   *  display). Applies prediction, sends INPUTs, and runs the freeze and
   *  reconnect timers. */
  onFrame(buttons: number, hz: number, autoMask: number): number {
    const now = this.now();
    // Reconnect timer.
    if (!this.socket && this.reconnectAt > 0 && now >= this.reconnectAt) {
      this.reconnectAt = 0;
      if (!this.stopped) this.connect();
    }
    // Freeze: 2 s without a snapshot -> stop predicting, rejoin.
    if (this.predictor && !this.frozen && now - this.lastStateAt > FREEZE_MS) {
      this.frozen = true;
      this.status = "frozen";
      this.socket?.close(1000, "freeze-rejoin");
      return 0;
    }
    if (!this.predictor || this.frozen) return 0;
    if (this.predictor instanceof RealmPredictor && !this.worldStateReady) return 0;

    // The held mask: live d-pad wins, else the auto-walk driver.
    const live = buttons & DPAD;
    const mask = live !== 0 ? live : autoMask;

    // Predict one reference tick per INPUT as before, but pack every
    // BATCH_SIZE ticks into one INPUT_BATCH message (20 Hz wire rate).
    const ticks = Math.max(1, Math.round(60 / hz));
    for (let t = 0; t < ticks; t++) {
      const seq = this.predictor instanceof RealmPredictor
        ? this.predictor.pushInput(mask, this.estimatedServerTime(now))
        : this.predictor.pushInput(mask);
      this.pending.push({ seq, buttons: mask });
      if (this.pending.length >= BATCH_SIZE) this.flushPending();
    }

    // RTT probe.
    if (now - this.lastPingAt > PING_MS) {
      this.lastPingAt = now;
      this.pingId++;
      this.send(encodePing(this.pingId, Math.round(now) % 0x80000000));
    }
    return mask;
  }

  /** Send the accumulated reference ticks as one INPUT_BATCH. */
  private flushPending(): void {
    if (this.pending.length === 0) return;
    const firstSeq = this.pending[0]!.seq;
    const buttons = this.pending.map((p) => p.buttons);
    this.pending.length = 0;
    this.send(encodeInputBatch(firstSeq, buttons));
  }

  /** Send a text message (CREATE/LINKQ/...) on the live socket. */
  sendText(text: string): void {
    if (this.socket?.readyState === "open") this.socket.send(text);
  }

  /** Re-send the JOIN with the current credential (after CREATE, or a
   *  link-code redeem). */
  rejoin(): void {
    if (this.socket?.readyState === "open") {
      this.socket.send(JSON.stringify(this.joinMessage()));
    }
  }

  private send(buf: ArrayBuffer): void {
    if (this.socket?.readyState === "open") this.socket.send(buf);
  }

  private observeServerClock(serverTimeMs: number): void {
    const localNow = this.now();
    const projected = this.serverClockMs === 0
      ? 0
      : this.serverClockMs + Math.max(0, localNow - this.serverClockLocalMs);
    this.serverClockMs = Math.max(projected, serverTimeMs);
    this.serverClockLocalMs = localNow;
    if (this.predictor instanceof RealmPredictor) this.predictor.world.setWorldTime(this.serverClockMs);
  }

  /** Estimated realm wall clock derived from the latest server sample and a
   * local monotonic clock. Used by both prediction and RenderRing. */
  estimatedServerTime(localNow = this.now()): number {
    if (this.serverClockMs === 0) return 0;
    return this.serverClockMs + Math.max(0, localNow - this.serverClockLocalMs);
  }

  get progressCount(): number {
    return this.progressLandmarks.size;
  }

  get progressKeys(): readonly string[] {
    return this.progressKeyList;
  }

  get improvementLevel(): number {
    const predictor = this.predictor;
    if (!(predictor instanceof RealmPredictor)) return 0;
    const move = predictor.current.move;
    return predictor.world.regionState(regionOf(move.tx), regionOf(move.ty))?.improvementLevel ?? 0;
  }

  hud(): OnlineHud {
    const retryIn = this.socket || this.reconnectAt === 0 ? 0 : Math.max(0, Math.round(this.reconnectAt - this.now()));
    return {
      status: this.status,
      myId: this.myId,
      online: this.online,
      allOnline: this.allOnline,
      rtt: this.rtt,
      corrections: this.corrections,
      unacked: this.predictor?.unacked ?? 0,
      realmId: this.realmId,
      generatorVersion: this.generatorVersion,
      landmarkFirstName: this.landmarkFirstName,
      progressCount: this.progressCount,
      progressKeys: this.progressKeys,
      improvementLevel: this.improvementLevel,
      rejectReason: this.rejectReason,
      rejectText: this.rejectReason ? (REJECT_TEXT[this.rejectReason] ?? this.rejectReason) : null,
      retryIn,
    };
  }
}
