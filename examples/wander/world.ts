// examples/wander/world.ts — the unbounded world's pure point functions.
//
// Every value here is a function of (seed, world tile x, world tile y) and
// nothing else: no caches sized to a world, no generation order, no host
// clock. Tile coordinates are signed integers; the practical range is int32
// in every direction (the hashes fold their inputs through Math.imul, so a
// coordinate past 2^31 still hashes deterministically, it just aliases).
//
//   chunk   32 x 32 tiles, the unit of residency (chunk.ts, residency.ts)
//   region  3 x 3 chunks = 96 x 96 tiles, the unit of settlement planning
//           (region.ts): at most one town, placed by hashed jitter, plus a
//           hashed "gate" on each shared region edge that both sides
//           compute identically, so roads meet without global state
//   biome   grass / mud / sand / snow from low-frequency 2D value noise,
//           equalized into four equal bands (snow, grass, mud, sand), so a
//           border only ever pairs a biome with its neighbour in grow's
//           cyclic order and every border has grow's transition / blend /
//           fringe seam art (B's seam art shows B-1)
//   nature  grow's coordinate-hashed woodland (growHash + value noise +
//           the Ninja stamps of grow-stamps.ts), evaluated per 2x2 block
//
// The value-noise lattice is grow's (same hash, same lattice formula).
// NoiseGrid evaluates the same formula over a rectangle with the lattice
// values fetched once per lattice cell; its results are bit-identical to the
// point function, which the order-independence tests rely on.

import { growHash, GROW_TILE } from "../grow/grow.ts";
import { STAMPS, stampCell } from "../grow/grow-stamps.ts";

export { growHash };

export const TILE = 16;
export const CHUNK = 32;
export const CHUNK_CELLS = CHUNK * CHUNK;
export const REGION_CHUNKS = 3;
export const REGION = CHUNK * REGION_CHUNKS; // 96 tiles

export type Biome = 0 | 1 | 2 | 3; // grass, mud, sand, snow (grow's order)
export const BIOME_NAMES = ["GRASS", "MUD", "SAND", "SNOW"] as const;

/** Region of a world tile (floor division: exact for negative tiles). */
export function regionOf(t: number): number {
  return Math.floor(t / REGION);
}

// ---------------------------------------------------------------------------
// Value noise (grow.ts formula, reimplemented here so the grow reducer's
// module stays untouched; growHash is grow's export).

export function lattice(seed: number, ix: number, iy: number, salt: number): number {
  return (growHash(seed, ix, iy, salt) % 10007) / 10006;
}

/** Smoothstep-interpolated value noise in [0, 1] — grow's valueNoise. */
export function valueNoise(seed: number, x: number, y: number, scale: number, salt: number): number {
  const fx = x / scale, fy = y / scale;
  const ix = Math.floor(fx), iy = Math.floor(fy);
  const tx = fx - ix, ty = fy - iy;
  const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
  const a = lattice(seed, ix, iy, salt), b = lattice(seed, ix + 1, iy, salt);
  const c = lattice(seed, ix, iy + 1, salt), d = lattice(seed, ix + 1, iy + 1, salt);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

/** valueNoise over a tile rectangle with each lattice value hashed once.
 *  get(x, y) is bit-identical to valueNoise(seed, x, y, scale, salt) for any
 *  (x, y) inside the rectangle the grid was built for. */
export class NoiseGrid {
  private readonly ix0: number;
  private readonly iy0: number;
  private readonly cols: number;
  private readonly values: Float64Array;
  constructor(
    readonly seed: number,
    readonly scale: number,
    readonly salt: number,
    x0: number, y0: number, x1: number, y1: number,
  ) {
    this.ix0 = Math.floor(x0 / scale);
    this.iy0 = Math.floor(y0 / scale);
    const ix1 = Math.floor(x1 / scale) + 1;
    const iy1 = Math.floor(y1 / scale) + 1;
    this.cols = ix1 - this.ix0 + 1;
    const rows = iy1 - this.iy0 + 1;
    this.values = new Float64Array(this.cols * rows);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        this.values[r * this.cols + c] = lattice(seed, this.ix0 + c, this.iy0 + r, salt);
      }
    }
  }
  get(x: number, y: number): number {
    const fx = x / this.scale, fy = y / this.scale;
    const ix = Math.floor(fx), iy = Math.floor(fy);
    const tx = fx - ix, ty = fy - iy;
    const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
    const at = (iy - this.iy0) * this.cols + (ix - this.ix0);
    const a = this.values[at]!, b = this.values[at + 1]!;
    const c = this.values[at + this.cols]!, d = this.values[at + this.cols + 1]!;
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  }
}

