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
} from "../../vendor/pocket-rpgkit/src/engine/session.ts";
import { keyedRecord } from "../../vendor/pocket-rpgkit/src/engine/clone.ts";
import { MOTION_HZ, motionTicksPerFrame } from "../../vendor/pocket-rpgkit/src/engine/motion-clock.ts";
import { BLOCK, canStepFrom, setPassageOverride, type Dir4, type PassageTable } from "../../vendor/pocket-rpgkit/src/engine/passability.ts";
import { blocksAt, roadAt, type ChunkData } from "./chunk.ts";
import { AutoWalker } from "./driver.ts";
import { chunkKey, regionKey, Residency, STEP_MAX, TICK_BUDGET, type Focus, type ResidencyStats } from "./residency.ts";
import { buildWindow, windowChunks, windowJob, windowRegions, WINDOW, type WindowBuild } from "./window.ts";
import { CHUNK, REGION, REGION_CHUNKS, regionOf, regionHub, growHash } from "./world.ts";
import { landmarkFor, isWilderness, nearestLandmark, type Landmark } from "./landmarks.ts";
import { TravelLog } from "./travel-log.ts";
import { improvementCells, pureLmIsWarm, pureLmPeek, pureLmSet, townErrand, townFacts, townPlaque, townTalk, type Errand, type TownLookups } from "./towns.ts";
import { F_DECOR, F_UPPER, planRegion, regionName, type RegionPlan } from "./region.ts";

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
/** Max helped towns remembered exactly (oldest falls off to the Bloom). */
export const HELP_CAP = 32;
/** How close to the hub the plaza action works (tiles). */
export const PLAZA_RADIUS = 12;
/** Within how many tiles of a visit-errand landmark it counts as visited. */
export const VISIT_ARRIVE = 6;
/** Auto-talk: chase a villager this far, for at most this many ticks, and
 *  page the dialog one line every TALK_PAGE ticks. The chase runs at fast
 *  speed (see onTownArrival) so a villager at the chase range is reached in
 *  about a second — inside the arrival pause, so the stop stays max(pause,
 *  talk) and the between-encounter gap does not grow. */
const TALK_RANGE = 12;
const TALK_BUDGET = 150;
const TALK_PAGE = 24;
/** Towns the auto-walker has talked at (bounded FIFO). The cap is set so the
 *  serialized errand state (helped set + Bloom + talked set + errand) stays
 *  within the 1 KiB save bound. */
const TALK_CAP = 24;
const DIR_MASK = [BTN_DOWN, BTN_LEFT, BTN_UP, BTN_RIGHT] as const;
/** Hard upper bound on the serialized errand session state (UTF-8 bytes). */
export const ERRANDS_SAVE_MAX = 1024;

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

/** A bounded Bloom filter of helped towns. The exact set (HELP_CAP) drives
 *  dialog and immediate flowers; the Bloom never forgets, so a town helped
 *  long ago still flowers when its plan is regenerated. False positives
 *  only ever add flowers — acceptable (R2 5.1). 1024 bits, 3 hashes: a few
 *  hundred helps keep the false-positive rate in the low percent. */
