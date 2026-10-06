// examples/wander/wander-sim.ts — the endless world's simulation.
//
// One pure fold per host frame, run as MOTION_HZ / hz reference ticks
// (60 per virtual second at every host rate, like the kit's session). Each
// reference tick, in order:
//
//   1. input      live buttons (manual) or the auto-wander driver's mask;
//                 a scheduled tape (schedule()/enqueue()) overrides the live
//                 poll with a per-reference-tick mask and taps, so replays,
//                 recordings and live hosts all fold identically at
//                 60/30/20/4 Hz. Live hosts sample their inputs once per host
//                 frame and enqueue them at the frame's first reference tick,
//                 so a slow host observes a click later than a fast one (the
//                 engine's host-frame input contract, src/engine/motion-clock.ts);
//                 the same recorded tape, however, replays tick-for-tick
//                 identically at every rate
//   2. session    stepSession on the window project (a 60 Hz session, so
//                 one call is one reference tick)
//   3. focus      the player's tile plus a lead along the facing
//   4. growth     regions the growth ring touches are discovered; newly
//                 born blocking cells and residents inside the window are
//                 written into the live passage table / switch bank
//   5. rings      the load/unload rings follow the focus
//   6. budget     TICK_BUDGET work units: the pending window build first,
//                 then chunk and region-plan generation
//   7. re-centre  when the player has left the window's centre chunk and
//                 the next window is built, swap it in (floating origin)
//
// Because generation, discovery and the window swap all happen at
// reference-tick granularity, the world, the residency and the
// auto-wander trajectory are identical at 60/30/20/4 Hz. A host frame at
// 4 Hz folds 15 reference ticks and may spend 15 ticks of budget; a 60 Hz
// frame spends one. Nothing here reads a clock or the host.

import {
  createSession,
  sessionPassageTable,
  startSession,
  stepSession,
  type Session,
  type SessionState,
} from "../../src/engine/session.ts";
import { keyedRecord } from "../../src/engine/clone.ts";
import { MOTION_HZ, motionTicksPerFrame } from "../../src/engine/motion-clock.ts";
import { BLOCK, canStepFrom, setPassageOverride, type Dir4, type PassageTable } from "../../src/engine/passability.ts";
import { blocksAt, roadAt, type ChunkData } from "./chunk.ts";
import { AutoWalker } from "./driver.ts";
import { regionKey, Residency, STEP_MAX, TICK_BUDGET, type Focus, type ResidencyStats } from "./residency.ts";
import { buildWindow, windowChunks, windowJob, windowRegions, WINDOW, type WindowBuild } from "./window.ts";
import { CHUNK, REGION, REGION_CHUNKS, regionOf } from "./world.ts";

const BTN_SELECT = 0x0001, BTN_START = 0x0008;
const BTN_UP = 0x0010, BTN_RIGHT = 0x0020, BTN_DOWN = 0x0040, BTN_LEFT = 0x0080;
const BTN_L = 0x0100, BTN_R = 0x0200;
const BTN_TRIANGLE = 0x1000, BTN_CIRCLE = 0x2000, BTN_CROSS = 0x4000, BTN_SQUARE = 0x8000;
const BTN_DPAD = BTN_UP | BTN_RIGHT | BTN_DOWN | BTN_LEFT;
/** Buttons that take the walk over from the driver. */
export const TAKEOVER = BTN_UP | BTN_RIGHT | BTN_DOWN | BTN_LEFT | BTN_CIRCLE | BTN_CROSS | BTN_L | BTN_R | BTN_START;
export const NEXT_SEED = 0x9e37_79b9;

export const LEAD = 10;
/** Growth ring half-size around the focus (tiles). */
export const GROW_RING_W = 22;
export const GROW_RING_H = 14;
export const IDLE_RESUME_SECONDS = 10;
export const FAST_SPEED = 8;
export const WALK_SPEED = 2;
export const START_LINGER_SECONDS = 5;

