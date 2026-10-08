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
import { startSession, type Session, type SessionState } from "../../../vendor/pocket-rpgkit/src/engine/session.ts";
import type { WindowBuild } from "../../wander/window.ts";
import type { Residency } from "../../wander/residency.ts";

export interface ArenaWorld {
  readonly seed: number;
  /** The frozen window (boot growth tick). */
  readonly window: WindowBuild;
  /** A 60 Hz session on the frozen window. */
  readonly session: Session;
  readonly x0: number;
  readonly y0: number;
  /** The residency the window was generated from. The world is frozen, so
   *  the render ring reads its chunks directly (no streaming). */
  readonly res: Residency;
  /** The sim clock at the freeze point. The ring's growth ticks are read
   *  against this fixed value, so the frozen world never ages. */
  readonly bootNow: number;
  /** Host-written birth switches at the shared arena's frozen age. */
  readonly initialSwitches: Readonly<Record<string, boolean>>;
}

/** Five seconds grows the starting settlement through its resident births;
 * the arena then freezes terrain and actor availability at this exact tick. */
export const ARENA_FREEZE_TICKS = 300;

export function buildArenaWorld(seed: number): ArenaWorld {
  const sim = new WanderSim({
    seed: seed >>> 0,
    hz: 60,
    viewW: WINDOW * 16,
    viewH: WINDOW * 16,
    manual: true,
  });
  for (let i = 0; i < ARENA_FREEZE_TICKS; i++) sim.step(0);
  return {
    seed: sim.seed,
    window: sim.window,
    session: sim.session,
    x0: sim.window.x0,
    y0: sim.window.y0,
    res: sim.res,
    bootNow: sim.now,
    initialSwitches: { ...sim.state.interp.sw.switches },
  };
}

/** Start one player from the same mature frozen state on client and server.
 * Terrain/passability live in the shared Session; actor birth switches live
 * in each player's reducer state and therefore must be seeded together. */
export function startArenaState(world: ArenaWorld): SessionState {
  const state = startSession(world.window.project, world.session);
  const sw = {
    ...state.interp.sw,
    switches: { ...state.interp.sw.switches, ...world.initialSwitches },
  };
  return { ...state, sw, interp: { ...state.interp, sw } };
}
