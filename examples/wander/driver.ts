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
import { landmarkApproach, nearestLandmark, type Landmark } from "./landmarks.ts";

const BTN_UP = 0x0010, BTN_RIGHT = 0x0020, BTN_DOWN = 0x0040, BTN_LEFT = 0x0080;
const DIR_MASK = [BTN_DOWN, BTN_LEFT, BTN_UP, BTN_RIGHT] as const;
const DX = [0, -1, 0, 1] as const;
const DY = [1, 0, -1, 0] as const;

export const PLAN_NODES_PER_TICK = 400;
const CELLS = WINDOW * WINDOW;
/** Regions (towns and landmarks) the driver has arrived at, most recent
 *  last. Replaces the old 6-town ring: a quarter-region horizon stops the
 *  driver circling inside one town cluster. */
const VISITED_MEMORY = 24;
/** How long the walker stands still after arriving at a town: at least two
 *  seconds, long enough for the sim's auto-talk to open a villager's dialog. */
export const ARRIVE_PAUSE = 150;
/** Brief pause at a discovered landmark, long enough for the FOUND notice. */
const LANDMARK_PAUSE = 30;
/** Manhattan distance at which a landmark leg counts as arrived. */
const LANDMARK_ARRIVE = 4;
const BLOCKED_PATIENCE = 30;
const EDGE = 2;
/** Search radius (regions) for the next town or landmark. */
const TARGET_RADIUS = 4;
/** A leg that has not left this many tiles of its anchor for OSCILLATE_LIMIT
 *  ticks is circling (the sliding-window A* is not making progress): the
 *  watchdog turns the heading and walks out of the pocket. */
const OSCILLATE_RADIUS = 24;
const OSCILLATE_LIMIT = 480;
/** Fallback leg length when no town or landmark is in range: short enough
 *  that the walker re-targets often and detours to a place that just came
 *  into range, long enough to leave an explored cluster. */
