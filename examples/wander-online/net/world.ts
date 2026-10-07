// examples/wander-online/net/world.ts — the frozen wander window both sides
// predict through.
//
// The server's Arena and the client's predictor each build the SAME world
// from the WELCOME seed: a WanderSim in manual mode, frozen at its boot
// growth tick. The construction is host-rate independent (the session is
// always created at MOTION_HZ; the window build and the driver do not read
// the configured hz), so a 20 Hz server and a 60 Hz client get byte-identical
// window projects and sessions. That shared reducer is what makes
// prediction free: the client folds the same inputs through the same pure
// stepSession and gets the same mover the server will.

import { WanderSim } from "../../wander/wander-sim.ts";
import { WINDOW } from "../../wander/window.ts";
import type { Session } from "../../../vendor/pocket-rpgkit/src/engine/session.ts";
import type { WindowBuild } from "../../wander/window.ts";

export interface ArenaWorld {
  readonly seed: number;
  /** The frozen window (boot growth tick). */
  readonly window: WindowBuild;
  /** A 60 Hz session on the frozen window. */
  readonly session: Session;
  readonly x0: number;
  readonly y0: number;
}

export function buildArenaWorld(seed: number): ArenaWorld {
  const sim = new WanderSim({
    seed: seed >>> 0,
    hz: 60,
    viewW: WINDOW * 16,
    viewH: WINDOW * 16,
    manual: true,
  });
  return { seed: sim.seed, window: sim.window, session: sim.session, x0: sim.window.x0, y0: sim.window.y0 };
}