// ---------------------------------------------------------------------------
// Biomes. Three octaves of value noise, sampled every four tiles and
// interpolated, pushed through a fixed equalizing curve (the empirical CDF
// of the field, sampled offline over 262,144 points), then cut into four
// equal bands: snow, grass, mud, sand. A low-frequency field cannot skip a
// band between neighbouring cells, so every border pairs B with B-1 (mod
// 4) — exactly the pairs whose seam art grow bakes (grow-art.ts
// transitionArt blends B with (B+3) % 4).

const BIOME_OCTAVES = [
  { scale: 208, weight: 0.6, salt: 0xb10e1 },
  { scale: 80, weight: 0.3, salt: 0xb10e2 },
  { scale: 28, weight: 0.1, salt: 0xb10e3 },
] as const;

/** Equalizing curve: CDF(v) at v = 0, 1/32, ..., 1 (piecewise linear). */
const BIOME_CDF: readonly number[] = [
  0, 0, 0, 0.0002, 0.0012, 0.004, 0.0103, 0.0218, 0.041, 0.0683, 0.1052,
  0.1527, 0.2091, 0.2736, 0.3453, 0.4212, 0.4985, 0.5762, 0.6513, 0.7225,
  0.7884, 0.8461, 0.8943, 0.9316, 0.959, 0.9778, 0.9894, 0.996, 0.9988,
  0.9998, 1, 1, 1,
];

/** Three-octave field at a lattice sample point (multiples of SAMPLE). */
function fieldAtSample(seed: number, sx: number, sy: number): number {
  let v = 0;
  for (const o of BIOME_OCTAVES) v += o.weight * valueNoise(seed, sx, sy, o.scale, o.salt);
  return v;
}

/** The biome field is the three-octave noise sampled every SAMPLE tiles and
 *  bilinearly interpolated between samples: the coarse octaves barely move
 *  inside four tiles, and a chunk then costs ~150 noise samples instead of
 *  ~1,400 per octave (QuickJS is the budget). */
export const BIOME_SAMPLE = 4;

function bilinear(a: number, b: number, c: number, d: number, tx: number, ty: number): number {
  return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
}

export function biomeFieldRaw(seed: number, x: number, y: number): number {
  const sx = Math.floor(x / BIOME_SAMPLE) * BIOME_SAMPLE, sy = Math.floor(y / BIOME_SAMPLE) * BIOME_SAMPLE;
  const tx = (x - sx) / BIOME_SAMPLE, ty = (y - sy) / BIOME_SAMPLE;
  return bilinear(
    fieldAtSample(seed, sx, sy), fieldAtSample(seed, sx + BIOME_SAMPLE, sy),
    fieldAtSample(seed, sx, sy + BIOME_SAMPLE), fieldAtSample(seed, sx + BIOME_SAMPLE, sy + BIOME_SAMPLE),
    tx, ty,
  );
}

/** Field values where the equalized ramp crosses k/4, k = 1..3 (the CDF
 *  is piecewise linear, so these invert it exactly per segment). */
const BAND_EDGES: readonly number[] = (() => {
  const edges: number[] = [];
  for (let k = 1; k < 4; k++) {
    const target = k / 4;
    let i = 0;
    while (i < 31 && BIOME_CDF[i + 1]! < target) i++;
    const a = BIOME_CDF[i]!, b = BIOME_CDF[i + 1]!;
    edges.push((i + (b > a ? (target - a) / (b - a) : 0)) / 32);
  }
  return edges;
})();

