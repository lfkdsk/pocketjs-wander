// examples/wander/region.ts — one region's settlement plan.
//
// A region is 96 x 96 tiles. Its plan is a pure function of (seed, rx, ry):
//
//   hub        a town's plaza (probability by the hub's biome) or a bare
//              crossroads with a signpost; hashed jitter around the centre
//   town       grow's rules turned 2D: a main street through a plaza with a
//              cross street, the well and notice board, road-facing lots
//              north of the street and a back-lane row south of it (widths
//              follow the chosen Ninja house, gaps vary), a biome-specific
//              work plot north of the plaza joined by a lane, one resident
//              per house walking a road route, and bushes by the doors
//   roads      one grow-style trunk from the hub to every active gate of the
//              region: straight out of the town, then straight runs of two
//              to six cells whose axis is drawn by the distance left on it
//              (long bends when far off, single jogs when nearly aligned),
//              then a straight three-cell tail onto the gate cell on the
//              region edge. The neighbouring
//              region computes the same gate from the same hash and runs
//              its own trunk to the cell across the edge, so the two roads
//              meet without either side seeing the other's plan
//   growth     every developed cell carries a birth tick: roads spread from
//              the plaza three cells per tick, then the plaza props, one
//              house per tick (with its door path), the work plot, one
//              resident per tick and the bushes. The state at growth tick k
//              is "every cell born <= k", so growth needs no stored history
//
// Development stays at least three tiles inside the region edge except the
// gate tails, whose nature is cleared on both sides by the same pure rule
// (corridor boxes); a 2 x 2 wilderness block reaches at most one tile over
// an edge, so a chunk never needs a neighbouring region's plan.

import type { MoveStep } from "../../src/engine/types.ts";
import { HOUSE_STAMPS, STAMPS, stampCell } from "../grow/grow-stamps.ts";
import {
  GROW_TILE as T, REGION, growHash, regionGates, regionHub,
  type Biome, type Gate, type RegionHub,
} from "./world.ts";

export const F_ROAD = 1;
/** A born developed upper cell keeps bodies out (houses, fences, props). */
export const F_BLOCK = 2;
/** Developed foliage walked under (grow-project's decor canopy). */
export const F_DECOR = 4;
export const F_GROUND = 8;
export const F_UPPER = 16;

/** Reference ticks (60 per virtual second) per growth tick. */
export const GROWTH_TICK_FRAMES = 8;
/** Road cells laid per growth tick along every trunk at once. */
export const ROAD_CELLS_PER_TICK = 3;
export const GATE_TAIL = 3;

export interface VillagerPlan {
  /** Stable world-unique event id: v<rx>_<ry>_<n>. */
  id: string;
  /** World tile of the house door front (a road cell). */
  x: number;
  y: number;
  route: MoveStep[];
  /** Route bounding box in world tiles (the window only hosts villagers
   *  whose whole walk fits inside it). */
  minX: number; minY: number; maxX: number; maxY: number;
  born: number;
  house: number;
}

export interface CorridorBox { x0: number; y0: number; x1: number; y1: number }

export interface RegionPlan {
  seed: number;
  rx: number;
  ry: number;
  /** World tile of the region's top-left cell. */
  x0: number;
  y0: number;
  hub: RegionHub;
  name: string;
  /** No development at all (no town and no active gate). */
  empty: boolean;
  /** 96x96 region-local grids (null when empty). */
  ground: Uint8Array | null;
  upper: Uint16Array | null;
  born: Uint8Array | null;
  flags: Uint8Array | null;
  villagers: VillagerPlan[];
  houses: number;
  /** Growth ticks until the last cell is born (0 when empty). */
  totalTicks: number;
  /** Tail boxes of the four gates (active or not, inactive ones empty). */
  corridors: CorridorBox[];
  /** Developed-cell bounding box, world tiles (inclusive). */
  devX0: number; devY0: number; devX1: number; devY1: number;
  /** Rough retained byte estimate. */
  bytes: number;
}