const DX = [0, -1, 0, 1] as const;
const DY = [1, 0, -1, 0] as const;
const DIR_NAMES = ["down", "left", "up", "right"] as const;
const BUTTON_FOR_DIR = [BTN_DOWN, BTN_LEFT, BTN_UP, BTN_RIGHT] as const;
const SLIDE_SIDES: readonly (readonly [Dir4, Dir4])[] = [[1, 3], [0, 2], [3, 1], [2, 0]];
const MANUAL_SLIDE_LOOKAHEAD = 16;

export interface WanderConfig {
  seed: number;
  hz: number;
  /** Viewport in logical px; sizes the load/unload rings. */
  viewW: number;
  viewH: number;
  /** Work units per reference tick. */
  budget?: number;
  fast?: boolean;
  /** Start in manual mode (tests). */
  manual?: boolean;
  /** Optional wall clock for the desktop benchmark's phase breakdown.
   *  Only ever read into `perf`; the simulation never branches on it. */
  clock?: () => number;
}

export type WanderMode = "auto" | "manual" | "goto";

/** One deterministic input at a reference tick. A tape of these lets live
 *  hosts, recordings, replays and tests press buttons, tap tiles and grow new
 *  seeds at exact reference ticks, so the same tape produces the same
 *  per-reference-tick trajectory at every host rate: a tap at tick 362 fires
 *  at tick 362 inside a 4 Hz fold, not at the next host frame boundary.
 *
 *  Same-tick semantics (implementation and tests agree):
 *  - Events must be queued in firing order (recordings are); events at the
 *    same tick fire in queue order.
 *  - The tick's held mask is the FINAL `buttons` value after all of the
 *    tick's events; edges are computed against the previous reference tick's
 *    final mask, so a press and a release queued for the same tick leave no
 *    ghost edge.
 *  - Taps (`goto`) take effect as they are consumed, before the tick's
 *    controls run; the tick's TRIANGLE/SELECT/TAKEOVER handling then runs
 *    with the final mask, so a held takeover mask queued at the same tick as
 *    a tap always wins (the walk is handed to the player).
 *  - `reseed` grows a fresh world: the sim is rebuilt in place and the
 *    reference-tick clock restarts at 0, so later events' `at` is relative
 *    to the new session (segment). The held mask carries across the reseed:
 *    a button still held when the world rebuilds keeps holding in the new
 *    session without producing a fresh press edge, so a host that samples a
 *    whole frame at once enqueues that frame's remaining mask changes and
 *    taps at `at: 0` (the new session's first tick), not at the old
 *    session's `now`. */
export interface ScheduledInput {
  /** Reference tick (WanderSim.now) at which the input applies. */
  at: number;
  /** Held button mask from this tick until the next scheduled mask. */
  buttons?: number;
  /** Tap: walk to this world tile from this tick. */
  goto?: { x: number; y: number };
  /** SQUARE: grow a new seed at this tick. The world rebuilds in place and
   *  the reference-tick clock restarts at 0. */
  reseed?: boolean;
}

export interface FrameReport {
  /** Units of generation work this host frame, and its budget. */
  units: number;
  budget: number;
  recentred: boolean;
  /** Regions whose growth tick changed this frame. */
  grown: number[];
}

/** Find the town nearest the origin (the walk starts on its plaza). */
function startTile(res: Residency): { x: number; y: number } {
  let best: { x: number; y: number; d: number } | null = null;
  for (let ry = -2; ry <= 2; ry++) for (let rx = -2; rx <= 2; rx++) {
    const h = res.hub(rx, ry);
    if (!h.town) continue;
    const d = Math.abs(h.x) + Math.abs(h.y);
    if (!best || d < best.d) best = { x: h.x, y: h.y + 1, d };
  }
  return best ?? { x: REGION / 2, y: REGION / 2 };
}