/** The biome band of a field value. Bands run snow, grass, mud, sand —
 *  cold to temperate to wet to dry — which is four consecutive steps of
 *  grow's cyclic order (grass, mud, sand, snow), so every border still pairs
 *  a biome with the one its seam art blends in. */
export function biomeFromField(v: number): Biome {
  let band = 0;
  while (band < 3 && v >= BAND_EDGES[band]!) band++;
  return ((band + 3) & 3) as Biome;
}

export function biomeAt(seed: number, x: number, y: number): Biome {
  return biomeFromField(biomeFieldRaw(seed, x, y));
}

/** Rectangle biome sampler: identical results to biomeAt, with each sample
 *  point's field computed once (and each lattice value hashed once). */
export class BiomeGrid {
  private readonly sx0: number;
  private readonly sy0: number;
  private readonly cols: number;
  private readonly field: Float64Array;
  constructor(seed: number, x0: number, y0: number, x1: number, y1: number) {
    this.sx0 = Math.floor(x0 / BIOME_SAMPLE);
    this.sy0 = Math.floor(y0 / BIOME_SAMPLE);
    const sx1 = Math.floor(x1 / BIOME_SAMPLE) + 1, sy1 = Math.floor(y1 / BIOME_SAMPLE) + 1;
    this.cols = sx1 - this.sx0 + 1;
    const rows = sy1 - this.sy0 + 1;
    const ax = this.sx0 * BIOME_SAMPLE, ay = this.sy0 * BIOME_SAMPLE;
    const bx = sx1 * BIOME_SAMPLE, by = sy1 * BIOME_SAMPLE;
    const grids = BIOME_OCTAVES.map((o) => new NoiseGrid(seed, o.scale, o.salt, ax, ay, bx, by));
    this.field = new Float64Array(this.cols * rows);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const sx = (this.sx0 + c) * BIOME_SAMPLE, sy = (this.sy0 + r) * BIOME_SAMPLE;
        let v = 0;
        for (let o = 0; o < BIOME_OCTAVES.length; o++) v += BIOME_OCTAVES[o]!.weight * grids[o]!.get(sx, sy);
        this.field[r * this.cols + c] = v;
      }
    }
  }
  biome(x: number, y: number): Biome {
    const qx = Math.floor(x / BIOME_SAMPLE), qy = Math.floor(y / BIOME_SAMPLE);
    const tx = (x - qx * BIOME_SAMPLE) / BIOME_SAMPLE, ty = (y - qy * BIOME_SAMPLE) / BIOME_SAMPLE;
    const at = (qy - this.sy0) * this.cols + (qx - this.sx0);
    const f = this.field;
    return biomeFromField(bilinear(f[at]!, f[at + 1]!, f[at + this.cols]!, f[at + this.cols + 1]!, tx, ty));
  }
}

/** Seam kind of a cell: B cells within Chebyshev distance 1/2/3 of a (B-1)
 *  cell get grow's transition / blend / fringe art (grow puts the same three
 *  steps on the far side of each band boundary). `lookup` returns the biome
 *  of any cell within 3 of (x, y). */
export function seamKindFrom(lookup: (x: number, y: number) => Biome, x: number, y: number): number {
  const b = lookup(x, y);
  const prev = (b + 3) & 3;
  let best = 4;
  for (let dy = -3; dy <= 3; dy++) {
    for (let dx = -3; dx <= 3; dx++) {
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      if (d === 0 || d >= best) continue;
      if (lookup(x + dx, y + dy) === prev) best = d;
    }
  }
  return best <= 3 ? best : 0;
}

// ---------------------------------------------------------------------------
// Wilderness. grow.ts's per-block species picks: a smooth forest field
// decides woods, edges, meadows and clearings; each 2x2 block holds at most
// one stamp. Blocks tile the plane with odd rows shifted one cell, so
// canopies stagger; every cell belongs to exactly one block, and a 2x2 stamp
// fills its block, so nature is local to the block (no cross-block lookups).

