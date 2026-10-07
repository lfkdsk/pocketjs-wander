// examples/wander/chunk.ts — one 32 x 32 chunk's resident data.
//
// A chunk is a pure function of (seed, cx, cy) and its region's plan, which
// is itself a pure function of (seed, rx, ry). Nothing reads another chunk,
// a cache, or the order chunks were generated in: the 3-cell biome margin
// and the stagger-shifted edge blocks are recomputed from the same point
// functions a neighbour uses, so both sides agree cell for cell.
//
// Layout of the per-cell arrays (1,024 cells, row-major):
//
//   terrain   biome | seamKind << 2 (fill / transition / blend / fringe)
//   devGround developed ground tile (road, plaza, fields), 0 = none
//   devUpper  developed upper tile (houses, fences, props, bushes), 0 = none
//   devBorn   growth tick the developed cell appears at (NEVER = none)
//   natUpper  wilderness stamp cell, 0 = none
//   natHide   growth tick development clears it at (NEVER = stays)
//   flags     plan flags of the developed cell | F_NAT_BLOCK
//
// Visibility at a region growth tick k (-1 before discovery, COMPLETE after):
// developed cells show when k >= devBorn, wilderness shows while k < natHide.

import { STAMPS } from "../../vendor/pocket-rpgkit/examples/grow/grow-stamps.ts";
import {
  BiomeGrid, CHUNK, CHUNK_CELLS, NOISE, NoiseGrid, REGION, blockOrigin, blockStamp,
  regionHub, regionOf, townClearingFrom, type Biome, type NatureSampler, type RegionHub,
} from "./world.ts";
import { F_BLOCK, F_ROAD, type CorridorBox, type RegionPlan } from "./region.ts";

export const NEVER = 255;
/** Growth tick meaning "fully grown" (birth ticks stay below it). */
export const COMPLETE = 254;
export const UNDISCOVERED = -1;
export const F_NAT_BLOCK = 64;
export const NO_SUB = 255;

export interface ChunkData {
  cx: number;
  cy: number;
  /** World tile of the top-left cell. */
  x0: number;
  y0: number;
  rx: number;
  ry: number;
  terrain: Uint8Array;
  /** Majority biome of each 16 x 16 fill block: [top-left, top-right,
   *  bottom-left, bottom-right]. */
  blockBiome: Uint8Array;
  /** Biome of each plain 4 x 4 patch (row-major 8 x 8), NO_SUB if mixed or
   *  seamed. */
  subBiome: Uint8Array;
  devGround: Uint8Array;
  devUpper: Uint16Array;
  devBorn: Uint8Array;
  natUpper: Uint16Array;
  natHide: Uint8Array;
  flags: Uint8Array;
  /** Cells whose appearance depends on the growth tick. */
  growCells: Uint16Array;
  bytes: number;
}

const MARGIN = 3;
const SPAN = CHUNK + 2 * MARGIN; // 38

function inBox(b: CorridorBox, x: number, y: number): boolean {
  return x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1;
}

/** Sampler over one chunk's rectangle; exact point-function results. A
 *  class, not closures: a generator frame that holds closures over itself
 *  is a reference cycle only QuickJS's collector can free. */