export class WanderSim {
  seed!: number;
  readonly hz: number;
  readonly ticksPerFrame: number;
  readonly budget: number;
  res!: Residency;
  driver!: AutoWalker;
  /** Reference ticks since boot (restarts at 0 on a reseed). */
  now = 0;
  /** Host frames since boot. */
  frame = 0;
  /** Session segment: 1 after the constructor's boot, incremented at every
   *  reseed (boot() does the increment). */
  segment = 0;
  window!: WindowBuild;
  session!: Session;
  state!: SessionState;
  mode: WanderMode = "auto";
  fast = false;
  focus!: Focus;
  viewW: number;
  viewH: number;
  idle = 0;
  /** Tiles the player has stepped since boot. */
  walked = 0;
  /** Growth tick of each region as last written into the live window. */
  private readonly windowTicks = new Map<number, number>();
  private pending: { cx: number; cy: number; gen: Generator<number, WindowBuild> } | null = null;
  private built: WindowBuild | null = null;
  private prevButtons = 0;
  /** Scheduled input tape (live hosts, recordings, replays, tests); while
   *  non-null it overrides the live `buttons` argument to step(), one mask
   *  per reference tick. */
  private tape: ScheduledInput[] | null = null;
  private tapeMask = 0;
  /** Final mask of the previous reference tick: edges are computed against
   *  it, so a press and a release in the same tick leave no ghost edge. */
  private prevTapeMask = 0;
  private lastTileX = NaN;
  private lastTileY = NaN;
  private lastFocusChunk = "";
  private ringTimer = 0;
  /** Optional per-reference-tick digest hook (tests and replays). When set,
   *  it is called at the end of every reference tick with that tick's
   *  digest — including ticks folded inside a low-Hz host frame — so a tape
   *  can be compared tick-for-tick at 60/30/20/4 Hz. Shipped hosts leave it
   *  unset: the hot path is one untaken branch. */
  onTick: ((digest: string) => void) | null = null;
  /** Optional hook fired after a scheduled reseed rebuilt the world (live
   *  hosts re-point their view at the new residency here). */
  onReseed: ((sim: WanderSim) => void) | null = null;
  maxFrameUnits = 0;
  budgetViolations = 0;
  recentres = 0;
  lastFrame: FrameReport = { units: 0, budget: 0, recentred: false, grown: [] };
  private readonly clock?: () => number;
  /** Per-phase wall time of the last frame (benchmark only). */
  perf = { driver: 0, session: 0, growth: 0, rings: 0, budget: 0, swap: 0 };
  private grownThisFrame = new Set<number>();
  private recentredThisFrame = false;
  private unitsThisFrame = 0;

  constructor(cfg: WanderConfig) {
    this.hz = cfg.hz;
    this.ticksPerFrame = motionTicksPerFrame(cfg.hz);
    this.budget = cfg.budget ?? TICK_BUDGET;
    this.clock = cfg.clock;
    this.viewW = cfg.viewW;
    this.viewH = cfg.viewH;
    this.boot(cfg.seed >>> 0, cfg.fast ?? false, cfg.manual === true);
  }

