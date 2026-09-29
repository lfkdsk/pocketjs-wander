// examples/wander/driver.ts — the auto-wander driver.
//
// A deterministic "attract" player for an endless world. It has no tape:
// every reference tick it looks at the live session state and the pure
// world, and chooses one d-pad mask. Same seed, same inputs, same masks.
//
//   target   the next town to visit: a settled region within two regions
//            of the player, not among the last few visited, scored by
//            distance and by how well it lines up with the heading (so the
//            walk keeps going somewhere instead of dithering); with no town
//            around it heads for a point far along the heading
//   path     weighted A* over the session window's passage table (roads
//            cost 1, open ground 2, so it takes the roads that grow between
//            towns when they help). A target outside the window is clamped
//            to the window's edge; as the window re-centres ahead of the
//            player the next leg is planned from the current leg's end
//            before the walker gets there, so it never stops to think
//   budget   A* expands at most PLAN_NODES_PER_TICK nodes per reference
//            tick and resumes on the next tick
//   bodies   residents walk the same roads; a walker blocked for half a
//            second marks that cell and re-plans around it
//
// The driver is folded once per 60 Hz reference tick by WanderSim, so the
// trajectory is identical at 60/30/20/4 Hz.

import type { MovementState } from "../../src/engine/movement.ts";
import type { PassageTable } from "../../src/engine/passability.ts";
import { BLOCK } from "../../src/engine/passability.ts";
import { REGION, growHash, regionOf, type RegionHub } from "./world.ts";
import { WINDOW } from "./window.ts";
import { regionKey } from "./residency.ts";

const BTN_UP = 0x0010, BTN_RIGHT = 0x0020, BTN_DOWN = 0x0040, BTN_LEFT = 0x0080;
const DIR_MASK = [BTN_DOWN, BTN_LEFT, BTN_UP, BTN_RIGHT] as const;
const DX = [0, -1, 0, 1] as const;
const DY = [1, 0, -1, 0] as const;

export const PLAN_NODES_PER_TICK = 400;
const CELLS = WINDOW * WINDOW;
const VISITED_MEMORY = 6;
const ARRIVE_PAUSE = 48;
const BLOCKED_PATIENCE = 30;
const EDGE = 2;

export interface DriverContext {
  now: number;
  move: MovementState;
  /** World tile of the window's top-left cell. */
  x0: number;
  y0: number;
  table: PassageTable;
  /** Born road cells of the window, row-major (1 = road). */
  roads: Uint8Array;
  /** Region facts (hubs). */
  res: { hub(rx: number, ry: number): RegionHub };
  /** The window is about to shift: plan after the swap. */
  swapPending: boolean;
}

interface Search {
  x0: number;
  y0: number;
  start: number;
  goal: number;
  size: number;
  /** Append to the current path instead of replacing it. */
  append: boolean;
}

/** A* scratch shared by every search: a generation stamp marks which g /
 *  from / closed entries belong to the current search, so starting one
 *  allocates and clears nothing. */
class SearchBuffers {
  readonly g = new Int32Array(CELLS);
  readonly from = new Int32Array(CELLS);
  readonly seen = new Int32Array(CELLS);
  readonly done = new Int32Array(CELLS);
  readonly heap = new Int32Array(CELLS * 4);
  readonly heapF = new Int32Array(CELLS * 4);
  gen = 0;
}

export class AutoWalker {
  /** Current target (world tile) and the region it belongs to. */
  target: { x: number; y: number; town: boolean; rx: number; ry: number } | null = null;
  /** Path in world tiles; pathIdx is the next cell to enter. */
  private px: number[] = [];
  private py: number[] = [];
  private pathIdx = 0;
  private search: Search | null = null;
  private readonly buf = new SearchBuffers();
  private readonly visited: number[] = [];
  private pause = 0;
  private blockedFor = 0;
  private lastTile = -1;
  private readonly avoid = new Set<number>();
  private failures = 0;
  heading: { hx: number; hy: number } = { hx: 1, hy: 0 };
  /** Manual walk-to target (touch): reached, then the driver idles. */
  gotoOnly = false;
  arrivedTowns = 0;

