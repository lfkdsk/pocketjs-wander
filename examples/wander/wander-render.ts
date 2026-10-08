// examples/wander/wander-render.ts — the render ring: pooled native nodes.
//
// Only the viewport plus a small overscan is ever mounted. Each layer owns
// a toroidal grid of slots exactly one render ring in size: tile (x, y)
// always lands in slot (x mod W, y mod H), so when the camera crosses a tile
// edge the column that scrolls out and the column that scrolls in share
// slots, and the slot's node is simply re-pointed (a translate and, if the
// art differs, a src). Walking never creates, destroys, inserts or removes
// a node once the pools are warm.
//
// Layers, bottom to top:
//
//   blocks  256 px biome fills, one per 16 x 16 tiles (the majority biome)
//   subs    64 px fills on plain 4 x 4 patches whose biome differs from the
//           block's
//   ground  one 16 px layer for everything flat: roads, plazas and fields
//           where development has grown (grow's ground art is opaque), and
//           elsewhere grow's transition / blend / fringe seam art plus the
//           few plain cells no fill covers
//   sprites the player and the residents (WanderView)
//   upper   props (16 px) and every multi-cell stamp — trees, boulders,
//           houses — as ONE node anchored on its top-left cell; the ring
//           overscans three tiles left and up so the anchor of anything
//           visible is always inside it
//
// A slot takes a node the first time it has something to show; a slot that
// empties hides its node and hands it to a pool shared by the layers (fills
// share one, cells another), where another layer can take it. Every layer
// has a hard cap (at most one node per slot, so the ring's cell count
// bounds the scene); a cell past the cap is dropped and counted.
//
// Positions are relative to a render origin in world tiles, re-based only
// when the camera wanders 65,536 tiles away, so every translate stays below
// 2^21 px and exact in the core's f32 — world tiles can be anywhere in int32.

import { createElement, insertNode, setProp, type NodeMirror } from "@pocketjs/framework/renderer";
import { jump } from "@pocketjs/framework/animation";
import { biomeAt, CHUNK } from "./world.ts";
import { groundAt, NO_SUB, upperAt, type ChunkData } from "./chunk.ts";
import { chunkKey, regionKey, type Residency } from "./residency.ts";
import { STAMP_LIST } from "../../vendor/pocket-rpgkit/examples/grow/grow-stamps.ts";
import { WANDER_BLOCK, WANDER_FILL64, WANDER_GROUND, WANDER_STAMPS, WANDER_TERRAIN, WANDER_UPPER } from "./assets-wander.ts";

export const TILE = 16;
/** Overscan on the left/top (the widest stamp is 4 x 3) and right/bottom. */
export const OVERSCAN_LEAD = 3;
export const OVERSCAN_TRAIL = 1;
const BLOCK_TILES = 16;
const SUB_TILES = 4;
const REBASE = 65536;


// Cell id -> whole-stamp anchor info. For a stamp's top-left cell: its
// image and size; for its other cells: "covered" (drawn by the anchor).
const STAMP_SRC: (string | undefined)[] = [];
const STAMP_W: number[] = [];
const STAMP_H: number[] = [];
const STAMP_COVERED: boolean[] = [];
for (const [base, w, h, src] of WANDER_STAMPS) {
  STAMP_SRC[base] = src;
  STAMP_W[base] = w;
  STAMP_H[base] = h;
}
for (const st of STAMP_LIST) {
  if (st.w * st.h > 1) for (let i = 1; i < st.w * st.h; i++) STAMP_COVERED[st.base + i] = true;
}

interface NodeRec { node: NodeMirror; src: string | null; x: number; y: number; w: number; h: number }

function imageNode(parent: NodeMirror, w: number, h: number): NodeRec {
  const node = createElement("image");
  setProp(node, "style", { posType: 1, insetL: 0, insetT: 0, width: w, height: h });
  insertNode(parent, node);
  return { node, src: null, x: NaN, y: NaN, w, h };
}

function place(rec: NodeRec, x: number, y: number): void {
  if (rec.x !== x) { jump(rec.node, "translateX", x); rec.x = x; }
  if (rec.y !== y) { jump(rec.node, "translateY", y); rec.y = y; }
}
function show(rec: NodeRec, src: string | null): void {
  if (rec.src !== src) { setProp(rec.node, "src", src, rec.src); rec.src = src; }
}
function size(rec: NodeRec, w: number, h: number): void {
  if (rec.w !== w || rec.h !== h) {
    setProp(rec.node, "style", { width: w, height: h }, { width: rec.w, height: rec.h });
    rec.w = w;
    rec.h = h;
  }
}

