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
  decodeState,
  decodeWelcome,
  encodeInputBatch,
  encodePing,
} from "./protocol.ts";
import { Predictor, type AuthoritativeMover } from "./predict.ts";
import { Interpolator } from "./interpolate.ts";

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
};

/** Reconnect policy per close token. Unknown tokens use the normal path. */
function policyFor(reason: string): "slow" | "never" | "normal" {
  if (reason === "full" || reason === "rest") return "slow";
  if (reason === "rate" || reason === "ip" || reason === "origin") return "never";
  return "normal";
}

/** Opens one PocketSocket. Injected by tests so the client lifecycle can be
 *  exercised without a PocketJS host; production code uses openSocket. */
export type SocketFactory = (url: string, opts: { timeoutMs: number }) => PocketSocket;

export interface OnlineClientOpts {
  /** Clock for the reconnect/freeze timers (tests inject a virtual one). */
  now?: () => number;
  /** Socket factory (tests inject an in-process transport). */
  socketFactory?: SocketFactory;
}

export interface OnlineHud {
  status: ConnStatus;
  myId: number;
  online: number;
  rtt: number;
  corrections: number;
  unacked: number;
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
  status: ConnStatus = "connecting";
  myId = 0;
  online = 0;
  rtt = 0;
  corrections = 0;
  /** Classified window grid (WINDOW*WINDOW), null until WELCOME. */
  grid: Uint8Array | null = null;
  predictor: Predictor | null = null;
  readonly interp = new Interpolator();
  /** Last 1008 rejection token, if any (cleared on a successful join). */
  rejectReason: string | null = null;

  private socket: PocketSocket | null = null;
  private seq = 0;
  private lastStateAt = 0;
  private lastPingAt = 0;
  private pingId = 0;
  private backoffMs = 1000;
  private slowBackoffMs = SLOW_BACKOFF_START_MS;
  private reconnectAt = 0;
  private frozen = false;
  private stopped = false;
  /** Predicted ticks waiting to be packed into the next INPUT_BATCH. */
  private pending: { seq: number; buttons: number }[] = [];
  private now: () => number;
  private readonly socketFactory: SocketFactory;

  constructor(url: string, name: string, color: number, opts: OnlineClientOpts = {}) {
    this.url = url;
    this.name = name;
    this.color = color & 0x0f;
    this.now = opts.now ?? (() => (globalThis.performance ? globalThis.performance.now() : Date.now()));
    this.socketFactory = opts.socketFactory ?? ((u, o) => openSocket(u, o));
    this.connect();
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
      // v:2 marks a batching client; v1 servers ignore the extra field.
      sock.send(JSON.stringify({ type: "join", name: this.name, color: this.color, v: 2 }));
    };
    sock.onMessage = (data) => this.onMessage(data);
    sock.onClose = (ev) => {
      this.socket = null;
      this.predictor = null;
      this.grid = null;
      this.myId = 0;
      this.online = 0;
      this.pending.length = 0;
      // Drop the previous epoch's remote entities so they cannot render
      // (or interpolate against the next epoch's snapshots) while away.
      this.interp.reset();
      this.handleClose(ev?.code ?? 0, ev?.reason ?? "");
    };
    sock.onError = () => { /* onClose follows; the reconnect lives there */ };
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
    if (typeof data === "string") return; // JOIN is the only text message, client-bound
    const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const kind = v.getUint8(0);
    if (kind === MSG.welcome) {
      const w = decodeWelcome(data);
      this.myId = w.you;
      this.grid = w.grid;
      this.predictor = new Predictor(w.seed);
      this.seq = 0;
      this.frozen = false;
      this.status = "joined";
      this.rejectReason = null;
      this.slowBackoffMs = SLOW_BACKOFF_START_MS;
      this.lastStateAt = this.now();
      // Fresh epoch: the interpolation buffer must not hold the previous
      // session's entities (push([]) alone would keep them until TTL).
      this.interp.reset();
      return;
    }
    if (kind === MSG.state) {
      const st = decodeState(data);
      const at = this.now();
      this.lastStateAt = at;
      this.online = st.entities.length;
      // Reconcile the local player against the authoritative mover.
      if (this.predictor) {
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

    // The held mask: live d-pad wins, else the auto-walk driver.
    const live = buttons & DPAD;
    const mask = live !== 0 ? live : autoMask;

    // Predict one reference tick per INPUT as before, but pack every
    // BATCH_SIZE ticks into one INPUT_BATCH message (20 Hz wire rate).
    const ticks = Math.max(1, Math.round(60 / hz));
    for (let t = 0; t < ticks; t++) {
      const seq = this.predictor.pushInput(mask);
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

  private send(buf: ArrayBuffer): void {
    if (this.socket?.readyState === "open") this.socket.send(buf);
  }

  hud(): OnlineHud {
    const retryIn = this.socket || this.reconnectAt === 0 ? 0 : Math.max(0, Math.round(this.reconnectAt - this.now()));
    return {
      status: this.status,
      myId: this.myId,
      online: this.online,
      rtt: this.rtt,
      corrections: this.corrections,
      unacked: this.predictor?.unacked ?? 0,
      rejectReason: this.rejectReason,
      rejectText: this.rejectReason ? (REJECT_TEXT[this.rejectReason] ?? this.rejectReason) : null,
      retryIn,
    };
  }
}
