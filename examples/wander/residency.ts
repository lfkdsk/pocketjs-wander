// examples/wander/residency.ts — focus-driven chunk residency.
//
// Three explicit rings around the focus point (the player's tile plus a
// lead in the walking direction), all rectangles in tiles:
//
//   render ring  the viewport plus a small overscan: the only cells the
//                view mounts as native nodes (wander-render.ts, which also
//                holds the node cap); computed by the view from the camera
//   load ring    render ring + LOAD_MARGIN: chunks it touches are wanted,
//                queued if missing and generated under the budget
//   unload ring  load ring + HYSTERESIS: resident chunks outside it are
//                evicted, so walking back and forth across one chunk edge
//                never regenerates anything
//
// plus a hard LRU cap on resident chunks (derived from the unload ring's
// worst case) and a byte estimate. Region plans live in their own small LRU.
//
// Generation runs in a work queue ordered by distance to the focus minus a
// bonus for lying along the heading; the session window's 3x3 chunks jump
// the queue. Work is metered in units (about 1 us of QuickJS each) and
// every job advances in slices of at most STEP_MAX units: runBudget(n)
// starts a slice only while spent + STEP_MAX <= n, so no call ever spends
// more than its budget. The simulation spends the budget once per 60 Hz
// reference tick, so residency itself is a deterministic function of the
// input stream at every host rate.
//
// Growth bookkeeping lives here too: a bounded "seen" Bloom filter of
// discovered regions (a region revisited after its growth finished simply
// shows complete, and a rare false positive shows complete early) and a
// capped map of regions growing right now, keyed to their discovery tick.

import { CHUNK, REGION, REGION_CHUNKS, growHash, regionGates, regionHub, type RegionHub } from "./world.ts";
import { chunkJob, COMPLETE, UNDISCOVERED, type ChunkData } from "./chunk.ts";
import { GROWTH_TICK_FRAMES, planRegionJob, type RegionPlan } from "./region.ts";

/** Largest slice any job may take (units; one unit is about a microsecond
 *  of desktop QuickJS). */
export const STEP_MAX = 420;
/** Work units per 60 Hz reference tick (about 1.5 ms of desktop QuickJS). */
export const TICK_BUDGET = 1500;
export const LOAD_MARGIN = 24;
export const HYSTERESIS = 32;
export const PLAN_CAP = 12;
export const GROWING_CAP = 32;
const BLOOM_BITS = 1 << 14;

/** Exact numeric keys over the whole int32 tile range (chunks need 27 bits
 *  per axis, regions 26; both products stay below 2^53). */
export function chunkKey(cx: number, cy: number): number {
  return cx * 134217728 + cy;
}
export function regionKey(rx: number, ry: number): number {
  return rx * 67108864 + ry;
}

export interface Rect { x0: number; y0: number; x1: number; y1: number }

export interface Focus {
  /** Focus tile (player + lead). */
  x: number;
  y: number;
  /** Unit heading (-1/0/1 per axis). */
  hx: number;
  hy: number;
}

export type ChunkState = "rendered" | "resident" | "queued" | "evicted" | "none";

interface Job {
  kind: "plan" | "chunk";
  key: number;
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  gen: Generator<number, RegionPlan | ChunkData>;
}

export interface ResidencyStats {
  resident: number;
  cap: number;
  bytes: number;
  plans: number;
  queued: number;
  generatedTotal: number;
  evictedTotal: number;
  /** Chunks finished during the last 60 reference ticks. */
  generatedLastSecond: number;
  seenRegions: number;
  growing: number;
  maxResident: number;
  /** Largest per-tick spend so far. */
  maxSpent: number;
}