  constructor(private readonly seed: number) {}

  reset(): void {
    this.target = null;
    this.px = []; this.py = []; this.pathIdx = 0;
    this.search = null;
    this.pause = 0; this.blockedFor = 0; this.lastTile = -1;
    this.avoid.clear();
    this.gotoOnly = false;
  }

  /** Walk to a world tile (touch), then stop. */
  goto(x: number, y: number): void {
    this.reset();
    this.gotoOnly = true;
    this.target = { x, y, town: false, rx: regionOf(x), ry: regionOf(y) };
  }

  get planning(): boolean {
    return this.search !== null;
  }
  get pathRemaining(): number {
    return this.px.length - this.pathIdx;
  }

  private pickTarget(px: number, py: number, ctx: DriverContext): void {
    const rx = regionOf(px), ry = regionOf(py);
    let best: { x: number; y: number; rx: number; ry: number; score: number } | null = null;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const h = ctx.res.hub(rx + dx, ry + dy);
        if (!h.town) continue;
        const key = regionKey(rx + dx, ry + dy);
        if (this.visited.includes(key)) continue;
        const vx = h.x - px, vy = h.y - py;
        const dist = Math.sqrt(vx * vx + vy * vy);
        if (dist < 6) continue;
        const along = dist > 0 ? (vx * this.heading.hx + vy * this.heading.hy) / dist : 0;
        const score = dist * (1.7 - along) + (growHash(this.seed, h.x, h.y, 0xd1) % 16);
        if (!best || score < best.score) best = { x: h.x, y: h.y, rx: rx + dx, ry: ry + dy, score };
      }
    }
    if (best) {
      this.target = { x: best.x, y: best.y, town: true, rx: best.rx, ry: best.ry };
    } else {
      this.target = { x: px + this.heading.hx * REGION, y: py + this.heading.hy * REGION, town: false, rx: regionOf(px + this.heading.hx * REGION), ry: regionOf(py + this.heading.hy * REGION) };
    }
  }

  /** Turn the heading a quarter (deterministic by count) after a dead end. */
  private turn(): void {
    const { hx, hy } = this.heading;
    this.heading = this.failures % 2 ? { hx: hy, hy: -hx } : { hx: -hy, hy: hx };
    this.failures++;
  }

  private passable(ctx: DriverContext, i: number): boolean {
    return ctx.table.overrides[i] !== BLOCK && !this.avoid.has(i);
  }

  /** Nearest passable window cell to a clamped goal (small spiral). */
  private goalCell(ctx: DriverContext, gx: number, gy: number): number {
    const lx = Math.max(EDGE, Math.min(WINDOW - 1 - EDGE, gx - ctx.x0));
    const ly = Math.max(EDGE, Math.min(WINDOW - 1 - EDGE, gy - ctx.y0));
    for (let r = 0; r <= 6; r++) {
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = lx + dx, y = ly + dy;
        if (x < EDGE || y < EDGE || x >= WINDOW - EDGE || y >= WINDOW - EDGE) continue;
        const i = y * WINDOW + x;
        if (this.passable(ctx, i)) return i;
      }
    }
    return -1;
  }

  private beginSearch(ctx: DriverContext, fromX: number, fromY: number, append: boolean): void {
    const t = this.target!;
    const sx = fromX - ctx.x0, sy = fromY - ctx.y0;
    if (sx < 0 || sy < 0 || sx >= WINDOW || sy >= WINDOW) { this.search = null; return; }
    const goal = this.goalCell(ctx, t.x, t.y);
    const start = sy * WINDOW + sx;
    if (goal < 0) { this.search = null; this.failed(); return; }
    const s: Search = { x0: ctx.x0, y0: ctx.y0, start, goal, size: 0, append };
    const b = this.buf;
    b.gen++;
    b.g[start] = 0; b.from[start] = -1; b.seen[start] = b.gen;
    this.push(s, start, this.h(start, goal));
    this.search = s;
  }

  private h(i: number, goal: number): number {
    const x = i % WINDOW, y = (i - x) / WINDOW, gx = goal % WINDOW, gy = (goal - gx) / WINDOW;
    // Weighted (3/2) Manhattan in half-cost units: roads cost 2, ground 4.
    return (Math.abs(x - gx) + Math.abs(y - gy)) * 3;
  }

  private push(s: Search, i: number, f: number): void {
    const heap = this.buf.heap, heapF = this.buf.heapF;
    if (s.size >= heap.length) return; // never in a 96 x 96 window
    let at = s.size++;
    while (at > 0) {
      const up = (at - 1) >> 1;
      if (heapF[up]! < f || (heapF[up] === f && heap[up]! <= i)) break;
      heap[at] = heap[up]!; heapF[at] = heapF[up]!;
      at = up;
    }
    heap[at] = i; heapF[at] = f;
  }
  private pop(s: Search): number {
    const heap = this.buf.heap, heapF = this.buf.heapF;
    const top = heap[0]!;
    s.size--;
    if (s.size > 0) {
      const i = heap[s.size]!, f = heapF[s.size]!;
      let at = 0;
      for (;;) {
        const l = at * 2 + 1, r = l + 1;
        let m = at, mf = f, mi = i;
        if (l < s.size && (heapF[l]! < mf || (heapF[l] === mf && heap[l]! < mi))) { m = l; mf = heapF[l]!; mi = heap[l]!; }
        if (r < s.size && (heapF[r]! < mf || (heapF[r] === mf && heap[r]! < mi))) { m = r; }
        if (m === at) break;
        heap[at] = heap[m]!; heapF[at] = heapF[m]!;
        at = m;
      }
      heap[at] = i; heapF[at] = f;
    }
    return top;
  }

  /** Expand up to `nodes` A* nodes. */
  private stepSearch(ctx: DriverContext, nodes: number): void {
    const s = this.search!;
    if (s.x0 !== ctx.x0 || s.y0 !== ctx.y0) { this.search = null; return; } // window moved
    const b = this.buf, gen = b.gen, over = ctx.table.overrides, roads = ctx.roads;
    const gx = s.goal % WINDOW, gy = (s.goal - gx) / WINDOW;
    const avoid = this.avoid.size ? this.avoid : null;
    for (let n = 0; n < nodes; n++) {
      if (s.size === 0) { this.search = null; this.failed(); return; }
      const i = this.pop(s);
      if (b.done[i] === gen) continue;
      b.done[i] = gen;
      if (i === s.goal) { this.finishSearch(s); return; }
      const x = i % WINDOW, y = (i - x) / WINDOW;
      const gi = b.g[i]!;
      for (let d = 0; d < 4; d++) {
        const nx = x + DX[d]!, ny = y + DY[d]!;
        if (nx < 0 || ny < 0 || nx >= WINDOW || ny >= WINDOW) continue;
        const j = ny * WINDOW + nx;
        if (b.done[j] === gen || over[j] === BLOCK || (avoid && avoid.has(j))) continue;
        const g = gi + (roads[j] ? 2 : 4);
        if (b.seen[j] !== gen || g < b.g[j]!) {
          b.seen[j] = gen; b.g[j] = g; b.from[j] = i;
          this.push(s, j, g + (Math.abs(nx - gx) + Math.abs(ny - gy)) * 3);
        }
      }
    }
  }

  private finishSearch(s: Search): void {
    const cells: number[] = [];
    for (let i = s.goal; i !== s.start && i >= 0; i = this.buf.from[i]!) cells.push(i);
    if (!cells.length && !s.append) { this.search = null; this.failed(); return; }
    cells.reverse();
    const xs = cells.map((i) => s.x0 + (i % WINDOW));
    const ys = cells.map((i) => s.y0 + Math.floor(i / WINDOW));
    if (s.append) {
      this.px = this.px.slice(this.pathIdx).concat(xs);
      this.py = this.py.slice(this.pathIdx).concat(ys);
    } else {
      this.px = xs; this.py = ys;
    }
    this.pathIdx = 0;
    this.search = null;
    this.failures = 0;
  }

  private failed(): void {
    if (this.gotoOnly) { this.target = null; return; }
    this.turn();
    this.target = null;
    this.px = []; this.py = []; this.pathIdx = 0;
  }

  /** Choose this reference tick's d-pad mask. */
  mask(ctx: DriverContext): number {
    const m = ctx.move;
    const tileX = ctx.x0 + m.tx, tileY = ctx.y0 + m.ty;
    if (m.moving) this.heading = { hx: DX[m.stepDir]!, hy: DY[m.stepDir]! };

    // Arrival at the target.
    const t = this.target;
    if (t && Math.abs(tileX - t.x) + Math.abs(tileY - t.y) <= (t.town ? 2 : 1)) {
      if (t.town) {
        this.visited.push(regionKey(t.rx, t.ry));
        if (this.visited.length > VISITED_MEMORY) this.visited.shift();
        this.arrivedTowns++;
        this.pause = ARRIVE_PAUSE;
      }
      this.target = null;
      this.px = []; this.py = []; this.pathIdx = 0; this.search = null;
      this.avoid.clear();
      if (this.gotoOnly) return m.moving ? DIR_MASK[m.stepDir]! : 0;
    }
    if (this.pause > 0) {
      this.pause--;
      return m.moving ? DIR_MASK[m.stepDir]! : 0;
    }
    if (!this.target) {
      if (this.gotoOnly) return m.moving ? DIR_MASK[m.stepDir]! : 0;
      this.pickTarget(tileX, tileY, ctx);
    }

    // Planning: a fresh plan when idle, the next leg ahead of time.
    if (this.search) {
      this.stepSearch(ctx, PLAN_NODES_PER_TICK);
    } else if (!ctx.swapPending) {
      if (this.pathRemaining === 0) {
        if (!m.moving) this.beginSearch(ctx, tileX, tileY, false);
      } else if (this.pathRemaining <= 12) {
        const ex = this.px[this.px.length - 1]!, ey = this.py[this.py.length - 1]!;
        if (Math.abs(ex - this.target!.x) + Math.abs(ey - this.target!.y) > 2) this.beginSearch(ctx, ex, ey, true);
      }
      if (this.search) this.stepSearch(ctx, PLAN_NODES_PER_TICK);
    }

    if (m.moving) return DIR_MASK[m.stepDir]!;

    // At a tile boundary: step toward the next path cell.
    while (this.pathIdx < this.px.length && this.px[this.pathIdx] === tileX && this.py[this.pathIdx] === tileY) this.pathIdx++;
    if (this.pathIdx >= this.px.length) return 0;
    const nx = this.px[this.pathIdx]!, ny = this.py[this.pathIdx]!;
    const ddx = nx - tileX, ddy = ny - tileY;
    if (Math.abs(ddx) + Math.abs(ddy) !== 1) {
      // Off the path (a resident pushed us around): plan again from here.
      this.px = []; this.py = []; this.pathIdx = 0;
      return 0;
    }
    const tile = tileY * 1e6 + tileX;
    if (tile === this.lastTile) {
      if (++this.blockedFor > BLOCKED_PATIENCE) {
        const lx = nx - ctx.x0, ly = ny - ctx.y0;
        if (lx >= 0 && ly >= 0 && lx < WINDOW && ly < WINDOW) this.avoid.add(ly * WINDOW + lx);
        this.blockedFor = 0;
        this.px = []; this.py = []; this.pathIdx = 0;
        return 0;
      }
    } else {
      this.lastTile = tile;
      this.blockedFor = 0;
    }
    const dir = ddy > 0 ? 0 : ddx < 0 ? 1 : ddy < 0 ? 2 : 3;
    return DIR_MASK[dir]!;
  }

  /** Stand still for `ticks` reference ticks. */
  hold(ticks: number): void {
    this.pause = Math.max(this.pause, ticks);
  }

  /** The window shifted: avoided cells are window-local, forget them. */
  windowMoved(): void {
    this.avoid.clear();
    this.search = null;
  }
}