class ChunkSampler implements NatureSampler {
  private readonly fa: NoiseGrid;
  private readonly fb: NoiseGrid;
  private readonly pa: NoiseGrid;
  private readonly me: NoiseGrid;
  private readonly hubs: (RegionHub | undefined)[] = new Array(9);
  private readonly rxBase: number;
  private readonly ryBase: number;
  private readonly nearTown: boolean;
  constructor(private readonly seed: number, private readonly x0: number, private readonly y0: number, private readonly biomes: Uint8Array) {
    const ax = x0 - 4, ay = y0 - 4, bx = x0 + CHUNK + 4, by = y0 + CHUNK + 4;
    this.fa = new NoiseGrid(seed, NOISE.forestA.scale, NOISE.forestA.salt, ax, ay, bx, by);
    this.fb = new NoiseGrid(seed, NOISE.forestB.scale, NOISE.forestB.salt, ax, ay, bx, by);
    this.pa = new NoiseGrid(seed, NOISE.patch.scale, NOISE.patch.salt, ax, ay, bx, by);
    this.me = new NoiseGrid(seed, NOISE.meadow.scale, NOISE.meadow.salt, ax, ay, bx, by);
    this.rxBase = regionOf(x0);
    this.ryBase = regionOf(y0);
    // The clearing is exactly 1 more than 21 tiles from a town hub, and hubs
    // sit 36+ tiles inside their region: only a chunk near its own region's
    // town ever evaluates the curve.
    const own = this.hubOf(x0, y0);
    this.nearTown = own.town && own.x > x0 - 30 && own.x < x0 + CHUNK + 30 && own.y > y0 - 30 && own.y < y0 + CHUNK + 30;
  }
  private hubOf(x: number, y: number): RegionHub {
    const rx = regionOf(x), ry = regionOf(y);
    const k = (rx - this.rxBase + 1) * 3 + (ry - this.ryBase + 1);
    return this.hubs[k] ??= regionHub(this.seed, rx, ry);
  }
  forest(x: number, y: number): number { return 0.68 * this.fa.get(x, y) + 0.32 * this.fb.get(x, y); }
  patch(x: number, y: number): number { return this.pa.get(x, y); }
  meadow(x: number, y: number): number { return this.me.get(x, y); }
  biome(x: number, y: number): Biome { return this.biomes[(y - this.y0 + MARGIN) * SPAN + (x - this.x0 + MARGIN)]! as Biome; }
  clearing(x: number, y: number): number { return this.nearTown ? townClearingFrom(this.hubOf(x, y), x, y) : 1; }
}

function reaches(b: CorridorBox, x0: number, y0: number): boolean {
  return b.x1 >= x0 - 1 && b.x0 <= x0 + CHUNK && b.y1 >= y0 - 1 && b.y0 <= y0 + CHUNK;
}

function devBornAt(plan: RegionPlan, x: number, y: number): number {
  if (plan.empty) return NEVER;
  const lx = x - plan.x0, ly = y - plan.y0;
  if (lx < 0 || ly < 0 || lx >= REGION || ly >= REGION) return NEVER;
  const k = ly * REGION + lx;
  return plan.flags![k] ? plan.born![k]! : NEVER;
}

/**
 * Generate chunk (cx, cy) against its region plan, yielding the work units
 * of each slice (never more than residency.ts STEP_MAX; about 6,500 units,
 * roughly as many microseconds of desktop QuickJS, per chunk).
 */