// ---------------------------------------------------------------------------

const SYL_A = ["Bram", "Oak", "Wil", "Fern", "Ash", "Thorn", "Mill", "Stone", "Elder", "Birch", "Frost", "Dune", "Reed", "Moss", "Hazel", "Pine"];
const SYL_B = ["ford", "mere", "wick", "holt", "dale", "stead", "brook", "field", "haven", "cross", "well", "moor", "gate", "hollow", "by", "ton"];
export function regionName(seed: number, rx: number, ry: number): string {
  const h = growHash(seed, rx, ry, 0x7a3e);
  return SYL_A[h % SYL_A.length]! + SYL_B[(h >>> 8) % SYL_B.length]!;
}

/** Deterministic per-plan random stream (mulberry-style over growHash). */
class Stream {
  private n = 0;
  constructor(private readonly seed: number, private readonly a: number, private readonly b: number, private readonly salt: number) {}
  next(): number {
    return (growHash(this.seed, this.a, this.b + this.n++ * 7919, this.salt) % 100003) / 100003;
  }
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }
}

const DX = [0, -1, 0, 1] as const;
const DY = [1, 0, -1, 0] as const;
const DIR_STEP: readonly MoveStep[] = ["moveDown", "moveLeft", "moveUp", "moveRight"];

const STREET_HALF = 16;
const LOT_HALF = 14;
const HOUSE_H = 3;
const PLOT_W = 11, PLOT_H = 5;

interface Builder {
  plan: RegionPlan;
  ground: Uint8Array;
  upper: Uint16Array;
  born: Uint8Array;
  flags: Uint8Array;
  /** Road cells in lay order (region-local index), before births. */
  trunk: number[];
}

const UNBORN = 255;

function localIndex(b: Builder, x: number, y: number): number {
  const lx = x - b.plan.x0, ly = y - b.plan.y0;
  if (lx < 0 || ly < 0 || lx >= REGION || ly >= REGION) return -1;
  return ly * REGION + lx;
}
/** Grow the developed bounding box (every write goes through here). */
function touch(b: Builder, x: number, y: number): void {
  const p = b.plan;
  if (x < p.devX0) p.devX0 = x; if (x > p.devX1) p.devX1 = x;
  if (y < p.devY0) p.devY0 = y; if (y > p.devY1) p.devY1 = y;
}

function setRoad(b: Builder, x: number, y: number, tile: number, born = UNBORN, trunk = true): void {
  const i = localIndex(b, x, y);
  if (i < 0) return;
  if (b.upper[i]) return; // never pave through a house or prop
  touch(b, x, y);
  if (!(b.flags[i]! & F_ROAD)) {
    b.flags[i]! |= F_ROAD | F_GROUND;
    b.ground[i] = tile;
    b.born[i] = born;
    if (trunk) b.trunk.push(i);
  } else if (born !== UNBORN && b.born[i]! > born) {
    b.born[i] = born;
  }
}
function setUpper(b: Builder, x: number, y: number, tile: number, born: number, flag: number): void {
  const i = localIndex(b, x, y);
  if (i < 0) return;
  touch(b, x, y);
  b.upper[i] = tile;
  b.flags[i]! |= F_UPPER | flag;
  b.born[i] = Math.min(b.born[i]!, born);
}
function setGround(b: Builder, x: number, y: number, tile: number, born: number): void {
  const i = localIndex(b, x, y);
  if (i < 0) return;
  touch(b, x, y);
  b.ground[i] = tile;
  b.flags[i]! |= F_GROUND;
  b.born[i] = Math.min(b.born[i]!, born);
}
function free(b: Builder, x: number, y: number): boolean {
  const i = localIndex(b, x, y);
  return i >= 0 && b.flags[i] === 0;
}

// ---------------------------------------------------------------------------
// Town layout (grow.ts townLots / placeTownHouse / paintIndustry, in 2D).

