// examples/wander/landmarks.ts — rare places hidden in the world.
//
// A landmark is a pure function of (seed, region): a roll decides whether
// the region holds one (always for pure-wilderness regions, LANDMARK_CHANCE
// otherwise), its kind, and an ordered list of candidate anchor cells. region.ts tries the candidates against the grown plan (roads and
// houses already occupy cells) and stores the placed landmark in the plan;
// the sim discovers it when its centre enters the viewport, and the view
// draws it from the chunk data like any other developed cell. Nothing here
// stores state: the roll is recomputed by anyone who needs it.
//
// Kinds use only tiles already in the wander asset set (WANDER_UPPER /
// WANDER_GROUND / WANDER_STAMPS), so no new art ships with this feature.

import { STAMPS } from "../grow/grow-stamps.ts";
import { GROW_TILE as T, REGION, growHash, regionGates, regionHub, regionOf } from "./world.ts";

export const LANDMARK_CHANCE = 0.6;
/** Kinds, indexed by the roll. */
export const LANDMARK_KINDS = ["STANDING STONES", "RUINED ARCH", "STRANGE TREE", "COLD SPRING", "GIANT BOULDER", "OLD CAMP"] as const;

export interface LandmarkCell {
  dx: number;
  dy: number;
  tile: number;
  /** 1 = upper prop, 0 = developed ground (spring water). */
  upper: boolean;
  block: boolean;
}

export interface Landmark {
  rx: number;
  ry: number;
  /** World tile of the anchor (top-left of the footprint). */
  x: number;
  y: number;
  /** World tile of the footprint centre (what the driver heads for and the
   *  viewport discovery test measures). */
  cx: number;
  cy: number;
  kind: number;
  kindName: string;
  cells: LandmarkCell[];
  /** Growth tick the first cell is born at (0: visible once the region is
   *  discovered, ahead of the town). */
  bornTick: number;
}

const R = T.ROCK, F = T.FLOWER_PROP;

/** A stamp's cells as landmark cells (the base row blocks). */
function stampCells(key: string, blockBase: boolean): LandmarkCell[] {
  const st = STAMPS[key]!;
  const cells: LandmarkCell[] = [];
  for (let dy = 0; dy < st.h; dy++) {
    for (let dx = 0; dx < st.w; dx++) {
      cells.push({ dx, dy, tile: st.base + dy * st.w + dx, upper: true, block: blockBase && dy === st.h - 1 });
    }
  }
  return cells;
}

/** Footprint of each kind (anchor-relative cells). Every kind fills at least
 *  a 3 x 3 box, has at least one blocking cell, and leaves a walkable ring
 *  (region.ts enforces the ring when it places the landmark). */
function footprint(kind: number): LandmarkCell[] {
  switch (kind) {
    case 0: // STANDING STONES: a dolmen — two uprights, a lintel, an altar.
      return [[1, 0, R, 1, 1], [0, 1, R, 1, 1], [2, 1, R, 1, 1], [1, 1, R, 1, 1], [1, 2, R, 1, 1]]
        .map(([dx, dy, tile, upper, block]) => ({ dx, dy, tile, upper: upper === 1, block: block === 1 }));
    case 1: // RUINED ARCH: the collapsed walls of someone who was here first.
      return [[0, 0, T.WALL_L, 1, 1], [1, 0, T.ROOF_M, 1, 1], [2, 0, T.WALL_R, 1, 1], [0, 1, R, 1, 1], [2, 1, R, 1, 1], [1, 2, R, 1, 1]]
        .map(([dx, dy, tile, upper, block]) => ({ dx, dy, tile, upper: upper === 1, block: block === 1 }));
    case 2: // STRANGE TREE: one tree in a ring of flowers.
      return [[1, 1, T.TREE, 1, 1], [0, 0, F, 1, 0], [2, 0, F, 1, 0], [0, 2, F, 1, 0], [2, 2, F, 1, 0]]
        .map(([dx, dy, tile, upper, block]) => ({ dx, dy, tile, upper: upper === 1, block: block === 1 }));
    case 3: // COLD SPRING: water and oasis ground ringed with stones.
      return [
        [1, 1, T.WATER, 0, 0], [0, 1, T.OASIS, 0, 0], [2, 1, T.OASIS, 0, 0], [1, 0, T.OASIS, 0, 0], [1, 2, T.OASIS, 0, 0],
        [0, 0, R, 1, 1], [2, 0, R, 1, 1], [0, 2, R, 1, 1], [2, 2, R, 1, 1],
      ].map(([dx, dy, tile, upper, block]) => ({ dx, dy, tile, upper: upper === 1, block: block === 1 }));
    case 4: { // GIANT BOULDER: a two-cell erratic left by the ice, with rubble.
      const cells = stampCells("boulder-grey", true);
      // Rubble rounds the footprint out to 3 x 3.
      for (const [dx, dy] of [[2, 0], [2, 1], [2, 2], [0, 2], [1, 2]] as const) {
        cells.push({ dx, dy, tile: R, upper: true, block: true });
      }
      return cells;
    }
    default: { // OLD CAMP: an abandoned tent and a log pile.
      return [[0, 0, T.TENT_L, 1, 1], [1, 0, T.TENT_M, 1, 1], [2, 0, T.TENT_R, 1, 1], [1, 2, T.LOGS, 1, 1], [0, 2, F, 1, 0], [2, 2, F, 1, 0]]
        .map(([dx, dy, tile, upper, block]) => ({ dx, dy, tile, upper: upper === 1, block: block === 1 }));
    }
  }
}

export function footprintSize(cells: LandmarkCell[]): { w: number; h: number } {
  let w = 0, h = 0;
  for (const c of cells) { w = Math.max(w, c.dx + 1); h = Math.max(h, c.dy + 1); }
  return { w, h };
}