  /** Build the world for `seed` and start a fresh session on its plaza.
   *  Called by the constructor and by a scheduled reseed; the tape, hooks,
   *  viewport and budget survive, everything world-relative restarts. The
   *  held input mask also survives a reseed: a key held across the epoch
   *  boundary keeps holding in the new session without re-firing as a fresh
   *  press (the constructor's mask is 0 anyway). */
  private boot(seed: number, fast: boolean, manual: boolean): void {
    this.seed = seed;
    this.segment++;
    this.now = 0;
    this.frame = 0;
    this.mode = manual ? "manual" : "auto";
    this.fast = fast;
    this.idle = 0;
    this.walked = 0;
    this.windowTicks.clear();
    this.pending = null;
    this.built = null;
    this.prevButtons = 0;
    // tapeMask / prevTapeMask deliberately survive: see boot()'s doc.
    this.lastTileX = NaN;
    this.lastTileY = NaN;
    this.lastFocusChunk = "";
    this.ringTimer = 0;
    this.recentres = 0;
    this.maxFrameUnits = 0;
    this.budgetViolations = 0;
    this.lastFrame = { units: 0, budget: 0, recentred: false, grown: [] };
    this.perf = { driver: 0, session: 0, growth: 0, rings: 0, budget: 0, swap: 0 };
    this.grownThisFrame = new Set();
    this.recentredThisFrame = false;
    this.unitsThisFrame = 0;
    this.res = new Residency(seed);
    this.driver = new AutoWalker(seed);
    const start = startTile(this.res);
    const cx = Math.floor(start.x / CHUNK), cy = Math.floor(start.y / CHUNK);
    this.focus = { x: start.x, y: start.y, hx: 1, hy: 0 };
    // Boot: the window and what the viewport shows are generated up front.
    this.res.updateRings(this.focus, this.viewTilesW, this.viewTilesH, windowChunks(cx, cy));
    this.res.fill(0);
    this.res.maxSpent = 0; // boot is the one unbudgeted fill
    this.discover();
    this.window = buildWindow(this.res, seed, cx, cy, (rx, ry) => this.res.regionTick(rx, ry, this.now), { ...start, dir: "down" });
    this.session = this.makeSession(this.window);
    this.state = this.freshState(this.window);
    for (const [k, t] of this.window.ticks) this.windowTicks.set(k, t);
    this.lastFocusChunk = `${cx},${cy}`;
    // The walk begins on a town that starts growing on the first frame:
    // stand and watch it grow before setting off.
    this.driver.hold(START_LINGER_SECONDS * MOTION_HZ);
    if (this.segment > 1) this.onReseed?.(this);
  }

  /** SQUARE: grow a new seed in place. The tape keeps playing (its later
   *  `at` values are relative to the new session); hooks and viewport
   *  survive. */
  reseed(): void {
    this.boot((this.seed + NEXT_SEED) >>> 0, this.fast, false);
  }

  get viewTilesW(): number { return Math.ceil(this.viewW / 16) + 2; }
  get viewTilesH(): number { return Math.ceil(this.viewH / 16) + 2; }

  private makeSession(w: WindowBuild): Session {
    const s = createSession(w.project, MOTION_HZ);
    s.cfg = { tile: 16, speed: this.fast ? FAST_SPEED : WALK_SPEED };
    return s;
  }

  private freshState(w: WindowBuild): SessionState {
    const st = startSession(w.project, this.session);
    this.applySwitches(st, w, (rx, ry) => w.ticks.get(regionKey(rx, ry)) ?? -1);
    return st;
  }

  private applySwitches(st: SessionState, w: WindowBuild, tickOf: (rx: number, ry: number) => number): void {
    const switches = keyedRecord<boolean>();
    for (const a of w.actors) if (tickOf(a.rx, a.ry) >= a.born) switches[a.switchId] = true;
    const sw = { ...st.interp.sw, switches };
    st.interp = { ...st.interp, sw };
    st.sw = sw;
  }

  /** World tile of the player. */
  get playerTile(): { x: number; y: number } {
    return { x: this.window.x0 + this.state.move.tx, y: this.window.y0 + this.state.move.ty };
  }
  /** World pixel of the player sprite's top-left (may exceed 2^31; doubles
   *  are exact to 2^53). */
  get playerPx(): { x: number; y: number } {
    return { x: this.window.x0 * 16 + this.state.move.px, y: this.window.y0 * 16 + this.state.move.py };
  }

  setViewport(w: number, h: number): void {
    this.viewW = w;
    this.viewH = h;
    this.lastFocusChunk = "";
  }

  setFast(on: boolean): void {
    this.fast = on;
    this.session.cfg = { tile: 16, speed: on ? FAST_SPEED : WALK_SPEED };
  }

  /** Touch: walk to a world tile, then idle (manual). */
  goto(x: number, y: number): void {
    this.mode = "goto";
    this.idle = 0;
    this.driver.goto(x, y);
  }