function container(parent: NodeMirror, name: string): NodeMirror {
  const node = createElement("view");
  setProp(node, "style", { posType: 1, insetL: 0, insetT: 0, width: 0, height: 0 });
  setProp(node, "debugName", name);
  insertNode(parent, node);
  return node;
}

/** Hidden image nodes any 16 px-grid layer may take. A node freed by one
 *  layer stays attached where it is (hidden) until another layer needs it,
 *  so the scene holds about as many nodes as are ever visible at once, not
 *  the sum of every layer's own peak. Nodes are never destroyed: a destroyed
 *  node is cyclic garbage for QuickJS's collector, and every live node costs
 *  it ~45 objects to walk, so both are kept low. */
class SharedPool {
  readonly free: NodeRec[] = [];
  created = 0;
}

/** One pooled layer over a toroidal slot grid. */
class SlotLayer {
  readonly root: NodeMirror;
  private slots: (NodeRec | null)[] = [];
  visible = 0;
  dropped = 0;
  cap = 0;
  constructor(parent: NodeMirror, name: string, private readonly nodeSize: number, private readonly pool: SharedPool) {
    this.root = container(parent, name);
  }
  resize(slots: number): void {
    for (const rec of this.slots) if (rec) { show(rec, null); this.pool.free.push(rec); }
    this.slots = new Array(slots).fill(null);
    this.visible = 0;
    this.cap = Math.max(this.cap, slots);
  }
  set(slot: number, src: string | null, px: number, py: number, w = this.nodeSize, h = this.nodeSize): void {
    let rec = this.slots[slot] ?? null;
    if (!src) {
      if (rec) { show(rec, null); this.pool.free.push(rec); this.slots[slot] = null; this.visible--; }
      return;
    }
    if (!rec) {
      rec = this.pool.free.pop() ?? null;
      if (rec) {
        if (rec.node.parent !== this.root) insertNode(this.root, rec.node);
      } else {
        if (this.visible >= this.cap) { this.dropped++; return; }
        rec = imageNode(this.root, w, h);
        this.pool.created++;
      }
      this.slots[slot] = rec;
      this.visible++;
    }
    size(rec, w, h);
    place(rec, px, py);
    show(rec, src);
  }
  shift(dx: number, dy: number): void {
    for (const rec of this.slots) if (rec) place(rec, rec.x + dx, rec.y + dy);
  }
}

/** A toroidal grid over cells of `span` tiles (1, 4 or 16). */
class Grid {
  W = 0;
  H = 0;
  keyX = new Float64Array(0);
  keyY = new Float64Array(0);
  constructor(readonly span: number) {}
  resize(cols: number, rows: number): void {
    this.W = cols;
    this.H = rows;
    this.keyX = new Float64Array(cols * rows).fill(NaN);
    this.keyY = new Float64Array(cols * rows).fill(NaN);
  }
  slot(gx: number, gy: number): number {
    return (((gy % this.H) + this.H) % this.H) * this.W + (((gx % this.W) + this.W) % this.W);
  }
}

export interface RenderStats {
  mounted: number; visible: number; dropped: number; cap: number; refillQueue: number;
  /** Visible nodes per layer: blocks, subs, ground, upper. */
  layers: number[];
}

export class RenderRing {
  readonly root: NodeMirror;
  private readonly blocks: SlotLayer;
  private readonly subs: SlotLayer;
  private readonly ground: SlotLayer;
  readonly sprites: NodeMirror;
  private readonly upper: SlotLayer;
  private readonly cellPool = new SharedPool();
  private readonly fillPool = new SharedPool();
  private readonly cells = new Grid(1);
  private readonly subGrid = new Grid(SUB_TILES);
  private readonly blockGrid = new Grid(BLOCK_TILES);
  /** Render origin, world tiles. */
  ox = 0;
  oy = 0;
  private rect = { x0: 0, y0: 0, valid: false };
  private readonly renderedTick = new Map<number, number>();
  private readonly placeholder = new Map<number, number>();
  /** Cells (world coords) whose chunk arrived after they were drawn. */
  private refill: number[] = [];
  private readonly tickCache = new Map<number, number>();
  private chunkCache: ChunkData | undefined;
  private chunkCacheKey = NaN;