export interface LandmarkRoll {
  kind: number;
  kindName: string;
  cells: LandmarkCell[];
  /** Candidate anchors (world tiles) in preference order. */
  candidates: { x: number; y: number }[];
}

/** The region's landmark roll: what kind and where it could stand. The
 *  plan records which candidate actually fit. Pure in (seed, rx, ry). A
 *  pure-wilderness region (no town, no gate road) always rolls a landmark —
 *  wild country is where the rare places are — so the 25 x 25 census
 *  guarantees a healthy stock of wilderness landmarks. */
export function landmarkRoll(seed: number, rx: number, ry: number): LandmarkRoll | null {
  const h = growHash(seed, rx, ry, 0x1a4d);
  if (!isWilderness(seed, rx, ry) && (h % 10007) / 10007 >= LANDMARK_CHANCE) return null;
  const kind = (h >>> 8) % LANDMARK_KINDS.length;
  const cells = footprint(kind);
  const { w, h: fh } = footprintSize(cells);
  const hub = regionHub(seed, rx, ry);
  const candidates: { x: number; y: number }[] = [];
  const x0 = rx * REGION, y0 = ry * REGION;
  for (let n = 0; n < 8; n++) {
    const ch = growHash(seed, rx * 31 + n, ry, 0x1a5e);
    const x = x0 + 10 + (ch % (REGION - 20 - w));
    const y = y0 + 10 + ((ch >>> 10) % (REGION - 20 - fh));
    const dx = x + (w >> 1) - hub.x, dy = y + (fh >> 1) - hub.y;
    if (hub.town && dx * dx + dy * dy < 24 * 24) continue; // keep clear of the town
    candidates.push({ x, y });
  }
  if (!candidates.length) return null;
  return { kind, kindName: LANDMARK_KINDS[kind]!, cells, candidates };
}

/** Whether a region holds no town and no active gate (a pure wilderness
 *  region: the only kind whose landmark placement is fixed without the
 *  grown plan). */
export function isWilderness(seed: number, rx: number, ry: number): boolean {
  if (regionHub(seed, rx, ry).town) return false;
  const g = regionGates(seed, rx, ry);
  return !(g.w.active || g.e.active || g.n.active || g.s.active);
}

/**
 * The landmark a region's roll produced, as a pure function of (seed, rx,
 * ry): the kind and the first candidate anchor. For a wilderness region
 * (no town, no gates) this is exactly where the plan places it, since every
 * cell is free. For a developed region the plan may place it at a later
 * candidate (the first can overlap a road or house) — read `plan.landmark`
 * (or the sim's placedLandmark()) for the placed position. Returns null
 * when the region rolled no landmark.
 */
export function landmarkFor(seed: number, rx: number, ry: number): Landmark | null {
  const roll = landmarkRoll(seed, rx, ry);
  if (!roll) return null;
  const c = roll.candidates[0]!;
  const { w, h } = footprintSize(roll.cells);
  return {
    rx, ry, x: c.x, y: c.y, cx: c.x + (w >> 1), cy: c.y + (h >> 1),
    kind: roll.kind, kindName: roll.kindName, cells: roll.cells, bornTick: 0,
  };
}

/** A cell on the landmark's walkable ring (the 1-cell border the placement
 *  rule keeps clear of developed blocks), the one nearest (px, py). The
 *  driver heads for this instead of the centre: the centre can sit inside
 *  the landmark's own blocking cells and be unreachable, which would stall
 *  the walker in a plan-fail loop. */
export function landmarkApproach(lm: Landmark, px: number, py: number): { x: number; y: number } {
  let minDx = Infinity, maxDx = -Infinity, minDy = Infinity, maxDy = -Infinity;
  for (const c of lm.cells) {
    if (c.dx < minDx) minDx = c.dx;
    if (c.dx > maxDx) maxDx = c.dx;
    if (c.dy < minDy) minDy = c.dy;
    if (c.dy > maxDy) maxDy = c.dy;
  }
  const x0 = lm.x + minDx - 1, y0 = lm.y + minDy - 1, x1 = lm.x + maxDx + 1, y1 = lm.y + maxDy + 1;
  let bx = x0, by = y0, bd = Infinity;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (x >= lm.x + minDx && x <= lm.x + maxDx && y >= lm.y + minDy && y <= lm.y + maxDy) continue;
      const d = Math.abs(x - px) + Math.abs(y - py);
      if (d < bd) { bd = d; bx = x; by = y; }
    }
  }
  return { x: bx, y: by };
}

/** The nearest placed, undiscovered landmark to (px, py) within `radius`
 *  regions (Manhattan distance to the centre), or null. Pure in its
 *  arguments: the HUD rumor and the driver's landmark legs both pick
 *  through this, so the auto-walker always hunts the landmark the rumor
 *  points at. `placed` returns a region's placed landmark (plan placement
 *  when generated, exact pure placement for wilderness, null otherwise);
 *  `isFound` reports a region already in the travel log. */
export function nearestLandmark(
  px: number,
  py: number,
  radius: number,
  placed: (rx: number, ry: number) => Landmark | null,
  isFound: (rx: number, ry: number) => boolean,
): Landmark | null {
  const prx = regionOf(px), pry = regionOf(py);
  let best: Landmark | null = null;
  let bestD = Infinity;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const rx = prx + dx, ry = pry + dy;
      if (isFound(rx, ry)) continue;
      const lm = placed(rx, ry);
      if (!lm) continue;
      const d = Math.abs(px - lm.cx) + Math.abs(py - lm.cy);
      if (d < bestD) { bestD = d; best = lm; }
    }
  }
  return best;
}
