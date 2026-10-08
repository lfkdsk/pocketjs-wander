// v4 client prediction over signed world coordinates.
//
// The history contains only mover state. Static collision is reproduced
// locally from the pinned seed/generator, while every fresh WELCOME creates
// a new epoch and therefore a new cache and rollback ring.

import type { MovementState } from "../../../vendor/pocket-rpgkit/src/engine/movement.ts";
import type { Dir4 } from "../../../vendor/pocket-rpgkit/src/engine/passability.ts";
import type { Welcome4 } from "./protocol.ts";
import {
  GENERATOR_VERSION,
  RealmWorld,
  type RealmState,
} from "./realm-world.ts";
import type { AuthoritativeMover } from "./predict.ts";

export const REALM_HISTORY_CAP = 128;

interface SavedFrame {
  seq: number;
  state: RealmState;
}

export type ReconcileResult = "matched" | "corrected" | "rebase-required";

function moverFromWelcome(welcome: Welcome4): MovementState {
  const m = welcome.mover;
  return {
    tx: m.tx,
    ty: m.ty,
    px: m.tx * 16 + m.px,
    py: m.ty * 16 + m.py,
    facing: m.dir as Dir4,
    phase: m.phase,
    stepDir: m.stepDir as Dir4,
    moving: m.moving,
    walking: m.walking,
  };
}

function sameMover(a: MovementState, b: AuthoritativeMover): boolean {
  return a.tx === b.tx && a.ty === b.ty && a.px === b.px && a.py === b.py &&
    a.facing === b.facing && a.phase === b.phase && a.stepDir === b.stepDir &&
    a.moving === b.moving && a.walking === b.walking;
}

function replaceMover(state: RealmState, auth: AuthoritativeMover): RealmState {
  return {
    ...state,
    move: {
      tx: auth.tx,
      ty: auth.ty,
      px: auth.px,
      py: auth.py,
      facing: auth.facing as Dir4,
      phase: auth.phase,
      stepDir: auth.stepDir as Dir4,
      moving: auth.moving,
      walking: auth.walking,
    },
  };
}

export class RealmPredictor {
  readonly world: RealmWorld;
  readonly epoch: number;
  readonly realmId: string;
  private state: RealmState;
  private seq = 0;
  private lastAck = 0;
  private history: SavedFrame[] = [];
  private inputs: { seq: number; buttons: number }[] = [];
  corrections = 0;

  constructor(welcome: Welcome4) {
    if (welcome.generatorVersion !== GENERATOR_VERSION) {
      throw new Error(`unsupported world generator ${welcome.generatorVersion}`);
    }
    this.epoch = welcome.epoch >>> 0;
    this.realmId = welcome.realmId;
    this.world = new RealmWorld(welcome.seed);
    this.state = { move: moverFromWelcome(welcome), chars: { chars: {} } };
    this.world.prime([{ x: this.state.move.tx, y: this.state.move.ty }], 0);
  }

  get current(): RealmState {
    return this.state;
  }

  get lastSeq(): number {
    return this.seq;
  }

  get unacked(): number {
    return this.inputs.length;
  }

  savedAt(seq: number): RealmState | null {
    return this.history.find((h) => h.seq === seq)?.state ?? null;
  }

  pushInput(buttons: number): number {
    this.seq++;
    this.state = this.world.step(this.state, buttons, this.seq);
    this.history.push({ seq: this.seq, state: this.state });
    this.inputs.push({ seq: this.seq, buttons });
    if (this.history.length > REALM_HISTORY_CAP) this.history.shift();
    if (this.inputs.length > REALM_HISTORY_CAP) this.inputs.shift();
    return this.seq;
  }

  reconcile(epoch: number, ackSeq: number, auth: AuthoritativeMover): ReconcileResult {
    if ((epoch >>> 0) !== this.epoch) return "rebase-required";
    if (ackSeq <= this.lastAck || ackSeq <= 0) return "matched";
    const idx = this.history.findIndex((h) => h.seq === ackSeq);
    if (idx < 0) return "rebase-required";
    this.lastAck = ackSeq;
    const base = this.history[idx]!.state;
    const replay = this.inputs.filter((i) => i.seq > ackSeq);
    if (sameMover(base.move, auth)) {
      this.inputs = replay;
      this.history = this.history.filter((h) => h.seq > ackSeq);
      return "matched";
    }

    this.corrections++;
    let state = replaceMover(base, auth);
    const rebuilt: SavedFrame[] = [];
    for (const input of replay) {
      state = this.world.step(state, input.buttons, input.seq);
      rebuilt.push({ seq: input.seq, state });
    }
    this.state = state;
    this.inputs = replay;
    this.history = rebuilt;
    return "corrected";
  }
}