interface Lot { x0: number; side: 0 | 1; kind: number; order: number }
function houseKey(biome: number, kind: number): string {
  const list = HOUSE_STAMPS[biome] ?? HOUSE_STAMPS[0]!;
  return list[kind % list.length]!;
}
function townLots(seed: number, rx: number, ry: number, cx: number, biome: Biome): Lot[] {
  const lots: Lot[] = [];
  const town = growHash(seed, rx, ry, 0x10a0);
  for (const side of [0, 1] as const) {
    for (const dir of [1, -1] as const) {
      const lane = side * 2 + (dir > 0 ? 1 : 0);
      let edge = cx + dir * (2 + (growHash(seed, town, lane, 0x10a7) % 2));
      let prev = side === 0 ? -1 : (growHash(seed, town, dir, 0x5ed0) % 3);
      const count = 3 + (growHash(seed, town, lane, 0x10a9) % 4); // 3..6 lots per arm
      for (let n = 0; n < count; n++) {
        const h = growHash(seed, town * 16 + n, lane, 0x1075);
        let kind = [0, 0, 0, 1, 1, 1, 2, 2][h % 8]!;
        if (kind === prev) kind = (kind + 1 + ((h >>> 3) % 2)) % 3;
        prev = kind;
        const w = STAMPS[houseKey(biome, kind)]!.w;
        const x0 = dir > 0 ? edge : edge - w + 1;
        if (x0 < cx - LOT_HALF || x0 + w - 1 > cx + LOT_HALF) break;
        lots.push({ x0, side, kind, order: n * 4 + lane });
        edge = dir > 0 ? x0 + w + 1 + ((h >>> 8) % 2) : x0 - 2 - ((h >>> 8) % 2);
      }
    }
  }
  return lots.sort((a, b) => a.order - b.order || a.x0 - b.x0);
}

function buildTown(b: Builder, hub: RegionHub): void {
  const { x: cx, y: cy } = hub;
  // Main street through the plaza and the cross street (trunk roads; their
  // births come from the breadth-first pass).
  for (let x = cx - STREET_HALF; x <= cx + STREET_HALF; x++) setRoad(b, x, cy, Math.abs(x - cx) <= 1 ? T.PLAZA : T.ROAD_H);
  for (let y = cy - 4; y <= cy + 4; y++) setRoad(b, cx, y, Math.abs(y - cy) <= 1 ? T.PLAZA : T.ROAD_V);
}