  /** Queue a tape of inputs at reference ticks, replacing any previous tape.
   *  While a tape is queued the live `buttons` argument to step() is ignored:
   *  each tick's held mask and edges come from the tape, so the same tape
   *  folds identically at 60/30/20/4 Hz. Events must be queued in firing
   *  order (see ScheduledInput for the same-tick contract); an event whose
   *  tick already passed applies at the next tick (tapes should be queued
   *  early). */
  schedule(inputs: ScheduledInput[]): void {
    this.tape = [...inputs];
    this.tapeMask = 0;
    this.prevTapeMask = 0;
  }

  /** Append one input to the tape, starting it if none is queued. Live hosts
   *  use this for their per-frame sampling: it does not reset edge state, so
   *  a held mask keeps holding across enqueues. */
  enqueue(input: ScheduledInput): void {
    (this.tape ??= []).push(input);
  }

  /** One host frame. */
  step(buttons: number): FrameReport {
    const pressed = buttons & ~this.prevButtons;
    this.prevButtons = buttons;
    this.grownThisFrame = new Set();
    this.recentredThisFrame = false;
    this.unitsThisFrame = 0;
    if (this.clock) this.perf = { driver: 0, session: 0, growth: 0, rings: 0, budget: 0, swap: 0 };
    for (let t = 0; t < this.ticksPerFrame; t++) {
      let mask = buttons, edge = t === 0 ? pressed : 0;
      if (this.tape) {
        // Scheduled inputs fire at their exact reference tick, even inside a
        // folded 4 Hz frame, so a tape folds identically at every host rate.
        // A reseed restarts the clock at 0; the same tick's remaining events
        // (and later ones) are relative to the new session.
        let ev: ScheduledInput | undefined;
        while ((ev = this.tape[0]) && ev.at <= this.now) {
          this.tape.shift();
          if (ev.buttons !== undefined) this.tapeMask = ev.buttons;
          if (ev.goto) this.goto(ev.goto.x, ev.goto.y);
          if (ev.reseed) this.reseed();
        }
        // Edges run from the previous reference tick's FINAL mask to this
        // tick's final mask, so a press and a release in the same tick leave
        // no ghost edge.
        edge = this.tapeMask & ~this.prevTapeMask;
        this.prevTapeMask = this.tapeMask;
        mask = this.tapeMask;
      }
      this.tick(mask, edge);
    }
    this.frame++;
    const frameBudget = this.budget * this.ticksPerFrame;
    if (this.unitsThisFrame > frameBudget) this.budgetViolations++;
    this.maxFrameUnits = Math.max(this.maxFrameUnits, this.unitsThisFrame);
    this.lastFrame = { units: this.unitsThisFrame, budget: frameBudget, recentred: this.recentredThisFrame, grown: [...this.grownThisFrame] };
    return this.lastFrame;
  }

  private lap(key: keyof WanderSim["perf"], since: number): number {
    if (!this.clock) return 0;
    const t = this.clock();
    this.perf[key] += t - since;
    return t;
  }

  /** Allocation-free movement probe matching the engine's legacy body
   *  overlay. The corner aid can ask several nearby questions without
   *  cloning a passage table and Set for each one. */
  private canManualStep(table: PassageTable, x: number, y: number, dir: Dir4): boolean {
    if (!canStepFrom(table, x, y, dir)) return false;
    const tx = x + DX[dir]!, ty = y + DY[dir]!;
    for (const id in this.state.chars.chars) {
      const ch = this.state.chars.chars[id]!;
      if (!ch.blocks) continue;
      if (ch.tx === tx && ch.ty === ty) return false;
      if (ch.moving && ch.tx + DX[ch.stepDir]! === tx && ch.ty + DY[ch.stepDir]! === ty) return false;
    }
    return true;
  }

