// examples/wander-online/net/realm-world.ts — a streamed, absolute-coordinate
// Wander world shared by the realm server and its client-side predictor.
//
// Generation remains the existing pure Wander generator.  This module only
// schedules planRegionJob/chunkJob, keeps their results in bounded caches,
// and adapts absolute world coordinates to the engine's small-map movement
// reducer.  In particular, movement is deliberately not reimplemented here:
// a 5 x 5 PassageTable centred on the mover is passed to stepMovementLegacy.

import { blocksAt, chunkJob, COMPLETE, type ChunkData } from "../../wander/chunk.ts";
import { planRegionJob, type RegionPlan } from "../../wander/region.ts";
import { CHUNK, REGION_CHUNKS, TILE, regionHub } from "../../wander/world.ts";
import { initialMovement, stepMovementLegacy, type MovementState } from "../../../vendor/pocket-rpgkit/src/engine/movement.ts";
import type { PassageTable } from "../../../vendor/pocket-rpgkit/src/engine/passability.ts";
import type { CharsState } from "../../../vendor/pocket-rpgkit/src/engine/chars.ts";

/** Bump this when the realm's deterministic terrain or scheduling contract changes. */
export const GENERATOR_VERSION = 1;
export const CHUNK_CACHE_CAP = 512;
export const CHUNK_TTL_TICKS = 1800;
export const PLAN_CACHE_CAP = 160;
/** Largest slice yielded by planRegionJob/chunkJob. */
export const REALM_STEP_MAX = 420;

export const I32_MIN = -0x8000_0000;
export const I32_MAX = 0x7fff_ffff;
const MIN_CHUNK = Math.floor(I32_MIN / CHUNK);
const MAX_CHUNK = Math.floor(I32_MAX / CHUNK);
const LOCAL_SPAN = 5;
const LOCAL_CENTRE = 2;

/** A player's absolute tile position. */
export interface RealmFocus {
  x: number;
  y: number;
  /** Optional unit heading used only to order generation work. */
  hx?: -1 | 0 | 1;
  hy?: -1 | 0 | 1;
}

/** Change in the active 3 x 3 chunk union caused by setFocuses. */
export interface FocusDelta {
  active: number;
  addedChunks: number;
  addedRegions: number;
}

/** Collision distinguishes an absent streamed chunk from generated terrain. */
export interface RealmCollision {
  ready: boolean;
  blocked: boolean;
}

export interface RealmCollisionSource {
  collisionAt(tx: number, ty: number): RealmCollision;
}

/** The realm reducer intentionally has no NPC simulation, but retains the
 * familiar empty chars shape so it can be consumed by shared render code. */
export interface RealmState {
  move: MovementState;
  chars: {
    /** Optional because realm states do not run the NPC RNG. */
    rng?: number;
    chars: CharsState["chars"];
  };
}

interface Coord {
  x: number;
  y: number;
  priority?: number;
}

interface PlanJob {
  kind: "plan";
  key: string;
  rx: number;
  ry: number;
  gen: Generator<number, RegionPlan>;
}

interface ChunkJob {
  kind: "chunk";
  key: string;
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  gen: Generator<number, ChunkData>;
}

type RealmJob = PlanJob | ChunkJob;

/** String keys stay exact at every signed-int32 tile coordinate. */
export function realmChunkKey(cx: number, cy: number): string {
  return `${cx},${cy}`;
}

export function realmRegionKey(rx: number, ry: number): string {
  return `${rx},${ry}`;
}

function validI32(value: number): boolean {
  return Number.isInteger(value) && value >= I32_MIN && value <= I32_MAX;
}

function validChunk(cx: number, cy: number): boolean {
  return Number.isInteger(cx) && Number.isInteger(cy)
    && cx >= MIN_CHUNK && cx <= MAX_CHUNK
    && cy >= MIN_CHUNK && cy <= MAX_CHUNK;
}

function coordOrder(a: Coord, b: Coord): number {
  return (a.priority ?? 0) - (b.priority ?? 0) || a.y - b.y || a.x - b.x;
}

function keyOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Multi-player residency for an unbounded realm.
 *
 * Every focus pins the Chebyshev-one (3 x 3) chunk neighbourhood.  Inactive
 * chunks remain reusable for 1,800 reference ticks, unless the hard 512
 * entry LRU cap has to reclaim them sooner.  Active chunks are never an
 * eviction candidate. */
export class MultiFocusWorld implements RealmCollisionSource {
  readonly chunks = new Map<string, ChunkData>();
  readonly plans = new Map<string, RegionPlan>();
  /** Completed chunks since the last drain. */
  readonly fresh: ChunkData[] = [];

  private activeCoords = new Map<string, Coord>();
  private activeRegions = new Map<string, Coord>();
  private readonly chunkUsed = new Map<string, number>();
  private readonly planUsed = new Map<string, number>();
  private job: RealmJob | null = null;
  private tick = 0;