class HelpedBloom {
  private readonly bits = new Uint32Array(32);
  constructor(private readonly seed: number) {}
  add(rx: number, ry: number): void {
    for (const b of this.bitsFor(rx, ry)) this.bits[b >>> 5]! |= 1 << (b & 31);
  }
  has(rx: number, ry: number): boolean {
    for (const b of this.bitsFor(rx, ry)) if (!(this.bits[b >>> 5]! & (1 << (b & 31)))) return false;
    return true;
  }
  private bitsFor(rx: number, ry: number): [number, number, number] {
    const h1 = growHash(this.seed, rx, ry, 0xb100a), h2 = growHash(this.seed, rx, ry, 0xb100b);
    return [h1 % 1024, h2 % 1024, ((h1 ^ (h2 >>> 7)) >>> 0) % 1024];
  }
  toJSON(): number[] { return [...this.bits]; }
  copyFrom(arr: readonly number[]): void {
    this.bits.fill(0);
    for (let i = 0; i < this.bits.length; i++) this.bits[i] = arr[i] ?? 0;
  }
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
  /** Travel log: discovered landmarks (bounded, overflow counted). */
  log = new TravelLog();
  /** Kind name of the most recent discovery (notice text), or "". */
  lastFind = "";
  /** The errand in progress, if any (a pure offer accepted at a plaza). */
  errand: Errand | null = null;
  /** Towns that received a delivery (bounded FIFO set of region keys). */
  readonly helped = new Set<number>();
  /** Total deliveries ever (never decreases). */
  helpedCount = 0;
  /** Bumped on accept/deliver; the view reads lastEvent for its notice. */
  eventVersion = 0;
  lastEvent = "";
  /** Bumped when a helped town's plaza decor is (re)applied. */
  improvedVersion = 0;
  /** Towns the auto-walker has talked at (bounded). */
  get talkedCount(): number { return this.talked.size; }
  private helpedBloom!: HelpedBloom;
  private readonly look: TownLookups = {
    hubOf: (rx, ry) => this.res.hub(rx, ry),
    // Pure in (seed, region): the cached placed landmark, never the
    // residency-aware placedLandmark (which returns null for a developed
    // region whose plan is not resident, so the plaza offer would depend
    // on what is loaded). The sim warms the cache under the per-tick
    // budget before the offer reads it; a cold cache degrades to null.
    landmarkOf: (rx, ry) => pureLmPeek(this.seed, rx, ry) ?? null,
  };
  /** Pure lookups for the on-demand dialog resolver. Identical to the
   *  build-time look: regionHub is the pure point function behind res.hub,
   *  and the landmark cache is content-addressed, so the expanded lines
   *  equal the old build-time bake. */
  private readonly tokenLook: TownLookups = {
    hubOf: (rx, ry) => regionHub(this.seed, rx, ry),
    landmarkOf: (rx, ry) => pureLmPeek(this.seed, rx, ry) ?? null,
  };
  /** Memoized expanded dialog lines per (region, villager, helped); a box
   *  opens one line token at a time, so this collapses the 3-4 resolver
   *  calls per dialog into one generation. Cleared on reseed and swap. */
  private readonly talkLineCache = new Map<string, string[]>();
  /** Auto-talk state machine (approach a villager, then page its dialog). */
  private talk: { phase: "approach" | "dialog"; ticks: number; town: number; villager: string | null; path: number[]; pathTick: number; stillTicks: number; lastX: number; lastY: number } | null = null;
  /** Town whose auto-talk dialog is currently open. A takeover drops the
   *  talk state but leaves the modal for the player to page; when the walk
   *  returns to auto (SELECT, or idle-resume) the pager is recreated for
   *  this town so the dialog finishes instead of orphaning the walker
   *  behind a modal nothing pages (the walker cannot move while a modal
   *  owns the session). Cleared when the dialog ends. */
  private pendingDialogTown: number | null = null;
  /** Towns the auto-walker has opened a villager dialog at (bounded FIFO). */
  private readonly talked = new Set<number>();
  private lastArrivedTowns = 0;
  /** Last tile scanned for landmarks (skip re-scan until the player moves). */
  private lastLandmarkX = NaN;
  private lastLandmarkY = NaN;
  /** Memoized placed landmark per region (bounded); see placedLandmark. */
  private readonly landmarkCache = new Map<number, Landmark | null>();
  /** Cached HUD rumor per player tile + log version; see nearestRumor. */
  private rumorCache: { x: number; y: number; version: number; value: ReturnType<WanderSim["nearestRumor"]> } | null = null;
  /** Growth tick of each region as last written into the live window. */
  private readonly windowTicks = new Map<number, number>();
  /** Centre chunks whose town-scan landmark facts are warm (windowReady). */
  private readonly readyWarm = new Map<number, boolean>();
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
    this.readyWarm.clear();
    this.talkLineCache.clear();
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
    // F1/F2 session state restarts with the world (a reseed grows a new
    // session): the log, errands and helped towns do not carry across.
    this.log = new TravelLog();
    this.lastFind = "";
    this.errand = null;
    this.helped.clear();
    this.helpedCount = 0;
    this.eventVersion = 0;
    this.lastEvent = "";
    this.improvedVersion = 0;
    this.helpedBloom = new HelpedBloom(seed);
    this.talk = null;
    this.pendingDialogTown = null;
    this.talked.clear();
    this.lastArrivedTowns = 0;
    this.lastLandmarkX = NaN;
    this.lastLandmarkY = NaN;
    this.landmarkCache.clear();
    this.rumorCache = null;
    this.res = new Residency(seed);
    // The budgeted fact job reports warmed landmarks here; the cache is the
    // only thing the window build and the plaza offer read.
    this.res.onFact = (rx, ry, lm) => pureLmSet(seed, rx, ry, lm);
    this.res.isFactWarm = (rx, ry) => pureLmIsWarm(seed, rx, ry);
    // A plan regenerated after eviction regrows its town's plaza flowers.
    this.res.onPlan = (plan) => {
      // The plan is now the authority for its region's landmark: drop any
      // memoized pure placement (a developed region may have placed a later
      // candidate than the first one) and the cached rumor (a new placed
      // landmark can change the nearest one).
      this.landmarkCache.delete(regionKey(plan.rx, plan.ry));
      this.rumorCache = null;
      if (this.helpedBloom.has(plan.rx, plan.ry)) this.applyImprovement(plan);
      // Proactively warm the town's 7x7 landmark scan (the on-demand dialog
      // resolver and the plaza offer read it) so a later talk finds it
      // ready; soaks idle budget.
      if (plan.hub.town) {
        for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
          this.res.warmFact(plan.rx + dx, plan.ry + dy);
        }
      }
    };
    this.driver = new AutoWalker(seed);
    const start = startTile(this.res);
    const cx = Math.floor(start.x / CHUNK), cy = Math.floor(start.y / CHUNK);
    this.focus = { x: start.x, y: start.y, hx: 1, hy: 0 };
    // Boot: the window and what the viewport shows are generated up front.
    this.res.updateRings(this.focus, this.viewTilesW, this.viewTilesH, windowChunks(cx, cy));
    this.res.fill(0);
    this.res.maxSpent = 0; // boot is the one unbudgeted fill
    // The start window's landmark facts warm under the per-tick budget (the
    // fact queue); the on-demand dialog resolver and the plaza offer read
    // only ready facts, so a cold cache degrades to "no landmark" until the
    // fact job warms it. A synchronous warm ran ~25 planRegions in the
    // boot frame.
    this.discover();
    this.window = buildWindow(this.res, seed, cx, cy, (rx, ry) => this.res.regionTick(rx, ry, this.now), { ...start, dir: "down" }, false, (rx, ry) => this.isHelped(rx, ry));
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
    const s = createSession(w.project, MOTION_HZ, { textTokens: (key) => this.expandDialogToken(key) });
    s.cfg = { tile: 16, speed: this.fast ? FAST_SPEED : WALK_SPEED };
    return s;
  }

  /** Expand a baked dialog token (`v:rx:ry:house:h:line` / `p:rx:ry:h:line`)
   *  into the line the old build-time bake would have produced. Called by the
   *  engine when a box opens (the talk frame), so the per-region line
   *  generation runs on demand, never in a window-build slice or on a swap
   *  frame. Pure in (seed, region, villager, helped): the plan comes from
   *  the residency or the identical pure planRegion, the landmark facts from
   *  the pure cache (warmed before the build), and the helped flag is frozen
   *  into the key at build time — so the expanded line equals the old bake.
   *  Memoized per (region, villager, helped) because a box opens one line
   *  token at a time. */
  private expandDialogToken(key: string): string | undefined {
    const parts = key.split(":");
    if (parts.length < 5) return undefined;
    const rx = Number(parts[1]), ry = Number(parts[2]);
    if (!Number.isInteger(rx) || !Number.isInteger(ry)) return undefined;
    const isVillager = parts[0] === "v";
    const house = isVillager ? Number(parts[3]) : 0;
    const helped = (isVillager ? parts[4] : parts[3]) === "1";
    const line = Number(isVillager ? parts[5] : parts[4]);
    if (!Number.isInteger(line) || line < 0) return undefined;
    const cacheKey = `${isVillager ? "v" : "p"}:${rx}:${ry}:${isVillager ? house + ":" : ""}${helped ? 1 : 0}`;
    let lines = this.talkLineCache.get(cacheKey);
    if (!lines) {
      const plan = this.res.plan(rx, ry) ?? planRegion(this.seed, rx, ry);
      if (!plan.hub.town) return undefined;
      const facts = townFacts(this.seed, plan, this.tokenLook);
      const errand = townErrand(this.seed, rx, ry, this.tokenLook.landmarkOf);
      lines = isVillager
        ? townTalk(this.seed, plan, house, facts, errand, helped).lines
        : townPlaque(this.seed, plan, facts, errand, helped);
      if (this.talkLineCache.size >= 256) this.talkLineCache.clear();
      this.talkLineCache.set(cacheKey, lines);
    }
    return lines[line];
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
    if (pressed & BTN_SELECT) { this.mode = "auto"; this.driver.reset(); this.idle = 0; this.clearTalk(); this.resumeAutoDialog(); }
    if (buttons & TAKEOVER) {
      if (this.mode !== "manual") this.driver.reset();
      this.mode = "manual";
      this.idle = 0;
      this.clearTalk();
    }
    // 1. input
    let mask = 0;
    let edges = 0;
    if (this.mode === "manual") {
      if (buttons & TAKEOVER) this.idle = 0;
      else if (++this.idle >= IDLE_RESUME_SECONDS * MOTION_HZ) { this.mode = "auto"; this.driver.reset(); this.resumeAutoDialog(); }
      mask = this.slideManualMask(buttons & TAKEOVER);
      edges = pressed;
    }
    if (this.mode !== "manual") {
      mask = this.driver.mask({
        now: this.now, move: this.state.move, x0: this.window.x0, y0: this.window.y0,
        table: this.session.tables.get(this.window.project.maps[0]!.id)!,
        roads: this.window.roads, res: this.res,
        swapPending: this.pending !== null || this.built !== null,
        found: this.log,
        placed: (rx, ry) => this.placedLandmark(rx, ry),
      });
      if (this.mode === "goto" && !this.driver.target && !this.state.move.moving) {
        this.mode = "manual";
        this.idle = 0;
      }
    }
    if (this.mode === "auto") {
      // Auto mode also plays the towns: it runs errands to their targets
      // and stops to talk to a villager at every town, once per town.
      this.syncErrandTarget();
      if (this.driver.arrivedTowns !== this.lastArrivedTowns) {
        this.lastArrivedTowns = this.driver.arrivedTowns;
        this.onTownArrival();
      }
      const talk = this.applyAutoTalk(mask);
      mask = talk.mask;
      edges |= talk.edges;
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
    // 3b. landmarks: a landmark is discovered when its centre enters the
    //     viewport (the growth ring has always discovered its region first).
    this.discoverLandmarks();
    // 3c. errands: a visit errand completes at its landmark.
    this.checkVisitErrand();
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
        this.pending = { cx: pcx, cy: pcy, gen: windowJob(this.res, this.seed, pcx, pcy, (rx, ry) => this.res.regionTick(rx, ry, this.now), { ...p, dir }, false, (rx, ry) => this.isHelped(rx, ry)) };
      }
      while (this.pending && spent + STEP_MAX <= this.budget) {
        const r = this.pending.gen.next();
        if (r.done) { this.built = r.value; this.pending = null; spent += 8; break; }
        spent += r.value;
      }
    }
    // Residency generation runs while no window is waiting to swap in. A
    // swap-pending frame (the build just completed, or a dialog owns the
    // session) skips generation entirely: the swap frame is a pointer swap,
    // not a generation frame, so a fast-travel recentre costs the same as
    // main's. The skipped generation runs on the next frame.
    if (!this.built) spent += this.res.runBudget(this.budget - spent, this.now);
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
    // The pure landmark facts every town region's 7x7 scan needs (the
    // on-demand dialog resolver and the plaza offer) must be warm before
    // the window swaps in: a dialog opened in the new window must expand
    // to the pure lines, and a cold cache would degrade to "no landmark".
    // Enqueue the cold ones and wait for the budgeted fact job to warm
    // them. The result is cached per centre chunk: once warm it stays warm
    // for the run (the pure cache is content-addressed and large enough to
    // outlast a session), so the per-tick cost is one Map.get, not ~400
    // lookups.
    const ck = chunkKey(cx, cy);
    if (this.readyWarm.get(ck) === true) return true;
    for (const [rx, ry] of windowRegions(cx, cy)) {
      if (!this.res.hub(rx, ry).town) continue;
      for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
        this.res.warmFact(rx + dx, ry + dy);
      }
    }
    for (const [rx, ry] of windowRegions(cx, cy)) {
      if (!this.res.hub(rx, ry).town) continue;
      for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
        if (!pureLmIsWarm(this.seed, rx + dx, ry + dy)) return false;
      }
    }
    if (this.readyWarm.size >= 256) this.readyWarm.clear();
    this.readyWarm.set(ck, true);
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
    this.talkLineCache.clear();
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
    return `${this.now}|${p.x},${p.y},${m.px - m.tx * 16},${m.py - m.ty * 16},${m.facing}|${this.window.x0},${this.window.y0}|${this.mode}|${this.errand ? `${this.errand.kind}:${this.errand.trx},${this.errand.try}` : "-"}|${this.helpedCount}|${chars.join(";")}`;
  }

  // -- F1: landmarks, rumor, travel log ------------------------------------

  /** The landmark a region actually placed: the plan's when generated,
   *  else the pure placement (exact for wilderness regions). A developed
   *  region whose plan is not generated yet returns null, so the rumor and
   *  the driver never act on a candidate that lost its spot.
   *
   *  Memoized per region (bounded): the pure roll is evaluated at most once
   *  per region per session — inside the budgeted plan job when the plan
   *  completes (onPlan drops the memo then), or as a one-time world-fact
   *  lookup for an undiscovered wilderness region the rumor scans (the same
   *  class of memoized fact as residency.hub). Nothing recomputes a roll
   *  per driver tick or per HUD refresh. */
  placedLandmark(rx: number, ry: number): Landmark | null {
    const k = regionKey(rx, ry);
    if (this.landmarkCache.has(k)) return this.landmarkCache.get(k)!;
    let lm: Landmark | null;
    const planned = this.res.plan(rx, ry)?.landmark;
    if (planned) {
      lm = planned;
    } else if (isWilderness(this.seed, rx, ry)) {
      // Exact for wilderness: the first candidate always fits (no developed
      // cells can reject it), so the pure placement equals the plan's.
      lm = landmarkFor(this.seed, rx, ry);
    } else {
      lm = null;
    }
    if (this.landmarkCache.size >= 256) this.landmarkCache.clear();
    this.landmarkCache.set(k, lm);
    return lm;
  }

  /** Record landmarks whose centre is inside the viewport. The growth ring
   *  (wider than the viewport) has always discovered the region first, so a
   *  placed landmark is born by the time it can be seen. Only re-scans when
   *  the player steps to a new tile. */
  private discoverLandmarks(): void {
    const p = this.playerTile;
    if (p.x === this.lastLandmarkX && p.y === this.lastLandmarkY) return;
    this.lastLandmarkX = p.x; this.lastLandmarkY = p.y;
    const rx = regionOf(p.x), ry = regionOf(p.y);
    const halfW = Math.floor(this.viewW / 32);
    const halfH = Math.floor(this.viewH / 32);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const plan = this.res.plan(rx + dx, ry + dy);
      const lm = plan?.landmark;
      if (!lm) continue;
      const key = regionKey(lm.rx, lm.ry);
      if (this.log.has(key)) continue;
      if (this.res.regionTick(lm.rx, lm.ry, this.now) < lm.bornTick) continue;
      if (Math.abs(lm.cx - p.x) > halfW || Math.abs(lm.cy - p.y) > halfH) continue;
      this.log.add(key, { name: plan!.name, kind: lm.kindName, x: lm.cx, y: lm.cy, rx: lm.rx, ry: lm.ry, t: this.now });
      this.lastFind = lm.kindName;
    }
  }

  /** Nearest undiscovered placed landmark within four regions, for the HUD
   *  rumor. Coordinates are the plan's actual placement (or the exact pure
   *  placement for wilderness), never a candidate that lost its spot.
   *  Live: cached per player tile + log version, so the direction and
   *  distance always match the tile the player stands on (the view polls
   *  it every few frames; the memoized placedLandmark makes a recompute
   *  cheap). */
  nearestRumor(): { kind: string; dir: string; dist: number; x: number; y: number } | null {
    const p = this.playerTile;
    if (this.rumorCache && this.rumorCache.x === p.x && this.rumorCache.y === p.y && this.rumorCache.version === this.log.version) return this.rumorCache.value;
    const lm = nearestLandmark(p.x, p.y, 4, (rrx, rry) => this.placedLandmark(rrx, rry), (rrx, rry) => this.log.has(regionKey(rrx, rry)));
    let value: ReturnType<WanderSim["nearestRumor"]> = null;
    if (lm) {
      const dist = Math.abs(p.x - lm.cx) + Math.abs(p.y - lm.cy);
      const wx = Math.sign(lm.cx - p.x), wy = Math.sign(lm.cy - p.y);
      const dir = wy < 0 ? (wx < 0 ? "NW" : wx > 0 ? "NE" : "N") : wy > 0 ? (wx < 0 ? "SW" : wx > 0 ? "SE" : "S") : wx < 0 ? "W" : "E";
      value = { kind: lm.kindName, dir, dist, x: lm.cx, y: lm.cy };
    }
    this.rumorCache = { x: p.x, y: p.y, version: this.log.version, value };
    return value;
  }

  /** Serialize the travel log (bounded session state) to a string. */
  serializeLog(): string { return this.log.serialize(); }

  /** Restore a travel log produced by serializeLog. */
  restoreLog(text: string): void { this.log.copyFrom(TravelLog.restore(text)); }

  /** Digest of the travel log (serialize/restore tests): total, version,
   *  the overflow counts, the remembered-identity count, and every window
   *  entry — a lossy restore changes the digest. */
  logDigest(): string {
    const parts: string[] = [];
    for (const [k, v] of this.log.found) parts.push(`${k}:${v.kind}`);
    const over = [...this.log.overflowCounts()].map(([k, n]) => `${k}=${n}`).sort().join(",");
    return `${this.log.total}:${this.log.version}:${this.log.seenSize}:${over}:${parts.join("|")}`;
  }

  // -- F2: errands, helped towns, plaza flowers, auto-talk -----------------

  /** Whether a town counts as helped (dialog and the exact flower set). */
  isHelped(rx: number, ry: number): boolean {
    return this.helped.has(regionKey(rx, ry)) || this.helpedBloom.has(rx, ry);
  }

  /** Whether the player stands on a town's plaza (CROSS accepts/delivers). */
  nearPlaza(): boolean {
    const p = this.playerTile;
    const plan = this.res.plan(regionOf(p.x), regionOf(p.y));
    if (!plan?.hub.town) return false;
    return Math.abs(p.x - plan.hub.x) + Math.abs(p.y - plan.hub.y) <= PLAZA_RADIUS;
  }

  /** Plaza action (CROSS near a town hub): accept the town's errand, or
   *  deliver the one in progress. The offer is pure in (seed, region), so
   *  two identical walks accept and deliver identically. */
  pressAction(): void {
    const p = this.playerTile;
    const rx = regionOf(p.x), ry = regionOf(p.y);
    const plan = this.res.plan(rx, ry);
    if (!plan?.hub.town) return;
    if (Math.abs(p.x - plan.hub.x) + Math.abs(p.y - plan.hub.y) > PLAZA_RADIUS) return;
    if (this.errand && this.errand.trx === rx && this.errand.try === ry) {
      this.completeErrand();
    } else if (!this.errand) {
      const e = townErrand(this.seed, rx, ry, this.look.landmarkOf);
      if (e) {
        this.errand = e;
        this.lastEvent = e.kind === "visit"
          ? `ERRAND: ${e.what} near ${e.targetName}`
          : `ERRAND: carry ${e.what} to ${e.targetName}`;
        this.eventVersion++;
      }
    }
  }

  /** Finish the active errand: the target town (deliver) or the offering
   *  town (visit) is helped, and its plaza gains flowers. Idempotent: a town
   *  helped a second time (the auto-walker re-delivers a pure offer) gains
   *  no extra flowers and does not evict a newer town from the exact set —
   *  flowers are a property of "has been helped", not of how many times. */
  private completeErrand(): void {
    const e = this.errand!;
    this.errand = null;
    const hrx = e.kind === "deliver" ? e.trx : e.orx;
    const hry = e.kind === "deliver" ? e.try : e.ory;
    const key = regionKey(hrx, hry);
    if (!this.helped.has(key) && !this.helpedBloom.has(hrx, hry)) {
      if (this.helped.size >= HELP_CAP) this.helped.delete(this.helped.keys().next().value!);
      this.helped.add(key);
      this.helpedBloom.add(hrx, hry);
      this.helpedCount++;
      const plan = this.res.plan(hrx, hry);
      if (plan) this.applyImprovement(plan);
      this.improvedVersion++;
    }
    const town = regionName(this.seed, hrx, hry);
    this.lastEvent = e.kind === "deliver"
      ? `DELIVERED: ${town} thanks you — flowers on the plaza`
      : `DONE: ${town} thanks you — flowers on their plaza`;
    this.eventVersion++;
  }

  /** Write a helped town's plaza flowers into its plan and resident chunks,
   *  so the change is visible at once and a chunk regenerated later grows
   *  it back from the plan. The Bloom replays this on plan regeneration. */
  private applyImprovement(plan: RegionPlan): void {
    const repaint = new Set<ChunkData>();
    for (const cell of improvementCells(plan)) {
      const i = (cell.y - plan.y0) * REGION + (cell.x - plan.x0);
      plan.upper![i] = cell.tile;
      plan.flags![i]! |= F_UPPER | F_DECOR;
      plan.born![i] = 0;
      const c = this.res.chunk(Math.floor(cell.x / CHUNK), Math.floor(cell.y / CHUNK));
      if (c) {
        const ci = (cell.y - c.y0) * CHUNK + (cell.x - c.x0);
        c.devUpper[ci] = cell.tile;
        c.devBorn[ci] = 0;
        c.flags[ci]! |= F_DECOR;
        repaint.add(c);
      }
    }
    // Queue the modified chunks for a render refresh (the view passes res.fresh
    // to RenderRing.update, which re-syncs their cells next frame).
    for (const c of repaint) this.res.fresh.push(c);
  }

  /** A visit errand completes when the walker reaches its landmark. */
  private checkVisitErrand(): void {
    const e = this.errand;
    if (!e || e.kind !== "visit") return;
    const p = this.playerTile;
    if (Math.abs(p.x - e.ax) + Math.abs(p.y - e.ay) <= VISIT_ARRIVE) this.completeErrand();
  }

  /** Keep the driver pointed at the active errand's destination. */
  private syncErrandTarget(): void {
    const e = this.errand;
    if (e) {
      const t = this.driver.errandTarget;
      if (!t || t.rx !== e.trx || t.ry !== e.try) {
        this.driver.errandTarget = { x: e.ax, y: e.ay, rx: e.trx, ry: e.try, landmark: e.kind === "visit" };
      }
    } else if (this.driver.errandTarget) {
      this.driver.errandTarget = null;
    }
  }

  /** The driver arrived at a town: deliver/accept an errand and start the
   *  once-per-town auto-talk. The town is recorded in `talked` only once a
   *  real villager dialog opens (applyAutoTalk), so a failed chase can
   *  retry on a later visit instead of being marked done forever. */
  private onTownArrival(): void {
    this.pressAction();
    const p = this.playerTile;
    const key = regionKey(regionOf(p.x), regionOf(p.y));
    if (this.talked.has(key)) return;
    this.talk = { phase: "approach", ticks: 0, town: key, villager: null, path: [], pathTick: -1, stillTicks: 0, lastX: p.x, lastY: p.y };
    this.driver.social = true;
    // Chase at fast speed: the BFS path is stable (no greedy oscillation),
    // so a villager up to TALK_RANGE tiles away is reached in ~1.5 s —
    // inside the arrival pause, keeping the stop at max(pause, talk).
    this.session.cfg = { tile: 16, speed: FAST_SPEED };
  }

  /** Stop an in-flight auto-talk (takeover / SELECT) and restore speed. */
  private clearTalk(): void {
    if (!this.talk) return;
    this.talk = null;
    this.driver.social = false;
    this.session.cfg = { tile: 16, speed: this.fast ? FAST_SPEED : WALK_SPEED };
  }

  /** The walk returns to auto (SELECT, or idle-resume after a takeover).
   *  If a villager dialog the auto-walk opened is still up, recreate its
   *  pager so the dialog finishes instead of freezing the walker: a takeover
   *  drops the talk state but leaves the modal for the player to page, and
   *  nothing in auto mode pages a dialog it did not open this visit. The
   *  walker cannot move while a modal owns the session, so without this the
   *  auto mode stays frozen forever after one press during an auto dialog. */
  private resumeAutoDialog(): void {
    if (!this.state.interp.modal) { this.pendingDialogTown = null; return; }
    if (this.talk || this.pendingDialogTown === null) return;
    this.talk = { phase: "dialog", ticks: 0, town: this.pendingDialogTown, villager: null, path: [], pathTick: -1, stillTicks: 0, lastX: 0, lastY: 0 };
    this.driver.social = true;
  }

  /** Auto-talk: chase ONE villager (locked at arrival, so the target does
   *  not flip between nearby villagers and oscillate), face it, open its
   *  dialog with CIRCLE, then page through until it closes. Returns the
   *  mask/edges to fold this tick (the driver stands down while this runs). */
  private applyAutoTalk(mask: number): { mask: number; edges: number } {
    const t = this.talk;
    if (!t) return { mask, edges: 0 };
    const end = (): { mask: number; edges: number } => {
      this.talk = null; this.driver.social = false; this.driver.resumeAfterSocial();
      this.pendingDialogTown = null;
      // Restore the walker's normal speed after the chase.
      this.session.cfg = { tile: 16, speed: this.fast ? FAST_SPEED : WALK_SPEED };
      return { mask, edges: 0 };
    };
    if (this.state.interp.modal) {
      if (t.phase !== "dialog") {
        // A real dialog opened: this town's auto-talk succeeded.
        t.phase = "dialog"; t.ticks = 0;
        this.pendingDialogTown = t.town;
        if (!this.talked.has(t.town)) {
          this.talked.add(t.town);
          if (this.talked.size > TALK_CAP) this.talked.delete(this.talked.keys().next().value!);
        }
      }
      t.ticks++;
      return { mask, edges: t.ticks % TALK_PAGE === 0 ? BTN_CIRCLE : 0 };
    }
    if (t.phase === "dialog") return end();
    if (++t.ticks > TALK_BUDGET) return end();
    // Lock onto one villager for the whole chase (the nearest at arrival);
    // re-pick only if it left the window, strayed too far, or the chase
    // stalled (the player boxed in by another char).
    let v = this.villagerPos(t.villager);
    const p0 = this.playerTile;
    if (p0.x === t.lastX && p0.y === t.lastY) {
      if (++t.stillTicks > 40) { t.villager = null; t.stillTicks = 0; v = null; }
    } else {
      t.stillTicks = 0; t.lastX = p0.x; t.lastY = p0.y;
    }
    if (!v || v.d > TALK_RANGE + 4) {
      const near = this.nearestVillager(TALK_RANGE);
      t.villager = near ? this.nearestVillagerId(near.x, near.y) : null;
      t.path = []; t.pathTick = -1;
      v = this.villagerPos(t.villager);
    }
    if (!v) return { mask, edges: 0 };
    const p = this.playerTile;
    if (v.d <= 1) {
      const dir = v.y > p.y ? 0 : v.y < p.y ? 2 : v.x < p.x ? 1 : 3;
      if (this.state.move.facing !== dir) return { mask: DIR_MASK[dir]!, edges: 0 };
      // The CIRCLE opens the villager dialog this tick. Record the town now,
      // not when the modal is observed: a takeover on the very next tick
      // clears the talk state before applyAutoTalk ever sees the modal, and
      // the resume pager must still know which dialog to finish.
      this.pendingDialogTown = t.town;
      return { mask, edges: BTN_CIRCLE };
    }
    // BFS path to the villager (robust around houses); recompute every 20
    // ticks or when the path is spent, since the villager is walking.
    if (t.path.length === 0 || t.ticks - t.pathTick >= 20) {
      t.path = this.chasePath(v.x, v.y);
      t.pathTick = t.ticks;
    }
    const next = t.path.shift();
    if (next === undefined) return { mask, edges: 0 }; // unreachable this tick
    return { mask: DIR_MASK[next]!, edges: 0 };
  }

  /** A BFS path of walk directions from the player to a walkable, char-free
   *  tile ADJACENT to (wx, wy), over the live passage table (bounded to a
   *  small window so it is cheap). Empty when no adjacent tile is reachable.
   *  The villager's own tile is blocked by the villager, so targeting it left
   *  the player stalled one tile short (the path's last step could never be
   *  taken); the player only ever needs to stand next to the villager. */
  private chasePath(wx: number, wy: number): number[] {
    const table = this.session.tables.get(this.window.project.maps[0]!.id)!;
    const m = this.state.move;
    const tx = wx - this.window.x0, ty = wy - this.window.y0;
    if (tx < 0 || ty < 0 || tx >= WINDOW || ty >= WINDOW) return [];
    const sx = m.tx, sy = m.ty;
    if (sx === tx && sy === ty) return [];
    const R = TALK_RANGE + 6;
    const x0 = Math.max(0, Math.min(sx, tx) - 2), y0 = Math.max(0, Math.min(sy, ty) - 2);
    const x1 = Math.min(WINDOW - 1, Math.max(sx, tx) + 2), y1 = Math.min(WINDOW - 1, Math.max(sy, ty) + 2);
    if (Math.abs(tx - sx) > R || Math.abs(ty - sy) > R) return [];
    // Blocking chars occupy tiles the passage table still marks walkable;
    // the player cannot step onto them, so the BFS must avoid them too.
    const blocked = new Set<number>();
    for (const id in this.state.chars.chars) {
      const ch = this.state.chars.chars[id]!;
      if (!ch.visible || !ch.blocks) continue;
      blocked.add(ch.ty * WINDOW + ch.tx);
    }
    const w = x1 - x0 + 1;
    const prev = new Int16Array(w * (y1 - y0 + 1)).fill(-1);
    const si = (sy - y0) * w + (sx - x0);
    prev[si] = si;
    const queue = new Int16Array(w * (y1 - y0 + 1));
    let qh = 0, qt = 0;
    queue[qt++] = si;
    const DX4 = [0, -1, 0, 1], DY4 = [1, 0, -1, 0];
    let goal = -1;
    while (qh < qt) {
      const cur = queue[qh++]!;
      const cx = x0 + (cur % w), cy = y0 + ((cur - (cur % w)) / w);
      // Goal: a walkable, char-free tile adjacent to the villager.
      if (Math.abs(cx - tx) + Math.abs(cy - ty) === 1 && !blocked.has(cur)) { goal = cur; break; }
      for (let d = 0; d < 4; d++) {
        const nx = cx + DX4[d]!, ny = cy + DY4[d]!;
        if (nx < x0 || ny < y0 || nx > x1 || ny > y1) continue;
        const ni = (ny - y0) * w + (nx - x0);
        if (prev[ni] !== -1) continue;
        if (blocked.has(ni)) continue;
        if (!canStepFrom(table, cx, cy, d as Dir4)) continue;
        prev[ni] = cur;
        queue[qt++] = ni;
      }
    }
    if (goal === -1) return [];
    const path: number[] = [];
    let cur = goal;
    while (cur !== si) {
      const pc = prev[cur]!;
      const px = x0 + (pc % w), py = y0 + ((pc - (pc % w)) / w);
      const cx = x0 + (cur % w), cy = y0 + ((cur - (cur % w)) / w);
      path.push(cx > px ? 3 : cx < px ? 1 : cy > py ? 0 : 2);
      cur = pc;
    }
    return path.reverse();
  }

  /** A visible villager's current world position by char id, or null. */
  private villagerPos(id: string | null): { x: number; y: number; d: number } | null {
    if (!id) return null;
    const ch = this.state.chars.chars[id];
    if (!ch || !ch.visible) return null;
    const x = this.window.x0 + ch.tx, y = this.window.y0 + ch.ty;
    const p = this.playerTile;
    return { x, y, d: Math.abs(x - p.x) + Math.abs(y - p.y) };
  }

  /** The char id of the visible villager nearest a world tile. */
  private nearestVillagerId(x: number, y: number): string | null {
    let best: string | null = null, bestD = Infinity;
    for (const id in this.state.chars.chars) {
      const ch = this.state.chars.chars[id]!;
      if (!ch.visible) continue;
      const cx = this.window.x0 + ch.tx, cy = this.window.y0 + ch.ty;
      const d = Math.abs(cx - x) + Math.abs(cy - y);
      if (d < bestD) { best = id; bestD = d; }
    }
    return best;
  }

  /** The nearest visible resident within `maxDist` tiles (world coords). */
  private nearestVillager(maxDist: number): { x: number; y: number; d: number } | null {
    const p = this.playerTile;
    let best: { x: number; y: number; d: number } | null = null;
    for (const id in this.state.chars.chars) {
      const ch = this.state.chars.chars[id]!;
      if (!ch.visible) continue;
      const x = this.window.x0 + ch.tx, y = this.window.y0 + ch.ty;
      const d = Math.abs(x - p.x) + Math.abs(y - p.y);
      if (d <= maxDist && (!best || d < best.d)) best = { x, y, d };
    }
    return best;
  }

  // -- F2: bounded session state (serialize/restore) -----------------------

  /** Serialize the errand session state to a string of at most
   *  ERRANDS_SAVE_MAX UTF-8 bytes. The helped set and Bloom are packed as
   *  base64 binary (FIFO order preserved); the errand is a small JSON
   *  object. The format is versioned and self-describing. */
  serializeErrands(): string {
    const hBuf = new ArrayBuffer(this.helped.size * 8);
    const hDv = new DataView(hBuf);
    let i = 0;
    for (const k of this.helped) { hDv.setFloat64(i * 8, k, true); i++; }
    const tBuf = new ArrayBuffer(this.talked.size * 8);
    const tDv = new DataView(tBuf);
    i = 0;
    for (const k of this.talked) { tDv.setFloat64(i * 8, k, true); i++; }
    const bBuf = new ArrayBuffer(128);
    const bDv = new DataView(bBuf);
    this.helpedBloom.toJSON().forEach((v, j) => bDv.setUint32(j * 4, v >>> 0, true));
    const e = this.errand ? {
      k: this.errand.kind, o: [this.errand.orx, this.errand.ory],
      t: [this.errand.trx, this.errand.try], c: [this.errand.tx, this.errand.ty],
      a: [this.errand.ax, this.errand.ay], n: this.errand.targetName, w: this.errand.what,
    } : null;
    const text = JSON.stringify({ v: 1, e, h: b64encode(new Uint8Array(hBuf)), t: b64encode(new Uint8Array(tBuf)), b: b64encode(new Uint8Array(bBuf)), hc: this.helpedCount });
    if (utf8Len(text) > ERRANDS_SAVE_MAX) throw new Error("wander: errand save exceeds 1 KiB");
    return text;
  }

  /** Restore errand session state produced by serializeErrands. Rejects
   *  (throws) oversize or malformed input: a wrong version, too many helped
   *  towns, a malformed Bloom or errand, or a save over the 1 KiB bound.
   *  Restored helped towns have their resident plaza flowers repainted. */
  restoreErrands(text: string): void {
    if (typeof text !== "string" || text.length === 0) throw new Error("wander: errand save is not a string");
    if (utf8Len(text) > ERRANDS_SAVE_MAX) throw new Error("wander: errand save exceeds 1 KiB");
    let s: unknown;
    try { s = JSON.parse(text); } catch { throw new Error("wander: errand save is not valid JSON"); }
    if (typeof s !== "object" || s === null) throw new Error("wander: errand save is not an object");
    const r = s as Record<string, unknown>;
    if (r.v !== 1) throw new Error("wander: errand save has an unsupported version");
    // An empty helped set serializes as h:"" (b64encode of zero bytes); that
    // is the valid encoding of "no town helped yet", not a malformed field.
    const hStr = typeof r.h === "string" ? r.h : "";
    const hBytes = hStr === "" ? new Uint8Array(0) : b64decode(hStr);
    if (hBytes.length % 8 !== 0) throw new Error("wander: errand save has a malformed helped set");
    const helpedCount = hBytes.length / 8;
    if (helpedCount > HELP_CAP) throw new Error("wander: errand save has too many helped towns");
    const helped: number[] = [];
    const hDv = new DataView(hBytes.buffer, hBytes.byteOffset, hBytes.byteLength);
    for (let j = 0; j < helpedCount; j++) helped.push(hDv.getFloat64(j * 8, true));
    // The talked set is optional (saves written before it was added omit it):
    // an empty set restores as "no town talked yet".
    const tStr = typeof r.t === "string" ? r.t : "";
    const tBytes = tStr === "" ? new Uint8Array(0) : b64decode(tStr);
    if (tBytes.length % 8 !== 0) throw new Error("wander: errand save has a malformed talked set");
    const talkedCount = tBytes.length / 8;
    if (talkedCount > TALK_CAP) throw new Error("wander: errand save has too many talked towns");
    const talked: number[] = [];
    const tDv = new DataView(tBytes.buffer, tBytes.byteOffset, tBytes.byteLength);
    for (let j = 0; j < talkedCount; j++) talked.push(tDv.getFloat64(j * 8, true));
    const bBytes = b64decode(typeof r.b === "string" ? r.b : "");
    if (bBytes.length !== 128) throw new Error("wander: errand save has a malformed bloom");
    const bloom: number[] = [];
    const bDv = new DataView(bBytes.buffer, bBytes.byteOffset, bBytes.byteLength);
    for (let j = 0; j < 32; j++) bloom.push(bDv.getUint32(j * 4, true));
    let errand: Errand | null = null;
    if (r.e !== null && r.e !== undefined) {
      if (typeof r.e !== "object" || r.e === null) throw new Error("wander: errand save has a malformed errand");
      const e = r.e as Record<string, unknown>;
      if (e.k !== "deliver" && e.k !== "visit") throw new Error("wander: errand save has an unknown errand kind");
      for (const a of [e.o, e.t, e.c, e.a]) {
        if (!Array.isArray(a) || a.length !== 2 || !a.every((n) => typeof n === "number" && Number.isInteger(n)))
          throw new Error("wander: errand save has malformed errand coordinates");
      }
      if (typeof e.n !== "string" || typeof e.w !== "string" || e.n.length > 64 || e.w.length > 64)
        throw new Error("wander: errand save has malformed errand strings");
      errand = {
        kind: e.k as Errand["kind"], orx: (e.o as number[])[0]!, ory: (e.o as number[])[1]!,
        trx: (e.t as number[])[0]!, try: (e.t as number[])[1]!,
        tx: (e.c as number[])[0]!, ty: (e.c as number[])[1]!,
        ax: (e.a as number[])[0]!, ay: (e.a as number[])[1]!,
        targetName: e.n, what: e.w,
      };
    }
    const hc = typeof r.hc === "number" && Number.isInteger(r.hc) && r.hc >= 0 ? r.hc : helpedCount;
    this.errand = errand;
    this.helped.clear();
    for (const k of helped) this.helped.add(k);
    this.talked.clear();
    for (const k of talked) this.talked.add(k);
    this.helpedBloom.copyFrom(bloom);
    this.helpedCount = hc;
    // Repaint resident plans of restored helped towns: a restore into an
    // already-resident plan must flower its plaza, not wait for eviction.
    for (const plan of this.res.eachPlan()) {
      if (this.isHelped(plan.rx, plan.ry)) this.applyImprovement(plan);
    }
    this.improvedVersion++;
  }

  /** Digest of the errand state (serialize/restore tests): helped count,
   *  the helped keys in FIFO order, the talked keys, every Bloom bit, and
   *  the full errand payload — a lossy or partial restore changes the digest. */
  errandsDigest(): string {
    const h = [...this.helped].join(",");
    const t = [...this.talked].join(",");
    const b = this.helpedBloom.toJSON().map((v) => (v >>> 0).toString(16)).join(",");
    const e = this.errand
      ? `${this.errand.kind}:${this.errand.orx},${this.errand.ory}:${this.errand.trx},${this.errand.try}:${this.errand.tx},${this.errand.ty}:${this.errand.ax},${this.errand.ay}:${this.errand.targetName}:${this.errand.what}`
      : "-";
    return `${this.helpedCount}|${h}|${t}|${b}|${e}`;
  }

  /** Test hook: mark a town helped without walking there (Bloom tests).
   *  Idempotent like completeErrand: a repeat help adds no flowers and does
   *  not evict a newer town from the exact set. */
  __helpForTest(rx: number, ry: number): void {
    const key = regionKey(rx, ry);
    if (this.helped.has(key) || this.helpedBloom.has(rx, ry)) return;
    if (this.helped.size >= HELP_CAP) this.helped.delete(this.helped.keys().next().value!);
    this.helped.add(key);
    this.helpedBloom.add(rx, ry);
    this.helpedCount++;
    const plan = this.res.plan(rx, ry);
    if (plan) this.applyImprovement(plan);
    this.improvedVersion++;
  }
}