  /** Wander-only corner aid for held manual input. At a tile boundary, a
   *  blocked cardinal direction may become one perpendicular step when that
   *  side reaches a clear route around the obstacle within a short lookahead.
   *  Long walls and closed pockets retain the ordinary face-in-place result.
   *  Auto and goto never call this helper, so their trajectories are exact. */
  private slideManualMask(buttons: number): number {
    if (this.state.move.moving) return buttons;
    const dpad = buttons & BTN_DPAD;
    if (dpad === 0 || (dpad & (dpad - 1)) !== 0) return buttons;
    const dir: Dir4 = dpad === BTN_DOWN ? 0 : dpad === BTN_LEFT ? 1 : dpad === BTN_UP ? 2 : 3;
    const m = this.state.move;
    const table = sessionPassageTable(this.session, this.state);
    if (this.canManualStep(table, m.tx, m.ty, dir)) return buttons;

    // Only start sliding when the held direction is known to clear again.
    // This keeps the aid local to corners instead of turning it into an
    // unbounded wall-following driver.
    let bestSide: Dir4 | null = null;
    let bestDistance = MANUAL_SLIDE_LOOKAHEAD + 1;
    for (const side of SLIDE_SIDES[dir]!) {
      let sx = m.tx, sy = m.ty;
      for (let distance = 1; distance <= MANUAL_SLIDE_LOOKAHEAD; distance++) {
        if (!this.canManualStep(table, sx, sy, side)) break;
        sx += DX[side]!;
        sy += DY[side]!;
        if (this.canManualStep(table, sx, sy, dir)) {
          if (distance < bestDistance) {
            bestSide = side;
            bestDistance = distance;
          }
          break;
        }
      }
    }
    if (bestSide !== null) return (buttons & ~BTN_DPAD) | BUTTON_FOR_DIR[bestSide]!;
    return buttons;
  }