function* placeHousesAndPlot(b: Builder, seed: number, hub: RegionHub, firstTick: number): Generator<number, { houses: { doorX: number; frontY: number; born: number }[]; plotTick: number }> {
  const { x: cx, y: cy, biome, rx, ry } = hub;
  const houses: { doorX: number; frontY: number; born: number }[] = [];
  let tick = firstTick;
  for (const lot of townLots(seed, rx, ry, cx, biome)) {
    const key = houseKey(biome, lot.kind);
    const st = STAMPS[key]!;
    const top = lot.side === 0 ? cy - 1 - HOUSE_H : cy + 2;
    const frontY = top + HOUSE_H;
    const doorX = lot.x0 + (st.door ?? 1);
    let fits = true;
    for (let y = top; y < top + HOUSE_H && fits; y++) for (let x = lot.x0; x < lot.x0 + st.w; x++) if (!free(b, x, y)) { fits = false; break; }
    if (!fits) continue;
    const born = tick++;
    for (let dy = 0; dy < st.h; dy++) for (let dx = 0; dx < st.w; dx++) setUpper(b, lot.x0 + dx, top + dy, stampCell(key, dx, dy), born, F_BLOCK);
    if (lot.side === 0) {
      setRoad(b, doorX, frontY, T.ROAD_V, born, false);
    } else {
      for (let px = Math.min(doorX, cx); px <= Math.max(doorX, cx); px++) setRoad(b, px, frontY, T.ROAD_H, born, false);
    }
    const h = growHash(seed, lot.x0, top, 0x7a2d);
    if (lot.side === 0 && h % 5 < 2) {
      for (let x = lot.x0; x < lot.x0 + st.w; x++) if (x !== doorX && free(b, x, frontY)) setUpper(b, x, frontY, T.FENCE_H, born, F_BLOCK);
    }
    const sideX = (h >>> 4) % 2 ? lot.x0 - 1 : lot.x0 + st.w;
    const propY = top + HOUSE_H - 1;
    if ((h >>> 6) % 3 !== 0 && free(b, sideX, propY)) {
      const prop = biome === 2 ? ((h >>> 9) % 2 ? stampCell("pot-red", 0, 0) : stampCell("pot-gold", 0, 0))
        : biome === 3 ? stampCell("snow-round", 0, 0)
        : biome === 1 ? T.FIREWOOD
        : (h >>> 9) % 2 ? stampCell("flower-sun", 0, 0) : stampCell("bush-b", 0, 0);
      setUpper(b, sideX, propY, prop, born, F_BLOCK);
    }
    houses.push({ doorX, frontY, born });
    yield 70;
  }
  // Work plot north of the plaza (grow's paintIndustry, fixed to the centre).
  yield 60;
  const plotTick = tick;
  const x0 = cx - 5, y0 = cy - 12;
  const plotGround = [T.FARM_A, T.WORK_YARD, T.OASIS, T.WINTER_PLOT][biome]!;
  for (let y = y0; y < y0 + PLOT_H; y++) for (let x = x0; x < x0 + PLOT_W; x++) {
    const edge = x === x0 || x === x0 + PLOT_W - 1 || y === y0 || y === y0 + PLOT_H - 1;
    if (biome === 0 || biome === 3) {
      if (edge) {
        if (!(x === cx && y === y0 + PLOT_H - 1)) setUpper(b, x, y, y === y0 || y === y0 + PLOT_H - 1 ? T.FENCE_H : T.FENCE_V, plotTick, F_BLOCK);
      } else setGround(b, x, y, biome === 3 ? plotGround : (y & 1) ? T.FARM_A : T.FARM_B, plotTick);
    } else if (biome === 1) {
      setGround(b, x, y, plotGround, plotTick);
      if (y === y0 + 1 && x % 3 !== 0) setUpper(b, x, y, T.LOGS, plotTick, F_BLOCK);
    } else {
      setGround(b, x, y, T.MARKET_RUG, plotTick);
      if (y === y0 + 1 && (x - x0) % 3 === 1) setUpper(b, x, y, T.STALL, plotTick, F_BLOCK);
    }
  }
  for (let py = y0 + PLOT_H - 1; py <= cy - 5; py++) setRoad(b, cx, py, T.ROAD_V, plotTick, false);
  if (biome === 0) setUpper(b, x0 + 9, y0 + 3, T.FLOWER_PROP, plotTick, F_BLOCK);
  if (biome === 1) { setUpper(b, x0 + 2, y0 + 1, T.LOGS, plotTick, F_BLOCK); setUpper(b, x0 + 4, y0 + 2, T.ROCK, plotTick, F_BLOCK); }
  if (biome === 2) { setUpper(b, x0 + 2, y0 + 1, T.STALL, plotTick, F_BLOCK); setUpper(b, x0 + 4, y0 + 2, T.STALL, plotTick, F_BLOCK); }
  if (biome === 3) { setUpper(b, x0 + 2, y0 + 1, T.FIREWOOD, plotTick, F_BLOCK); setUpper(b, x0 + 4, y0 + 2, T.FIR, plotTick, F_BLOCK); }
  return { houses, plotTick };
}

// ---------------------------------------------------------------------------
// Trunk roads to the gates.

interface GateEnd { x: number; y: number; tdx: number; tdy: number }