export function* chunkJob(seed: number, cx: number, cy: number, plan: RegionPlan): Generator<number, ChunkData> {
  const x0 = cx * CHUNK, y0 = cy * CHUNK;
  // 1. Biomes over the chunk plus a 3-cell margin.
  // Units are calibrated to about one microsecond of desktop QuickJS each.
  const grid = new BiomeGrid(seed, x0 - MARGIN, y0 - MARGIN, x0 + CHUNK + MARGIN, y0 + CHUNK + MARGIN);
  yield 420;
  const biomes = new Uint8Array(SPAN * SPAN);
  for (let r = 0; r < SPAN; r++) {
    for (let c = 0; c < SPAN; c++) biomes[r * SPAN + c] = grid.biome(x0 - MARGIN + c, y0 - MARGIN + r);
    if ((r & 7) === 7) yield 300;
  }
  yield 240;

  // 2. Seam kinds: Chebyshev distance (<= 3) to the nearest cell of the
  //    previous biome. The nearest such cell can always be taken on the
  //    biome's edge (a cell with a differing 4-neighbour between it and the
  //    target), so only edge cells stamp their 7x7 neighbourhood.
  const kinds = new Uint8Array(CHUNK_CELLS).fill(4);
  for (let r = 0; r < SPAN; r++) {
    for (let c = 0; c < SPAN; c++) {
      const j = r * SPAN + c, b = biomes[j]!;
      if (!((c > 0 && biomes[j - 1] !== b) || (c + 1 < SPAN && biomes[j + 1] !== b)
        || (r > 0 && biomes[j - SPAN] !== b) || (r + 1 < SPAN && biomes[j + SPAN] !== b))) continue;
      const next = (b + 1) & 3;
      const ya = Math.max(0, r - 3 - MARGIN), yb = Math.min(CHUNK - 1, r + 3 - MARGIN);
      const xa = Math.max(0, c - 3 - MARGIN), xb = Math.min(CHUNK - 1, c + 3 - MARGIN);
      for (let y = ya; y <= yb; y++) {
        const dy = y + MARGIN - r, ady = dy < 0 ? -dy : dy;
        const row = (y + MARGIN) * SPAN + MARGIN;
        for (let x = xa; x <= xb; x++) {
          if (biomes[row + x] !== next) continue;
          const dx = x + MARGIN - c, adx = dx < 0 ? -dx : dx;
          const d = ady > adx ? ady : adx;
          const i = y * CHUNK + x;
          if (d < kinds[i]!) kinds[i] = d;
        }
      }
    }
    if ((r & 7) === 7) yield 140;
  }
  yield 110;
  const terrain = new Uint8Array(CHUNK_CELLS);
  const counts = new Uint16Array(16);
  for (let y = 0; y < CHUNK; y++) {
    for (let x = 0; x < CHUNK; x++) {
      const b = biomes[(y + MARGIN) * SPAN + (x + MARGIN)]!;
      const k = kinds[y * CHUNK + x]!;
      terrain[y * CHUNK + x] = b | ((k <= 3 ? k : 0) << 2);
      counts[((y >> 4) * 2 + (x >> 4)) * 4 + b]!++;
    }
  }
  yield 300;
  // 4 x 4 patches of one plain biome (a 64 px fill covers them).
  const subBiome = new Uint8Array(64).fill(NO_SUB);
  for (let sy = 0; sy < 8; sy++) {
    for (let sx = 0; sx < 8; sx++) {
      let b = -1;
      let ok = true;
      for (let y = sy * 4; y < sy * 4 + 4 && ok; y++) {
        for (let x = sx * 4; x < sx * 4 + 4; x++) {
          const t = terrain[y * CHUNK + x]!;
          if (t >> 2 || (b >= 0 && (t & 3) !== b)) { ok = false; break; }
          b = t & 3;
        }
      }
      if (ok) subBiome[sy * 8 + sx] = b;
    }
  }
  const blockBiome = new Uint8Array(4);
  for (let k = 0; k < 4; k++) {
    let best = 0;
    for (let b = 1; b < 4; b++) if (counts[k * 4 + b]! > counts[k * 4 + best]!) best = b;
    blockBiome[k] = best;
  }
  yield 360;

  // 3. Development from the region plan.
  const devGround = new Uint8Array(CHUNK_CELLS);
  const devUpper = new Uint16Array(CHUNK_CELLS);
  const devBorn = new Uint8Array(CHUNK_CELLS).fill(NEVER);
  const flags = new Uint8Array(CHUNK_CELLS);
  const lx0 = x0 - plan.x0, ly0 = y0 - plan.y0;
  if (!plan.empty) {
    for (let y = 0; y < CHUNK; y++) {
      const row = (ly0 + y) * REGION + lx0;
      for (let x = 0; x < CHUNK; x++) {
        const f = plan.flags![row + x]!;
        if (!f) continue;
        const i = y * CHUNK + x;
        devGround[i] = plan.ground![row + x]!;
        devUpper[i] = plan.upper![row + x]!;
        devBorn[i] = plan.born![row + x]!;
        flags[i] = f;
      }
    }
  }
  yield 150;

  // 4. Wilderness by 2x2 block. Blocks on odd rows are shifted one cell, so
  //    a chunk's left and right edges cut blocks: both chunks evaluate the
  //    same block and keep their own half.
  const natUpper = new Uint16Array(CHUNK_CELLS);
  const natHide = new Uint8Array(CHUNK_CELLS).fill(NEVER);
  const sampler = new ChunkSampler(seed, x0, y0, biomes);
  yield 320;
  // Only corridors and development that reach this chunk (plus the one-cell
  // block overhang) need testing per block.
  const corridors = plan.corridors.filter((b) => reaches(b, x0, y0));
  const devHere = !plan.empty && reaches({ x0: plan.devX0, y0: plan.devY0, x1: plan.devX1, y1: plan.devY1 }, x0, y0);
  const by0 = Math.floor(y0 / 2), by1 = Math.floor((y0 + CHUNK - 1) / 2);
  for (let by = by0; by <= by1; by++) {
    const shift = by & 1;
    const bx0 = Math.floor((x0 - shift) / 2), bx1 = Math.floor((x0 + CHUNK - 1 - shift) / 2);
    for (let bx = bx0; bx <= bx1; bx++) {
      const item = blockStamp(seed, bx, by, sampler);
      if (!item) continue;
      if (corridors.length) {
        // Gate corridors clear whole blocks on both sides of the edge.
        const o = blockOrigin(bx, by);
        let cleared = false;
        for (const box of corridors) {
          if (inBox(box, o.x0, o.y0) || inBox(box, o.x0 + 1, o.y0) || inBox(box, o.x0, o.y0 + 1) || inBox(box, o.x0 + 1, o.y0 + 1)) { cleared = true; break; }
        }
        if (cleared) continue;
      }
      const st = STAMPS[item.key]!;
      // A multi-cell stamp vanishes whole when development reaches any of
      // its cells (grow's wildernessTileAt); a single cell only for itself.
      let hide = NEVER;
      if (devHere) for (let dy = 0; dy < st.h; dy++) for (let dx = 0; dx < st.w; dx++) hide = Math.min(hide, devBornAt(plan, item.x + dx, item.y + dy));
      for (let dy = 0; dy < st.h; dy++) for (let dx = 0; dx < st.w; dx++) {
        const x = item.x + dx - x0, y = item.y + dy - y0;
        if (x < 0 || y < 0 || x >= CHUNK || y >= CHUNK) continue;
        const i = y * CHUNK + x;
        natUpper[i] = st.base + dy * st.w + dx;
        natHide[i] = hide;
        // Trunks and boulder bases block; a canopy row is walked under
        // (bodies draw below the upper layer), bushes and flowers over.
        if (st.h > 1 && dy === st.h - 1) flags[i]! |= F_NAT_BLOCK;
      }
    }
    yield 220;
  }

  // 5. Cells that change with growth.
  let n = 0;
  const grow = new Uint16Array(CHUNK_CELLS);
  for (let i = 0; i < CHUNK_CELLS; i++) if (devBorn[i] !== NEVER || natHide[i] !== NEVER) grow[n++] = i;
  const growCells = grow.slice(0, n);
  yield 120;
  return {
    cx, cy, x0, y0, rx: plan.rx, ry: plan.ry, terrain, blockBiome, subBiome,
    devGround, devUpper, devBorn, natUpper, natHide, flags, growCells,
    bytes: CHUNK_CELLS * 9 + n * 2 + 64 + 256,
  };
}