  private tick(buttons: number, pressed: number): void {
    let t = this.clock ? this.clock() : 0;
    // 0. host controls (per reference tick: a live host delivers edges at the
    //    frame's first tick, a scheduled tape at its exact tick)
    if (pressed & BTN_TRIANGLE) this.setFast(!this.fast);
    if (pressed & BTN_SELECT) { this.mode = "auto"; this.driver.reset(); this.idle = 0; }
    if (buttons & TAKEOVER) {
      if (this.mode !== "manual") this.driver.reset();
      this.mode = "manual";
      this.idle = 0;
    }
    // 1. input
    let mask = 0;
    let edges = 0;
    if (this.mode === "manual") {
      if (buttons & TAKEOVER) this.idle = 0;
      else if (++this.idle >= IDLE_RESUME_SECONDS * MOTION_HZ) { this.mode = "auto"; this.driver.reset(); }
      mask = this.slideManualMask(buttons & TAKEOVER);
      edges = pressed;
    }
    if (this.mode !== "manual") {
      mask = this.driver.mask({
        now: this.now, move: this.state.move, x0: this.window.x0, y0: this.window.y0,
        table: this.session.tables.get(this.window.project.maps[0]!.id)!,
        roads: this.window.roads, res: this.res,
        swapPending: this.pending !== null || this.built !== null,
      });
      if (this.mode === "goto" && !this.driver.target && !this.state.move.moving) {
        this.mode = "manual";
        this.idle = 0;
      }
    }
    t = this.lap("driver", t);
    // 2. session (one reference tick)
    this.state = stepSession(this.session, this.state, {
      buttons: mask,
      confirmEdge: !!(edges & BTN_CIRCLE),
      cancelEdge: !!(edges & BTN_CROSS),
      upEdge: !!(edges & BTN_UP),
      downEdge: !!(edges & BTN_DOWN),
    });
    t = this.lap("session", t);
    // 3. focus
    const p = this.playerTile;
    if (p.x !== this.lastTileX || p.y !== this.lastTileY) { this.walked++; this.lastTileX = p.x; this.lastTileY = p.y; }
    const f = this.state.move.facing;
    this.focus = { x: p.x + DX[f]! * LEAD, y: p.y + DY[f]! * LEAD, hx: DX[f]!, hy: DY[f]! };
    // 4. growth
    this.discover();
    this.applyGrowth();
    this.res.retireGrowth(this.now);
    t = this.lap("growth", t);
    // 5. rings
    const pcx = Math.floor(p.x / CHUNK), pcy = Math.floor(p.y / CHUNK);
    const fk = `${Math.floor(this.focus.x / CHUNK)},${Math.floor(this.focus.y / CHUNK)},${pcx},${pcy}`;
    if (fk !== this.lastFocusChunk || --this.ringTimer <= 0) {
      this.lastFocusChunk = fk;
      this.ringTimer = 30;
      const pins = windowChunks(this.window.cx, this.window.cy);
      if (pcx !== this.window.cx || pcy !== this.window.cy) pins.push(...windowChunks(pcx, pcy));
      this.res.updateRings(this.focus, this.viewTilesW, this.viewTilesH, pins);
    }
    t = this.lap("rings", t);
    // 6. budget: the window build first, then generation.
    let spent = 0;
    if (pcx === this.window.cx && pcy === this.window.cy) {
      // Back in the centre chunk before the next window was swapped in.
      this.pending = null;
      this.built = null;
    } else if (!this.built) {
      if (this.pending && (this.pending.cx !== pcx || this.pending.cy !== pcy)) this.pending = null;
      if (!this.pending && this.windowReady(pcx, pcy)) {
        const dir = DIR_NAMES[this.state.move.facing]!;
        this.pending = { cx: pcx, cy: pcy, gen: windowJob(this.res, this.seed, pcx, pcy, (rx, ry) => this.res.regionTick(rx, ry, this.now), { ...p, dir }) };
      }
      while (this.pending && spent + STEP_MAX <= this.budget) {
        const r = this.pending.gen.next();
        if (r.done) { this.built = r.value; this.pending = null; spent += 8; break; }
        spent += r.value;
      }
    }
    spent += this.res.runBudget(this.budget - spent, this.now);
    this.unitsThisFrame += spent;
    t = this.lap("budget", t);
    // 7. re-centre once the build exists and no dialog owns the session.
    if (this.built && this.state.interp.main === null && !this.state.interp.modal) {
      const b = this.built;
      this.built = null;
      if (b.cx === pcx && b.cy === pcy) this.swap(b);
    }
    this.lap("swap", t);
    this.now++;
    if (this.onTick) this.onTick(this.digest());
  }

  private windowReady(cx: number, cy: number): boolean {
    for (const [x, y] of windowChunks(cx, cy)) if (!this.res.chunk(x, y)) return false;
    for (const [rx, ry] of windowRegions(cx, cy)) if (!this.res.plan(rx, ry)) return false;
    return true;
  }

  /** Discover every developed region the growth ring touches. */
  private discover(): void {
    const f = this.focus;
    const rx0 = regionOf(f.x - GROW_RING_W), rx1 = regionOf(f.x + GROW_RING_W);
    const ry0 = regionOf(f.y - GROW_RING_H), ry1 = regionOf(f.y + GROW_RING_H);
    for (let ry = ry0; ry <= ry1; ry++) for (let rx = rx0; rx <= rx1; rx++) {
      if (this.res.discover(rx, ry, this.now)) this.grownThisFrame.add(regionKey(rx, ry));
    }
  }