function gateEnds(seed: number, rx: number, ry: number): { gate: Gate; end: GateEnd; key: number }[] {
  const g = regionGates(seed, rx, ry);
  const x0 = rx * REGION, y0 = ry * REGION, x1 = x0 + REGION - 1, y1 = y0 + REGION - 1;
  return [
    { gate: g.w, end: { x: x0, y: y0 + g.w.at, tdx: -1, tdy: 0 }, key: 0 },
    { gate: g.e, end: { x: x1, y: y0 + g.e.at, tdx: 1, tdy: 0 }, key: 1 },
    { gate: g.n, end: { x: x0 + g.n.at, y: y0, tdx: 0, tdy: -1 }, key: 2 },
    { gate: g.s, end: { x: x0 + g.s.at, y: y1, tdx: 0, tdy: 1 }, key: 3 },
  ];
}

/** Corridor box of one gate: the tail on this side and the mirrored tail
 *  across the edge. Identical from both regions. */
export function corridorOf(end: GateEnd): CorridorBox {
  const ax = end.x - end.tdx * GATE_TAIL, ay = end.y - end.tdy * GATE_TAIL;
  const bx = end.x + end.tdx * (GATE_TAIL + 1), by = end.y + end.tdy * (GATE_TAIL + 1);
  return { x0: Math.min(ax, bx), y0: Math.min(ay, by), x1: Math.max(ax, bx), y1: Math.max(ay, by) };
}

function layTrunk(b: Builder, seed: number, start: { x: number; y: number }, exit: { dx: number; dy: number; len: number }, end: GateEnd, salt: number): void {
  let x = start.x, y = start.y;
  setRoad(b, x, y, T.ROAD_H);
  for (let n = 0; n < exit.len; n++) { x += exit.dx; y += exit.dy; setRoad(b, x, y, exit.dx !== 0 ? T.ROAD_H : T.ROAD_V); }
  // Tail start: GATE_TAIL cells inside the gate cell.
  const tx = end.x - end.tdx * GATE_TAIL, ty = end.y - end.tdy * GATE_TAIL;
  const horizontal = end.tdx !== 0;
  // Straight runs of 2..6 cells; the axis of each run is drawn with odds
  // proportional to the distance still to cover on it, so a road with far
  // to go sideways bends in long legs and a nearly aligned one only jogs.
  let run = 0, onMinor = false;
  for (let guard = 0, step = 0; guard < 600 && (x !== tx || y !== ty); guard++) {
    const remMaj = horizontal ? Math.abs(tx - x) : Math.abs(ty - y);
    const remMin = horizontal ? Math.abs(ty - y) : Math.abs(tx - x);
    if (run <= 0 || (onMinor ? remMin === 0 : remMaj === 0)) {
      const h = growHash(seed, salt, step++, 0x7065);
      if (remMin === 0) onMinor = false;
      else if (remMaj === 0) onMinor = true;
      else onMinor = (h % 1000) / 1000 < remMin / (remMin + remMaj) * (onMinor ? 0.6 : 1.4);
      run = 2 + ((h >>> 10) % 5);
    }
    if (onMinor) {
      if (horizontal) y += Math.sign(ty - y); else x += Math.sign(tx - x);
      setRoad(b, x, y, horizontal ? T.ROAD_V : T.ROAD_H);
    } else {
      if (horizontal) x += Math.sign(tx - x); else y += Math.sign(ty - y);
      setRoad(b, x, y, horizontal ? T.ROAD_H : T.ROAD_V);
    }
    run--;
  }
  for (let n = 1; n <= GATE_TAIL; n++) setRoad(b, tx + end.tdx * n, ty + end.tdy * n, horizontal ? T.ROAD_H : T.ROAD_V);
}

// ---------------------------------------------------------------------------
// Residents (grow.ts roadRoute over the town's own road cells).