  constructor(parent: NodeMirror, private res: Residency, private seed: number, private now: () => number) {
    this.root = container(parent, "wander-world");
    this.blocks = new SlotLayer(this.root, "wander-blocks", BLOCK_TILES * TILE, this.fillPool);
    this.subs = new SlotLayer(this.root, "wander-subs", SUB_TILES * TILE, this.fillPool);
    this.ground = new SlotLayer(this.root, "wander-ground", TILE, this.cellPool);
    this.sprites = container(this.root, "wander-sprites");
    this.upper = new SlotLayer(this.root, "wander-upper", TILE, this.cellPool);
  }

  /** Point the ring at a new world (seed change): every node is kept. */
  reset(res: Residency, seed: number, originX: number, originY: number): void {
    this.res = res;
    this.seed = seed;
    this.ox = originX;
    this.oy = originY;
    this.renderedTick.clear();
    this.placeholder.clear();
    this.refill = [];
    this.chunkCache = undefined;
    this.chunkCacheKey = NaN;
    this.resize(this.cells.W, this.cells.H, true);
  }

  /** Size the ring for a viewport (tiles incl. overscan). */
  resize(cols: number, rows: number, force = false): void {
    if (!force && cols === this.cells.W && rows === this.cells.H) return;
    this.cells.resize(cols, rows);
    this.subGrid.resize(Math.floor((cols - 1) / SUB_TILES) + 2, Math.floor((rows - 1) / SUB_TILES) + 2);
    this.blockGrid.resize(Math.floor((cols - 1) / BLOCK_TILES) + 2, Math.floor((rows - 1) / BLOCK_TILES) + 2);
    const n = cols * rows;
    this.ground.resize(n);
    this.upper.resize(n);
    this.subs.resize(this.subGrid.W * this.subGrid.H);
    this.blocks.resize(this.blockGrid.W * this.blockGrid.H);
    this.rect.valid = false;
  }

  get nodeCap(): number {
    return this.ground.cap + this.upper.cap + this.subs.cap + this.blocks.cap;
  }

  /** Re-draw every cell of the current rect next frame (one-off decor such
   *  as a helped town's plaza flowers). */
  invalidateAll(): void {
    if (!this.rect.valid) return;
    const x1 = this.rect.x0 + this.cells.W - 1, y1 = this.rect.y0 + this.cells.H - 1;
    for (let y = this.rect.y0; y <= y1; y++) {
      for (let x = this.rect.x0; x <= x1; x++) this.refill.push(x, y);
    }
  }

  stats(): RenderStats {
    const layers = [this.blocks, this.subs, this.ground, this.upper];
    let visible = 0, dropped = 0;
    for (const l of layers) { visible += l.visible; dropped += l.dropped; }
    return {
      mounted: this.cellPool.created + this.fillPool.created, visible, dropped,
      cap: this.nodeCap, refillQueue: this.refill.length / 2,
      layers: layers.map((l) => l.visible),
    };
  }

  private regionTickCached(rx: number, ry: number): number {
    const k = regionKey(rx, ry);
    let t = this.tickCache.get(k);
    if (t === undefined) { t = this.res.regionTick(rx, ry, this.now()); this.tickCache.set(k, t); }
    return t;
  }

  private chunkAt(tx: number, ty: number): ChunkData | undefined {
    const cx = Math.floor(tx / CHUNK), cy = Math.floor(ty / CHUNK);
    const k = cx * 134217728 + cy;
    if (k !== this.chunkCacheKey) { this.chunkCacheKey = k; this.chunkCache = this.res.chunk(cx, cy); }
    return this.chunkCache;
  }

