// examples/wander-online/net/npc.ts — residents of a shared realm town as a
// pure function of the realm clock.
//
// Single-player villagers are engine characters whose patrol routes are
// stepped by the session reducer and blocked by the player. In the realm
// nobody owns that reducer: every client and the server derive each
// resident's pose from (plan, region discovery time, server time) alone, so
// the pose needs no wire traffic and no storage. Residents never block a
// mover; they are talked to, not bumped into.

import { COMPLETE } from "../../wander/chunk.ts";
import { GROWTH_TICK_FRAMES, type RegionPlan, type VillagerPlan } from "../../wander/region.ts";
import type { MoveStep } from "../../../vendor/pocket-rpgkit/src/engine/types.ts";
import type { Dir4 } from "../../../vendor/pocket-rpgkit/src/engine/passability.ts";
import type { MovementState } from "../../../vendor/pocket-rpgkit/src/engine/movement.ts";

const TILE = 16;
/** Reference ticks per route step at walking speed (16 px at 2 px/tick); a
 *  `wait` step lasts the same, as in the engine's route runner. */
export const NPC_STEP_TICKS = 8;
const WALK_PX = TILE / NPC_STEP_TICKS;
const REFERENCE_HZ = 60;

const DX: readonly number[] = [0, -1, 0, 1]; // down, left, up, right
const DY: readonly number[] = [1, 0, -1, 0];

function stepDir(step: MoveStep): Dir4 | -1 {
  switch (step) {
    case "moveDown": return 0;
    case "moveLeft": return 1;
    case "moveUp": return 2;
    case "moveRight": return 3;
    default: return -1;
  }
}

export interface NpcPose {
  id: string;
  rx: number;
  ry: number;
  n: number;
  house: number;
  tx: number;
  ty: number;
  px: number;
  py: number;
  facing: Dir4;
  /** 0..NPC_STEP_TICKS-1 within the current step (0 while waiting). */
  phase: number;
}

/** Reference ticks elapsed since a region's shared discovery. */
export function ticksSinceDiscovery(discoveredAtMs: number, nowMs: number): number {
  return Math.floor(Math.max(0, nowMs - discoveredAtMs) * REFERENCE_HZ / 1000);
}

/** The growth tick a region reached, capped like the shared projection. */
export function growthTickOf(ticks: number): number {
  return Math.min(COMPLETE, Math.floor(ticks / GROWTH_TICK_FRAMES));
}

/** A resident's pose `ticks` reference ticks after its region was
 *  discovered, or null while it is not born yet. Pure. */
export function villagerPoseAt(v: VillagerPlan, ticks: number): NpcPose | null {
  if (growthTickOf(ticks) < v.born) return null;
  const route = v.route;
  const base: NpcPose = { id: v.id, rx: 0, ry: 0, n: 0, house: v.house, tx: v.x, ty: v.y, px: v.x * TILE, py: v.y * TILE, facing: 0, phase: 0 };
  if (route.length === 0) return base;
  const elapsed = Math.max(0, ticks - v.born * GROWTH_TICK_FRAMES);
  const period = route.length * NPC_STEP_TICKS;
  const k = elapsed % period;
  const index = Math.floor(k / NPC_STEP_TICKS);
  const sub = k % NPC_STEP_TICKS;
  let x = v.x, y = v.y;
  let facing: Dir4 = 0;
  for (let i = 0; i < index; i++) {
    const d = stepDir(route[i]!);
    if (d === -1) continue;
    x += DX[d]!; y += DY[d]!; facing = d;
  }
  const d = stepDir(route[index]!);
  if (d === -1) {
    return { ...base, tx: x, ty: y, px: x * TILE, py: y * TILE, facing, phase: 0 };
  }
  return { ...base, tx: x, ty: y, px: x * TILE + DX[d]! * WALK_PX * sub, py: y * TILE + DY[d]! * WALK_PX * sub, facing: d, phase: sub };
}

/** Every born resident of a town plan at `ticks` since discovery. */
export function townResidentsAt(plan: RegionPlan, ticks: number): NpcPose[] {
  const out: NpcPose[] = [];
  if (plan.empty || !plan.hub.town) return out;
  for (let n = 0; n < plan.villagers.length; n++) {
    const pose = villagerPoseAt(plan.villagers[n]!, ticks);
    if (pose) out.push({ ...pose, rx: plan.rx, ry: plan.ry, n });
  }
  return out;
}

/** The tile a mover's action targets: the cell in front of it. */
export function frontTile(move: Pick<MovementState, "tx" | "ty" | "facing">): { x: number; y: number } {
  return { x: move.tx + DX[move.facing]!, y: move.ty + DY[move.facing]! };
}

/** The resident a mover can talk to: standing on the tile in front of the
 *  mover or on its own tile, exactly like the engine's action trigger. */
export function talkTarget(move: Pick<MovementState, "tx" | "ty" | "facing">, residents: readonly NpcPose[]): NpcPose | null {
  const front = frontTile(move);
  for (const r of residents) {
    if ((r.tx === front.x && r.ty === front.y) || (r.tx === move.tx && r.ty === move.ty)) return r;
  }
  return null;
}

/** Chebyshev distance from a mover to a resident, for the server's tolerant
 *  talk validation (a client judges adjacency at its estimated clock). */
export function residentDistance(move: Pick<MovementState, "tx" | "ty">, r: NpcPose): number {
  return Math.max(Math.abs(r.tx - move.tx), Math.abs(r.ty - move.ty));
}

/** The notice board's tile (hub + (1,1)) and the growth tick it is born at. */
export function plaqueOf(plan: RegionPlan): { x: number; y: number; born: number } | null {
  if (plan.empty || !plan.hub.town) return null;
  const x = plan.hub.x + 1, y = plan.hub.y + 1;
  const li = (y - plan.y0) * 96 + (x - plan.x0);
  const F_BLOCK = 2;
  const born = (plan.flags![li]! & F_BLOCK) ? plan.born![li]! : 0;
  return { x, y, born };
}