function villagerRoute(b: Builder, seed: number, rx: number, ry: number, n: number, x0: number, y0: number, box: CorridorBox): { steps: MoveStep[]; minX: number; minY: number; maxX: number; maxY: number } {
  const rng = new Stream(seed, rx * 131 + n, ry, 0x7111);
  const out: number[] = [];
  let x = x0, y = y0, dir = 0;
  let minX = x, minY = y, maxX = x, maxY = y;
  for (let k = 0; k < 12; k++) {
    const options: number[] = [];
    for (let d = 0; d < 4; d++) {
      const nx = x + DX[d]!, ny = y + DY[d]!;
      if (nx < box.x0 || nx > box.x1 || ny < box.y0 || ny > box.y1) continue;
      const i = localIndex(b, nx, ny);
      if (i >= 0 && (b.flags[i]! & F_ROAD) && !(b.flags[i]! & F_UPPER)) options.push(d);
    }
    if (!options.length) break;
    const next = options.includes(dir) && rng.next() < 0.7 ? dir : options[rng.int(0, options.length - 1)]!;
    out.push(next);
    x += DX[next]!; y += DY[next]!; dir = next;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  const steps = out.map((d) => DIR_STEP[d]!);
  if (steps.length) {
    steps.push("wait");
    for (let i = out.length - 1; i >= 0; i--) steps.push(DIR_STEP[out[i]! ^ 2]!);
    steps.push("wait");
  }
  return { steps, minX, minY, maxX, maxY };
}

// ---------------------------------------------------------------------------

/**
 * Build a region plan, yielding the work units of each slice (never more
 * than residency.ts STEP_MAX; about 2,500 units, roughly as many
 * microseconds of desktop QuickJS, per plan). Run to completion with
 * planRegion().
 */
export function* planRegionJob(seed: number, rx: number, ry: number): Generator<number, RegionPlan> {
  const hub = regionHub(seed, rx, ry);
  const ends = gateEnds(seed, rx, ry);
  const x0 = rx * REGION, y0 = ry * REGION;
  const plan: RegionPlan = {
    seed, rx, ry, x0, y0, hub, name: regionName(seed, rx, ry), empty: true,
    ground: null, upper: null, born: null, flags: null, villagers: [], houses: 0, totalTicks: 0,
    corridors: ends.filter((e) => e.gate.active).map((e) => corridorOf(e.end)),
    devX0: hub.x, devY0: hub.y, devX1: hub.x, devY1: hub.y, bytes: 256,
  };
  const active = ends.filter((e) => e.gate.active);
  if (!hub.town && active.length === 0) return plan;
  yield 40;

  const cells = REGION * REGION;
  const b: Builder = {
    plan, ground: new Uint8Array(cells), upper: new Uint16Array(cells),
    born: new Uint8Array(cells).fill(UNBORN), flags: new Uint8Array(cells), trunk: [],
  };
  plan.empty = false;
  plan.ground = b.ground; plan.upper = b.upper; plan.born = b.born; plan.flags = b.flags;
  plan.bytes = cells * 5 + 512;

  // 1. Trunk network: town streets (or the crossroads) and gate roads.
  if (hub.town) buildTown(b, hub);
  else setRoad(b, hub.x, hub.y, T.ROAD_CROSS);
  yield 120;
  for (const e of active) {
    let start = { x: hub.x, y: hub.y };
    let exit = { dx: e.end.tdx, dy: e.end.tdy, len: 2 };
    if (hub.town) {
      if (e.end.tdx !== 0) {
        start = { x: hub.x + e.end.tdx * STREET_HALF, y: hub.y };
        exit = { dx: e.end.tdx, dy: 0, len: 0 };
      } else {
        start = { x: hub.x + (e.end.x < hub.x ? -STREET_HALF : STREET_HALF), y: hub.y };
        exit = { dx: 0, dy: e.end.tdy, len: e.end.tdy < 0 ? 14 : 8 };
      }
    }
    layTrunk(b, seed, start, exit, e.end, growHash(seed, rx, ry, 0x7700 + e.key));
    yield 160;
  }

  // 2. Birth ticks: breadth-first from the hub over the trunk network.
  const dist = new Int16Array(cells).fill(-1);
  const hubIndex = localIndex(b, hub.x, hub.y);
  const queue = new Int32Array(b.trunk.length + 1);
  let head = 0, tail = 0;
  dist[hubIndex] = 0; queue[tail++] = hubIndex;
  while (head < tail) {
    const i = queue[head++]!;
    const lx = i % REGION, ly = (i - lx) / REGION;
    for (let d = 0; d < 4; d++) {
      const nx = lx + DX[d]!, ny = ly + DY[d]!;
      if (nx < 0 || ny < 0 || nx >= REGION || ny >= REGION) continue;
      const j = ny * REGION + nx;
      if (dist[j] !== -1 || !(b.flags[j]! & F_ROAD)) continue;
      dist[j] = dist[i]! + 1;
      queue[tail++] = j;
    }
    if ((head & 255) === 0) yield 256;
  }
  let lastRoad = 0, streetDone = 0;
  for (const i of b.trunk) {
    const born = Math.floor(Math.max(0, dist[i]!) / ROAD_CELLS_PER_TICK);
    b.born[i] = born;
    lastRoad = Math.max(lastRoad, born);
    const lx = i % REGION, ly = (i - lx) / REGION;
    if (hub.town && ((ly + y0 === hub.y && Math.abs(lx + x0 - hub.x) <= STREET_HALF) || (lx + x0 === hub.x && Math.abs(ly + y0 - hub.y) <= 4))) {
      streetDone = Math.max(streetDone, born);
    }
  }
  yield 200;

  // 3. Town growth: plaza props, houses, plot, residents, bushes.
  let last = lastRoad;
  if (hub.town) {
    const propsTick = streetDone + 1;
    setUpper(b, hub.x - 1, hub.y - 1, hub.biome === 3 ? T.FIREWOOD : T.WELL, propsTick, F_BLOCK);
    setUpper(b, hub.x + 1, hub.y + 1, T.NOTICE, propsTick, F_BLOCK);
    const { houses, plotTick } = yield* placeHousesAndPlot(b, seed, hub, propsTick + 1);
    plan.houses = houses.length;
    yield 160;
    const box = { x0: hub.x - STREET_HALF, y0: hub.y - 12, x1: hub.x + STREET_HALF, y1: hub.y + 6 };
    let tick = plotTick + 1;
    for (let n = 0; n < houses.length; n++) {
      const h = houses[n]!;
      const route = villagerRoute(b, seed, rx, ry, n, h.doorX, h.frontY, box);
      plan.villagers.push({ id: `v${rx}_${ry}_${n}`, x: h.doorX, y: h.frontY, route: route.steps, minX: route.minX, minY: route.minY, maxX: route.maxX, maxY: route.maxY, born: tick++, house: n });
      yield 60;
    }
    // Bushes by the doors (grow's seedSettledDecor), walked under.
    const decorTick = tick;
    let placed = 0;
    for (let n = 0; n < houses.length * 3 && placed < 10; n++) {
      const h = houses[n % houses.length]!;
      const r = growHash(seed, rx * 977 + n, ry, 0xdec0);
      const dx = (r % 7) - 3, dy = ((r >>> 4) % 7) - 3;
      if (Math.abs(dx) + Math.abs(dy) < 3) continue;
      const x = h.doorX + dx, y = h.frontY + dy;
      if (!free(b, x, y)) continue;
      setUpper(b, x, y, hub.biome === 3 ? T.SNOW_SHRUB : T.BUSH, decorTick, F_DECOR);
      placed++;
    }
    last = Math.max(last, decorTick);
  } else {
    setUpper(b, hub.x + 1, hub.y - 1, T.NOTICE, 1, F_BLOCK);
    last = Math.max(last, 1);
  }
  plan.totalTicks = last + 1;

  yield 60;
  return plan;
}

/** Run a plan job to completion (tests, tools). */
export function planRegion(seed: number, rx: number, ry: number): RegionPlan {
  const job = planRegionJob(seed, rx, ry);
  for (;;) {
    const r = job.next();
    if (r.done) return r.value;
  }
}

/** Growth tick of a plan at `frames` reference ticks since discovery. */
export function growthTickAt(frames: number): number {
  return Math.floor(Math.max(0, frames) / GROWTH_TICK_FRAMES);
}
