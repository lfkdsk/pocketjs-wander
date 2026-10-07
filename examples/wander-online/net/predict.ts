// examples/wander-online/net/predict.ts — client-side prediction and
// reconciliation, pure logic (no PocketJS imports; the view and the socket
// glue live in client.ts).
//
// The client predicts its own mover by folding every held input through the
// SAME reducer the server uses (net/world.ts builds the identical frozen
// window and session from the WELCOME seed), one reference tick per input.
// Each input gets a sequence number; the server acks the last sequence it
// applied in every snapshot (ackSeq). On a snapshot the client:
//
//   1. finds its saved predicted state at ackSeq,
//   2. compares that state's mover with the snapshot's authoritative mover,
//   3. on a mismatch, snaps the mover to the authoritative one and replays
//      every unacked input (seq > ackSeq) through the reducer — the standard
//      rollback-and-replay reconciliation — and counts a correction,
//   4. discards inputs and history at or below ackSeq.
//
// With a reliable, in-order transport (WebSocket) and no server underflow
// the prediction is exact, so corrections stay at zero. A correction is
// visible as a small position snap, which is the correct behaviour under
// packet delay or server stalls.

import { stepSession, type Session, type SessionState } from "../../../vendor/pocket-rpgkit/src/engine/session.ts";
import { startSession } from "../../../vendor/pocket-rpgkit/src/engine/session.ts";
import type { Dir4 } from "../../../vendor/pocket-rpgkit/src/engine/passability.ts";
import { buildArenaWorld, type ArenaWorld } from "./world.ts";

/** Saved predicted states, oldest first. Bounded so a long stall cannot
 *  grow memory without limit; a snapshot older than the oldest entry is
 *  skipped (the client will rejoin if that persists). */
export const HISTORY_CAP = 128;

export interface AuthoritativeMover {
  tx: number;
  ty: number;
  px: number;
  py: number;
  facing: number;
  phase: number;
  stepDir: number;
  moving: boolean;
  walking: boolean;
}

interface SavedFrame {
  seq: number;
  state: SessionState;
}

export class Predictor {
  readonly world: ArenaWorld;
  private readonly session: Session;
  private state: SessionState;
  private seq = 0;
  private history: SavedFrame[] = [];
  private inputs: { seq: number; buttons: number }[] = [];
  /** Total corrections since join (rollback-and-replay events). */
  corrections = 0;

  constructor(seed: number) {
    this.world = buildArenaWorld(seed);
    this.session = this.world.session;
    this.state = startSession(this.world.window.project, this.session);
  }

  /** Current predicted state (the mover the view renders). */
  get current(): SessionState {
    return this.state;
  }

  /** The saved predicted state at input sequence `seq`, or null when it has
   *  been trimmed from the ring. Tests use this to assert a rollback's
   *  replay rebuilt every unacked tick. */
  savedAt(seq: number): SessionState | null {
    return this.history.find((h) => h.seq === seq)?.state ?? null;
  }

  /** Last input sequence sent. */
  get lastSeq(): number {
    return this.seq;
  }

  /** Number of inputs the server has not yet acked (for HUD/stats). */
  get unacked(): number {
    return this.inputs.length;
  }

  /** Apply one reference tick of held input, locally and immediately:
   *  this is the prediction. Returns the input's sequence number. */
  pushInput(buttons: number): number {
    this.seq++;
    this.state = stepSession(this.session, this.state, { buttons });
    this.history.push({ seq: this.seq, state: this.state });
    this.inputs.push({ seq: this.seq, buttons });
    if (this.history.length > HISTORY_CAP) this.history.shift();
    if (this.inputs.length > HISTORY_CAP) this.inputs.shift();
    return this.seq;
  }

  /** Reconcile against an authoritative snapshot for the local player.
   *  Returns true when a correction (rollback + replay) happened. */
  reconcile(ackSeq: number, auth: AuthoritativeMover): boolean {
    if (ackSeq <= 0) return false;
    const idx = this.history.findIndex((h) => h.seq === ackSeq);
    if (idx < 0) return false; // ackSeq outside our window: nothing to do
    const base = this.history[idx]!.state;
    const pred = base.move;
    const match =
      pred.tx === auth.tx && pred.ty === auth.ty &&
      pred.px === auth.px && pred.py === auth.py &&
      pred.facing === auth.facing && pred.phase === auth.phase &&
      pred.stepDir === auth.stepDir && pred.moving === auth.moving &&
      pred.walking === auth.walking;
    // The server has applied everything up to ackSeq: those inputs are
    // confirmed and leave the unacked queue either way.
    const replay = this.inputs.filter((i) => i.seq > ackSeq);
    if (match) {
      this.inputs = replay;
      this.history = this.history.filter((h) => h.seq > ackSeq);
      return false;
    }
    // Correction: rebuild from the authoritative mover at ackSeq (the whole
    // movement state, so phase/walking/stepDir re-sync and the correction
    // does not cascade), then replay the unacked inputs in order.
    this.corrections++;
    let s: SessionState = {
      ...base,
      move: {
        ...pred,
        tx: auth.tx, ty: auth.ty, px: auth.px, py: auth.py,
        facing: auth.facing as Dir4, phase: auth.phase, stepDir: auth.stepDir as Dir4,
        moving: auth.moving, walking: auth.walking,
      },
    };
    const rebuilt: SavedFrame[] = [];
    for (const inp of replay) {
      s = stepSession(this.session, s, { buttons: inp.buttons });
      rebuilt.push({ seq: inp.seq, state: s });
    }
    this.state = s;
    this.inputs = replay;
    this.history = rebuilt;
    return true;
  }
}