type Pick = readonly (readonly [string, number])[];
/** A species table flattened for the hot path: cumulative weights, no
 *  per-call destructuring (QuickJS iterates tuples slowly). */
interface PickTable { keys: readonly string[]; cum: Float64Array; total: number }
function table(list: Pick): PickTable {
  const cum = new Float64Array(list.length);
  let total = 0;
  list.forEach(([, w], i) => { total += w; cum[i] = total; });
  return { keys: list.map(([k]) => k), cum, total };
}
/** grow.ts's pick(): the first entry whose running weight exceeds r * total. */
function pick(t: PickTable, r: number): string {
  const at = r * t.total;
  for (let i = 0; i < t.keys.length; i++) if (at < t.cum[i]!) return t.keys[i]!;
  return t.keys[t.keys.length - 1]!;
}
// Species tables mirror grow.ts (WOOD / EDGE / MEADOW / STRAY).
const WOOD: readonly PickTable[] = ([
  [["tree-round", 5], ["tree-round-b", 4], ["tree-round-c", 3], ["tree-pine", 3], ["tree-cherry", 0.35]],
  [["tree-pine", 6], ["tree-round-c", 1.2], ["tree-dead", 2.4], ["stump-big", 0.3], ["boulder-brown", 0.4]],
  [["palm", 5], ["palm-b", 4], ["boulder-brown", 0.8]],
  [["tree-snowpine", 5], ["tree-snowpine-moss", 3], ["tree-snowround", 2], ["bush-snow", 0.8]],
] as readonly Pick[]).map(table);
const EDGE: readonly PickTable[] = ([
  [["bush-a", 3], ["bush-b", 3], ["bush-c", 2], ["tuft-b", 1]],
  [["bush-c", 3], ["stump", 1.5], ["rock-brown", 1.5], ["twig", 0.6]],
  [["tuft-c", 2], ["rock-brown", 2]],
  [["snow-round", 3], ["snow-grass", 2], ["snow-rock", 1.5]],
] as readonly Pick[]).map(table);
const MEADOW: readonly PickTable[] = ([
  [["flower-sun", 2], ["flower-sun-b", 1.5], ["flower-daisy", 2], ["clover", 2], ["tuft-a", 2.5], ["tuft-c", 2]],
  [["tuft-b", 3], ["clover", 1.5], ["leaves", 0.6]],
  [["tuft-c", 2], ["rock-brown", 0.5]],
  [["snow-grass", 3], ["snow-grass-b", 3], ["snowball", 1]],
] as readonly Pick[]).map(table);
const STRAY: readonly PickTable[] = ([
  [["rock-grey", 1], ["tuft-a", 2], ["bush-b", 1]],
  [["rock-brown", 2], ["stump", 1]],
  [["rock-brown", 2], ["tuft-c", 1]],
  [["snow-rock", 2], ["snowball", 1]],
] as readonly Pick[]).map(table);
const WOOD_THRESHOLD = 0.53, EDGE_THRESHOLD = 0.42, MEADOW_THRESHOLD = 0.56;

export const NOISE = {
  forestA: { scale: 13, salt: 0xf0e5 },
  forestB: { scale: 4.5, salt: 0x1ea7 },
  patch: { scale: 9, salt: 0x5bec },
  meadow: { scale: 6, salt: 0x3ead },
} as const;

/** Block (bx, by) covers x in [x0, x0+1], y in [y0, y0+1]. */
export function blockOrigin(bx: number, by: number): { x0: number; y0: number } {
  return { x0: bx * 2 + (by & 1), y0: by * 2 };
}
/** The block that owns cell (x, y). */
export function blockOfCell(x: number, y: number): { bx: number; by: number } {
  const by = Math.floor(y / 2);
  return { bx: Math.floor((x - (by & 1)) / 2), by };
}

export interface NatureSampler {
  forest(x: number, y: number): number;
  patch(x: number, y: number): number;
  meadow(x: number, y: number): number;
  biome(x: number, y: number): Biome;
  /** 0 inside a town site's clearing, 1 in open country. */
  clearing(x: number, y: number): number;
}