export class Residency {
  readonly chunks = new Map<number, ChunkData>();
  /** Last reference tick each resident chunk was wanted (LRU order). */
  private readonly used = new Map<number, number>();
  private readonly plans = new Map<number, RegionPlan>();
  private readonly planUsed = new Map<number, number>();
  private readonly hubs = new Map<number, RegionHub>();
  /** key -> [cx, cy, priority score] for every chunk the load ring (or the
   *  session window) wants. */
  private readonly wanted = new Map<number, [number, number, number]>();
  private readonly pinned = new Set<number>();
  private readonly recentEvicted: number[] = [];
  private readonly recentGenerated: number[] = [];
  private job: Job | null = null;
  private queueCache: number[] = [];
  private queueDirty = true;
  private readonly bloom = new Uint32Array(BLOOM_BITS / 32);
  private seenCount = 0;
  /** Regions growing now: key -> discovery reference tick. */
  readonly growing = new Map<number, number>();
  private loadRect: Rect = { x0: 0, y0: 0, x1: -1, y1: -1 };
  private unloadRect: Rect = { x0: 0, y0: 0, x1: -1, y1: -1 };
  private tick = 0;
  cap = 32;
  generatedTotal = 0;
  evictedTotal = 0;
  maxResident = 0;
  maxSpent = 0;
  /** Chunks completed since the view last drained them. */
  readonly fresh: ChunkData[] = [];

  constructor(readonly seed: number) {}

  // -- region facts (pure, memoized) --------------------------------------

  hub(rx: number, ry: number): RegionHub {
    const k = regionKey(rx, ry);
    let h = this.hubs.get(k);
    if (!h) {
      if (this.hubs.size >= 256) this.hubs.clear();
      h = regionHub(this.seed, rx, ry);
      this.hubs.set(k, h);
    }
    return h;
  }
  /** A region with nothing to grow never enters the seen set. */
  regionDeveloped(rx: number, ry: number): boolean {
    if (this.hub(rx, ry).town) return true;
    const g = regionGates(this.seed, rx, ry);
    return g.w.active || g.e.active || g.n.active || g.s.active;
  }
  plan(rx: number, ry: number): RegionPlan | undefined {
    const k = regionKey(rx, ry);
    const p = this.plans.get(k);
    if (p) this.planUsed.set(k, this.tick);
    return p;
  }
  chunk(cx: number, cy: number): ChunkData | undefined {
    return this.chunks.get(chunkKey(cx, cy));
  }

  // -- growth ---------------------------------------------------------------

  private bloomBits(rx: number, ry: number): [number, number, number] {
    const h1 = growHash(this.seed, rx, ry, 0x5ee1), h2 = growHash(this.seed, rx, ry, 0x5ee2);
    return [h1 % BLOOM_BITS, h2 % BLOOM_BITS, ((h1 ^ (h2 >>> 7)) >>> 0) % BLOOM_BITS];
  }
  seen(rx: number, ry: number): boolean {
    for (const b of this.bloomBits(rx, ry)) if (!(this.bloom[b >>> 5]! & (1 << (b & 31)))) return false;
    return true;
  }
  private markSeen(rx: number, ry: number): void {
    for (const b of this.bloomBits(rx, ry)) this.bloom[b >>> 5]! |= 1 << (b & 31);
    this.seenCount++;
  }
  /** Record discovery; returns true when the region starts growing now. */
  discover(rx: number, ry: number, now: number): boolean {
    if (this.seen(rx, ry) || !this.regionDeveloped(rx, ry)) return false;
    this.markSeen(rx, ry);
    if (this.growing.size >= GROWING_CAP) {
      // The oldest growth is closest to done; it jumps to complete.
      const first = this.growing.keys().next().value!;
      this.growing.delete(first);
    }
    this.growing.set(regionKey(rx, ry), now);
    return true;
  }
  /** Growth tick of a region at reference tick `now`. */
  regionTick(rx: number, ry: number, now: number): number {
    const t0 = this.growing.get(regionKey(rx, ry));
    if (t0 !== undefined) return Math.min(COMPLETE, Math.floor((now - t0) / GROWTH_TICK_FRAMES));
    return this.seen(rx, ry) ? COMPLETE : UNDISCOVERED;
  }
  /** Retire growths whose plans say they are finished (or that ran past
   *  any plan's length); a retired region reads as complete. */
  retireGrowth(now: number): void {
    for (const [k, t0] of this.growing) {
      const tick = Math.floor((now - t0) / GROWTH_TICK_FRAMES);
      const p = this.plans.get(k);
      if (tick >= COMPLETE || (p && tick >= p.totalTicks)) this.growing.delete(k);
    }
  }

  // -- rings ----------------------------------------------------------------