export function generateChunk(seed: number, cx: number, cy: number, plan: RegionPlan): ChunkData {
  const job = chunkJob(seed, cx, cy, plan);
  for (;;) {
    const r = job.next();
    if (r.done) return r.value;
  }
}

/** Upper tile shown at growth tick k (0 = none). */
export function upperAt(c: ChunkData, i: number, k: number): number {
  if (c.devUpper[i] && k >= c.devBorn[i]!) return c.devUpper[i]!;
  if (c.natUpper[i] && k < c.natHide[i]!) return c.natUpper[i]!;
  return 0;
}
/** Developed ground tile shown at growth tick k (0 = none). */
export function groundAt(c: ChunkData, i: number, k: number): number {
  return c.devGround[i] && k >= c.devBorn[i]! ? c.devGround[i]! : 0;
}
/** Does the cell keep bodies out at growth tick k? */
export function blocksAt(c: ChunkData, i: number, k: number): boolean {
  if (c.devUpper[i] && k >= c.devBorn[i]!) return (c.flags[i]! & F_BLOCK) !== 0;
  if (c.natUpper[i] && k < c.natHide[i]! && (c.flags[i]! & F_NAT_BLOCK)) return true;
  return false;
}
/** Walkable road at growth tick k (the auto-walker prefers these). */
export function roadAt(c: ChunkData, i: number, k: number): boolean {
  return (c.flags[i]! & F_ROAD) !== 0 && k >= c.devBorn[i]!;
}