/** Point sampler: every call hashes its lattice corners. */
export function pointNature(seed: number): NatureSampler {
  return {
    forest: (x, y) => 0.68 * valueNoise(seed, x, y, NOISE.forestA.scale, NOISE.forestA.salt)
      + 0.32 * valueNoise(seed, x, y, NOISE.forestB.scale, NOISE.forestB.salt),
    patch: (x, y) => valueNoise(seed, x, y, NOISE.patch.scale, NOISE.patch.salt),
    meadow: (x, y) => valueNoise(seed, x, y, NOISE.meadow.scale, NOISE.meadow.salt),
    biome: (x, y) => biomeAt(seed, x, y),
    clearing: (x, y) => townClearing(seed, x, y),
  };
}

/** A placed natural stamp: key and top-left cell. */
export interface BlockItem { key: string; x: number; y: number }

/** What one 2x2 wilderness block holds (grow.ts blockStamp, minus the
 *  strip bounds). Pure in (seed, bx, by) given a sampler of the same seed. */
export function blockStamp(seed: number, bx: number, by: number, s: NatureSampler): BlockItem | undefined {
  const x0 = bx * 2 + (by & 1), y0 = by * 2;
  const h = growHash(seed, bx, by, 0xb10c);
  const r = (h % 10007) / 10007, jitter = ((h >>> 14) % 10007) / 10007;
  const biome = s.biome(x0, y0 + 1);
  const patch = s.patch(x0, y0);
  const species = Math.min(0.9999, Math.max(0, 0.78 * patch + 0.22 * jitter));
  const sparse = biome === 2 ? 0.8 : 1; // the desert stays open
  const d = s.forest(x0 + 1, y0 + 1) * sparse * (0.45 + 0.55 * s.clearing(x0 + 1, y0 + 1));
  // A 1x1 item sits in one cell of the block, chosen by the hash's top bits.
  const cell = h >>> 28;
  const ox = x0 + (cell & 1), oy = y0 + ((cell >> 1) & 1);
  if (d >= WOOD_THRESHOLD) {
    if (r < 0.84) return { key: pick(WOOD[biome]!, species), x: x0, y: y0 };
    return r < 0.9 ? { key: pick(EDGE[biome]!, jitter), x: ox, y: oy } : undefined;
  }
  if (d >= EDGE_THRESHOLD) {
    const t = (d - EDGE_THRESHOLD) / (WOOD_THRESHOLD - EDGE_THRESHOLD);
    if (r < 0.1 + 0.32 * t) return { key: biome === 0 && jitter < 0.4 ? "tree-small" : pick(WOOD[biome]!, species), x: x0, y: y0 };
    if (r < 0.5) return { key: pick(EDGE[biome]!, jitter), x: ox, y: oy };
    return undefined;
  }
  const m = s.meadow(x0, y0);
  if (m >= MEADOW_THRESHOLD && r < 0.6 + (m - MEADOW_THRESHOLD)) return { key: pick(MEADOW[biome]!, jitter), x: ox, y: oy };
  if (r < 0.03) return { key: pick(STRAY[biome]!, jitter), x: ox, y: oy };
  return undefined;
}

/** Natural upper cell at (x, y): the stamp cell id, or 0. */
export function naturalCellAt(seed: number, x: number, y: number, s: NatureSampler = pointNature(seed)): number {
  const { bx, by } = blockOfCell(x, y);
  const item = blockStamp(seed, bx, by, s);
  if (!item) return 0;
  const st = STAMPS[item.key]!;
  const dx = x - item.x, dy = y - item.y;
  return dx >= 0 && dy >= 0 && dx < st.w && dy < st.h ? stampCell(item.key, dx, dy) : 0;
}

// ---------------------------------------------------------------------------
// Regions: one optional town per 96x96 region, and a gate on each edge.