  /** Draw cell (tx, ty) into its slot on every cell layer. */
  private syncCell(tx: number, ty: number): void {
    const grid = this.cells;
    const slot = grid.slot(tx, ty);
    grid.keyX[slot] = tx;
    grid.keyY[slot] = ty;
    const px = (tx - this.ox) * TILE, py = (ty - this.oy) * TILE;
    const c = this.chunkAt(tx, ty);
    if (!c) {
      this.ground.set(slot, null, px, py);
      this.upper.set(slot, null, px, py);
      return;
    }
    const lx = tx - c.x0, ly = ty - c.y0, i = ly * CHUNK + lx;
    const k = this.regionTickCached(c.rx, c.ry);
    const g = groundAt(c, i, k);
    if (g) {
      this.ground.set(slot, WANDER_GROUND[g] ?? null, px, py);
    } else {
      const t = c.terrain[i]!;
      const biome = t & 3, kind = t >> 2;
      const sub = c.subBiome[(ly >> 2) * 8 + (lx >> 2)]!;
      const fill = sub !== NO_SUB ? sub : c.blockBiome[(ly >> 4) * 2 + (lx >> 4)]!;
      this.ground.set(slot, kind || biome !== fill ? WANDER_TERRAIN[biome]![kind]! : null, px, py);
    }
    const u = upperAt(c, i, k);
    const stamp = STAMP_SRC[u];
    if (stamp) this.upper.set(slot, stamp, px, py, STAMP_W[u], STAMP_H[u]);
    else this.upper.set(slot, STAMP_COVERED[u] ? null : WANDER_UPPER[u] ?? null, px, py);
  }

  private blockBiome(bx: number, by: number): number {
    const tx = bx * BLOCK_TILES, ty = by * BLOCK_TILES;
    const c = this.chunkAt(tx, ty);
    if (c) return c.blockBiome[(((ty - c.y0) >> 4) * 2) + ((tx - c.x0) >> 4)]!;
    // Placeholder while the chunk generates: the biome at the block centre.
    const k = bx * 134217728 + by;
    let b = this.placeholder.get(k);
    if (b === undefined) {
      if (this.placeholder.size > 512) this.placeholder.clear();
      b = biomeAt(this.seed, tx + BLOCK_TILES / 2, ty + BLOCK_TILES / 2);
      this.placeholder.set(k, b);
    }
    return b;
  }

  private syncBlock(bx: number, by: number): void {
    const g = this.blockGrid, slot = g.slot(bx, by);
    g.keyX[slot] = bx; g.keyY[slot] = by;
    this.blocks.set(slot, WANDER_BLOCK[this.blockBiome(bx, by)]!, (bx * BLOCK_TILES - this.ox) * TILE, (by * BLOCK_TILES - this.oy) * TILE);
  }

  private syncSub(sx: number, sy: number): void {
    const g = this.subGrid, slot = g.slot(sx, sy);
    g.keyX[slot] = sx; g.keyY[slot] = sy;
    const tx = sx * SUB_TILES, ty = sy * SUB_TILES;
    const c = this.chunkAt(tx, ty);
    let src: string | null = null;
    if (c) {
      const lx = tx - c.x0, ly = ty - c.y0;
      const sub = c.subBiome[(ly >> 2) * 8 + (lx >> 2)]!;
      if (sub !== NO_SUB && sub !== c.blockBiome[(ly >> 4) * 2 + (lx >> 4)]) src = WANDER_FILL64[sub]!;
    }
    this.subs.set(slot, src, (tx - this.ox) * TILE, (ty - this.oy) * TILE);
  }

  /** Coarse grids: (re)draw every slot whose key is stale for this rect. */
  private syncCoarse(g: Grid, x0: number, y0: number, draw: (gx: number, gy: number) => void, force: boolean): void {
    const gx0 = Math.floor(x0 / g.span), gy0 = Math.floor(y0 / g.span);
    for (let gy = gy0; gy < gy0 + g.H; gy++) {
      for (let gx = gx0; gx < gx0 + g.W; gx++) {
        const slot = g.slot(gx, gy);
        if (force || g.keyX[slot] !== gx || g.keyY[slot] !== gy) draw(gx, gy);
      }
    }
  }