// -- base64 + UTF-8 length (portable: no btoa/TextEncoder dependency) -------

const B64C = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function b64encode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!, b1 = i + 1 < bytes.length ? bytes[i + 1]! : 0, b2 = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    out += B64C[b0 >> 2]! + B64C[((b0 & 3) << 4) | (b1 >> 4)]!;
    out += i + 1 < bytes.length ? B64C[((b1 & 15) << 2) | (b2 >> 6)]! : "=";
    out += i + 2 < bytes.length ? B64C[b2 & 63]! : "=";
  }
  return out;
}

function b64decode(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9+/=]/g, "");
  if (clean.length === 0 || clean.length % 4 !== 0) throw new Error("wander: invalid base64 in errand save");
  const pad = (clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0);
  const len = (clean.length * 3) / 4 - pad;
  const out = new Uint8Array(len);
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = B64C.indexOf(clean[i]!), c1 = B64C.indexOf(clean[i + 1]!);
    const c2 = clean[i + 2] === "=" ? 0 : B64C.indexOf(clean[i + 2]!);
    const c3 = clean[i + 3] === "=" ? 0 : B64C.indexOf(clean[i + 3]!);
    if (c0 < 0 || c1 < 0 || c2 < 0 || c3 < 0) throw new Error("wander: invalid base64 in errand save");
    const n = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3;
    if (o < len) out[o++] = (n >> 16) & 255;
    if (o < len) out[o++] = (n >> 8) & 255;
    if (o < len) out[o++] = n & 255;
  }
  return out;
}

/** UTF-8 byte length of a string (the save is ASCII, but be exact). */
function utf8Len(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : 3;
  }
  return n;
}