const TOWN_CHANCE: readonly number[] = [0.78, 0.62, 0.5, 0.58]; // by hub biome
const HUB_JITTER_X = 12, HUB_JITTER_Y = 10;

/** Fraction of regions that are trackless wild: no town and no road grows
 *  there, so a long walk leaves the settled country behind and finds only
 *  landmarks. The roll is a pure hash both sides of every edge evaluate
 *  identically, so suppressing a gate suppresses it from both regions. */
const WILD_CHANCE = 0.06;
export function isWild(seed: number, rx: number, ry: number): boolean {
  return (growHash(seed, rx, ry, 0x3d1a) % 10007) / 10007 < WILD_CHANCE;
}

export interface RegionHub {
  rx: number; ry: number;
  /** World tile of the hub: a town's plaza, or a crossroads in the wild. */
  x: number; y: number;
  biome: Biome;
  town: boolean;
}

export function regionHub(seed: number, rx: number, ry: number): RegionHub {
  const h = growHash(seed, rx, ry, 0x4b0b);
  const jx = (h % (2 * HUB_JITTER_X + 1)) - HUB_JITTER_X;
  const jy = ((h >>> 8) % (2 * HUB_JITTER_Y + 1)) - HUB_JITTER_Y;
  const x = rx * REGION + REGION / 2 + jx;
  const y = ry * REGION + REGION / 2 + jy;
  const biome = biomeAt(seed, x, y);
  const roll = (growHash(seed, rx, ry, 0x70e5) % 10007) / 10007;
  return { rx, ry, x, y, biome, town: roll < TOWN_CHANCE[biome]! && !isWild(seed, rx, ry) };
}

/** 0 inside a town site (so the plaza lands in a clearing, as grow's
 *  chapters do), 1 in open country. Only the cell's own region can hold a
 *  town close enough to matter: hubs sit 36+ tiles inside their region. */
export function townClearing(seed: number, x: number, y: number): number {
  return townClearingFrom(regionHub(seed, regionOf(x), regionOf(y)), x, y);
}
/** townClearing given the hub of (x, y)'s own region. */
export function townClearingFrom(hub: RegionHub, x: number, y: number): number {
  if (!hub.town) return 1;
  const dx = (x - hub.x) / 1.35, dy = (y - hub.y + 2) * 1.15;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const t = Math.max(0, Math.min(1, (dist - 12) / 9));
  return t * t * (3 - 2 * t);
}

/** Gate edges. A vertical edge sits between regions (rx-1, ry) and (rx, ry)
 *  at world x = rx * 96; a horizontal edge between (rx, ry-1) and (rx, ry)
 *  at world y = ry * 96. Both sides call this with the same key. */
export interface Gate {
  active: boolean;
  /** Offset of the road along the edge, 12..83 tiles from the edge start. */
  at: number;
}
const GATE_CHANCE = 0.72;
export function gateOf(seed: number, vertical: boolean, rx: number, ry: number): Gate {
  const h = growHash(seed, rx, ry, vertical ? 0x6a7e : 0x6a7f);
  // The two regions this edge joins (both compute it identically): a wild
  // region on either side keeps the edge closed, so no road enters it.
  const arx = vertical ? rx - 1 : rx, ary = vertical ? ry : ry - 1;
  const active = (h % 10007) / 10007 < GATE_CHANCE
    && !isWild(seed, arx, ary) && !isWild(seed, rx, ry);
  return { active, at: 12 + ((h >>> 12) % 72) };
}

/** Gates of region (rx, ry): west, east, north, south. */
export function regionGates(seed: number, rx: number, ry: number): { w: Gate; e: Gate; n: Gate; s: Gate } {
  return {
    w: gateOf(seed, true, rx, ry),
    e: gateOf(seed, true, rx + 1, ry),
    n: gateOf(seed, false, rx, ry),
    s: gateOf(seed, false, rx, ry + 1),
  };
}

// Ground tile of an undeveloped cell in the generated project (grow-project
// uses the same four biome base ids).
export const BIOME_BASE_TILE = [90, 91, 92, 93] as const;
export { GROW_TILE };