  /**
   * One frame: camera top-left in world px and the chunks that finished
   * since the last frame. Returns the world-root translate.
   */
  update(camX: number, camY: number, fresh: readonly ChunkData[], cellBudget = 700): { x: number; y: number } {
    this.tickCache.clear();
    this.chunkCacheKey = NaN;
    const ctx = Math.floor(camX / TILE), cty = Math.floor(camY / TILE);
    if (Math.abs(ctx - this.ox) > REBASE || Math.abs(cty - this.oy) > REBASE) {
      // Re-base the render origin (once per 65,536 tiles of travel).
      const dx = (this.ox - ctx) * TILE, dy = (this.oy - cty) * TILE;
      for (const l of [this.blocks, this.subs, this.ground, this.upper]) l.shift(dx, dy);
      this.ox = ctx;
      this.oy = cty;
    }
    const W = this.cells.W, H = this.cells.H;
    const x0 = ctx - OVERSCAN_LEAD, y0 = cty - OVERSCAN_LEAD;
    const x1 = x0 + W - 1, y1 = y0 + H - 1;
    const prev = this.rect;
    const full = !prev.valid || Math.abs(prev.x0 - x0) >= W || Math.abs(prev.y0 - y0) >= H;
    if (full) {
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) this.syncCell(x, y);
      this.refill = [];
    } else if (prev.x0 !== x0 || prev.y0 !== y0) {
      const px1 = prev.x0 + W - 1, py1 = prev.y0 + H - 1;
      for (let y = y0; y <= y1; y++) {
        const rowNew = y < prev.y0 || y > py1;
        for (let x = x0; x <= x1; x++) if (rowNew || x < prev.x0 || x > px1) this.syncCell(x, y);
      }
    }
    this.syncCoarse(this.blockGrid, x0, y0, (bx, by) => this.syncBlock(bx, by), full);
    this.syncCoarse(this.subGrid, x0, y0, (sx, sy) => this.syncSub(sx, sy), full);
    // Chunks that arrived: redraw their fills now, queue their cells.
    for (const c of fresh) {
      if (c.x0 + CHUNK - 1 < x0 || c.x0 > x1 || c.y0 + CHUNK - 1 < y0 || c.y0 > y1) continue;
      this.syncCoarse(this.blockGrid, x0, y0, (bx, by) => {
        if (bx * BLOCK_TILES >= c.x0 && bx * BLOCK_TILES < c.x0 + CHUNK && by * BLOCK_TILES >= c.y0 && by * BLOCK_TILES < c.y0 + CHUNK) this.syncBlock(bx, by);
      }, true);
      this.syncCoarse(this.subGrid, x0, y0, (sx, sy) => {
        if (sx * SUB_TILES >= c.x0 && sx * SUB_TILES < c.x0 + CHUNK && sy * SUB_TILES >= c.y0 && sy * SUB_TILES < c.y0 + CHUNK) this.syncSub(sx, sy);
      }, true);
      const ya = Math.max(y0, c.y0), yb = Math.min(y1, c.y0 + CHUNK - 1);
      const xa = Math.max(x0, c.x0), xb = Math.min(x1, c.x0 + CHUNK - 1);
      for (let y = ya; y <= yb; y++) for (let x = xa; x <= xb; x++) this.refill.push(x, y);
    }
    // Growth: cells whose birth or clearing tick was crossed.
    const cx0 = Math.floor(x0 / CHUNK), cx1 = Math.floor(x1 / CHUNK);
    const cy0 = Math.floor(y0 / CHUNK), cy1 = Math.floor(y1 / CHUNK);
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const c = this.res.chunk(cx, cy);
        if (!c || !c.growCells.length) continue;
        const tick = this.regionTickCached(c.rx, c.ry);
        const key = chunkKey(cx, cy);
        const last = this.renderedTick.get(key);
        this.renderedTick.set(key, tick);
        if (last === undefined || last === tick) continue;
        const lo = Math.min(last, tick), hi = Math.max(last, tick);
        for (let n = 0; n < c.growCells.length; n++) {
          const i = c.growCells[n]!;
          const born = c.devBorn[i]!, hide = c.natHide[i]!;
          if (!((born > lo && born <= hi) || (hide > lo && hide <= hi))) continue;
          const tx = c.x0 + (i % CHUNK), ty = c.y0 + (i >> 5);
          if (tx >= x0 && tx <= x1 && ty >= y0 && ty <= y1) this.syncCell(tx, ty);
        }
      }
    }
    if (this.renderedTick.size > 256) this.renderedTick.clear();
    // Refill queued cells under a per-frame cell budget.
    let n = 0;
    while (this.refill.length && n < cellBudget) {
      const ty = this.refill.pop()!, tx = this.refill.pop()!;
      if (tx >= x0 && tx <= x1 && ty >= y0 && ty <= y1) { this.syncCell(tx, ty); n++; }
    }
    this.rect = { x0, y0, valid: true };
    return { x: this.ox * TILE - camX, y: this.oy * TILE - camY };
  }
}