  constructor(readonly seed: number) {}

  get active(): ReadonlySet<string> {
    return new Set(this.activeCoords.keys());
  }

  get activeCount(): number {
    return this.activeCoords.size;
  }

  get plansSize(): number {
    return this.plans.size;
  }

  get queuedCount(): number {
    let count = 0;
    for (const key of this.activeCoords.keys()) if (!this.chunks.has(key)) count++;
    return count;
  }

  chunk(cx: number, cy: number): ChunkData | undefined {
    return this.chunks.get(realmChunkKey(cx, cy));
  }

  /** A-phase realms expose the fully-grown terrain phase everywhere. */
  regionTick(_rx: number, _ry: number, _now: number): number {
    return COMPLETE;
  }

  /** Replace the focus set and return its exact active-frontier delta. */
  setFocuses(focuses: readonly RealmFocus[], now: number): FocusDelta {
    if (!Number.isSafeInteger(now) || now < 0) throw new RangeError(`realm tick ${now} must be a non-negative safe integer`);
    this.tick = now;
    const next = new Map<string, Coord>();
    for (const focus of focuses) {
      if (!validI32(focus.x) || !validI32(focus.y)) {
        throw new RangeError(`realm focus ${focus.x},${focus.y} lies outside signed int32 tiles`);
      }
      const hx = focus.hx ?? 0, hy = focus.hy ?? 0;
      if (!Number.isInteger(hx) || !Number.isInteger(hy) || hx < -1 || hx > 1 || hy < -1 || hy > 1) {
        throw new RangeError(`realm heading ${hx},${hy} must use -1/0/1 components`);
      }
      const centreX = Math.floor(focus.x / CHUNK);
      const centreY = Math.floor(focus.y / CHUNK);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const cx = centreX + dx, cy = centreY + dy;
        if (!validChunk(cx, cy)) continue; // clipped only at the int32 edge
        // Centre first, then the forward edge (column/row), then the rest.
        // For a diagonal heading the two forward edges form the expected L.
        const priority = dx === 0 && dy === 0
          ? 0
          : ((hx !== 0 && dx === hx) || (hy !== 0 && dy === hy) ? 1 : 2);
        const key = realmChunkKey(cx, cy);
        const old = next.get(key);
        if (!old || priority < old.priority!) next.set(key, { x: cx, y: cy, priority });
      }
    }
    if (next.size > CHUNK_CACHE_CAP) {
      throw new RangeError(`realm active union ${next.size} exceeds chunk cache cap ${CHUNK_CACHE_CAP}`);
    }

    // Stable coordinate ordering makes generation independent of focus order.
    this.activeCoords = new Map([...next.entries()].sort((a, b) => coordOrder(a[1], b[1])));
    const nextRegions = new Map<string, Coord>();
    for (const { x: cx, y: cy } of this.activeCoords.values()) {
      const rx = Math.floor(cx / REGION_CHUNKS), ry = Math.floor(cy / REGION_CHUNKS);
      nextRegions.set(realmRegionKey(rx, ry), { x: rx, y: ry });
    }
    this.activeRegions = nextRegions;

    let addedChunks = 0;
    for (const key of this.activeCoords.keys()) {
      if (!this.chunks.has(key)) {
        // Missing versus newly active are different notions; count against
        // the previous active union below, not against residency.
      }
      if (!this.previousActive.has(key)) addedChunks++;
      if (this.chunks.has(key)) this.chunkUsed.set(key, now);
    }
    let addedRegions = 0;
    for (const key of this.activeRegions.keys()) if (!this.previousRegions.has(key)) addedRegions++;