  /** Update the wanted set for a focus and a render ring size (tiles). */
  updateRings(focus: Focus, viewW: number, viewH: number, pin: readonly [number, number][]): void {
    const hw = Math.ceil(viewW / 2) + LOAD_MARGIN, hh = Math.ceil(viewH / 2) + LOAD_MARGIN;
    this.loadRect = { x0: focus.x - hw, y0: focus.y - hh, x1: focus.x + hw, y1: focus.y + hh };
    this.unloadRect = { x0: this.loadRect.x0 - HYSTERESIS, y0: this.loadRect.y0 - HYSTERESIS, x1: this.loadRect.x1 + HYSTERESIS, y1: this.loadRect.y1 + HYSTERESIS };
    // Worst case of chunks touching the unload rectangle, plus the pinned
    // window: the hard LRU cap.
    const spanX = Math.ceil((this.unloadRect.x1 - this.unloadRect.x0 + 1) / CHUNK) + 1;
    const spanY = Math.ceil((this.unloadRect.y1 - this.unloadRect.y0 + 1) / CHUNK) + 1;
    this.cap = Math.max(24, spanX * spanY);
    this.wanted.clear();
    this.pinned.clear();
    const cx0 = Math.floor(this.loadRect.x0 / CHUNK), cx1 = Math.floor(this.loadRect.x1 / CHUNK);
    const cy0 = Math.floor(this.loadRect.y0 / CHUNK), cy1 = Math.floor(this.loadRect.y1 / CHUNK);
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const mx = cx * CHUNK + CHUNK / 2 - focus.x, my = cy * CHUNK + CHUNK / 2 - focus.y;
        const dist = Math.sqrt(mx * mx + my * my);
        const along = dist > 0 ? (mx * focus.hx + my * focus.hy) / dist : 0;
        this.wanted.set(chunkKey(cx, cy), [cx, cy, dist - 24 * along]);
      }
    }
    for (const [cx, cy] of pin) {
      const k = chunkKey(cx, cy);
      this.pinned.add(k);
      this.wanted.set(k, [cx, cy, -1e6 + this.pinned.size]);
    }
    for (const k of this.wanted.keys()) if (this.chunks.has(k)) this.used.set(k, this.tick);
    this.queueDirty = true;
    this.evict();
  }

  private inUnload(c: ChunkData): boolean {
    const r = this.unloadRect;
    return c.x0 + CHUNK - 1 >= r.x0 && c.x0 <= r.x1 && c.y0 + CHUNK - 1 >= r.y0 && c.y0 <= r.y1;
  }

  private dropChunk(k: number): void {
    this.chunks.delete(k);
    this.used.delete(k);
    this.recentEvicted.push(k);
    if (this.recentEvicted.length > 48) this.recentEvicted.shift();
    this.evictedTotal++;
  }

  private evict(): void {
    for (const [k, c] of this.chunks) {
      if (!this.pinned.has(k) && !this.inUnload(c)) this.dropChunk(k);
    }
    if (this.chunks.size > this.cap) {
      const order = [...this.used.entries()].filter(([k]) => !this.pinned.has(k) && !this.wanted.has(k)).sort((a, b) => a[1] - b[1] || a[0] - b[0]);
      for (const [k] of order) {
        if (this.chunks.size <= this.cap) break;
        this.dropChunk(k);
      }
    }
    if (this.plans.size > PLAN_CAP) {
      const needed = new Set<number>();
      for (const c of this.chunks.values()) needed.add(regionKey(c.rx, c.ry));
      if (this.job) needed.add(regionKey(this.job.rx, this.job.ry));
      const order = [...this.planUsed.entries()].filter(([k]) => !needed.has(k)).sort((a, b) => a[1] - b[1] || a[0] - b[0]);
      for (const [k] of order) {
        if (this.plans.size <= PLAN_CAP) break;
        this.plans.delete(k);
        this.planUsed.delete(k);
      }
    }
  }

  // -- scheduler ------------------------------------------------------------

  private queue(): number[] {
    if (this.queueDirty) {
      this.queueCache = [...this.wanted.entries()]
        .filter(([k]) => !this.chunks.has(k))
        .sort((a, b) => a[1][2] - b[1][2] || a[0] - b[0])
        .map(([k]) => k);
      this.queueDirty = false;
    }
    return this.queueCache;
  }

  get queuedCount(): number {
    return this.queue().length;
  }

  private nextJob(): Job | null {
    const q = this.queue();
    while (q.length) {
      const k = q[0]!;
      if (this.chunks.has(k) || !this.wanted.has(k)) { q.shift(); continue; }
      const [cx, cy] = this.wanted.get(k)!;
      const rx = Math.floor(cx / REGION_CHUNKS), ry = Math.floor(cy / REGION_CHUNKS);
      const plan = this.plan(rx, ry);
      if (!plan) return { kind: "plan", key: regionKey(rx, ry), cx, cy, rx, ry, gen: planRegionJob(this.seed, rx, ry) };
      return { kind: "chunk", key: k, cx, cy, rx, ry, gen: chunkJob(this.seed, cx, cy, plan) };
    }
    return null;
  }

  /** Spend at most `budget` units. Returns the units spent. */
  runBudget(budget: number, now: number): number {
    this.tick = now;
    let spent = 0;
    while (spent + STEP_MAX <= budget) {
      if (this.job && this.job.kind === "chunk" && !this.wanted.has(this.job.key)) this.job = null;
      if (!this.job) {
        this.job = this.nextJob();
        if (!this.job) break;
      }
      const r = this.job.gen.next();
      if (!r.done) {
        if (r.value > STEP_MAX) throw new Error(`wander: job slice of ${r.value} units exceeds ${STEP_MAX}`);
        spent += r.value;
        continue;
      }
      spent += 8;
      const job = this.job;
      this.job = null;
      if (job.kind === "plan") {
        this.plans.set(job.key, r.value as RegionPlan);
        this.planUsed.set(job.key, now);
      } else if (this.wanted.has(job.key)) {
        const c = r.value as ChunkData;
        this.chunks.set(job.key, c);
        this.used.set(job.key, now);
        this.fresh.push(c);
        if (this.fresh.length > 64) this.fresh.shift(); // undrained (headless)
        this.generatedTotal++;
        this.recentGenerated.push(now);
        this.queueDirty = true;
        this.maxResident = Math.max(this.maxResident, this.chunks.size);
        this.evict();
      }
    }
    while (this.recentGenerated.length && this.recentGenerated[0]! <= now - 60) this.recentGenerated.shift();
    this.maxSpent = Math.max(this.maxSpent, spent);
    return spent;
  }

  /** Generate everything wanted right now (boot only). */
  fill(now: number, limitChunks = Infinity): void {
    let made = 0;
    while (this.queuedCount > 0 && made < limitChunks) {
      const before = this.chunks.size;
      this.runBudget(1e9, now);
      made += this.chunks.size - before;
      if (this.chunks.size === before && !this.job) break;
    }
  }

  // -- views ---------------------------------------------------------------

  chunkState(cx: number, cy: number, render: Rect): ChunkState {
    const k = chunkKey(cx, cy);
    if (this.chunks.has(k)) {
      const x0 = cx * CHUNK, y0 = cy * CHUNK;
      return x0 + CHUNK - 1 >= render.x0 && x0 <= render.x1 && y0 + CHUNK - 1 >= render.y0 && y0 <= render.y1 ? "rendered" : "resident";
    }
    if (this.wanted.has(k)) return "queued";
    if (this.recentEvicted.includes(k)) return "evicted";
    return "none";
  }
  get rings(): { load: Rect; unload: Rect } {
    return { load: this.loadRect, unload: this.unloadRect };
  }

  bytes(): number {
    let n = 0;
    for (const c of this.chunks.values()) n += c.bytes;
    for (const p of this.plans.values()) n += p.bytes;
    return n + this.bloom.byteLength + this.growing.size * 32;
  }

  stats(): ResidencyStats {
    return {
      resident: this.chunks.size, cap: this.cap, bytes: this.bytes(), plans: this.plans.size,
      queued: this.queuedCount, generatedTotal: this.generatedTotal, evictedTotal: this.evictedTotal,
      generatedLastSecond: this.recentGenerated.length, seenRegions: this.seenCount,
      growing: this.growing.size, maxResident: this.maxResident, maxSpent: this.maxSpent,
    };
  }
}

export { REGION };