  /** Bring the live window up to each region's current growth tick. */
  private applyGrowth(): void {
    const table = this.session.tables.get(this.window.project.maps[0]!.id)!;
    let switches: Record<string, boolean> | null = null;
    for (const [rx, ry] of windowRegions(this.window.cx, this.window.cy)) {
      const k = regionKey(rx, ry);
      const tick = this.res.regionTick(rx, ry, this.now);
      const last = this.windowTicks.get(k) ?? tick;
      if (tick !== this.res.regionTick(rx, ry, this.now - 1)) this.grownThisFrame.add(k);
      if (tick <= last) { this.windowTicks.set(k, Math.max(last, tick)); continue; }
      this.windowTicks.set(k, tick);
      for (const [cx, cy] of windowChunks(this.window.cx, this.window.cy)) {
        if (Math.floor(cx / REGION_CHUNKS) !== rx || Math.floor(cy / REGION_CHUNKS) !== ry) continue;
        const c = this.res.chunk(cx, cy);
        if (!c) continue;
        this.patchChunk(table, c, last, tick);
      }
      for (const a of this.window.actors) {
        if (a.rx !== rx || a.ry !== ry || a.born <= last || a.born > tick) continue;
        switches ??= keyedRecord(this.state.interp.sw.switches);
        switches[a.switchId] = true;
      }
    }
    if (switches) {
      const sw = { ...this.state.interp.sw, switches };
      this.state = { ...this.state, sw, interp: { ...this.state.interp, sw } };
    }
  }

  private patchChunk(table: PassageTable, c: ChunkData, last: number, tick: number): void {
    const ox = c.x0 - this.window.x0, oy = c.y0 - this.window.y0;
    const roads = this.window.roads;
    for (let n = 0; n < c.growCells.length; n++) {
      const i = c.growCells[n]!;
      const born = c.devBorn[i]!, hide = c.natHide[i]!;
      if (!((born > last && born <= tick) || (hide > last && hide <= tick))) continue;
      const lx = i % CHUNK, ly = (i - lx) / CHUNK;
      const at = (oy + ly) * WINDOW + ox + lx;
      setPassageOverride(table, at, blocksAt(c, i, tick) ? BLOCK : 0);
      roads[at] = roadAt(c, i, tick) ? 1 : 0;
    }
  }

  /** Swap in a freshly built window: the floating-origin re-centre. */
  private swap(b: WindowBuild): void {
    const dx = b.x0 - this.window.x0, dy = b.y0 - this.window.y0;
    const s0 = this.state;
    const move = { ...s0.move, tx: s0.move.tx - dx, ty: s0.move.ty - dy, px: s0.move.px - dx * 16, py: s0.move.py - dy * 16 };
    const chars = keyedRecord<typeof s0.chars.chars[string]>();
    for (const id of Object.keys(s0.chars.chars)) {
      const ch = s0.chars.chars[id]!;
      chars[id] = { ...ch, tx: ch.tx - dx, ty: ch.ty - dy, px: ch.px - dx * 16, py: ch.py - dy * 16 };
    }
    this.window = b;
    this.session = this.makeSession(b);
    this.state = { ...s0, move, chars: { rng: s0.chars.rng, chars } };
    this.applySwitches(this.state, b, (rx, ry) => b.ticks.get(regionKey(rx, ry)) ?? -1);
    this.windowTicks.clear();
    for (const [k, t] of b.ticks) this.windowTicks.set(k, t);
    this.applyGrowth();
    this.driver.windowMoved();
    this.recentres++;
    this.recentredThisFrame = true;
    this.lastFocusChunk = "";
  }

  stats(): ResidencyStats & { recentres: number; maxFrameUnits: number; budgetViolations: number } {
    return { ...this.res.stats(), recentres: this.recentres, maxFrameUnits: this.maxFrameUnits, budgetViolations: this.budgetViolations };
  }

  /** Stable digest of the semantic state (trajectory tests). */
  digest(): string {
    const p = this.playerTile;
    const m = this.state.move;
    const chars = Object.keys(this.state.chars.chars).sort().map((id) => {
      const c = this.state.chars.chars[id]!;
      return `${id}@${this.window.x0 + c.tx},${this.window.y0 + c.ty},${c.px - c.tx * 16},${c.py - c.ty * 16}`;
    });
    return `${this.now}|${p.x},${p.y},${m.px - m.tx * 16},${m.py - m.ty * 16},${m.facing}|${this.window.x0},${this.window.y0}|${this.mode}|${chars.join(";")}`;
  }
}