const WAYPOINT = 96;

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
  /** Whether a region's landmark is already in the travel log. */
  found: { has(key: number): boolean };
  /** The region's placed landmark (plan placement when generated, exact
   *  pure placement for wilderness, null otherwise). */
  placed(rx: number, ry: number): Landmark | null;
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
  target: { x: number; y: number; town: boolean; landmark: boolean; rx: number; ry: number } | null = null;
  /** Active errand's destination, set by the sim. While set, the driver
   *  drops whatever it was walking for and heads there, bypassing the
   *  visited horizon so an errand across a recent cluster still gets run. */
  errandTarget: { x: number; y: number; rx: number; ry: number; landmark: boolean } | null = null;
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
  /** Regions whose target the A* could not reach: skipped until the driver
   *  arrives somewhere or moves on, so a plan failure does not re-target the
   *  same unreachable place forever. */
  private readonly skipped = new Set<number>();
  /** Ticks the walker has stayed within OSCILLATE_RADIUS of watchAnchor. */
  private watchTicks = 0;
  private watchX = 0;
  private watchY = 0;
  private watchInit = false;
  /** Last region the walker stood in (skipped targets are retried when it
   *  changes: a goal unreachable from one side may open up from another). */
  private lastRegX = 0;
  private lastRegY = 0;
  private lastRegInit = false;
  /** Ticks to walk greedily toward the target after the watchdog fired. */
  private greedyTicks = 0;
  /** Watchdog escape waypoint (errand legs keep their target and escape
   *  toward this first, so a stuck errand leg still breaks out). */
  private escape: { x: number; y: number } | null = null;
  /** Previous greedy-step tile (anti-oscillation penalty). */
  private greedyPrevX = 0;
  private greedyPrevY = 0;
  private greedyPrevInit = false;
  private failures = 0;
  heading: { hx: number; hy: number } = { hx: 1, hy: 0 };
  /** Manual walk-to target (touch): reached, then the driver idles. */
  gotoOnly = false;
  /** While the sim's auto-talk owns movement (chasing a villager), the
   *  driver stands and does not plan: its paths are not corrupted by the
   *  sim's chase steps. Cleared when the talk ends. */
  social = false;
  arrivedTowns = 0;

  constructor(private readonly seed: number) {}

  reset(): void {
    this.target = null;
    this.errandTarget = null;
    this.px = []; this.py = []; this.pathIdx = 0;
    this.search = null;
    this.pause = 0; this.blockedFor = 0; this.lastTile = -1;
    this.avoid.clear();
    this.skipped.clear();
    this.watchTicks = 0; this.watchInit = false;
    this.lastRegInit = false;
    this.gotoOnly = false;
    this.escape = null;
    this.greedyTicks = 0;
    this.greedyPrevInit = false;
  }

  /** Walk to a world tile (touch), then stop. */
  goto(x: number, y: number): void {
    this.reset();
    this.gotoOnly = true;
    this.target = { x, y, town: false, landmark: false, rx: regionOf(x), ry: regionOf(y) };
  }

  get planning(): boolean {
    return this.search !== null;
  }
  get pathRemaining(): number {
    return this.px.length - this.pathIdx;
  }

  private pickTarget(px: number, py: number, ctx: DriverContext): void {
    const rx = regionOf(px), ry = regionOf(py);
    // The landmark candidate is the nearest undiscovered placed landmark —
    // the same one the HUD rumor points at. The town candidate is the
    // nearest town. Picking among the two nearest keeps legs short.
    const lm = nearestLandmark(px, py, TARGET_RADIUS, ctx.placed, (rrx, rry) => ctx.found.has(regionKey(rrx, rry)));
    let lmCand: { x: number; y: number; rrx: number; rry: number } | null = null;
    if (lm && !this.visited.includes(regionKey(lm.rx, lm.ry)) && !this.skipped.has(regionKey(lm.rx, lm.ry))) {
      lmCand = { ...landmarkApproach(lm, px, py), rrx: lm.rx, rry: lm.ry };
    }
    let townCand: { x: number; y: number; rrx: number; rry: number } | null = null;
    let townD2 = Infinity;
    for (let dy = -TARGET_RADIUS; dy <= TARGET_RADIUS; dy++) {
      for (let dx = -TARGET_RADIUS; dx <= TARGET_RADIUS; dx++) {
        const rrx = rx + dx, rry = ry + dy;
        if (this.visited.includes(regionKey(rrx, rry)) || this.skipped.has(regionKey(rrx, rry))) continue;
        const h = ctx.res.hub(rrx, rry);
        if (!h.town) continue;
        const d2 = (h.x - px) * (h.x - px) + (h.y - py) * (h.y - py);
        if (d2 < townD2) { townD2 = d2; townCand = { x: h.x, y: h.y, rrx, rry }; }
      }
    }
    // Score both by distance and heading; a target behind the walker only
    // wins when nothing is ahead, so a leg does not turn back through
    // explored country (a forward waypoint keeps the walk moving instead).
    const along = (x: number, y: number): number => {
      const vx = x - px, vy = y - py;
      const d = Math.sqrt(vx * vx + vy * vy);
      return d > 0 ? (vx * this.heading.hx + vy * this.heading.hy) / d : 0;
    };
    const lmAlong = lmCand ? along(lmCand.x, lmCand.y) : -2;
    const townAlong = townCand ? along(townCand.x, townCand.y) : -2;
    const lmScore = lmCand ? Math.sqrt((lmCand.x - px) ** 2 + (lmCand.y - py) ** 2) * (1.6 - lmAlong) : Infinity;
    const townScore = townCand ? Math.sqrt(townD2) * (1.6 - townAlong) : Infinity;
    let pick: { x: number; y: number; town: boolean; rrx: number; rry: number } | null = null;
    if (lmScore <= townScore) { pick = lmCand ? { ...lmCand, town: false } : null; }
    else { pick = townCand ? { ...townCand, town: true } : null; }
    if (pick) {
      this.target = { x: pick.x, y: pick.y, town: pick.town, landmark: !pick.town, rx: pick.rrx, ry: pick.rry };
    } else {
      const wx = px + this.heading.hx * WAYPOINT, wy = py + this.heading.hy * WAYPOINT;
      this.target = { x: wx, y: wy, town: false, landmark: false, rx: regionOf(wx), ry: regionOf(wy) };
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
        const g = gi + (roads[j] ? 2 : 3);
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
    // Remember the unreachable region so pickTarget does not re-pick it.
    if (this.target) {
      this.skipped.add(regionKey(this.target.rx, this.target.ry));
      if (this.skipped.size > 8) this.skipped.clear();
    }
    this.turn();
    this.target = null;
    this.px = []; this.py = []; this.pathIdx = 0;
  }

  /** Choose this reference tick's d-pad mask. */
  mask(ctx: DriverContext): number {
    // Auto-talk owns movement while it chases a villager: stand still and
    // plan nothing (the sim injects the chase mask and clears social when
    // the dialog closes or the chase gives up). The arrival pause still
    // counts down, so the stop is max(pause, talk), not their sum.
    if (this.social) {
      if (this.pause > 0) this.pause--;
      return 0;
    }
    const m = ctx.move;
    const tileX = ctx.x0 + m.tx, tileY = ctx.y0 + m.ty;
    if (m.moving) this.heading = { hx: DX[m.stepDir]!, hy: DY[m.stepDir]! };

    // Arrival at the target.
    const t = this.target;
    const arriveAt = t ? (t.town ? 2 : t.landmark ? LANDMARK_ARRIVE : 1) : 0;
    if (t && Math.abs(tileX - t.x) + Math.abs(tileY - t.y) <= arriveAt) {
      if (t.town) {
        this.visited.push(regionKey(t.rx, t.ry));
        if (this.visited.length > VISITED_MEMORY) this.visited.shift();
        this.arrivedTowns++;
        this.pause = ARRIVE_PAUSE;
      } else if (t.landmark) {
        this.visited.push(regionKey(t.rx, t.ry));
        if (this.visited.length > VISITED_MEMORY) this.visited.shift();
        this.pause = LANDMARK_PAUSE;
      }
      this.target = null;
      this.px = []; this.py = []; this.pathIdx = 0; this.search = null;
      this.avoid.clear();
      this.skipped.clear();
      this.watchTicks = 0; this.watchInit = false;
      if (this.gotoOnly) return m.moving ? DIR_MASK[m.stepDir]! : 0;
    }
    if (this.pause > 0) {
      this.pause--;
      return m.moving ? DIR_MASK[m.stepDir]! : 0;
    }
    // An active errand leads: head for its destination, bypassing the
    // visited horizon (the target may be a town walked past recently).
    if (this.errandTarget) {
      const e = this.errandTarget;
      if (!this.target || this.target.rx !== e.rx || this.target.ry !== e.ry) {
        this.target = { x: e.x, y: e.y, town: !e.landmark, landmark: e.landmark, rx: e.rx, ry: e.ry };
        this.px = []; this.py = []; this.pathIdx = 0; this.search = null;
      }
    } else if (!this.gotoOnly) {
      const rrx = regionOf(tileX), rry = regionOf(tileY);
      if (!this.lastRegInit) { this.lastRegX = rrx; this.lastRegY = rry; this.lastRegInit = true; }
      else if (rrx !== this.lastRegX || rry !== this.lastRegY) {
        this.lastRegX = rrx; this.lastRegY = rry;
        this.skipped.clear();
      }
    }
    // Watchdog: a leg that has not left a small radius in a few seconds is
    // circling (the sliding-window A* is not making progress). Turn the
    // heading and walk out of the pocket toward a waypoint. Errand legs use
    // a longer limit: their destination is explicit and the approach may
    // wind through a town, but a truly stuck errand leg still breaks out.
    if (!this.gotoOnly) {
      const limit = this.errandTarget ? OSCILLATE_LIMIT * 2 : OSCILLATE_LIMIT;
      if (!this.watchInit) { this.watchX = tileX; this.watchY = tileY; this.watchInit = true; this.watchTicks = 0; }
      else if (Math.abs(tileX - this.watchX) > OSCILLATE_RADIUS || Math.abs(tileY - this.watchY) > OSCILLATE_RADIUS) {
        this.watchX = tileX; this.watchY = tileY; this.watchTicks = 0;
      } else if (++this.watchTicks > limit) {
        this.watchTicks = 0;
        this.turn();
        this.px = []; this.py = []; this.pathIdx = 0; this.search = null;
        const wx = tileX + this.heading.hx * WAYPOINT, wy = tileY + this.heading.hy * WAYPOINT;
        if (this.errandTarget) {
          // Keep the errand target; escape the pocket first, then re-approach.
          this.escape = { x: wx, y: wy };
          this.greedyTicks = 90;
        } else {
          if (this.target) this.skipped.add(regionKey(this.target.rx, this.target.ry));
          this.target = { x: wx, y: wy, town: false, landmark: false, rx: regionOf(wx), ry: regionOf(wy) };
          this.greedyTicks = 60;
        }
      }
    }
    if (!this.target) {
      if (this.gotoOnly) return m.moving ? DIR_MASK[m.stepDir]! : 0;
      this.pickTarget(tileX, tileY, ctx);
    }

    // Watchdog escape: walk greedily toward the escape waypoint (or the
    // target on a non-errand leg) for a few ticks.
    if (this.greedyTicks > 0 && !this.gotoOnly) {
      this.greedyTicks--;
      if (this.greedyTicks === 0) this.escape = null;
      const g = this.escape ?? this.target;
      if (g) return this.greedyStep(ctx, g.x, g.y);
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
    if (this.pathIdx >= this.px.length) {
      // No A* path (the goal is outside the window or unreachable): walk
      // greedily toward the target so the walker keeps closing on it and the
      // window re-centres, instead of standing still and re-planning.
      if (this.target && !this.gotoOnly) return this.greedyStep(ctx, this.target.x, this.target.y);
      return 0;
    }
    const nx = this.px[this.pathIdx]!, ny = this.py[this.pathIdx]!;
    const ddx = nx - tileX, ddy = ny - tileY;
    if (Math.abs(ddx) + Math.abs(ddy) !== 1) {
      // Off the path (a resident pushed us around, or the window moved): plan
      // again from here.
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
        // The avoid set is for transient blocks (a resident, a freshly grown
        // cell). If it has grown large the entries are stale or the walker is
        // boxed in: drop them and re-plan fresh instead of spiralling around
        // a growing ghost map.
        if (this.avoid.size > 12) this.avoid.clear();
        return 0;
      }
    } else {
      this.lastTile = tile;
      this.blockedFor = 0;
    }
    const dir = ddy > 0 ? 0 : ddx < 0 ? 1 : ddy < 0 ? 2 : 3;
    return DIR_MASK[dir]!;
  }

  /** Pick the passable adjacent cell closest to (tx, ty) — a hill-climbing
   *  fallback for when the A* has no path, so the walker still closes on the
   *  target and the window re-centres ahead of it. The previous greedy tile
   *  carries a penalty so the walker follows a wall instead of oscillating
   *  between two cells when the direct route is blocked. */
  private greedyStep(ctx: DriverContext, tx: number, ty: number): number {
    const m = ctx.move;
    const tileX = ctx.x0 + m.tx, tileY = ctx.y0 + m.ty;
    let best = -1, bestD = Infinity;
    for (let d = 0; d < 4; d++) {
      const nx = tileX + DX[d]!, ny = tileY + DY[d]!;
      const lx = nx - ctx.x0, ly = ny - ctx.y0;
      if (lx < 0 || ly < 0 || lx >= WINDOW || ly >= WINDOW) continue;
      const i = ly * WINDOW + lx;
      if (ctx.table.overrides[i] === BLOCK || this.avoid.has(i)) continue;
      let dist = Math.abs(nx - tx) + Math.abs(ny - ty);
      if (this.greedyPrevInit && nx === this.greedyPrevX && ny === this.greedyPrevY) dist += 4;
      if (dist < bestD) { bestD = dist; best = d; }
    }
    if (best >= 0) { this.greedyPrevX = tileX; this.greedyPrevY = tileY; this.greedyPrevInit = true; }
    return best >= 0 ? DIR_MASK[best]! : 0;
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

  /** Forget the current path and transient blocks after the sim moved the
   *  player during auto-talk, so the next leg is planned from scratch. */
  resumeAfterSocial(): void {
    this.px = []; this.py = []; this.pathIdx = 0;
    this.search = null;
    this.avoid.clear();
    this.blockedFor = 0;
    this.lastTile = -1;
    this.greedyPrevInit = false;
  }
}