    this.previousActive = new Set(this.activeCoords.keys());
    this.previousRegions = new Set(this.activeRegions.keys());
    if (this.job && !this.jobWanted(this.job)) this.job = null;
    this.evictChunks(now);
    this.evictPlans();
    return { active: this.activeCoords.size, addedChunks, addedRegions };
  }

  private previousActive = new Set<string>();
  private previousRegions = new Set<string>();

  private jobWanted(job: RealmJob): boolean {
    if (job.kind === "chunk") return this.activeCoords.has(job.key) && !this.chunks.has(job.key);
    return this.activeRegions.has(job.key) && !this.plans.has(job.key);
  }

  private nextJob(): RealmJob | null {
    for (const [key, { x: cx, y: cy }] of this.activeCoords) {
      if (this.chunks.has(key)) continue;
      const rx = Math.floor(cx / REGION_CHUNKS), ry = Math.floor(cy / REGION_CHUNKS);
      const pkey = realmRegionKey(rx, ry);
      const plan = this.plans.get(pkey);
      if (!plan) return { kind: "plan", key: pkey, rx, ry, gen: planRegionJob(this.seed, rx, ry) };
      this.planUsed.set(pkey, this.tick);
      return { kind: "chunk", key, cx, cy, rx, ry, gen: chunkJob(this.seed, cx, cy, plan) };
    }
    return null;
  }

  /** Advance generation without ever starting a slice that could exceed the
   * supplied unit budget. */
  runBudget(budget: number, now: number): number {
    if (!Number.isFinite(budget) || budget < 0) throw new RangeError(`invalid realm budget ${budget}`);
    if (!Number.isSafeInteger(now) || now < 0) throw new RangeError(`invalid realm tick ${now}`);
    this.tick = now;
    let spent = 0;
    while (spent + REALM_STEP_MAX <= budget) {
      if (this.job && !this.jobWanted(this.job)) this.job = null;
      if (!this.job) {
        this.job = this.nextJob();
        if (!this.job) break;
      }
      const result = this.job.gen.next();
      if (!result.done) {
        if (result.value > REALM_STEP_MAX) throw new Error(`realm job slice ${result.value} exceeds ${REALM_STEP_MAX}`);
        spent += result.value;
        continue;
      }

      // Completion accounting is smaller than the slice reservation above.
      spent += 8;
      const completed = this.job;
      this.job = null;
      if (completed.kind === "plan") {
        if (!this.activeRegions.has(completed.key)) continue;
        const plan = result.value as RegionPlan;
        this.plans.set(completed.key, plan);
        this.planUsed.set(completed.key, now);
        this.evictPlans();
      } else if (this.activeCoords.has(completed.key)) {
        const chunk = result.value as ChunkData;
        this.chunks.set(completed.key, chunk);
        this.chunkUsed.set(completed.key, now);
        this.fresh.push(chunk);
        if (this.fresh.length > CHUNK_CACHE_CAP) this.fresh.shift();
        this.evictChunks(now);
      }
    }
    // Time alone can expire inactive cache entries even when no work ran.
    this.evictChunks(now);
    this.evictPlans();
    return spent;
  }

  /** Generate the complete active union synchronously.  Intended for client
   * prediction boot and the small frontier change at a chunk crossing. */
  prime(focuses?: readonly RealmFocus[], now = this.tick): void {
    if (focuses) this.setFocuses(focuses, now);
    while (this.queuedCount > 0) {
      const before = this.queuedCount;
      this.runBudget(1_000_000_000, now);
      if (this.queuedCount === before && !this.job) throw new Error("realm prime made no generation progress");
    }
  }

  /** Budgeted streaming alias used by hosts once per reference interval. */
  stream(budget: number, now: number): number;
  stream(focuses: readonly RealmFocus[], budget: number, now: number): number;
  stream(a: number | readonly RealmFocus[], b: number, c?: number): number {
    if (Array.isArray(a)) {
      this.setFocuses(a, c!);
      return this.runBudget(b, c!);
    }
    return this.runBudget(a as number, b);
  }

  drainFresh(): ChunkData[] {
    const drained = this.fresh.splice(0);
    return drained.filter((chunk) => this.chunks.get(realmChunkKey(chunk.cx, chunk.cy)) === chunk);
  }

  collisionAt(tx: number, ty: number): RealmCollision {
    if (!validI32(tx) || !validI32(ty)) return { ready: true, blocked: true };
    const cx = Math.floor(tx / CHUNK), cy = Math.floor(ty / CHUNK);
    const chunk = this.chunk(cx, cy);
    if (!chunk) return { ready: false, blocked: true };
    const lx = tx - chunk.x0, ly = ty - chunk.y0;
    return { ready: true, blocked: blocksAt(chunk, ly * CHUNK + lx, COMPLETE) };
  }

  /** Drop every inactive chunk and every cached plan.  With no focuses this
   * clears the whole cache; active chunks remain pinned by contract. */
  clearCache(): number {
    let removed = 0;
    for (const key of [...this.chunks.keys()]) {
      if (this.activeCoords.has(key)) continue;
      this.chunks.delete(key);
      this.chunkUsed.delete(key);
      removed++;
    }
    this.plans.clear();
    this.planUsed.clear();
    if (this.activeCoords.size === 0) this.fresh.length = 0;
    if (this.job && !this.jobWanted(this.job)) this.job = null;
    return removed;
  }

  private evictChunks(now: number): void {
    // TTL is the normal policy.
    for (const [key, used] of this.chunkUsed) {
      if (!this.activeCoords.has(key) && now - used >= CHUNK_TTL_TICKS) {
        this.chunks.delete(key);
        this.chunkUsed.delete(key);
      }
    }
    // The hard cap has priority over TTL, but still never selects active.
    if (this.chunks.size <= CHUNK_CACHE_CAP) return;
    const candidates = [...this.chunks.keys()]
      .filter((key) => !this.activeCoords.has(key))
      .sort((a, b) => (this.chunkUsed.get(a) ?? -1) - (this.chunkUsed.get(b) ?? -1) || keyOrder(a, b));
    for (const key of candidates) {
      if (this.chunks.size <= CHUNK_CACHE_CAP) break;
      this.chunks.delete(key);
      this.chunkUsed.delete(key);
    }
    if (this.chunks.size > CHUNK_CACHE_CAP) throw new Error("realm active chunks exceed hard cache cap");
    if (this.chunks.size === 0 && this.activeCoords.size === 0) this.fresh.length = 0;
  }

  private evictPlans(): void {
    if (this.plans.size <= PLAN_CACHE_CAP) return;
    const order = [...this.plans.keys()].sort(
      (a, b) => (this.planUsed.get(a) ?? -1) - (this.planUsed.get(b) ?? -1) || keyOrder(a, b),
    );
    for (const key of order) {
      if (this.plans.size <= PLAN_CACHE_CAP) break;
      this.plans.delete(key);
      this.planUsed.delete(key);
    }
  }
}

