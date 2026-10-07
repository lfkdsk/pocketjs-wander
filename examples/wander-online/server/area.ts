// examples/wander-online/server/area.ts — a frozen wander window as a
// shared multiplayer arena, with per-player input queues.
//
// The area server owns ONE authoritative copy of the kit's reducer: a
// wander window (96x96 tiles, built by the same pure world generation the
// wander example uses) frozen at its boot growth tick. Every connected
// player is a plain SessionState on that one Session. Clients send one
// INPUT per predicted reference tick, each carrying a sequence number; the
// server queues them and consumes ONE per reference tick (holding the last
// mask on underflow), so the server's fold of a player's input sequence is
// exactly the client's prediction of it. The server advances at 20 Hz,
// folding 3 reference ticks per frame (motionTicksPerFrame(20), the same
// fold the kit's hosts use). Nothing here reads a clock: a recorded input
// tape replays byte-identically.

import { startSession, stepSession, type SessionState } from "../../../vendor/pocket-rpgkit/src/engine/session.ts";
import { motionTicksPerFrame } from "../../../vendor/pocket-rpgkit/src/engine/motion-clock.ts";
import { WINDOW } from "../../wander/window.ts";
import { buildArenaWorld, type ArenaWorld } from "../net/world.ts";

/** Per-player input queue bound. The client keeps at most 128 unacked
 *  inputs; a queue this deep means the server is badly stalled. */
export const INPUT_QUEUE_CAP = 256;

export interface QueuedInput {
  seq: number;
  buttons: number;
}

export interface ArenaPlayer {
  id: number;
  name: string;
  color: number;
  state: SessionState;
  /** Held d-pad mask, the only thing clients may change. */
  buttons: number;
  /** Last INPUT sequence applied to this player (the ack watermark). */
  lastSeq: number;
  /** Pending inputs, in send order, consumed one per reference tick. */
  queue: QueuedInput[];
  /** Inputs refused because the queue was full (load signal). */
  dropped: number;
}

export interface ArenaConfig {
  seed: number;
  hz: number;
}

export class Arena {
  readonly seed: number;
  readonly hz: number;
  /** Reference (60 Hz) ticks folded per host frame: MOTION_HZ / hz, so a
   *  20 Hz server frame advances 3 reference ticks — the same fold the
   *  kit's hosts use (motion-clock.ts). */
  readonly ticksPerFrame: number;
  /** Total reference ticks advanced since boot (stepRefTick calls). */
  refTicks = 0;
  readonly world: ArenaWorld;
  readonly session: ArenaWorld["session"];
  readonly players = new Map<number, ArenaPlayer>();
  frame = 0;
  private nextId = 1;

  constructor(cfg: ArenaConfig) {
    this.seed = cfg.seed >>> 0;
    this.hz = cfg.hz;
    this.ticksPerFrame = motionTicksPerFrame(this.hz);
    this.world = buildArenaWorld(this.seed);
    this.session = this.world.session;
  }

  get x0(): number {
    return this.world.x0;
  }
  get y0(): number {
    return this.world.y0;
  }

  add(name: string, color: number): ArenaPlayer {
    const id = this.nextId++;
    const state = startSession(this.world.window.project, this.session);
    const p: ArenaPlayer = { id, name, color, state, buttons: 0, lastSeq: 0, queue: [], dropped: 0 };
    this.players.set(id, p);
    return p;
  }

  remove(id: number): void {
    this.players.delete(id);
  }

  /** Queue a client INPUT. Stale or duplicate seqs (already applied) are
   *  ignored; a full queue drops the newest input and counts it. */
  pushInput(player: ArenaPlayer, seq: number, buttons: number): void {
    if (seq <= player.lastSeq) return;
    const last = player.queue[player.queue.length - 1];
    if (last && seq <= last.seq) return;
    if (player.queue.length >= INPUT_QUEUE_CAP) {
      player.dropped++;
      return;
    }
    player.queue.push({ seq, buttons });
  }

  /** Advance every player by one 60 Hz reference tick, consuming one queued
   *  input each (holding the last mask when the queue is empty). Public so
   *  replay tooling and the parity test can drive the arena tick-by-tick. */
  stepRefTick(): void {
    for (const p of this.players.values()) {
      const inp = p.queue.shift();
      if (inp) {
        p.buttons = inp.buttons;
        p.lastSeq = inp.seq;
      }
      p.state = stepSession(this.session, p.state, { buttons: p.buttons });
    }
    this.refTicks++;
  }

  /** One host frame: fold ticksPerFrame reference ticks (3 at 20 Hz),
   *  matching the kit's multi-hz contract: 60 reference ticks per virtual
   *  second at every host rate. */
  step(): void {
    for (let t = 0; t < this.ticksPerFrame; t++) this.stepRefTick();
    this.frame++;
  }

  /** Tile index for aoi(): head[cell] -> first player slot, next[slot] ->
   *  following slot (-1 ends). Rebuilt by indexPlayers() once per broadcast. */
  private head = new Int32Array(WINDOW * WINDOW).fill(-1);
  private next = new Int32Array(0);
  private slots: ArenaPlayer[] = [];

  /** Bucket every player by tile; call once before a batch of aoi(). */
  indexPlayers(): void {
    this.head.fill(-1);
    this.slots = [...this.players.values()];
    if (this.next.length < this.slots.length) this.next = new Int32Array(this.slots.length * 2);
    for (let i = 0; i < this.slots.length; i++) {
      const m = this.slots[i]!.state.move;
      if (m.tx < 0 || m.ty < 0 || m.tx >= WINDOW || m.ty >= WINDOW) continue;
      const cell = m.ty * WINDOW + m.tx;
      this.next[i] = this.head[cell]!;
      this.head[cell] = i;
    }
  }

  /** Players whose Chebyshev tile distance from p is <= radius: p first,
   *  then nearest first (ties by ascending id), at most `cap` in total.
   *  The wire caps a snapshot at MAX_AOI entities, so this order decides
   *  who survives the cap. Scans tile rings outward over the index built
   *  by indexPlayers() and stops at the first full ring past the cap, so
   *  a crowd costs O(cap) per viewer instead of a sort of everyone. */
  aoi(p: ArenaPlayer, radius: number, cap = Infinity): ArenaPlayer[] {
    const { tx, ty } = p.state.move;
    const out: ArenaPlayer[] = [p];
    const ring: ArenaPlayer[] = [];
    const visit = (x: number, y: number): void => {
      if (x < 0 || y < 0 || x >= WINDOW || y >= WINDOW) return;
      for (let i = this.head[y * WINDOW + x]!; i >= 0; i = this.next[i]!) {
        const q = this.slots[i]!;
        if (q.id !== p.id) ring.push(q);
      }
    };
    for (let d = 0; d <= radius && out.length < cap; d++) {
      ring.length = 0;
      if (d === 0) visit(tx, ty);
      else {
        for (let x = tx - d; x <= tx + d; x++) {
          visit(x, ty - d);
          visit(x, ty + d);
        }
        for (let y = ty - d + 1; y <= ty + d - 1; y++) {
          visit(tx - d, y);
          visit(tx + d, y);
        }
      }
      ring.sort((a, b) => a.id - b.id);
      for (const q of ring) {
        if (out.length >= cap) break;
        out.push(q);
      }
    }
    return out;
  }

  /** Stable semantic digest of one player's mover (determinism tests). */
  digest(id: number): string {
    const p = this.players.get(id);
    if (!p) return "gone";
    const m = p.state.move;
    return `${this.frame}:${m.tx},${m.ty},${m.px},${m.py},${m.facing},${m.moving}`;
  }
}