/** Deterministic origin-realm spawn, on region (0,0)'s road hub. */
export function realmStart(seed: number): { tx: number; ty: number } {
  const hub = regionHub(seed >>> 0, 0, 0);
  return { tx: hub.x, ty: hub.y };
}

/** Pure initial reducer state. */
export function startRealmState(seed: number): RealmState {
  const start = realmStart(seed);
  return {
    move: initialMovement(start.tx, start.ty, 0, { tile: TILE, speed: 2 }),
    chars: { rng: seed >>> 0, chars: Object.create(null) as CharsState["chars"] },
  };
}

function localPassage(collision: RealmCollisionSource, ox: number, oy: number): PassageTable {
  const cells = LOCAL_SPAN * LOCAL_SPAN;
  const solid = new Uint8Array(cells);
  const exitMask = new Uint8Array(cells);
  for (let y = 0; y < LOCAL_SPAN; y++) for (let x = 0; x < LOCAL_SPAN; x++) {
    const tx = ox + x, ty = oy + y;
    // Missing chunks are solid.  The ready bit remains available to callers
    // that want to distinguish streaming pressure from authored collision.
    const result = validI32(tx) && validI32(ty)
      ? collision.collisionAt(tx, ty)
      : { ready: true, blocked: true };
    if (result.blocked) {
      solid[y * LOCAL_SPAN + x] = 1;
    }
    // A mover cannot escape from an absent source chunk merely because its
    // destination happened to finish streaming first.
    if (!result.ready) exitMask[y * LOCAL_SPAN + x] = 0b1111;
  }
  return {
    width: LOCAL_SPAN,
    height: LOCAL_SPAN,
    overrides: new Int8Array(cells),
    solid,
    entryMask: new Uint8Array(cells),
    exitMask,
    ground: new Array<string>(cells).fill("realm.0"),
    sheets: new Map(),
  };
}

/** Shared absolute-coordinate realm reducer.  It performs no generation and
 * is therefore safe for a budgeted multi-player server. */
export function stepRealmMover(
  state: RealmState,
  buttons: number,
  collision: RealmCollisionSource,
  _now?: number,
): RealmState {
  const move = state.move;
  const ox = move.tx - LOCAL_CENTRE, oy = move.ty - LOCAL_CENTRE;
  const local: MovementState = {
    ...move,
    tx: LOCAL_CENTRE,
    ty: LOCAL_CENTRE,
    px: move.px - ox * TILE,
    py: move.py - oy * TILE,
  };
  const next = stepMovementLegacy(local, buttons, localPassage(collision, ox, oy), { tile: TILE, speed: 2 });
  const absolute: MovementState = {
    ...next,
    tx: next.tx + ox,
    ty: next.ty + oy,
    px: next.px + ox * TILE,
    py: next.py + oy * TILE,
  };
  return absolute === move ? state : { ...state, move: absolute };
}

/** Movement-only compatibility surface for authoritative arenas that store
 * the empty chars object alongside their own player record. */
export function stepRealmMovement(
  collision: RealmCollisionSource,
  move: MovementState,
  buttons: number,
): MovementState {
  return stepRealmMover({ move, chars: { chars: Object.create(null) as CharsState["chars"] } }, buttons, collision).move;
}

/** Synchronous single-player/client convenience wrapper. */
export class RealmWorld extends MultiFocusWorld {
  start(): RealmState {
    return startRealmState(this.seed);
  }

  step(state: RealmState, buttons: number, now = 0): RealmState {
    const focus = [{ x: state.move.tx, y: state.move.ty }];
    this.setFocuses(focus, now);
    this.prime(undefined, now);
    return stepRealmMover(state, buttons, this, now);
  }
}
