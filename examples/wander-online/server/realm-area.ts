// Authoritative v4 arena over the endless, signed-coordinate Wander world.
// Networking cadence and input queue semantics intentionally match the v3
// Arena; only the movement/collision source and sparse AOI index differ.

import { motionTicksPerFrame } from "../../../vendor/pocket-rpgkit/src/engine/motion-clock.ts";
import type { Dir4 } from "../../../vendor/pocket-rpgkit/src/engine/passability.ts";
import { regionOf } from "../../wander/world.ts";
import { planRegion, type RegionPlan } from "../../wander/region.ts";
import { purePlacedLandmark, townErrand, type Errand } from "../../wander/towns.ts";
import type { Landmark } from "../../wander/landmarks.ts";
import {
  emptyJourney,
  isCooperativeErrand,
  journeyAccept,
  journeyComplete,
  journeyTalk,
  JOURNEY_EVENT,
  PLAZA_RADIUS,
  resolveErrand,
  VISIT_ARRIVE,
  type JourneyEvent,
  type JourneyEventKind,
  type JourneyPair,
  type PlayerJourney,
} from "../net/journey.ts";
import { frontTile, plaqueOf, residentDistance, ticksSinceDiscovery, townResidentsAt } from "../net/npc.ts";
import { BTN, COMMAND, PLAYER_PROGRESS_MAX, type CommandMessage, type PlayerJourneyMessage, type PlayerProgressMessage } from "../net/protocol.ts";
import {
  MultiFocusWorld,
  realmStart,
  startRealmState,
  stepRealmMovement,
  type RealmFocus,
  type RealmState,
} from "../net/realm-world.ts";
import { EMOTE_MIN_INTERVAL_MS, isEmoteId } from "../net/emote.ts";
import { farRowsFor, type FarRow } from "../net/far.ts";
import { pickSpawn, spawnHash, type SpawnPick } from "../net/spawn.ts";
import {
  REALM_DISCOVERY_HALF_H,
  REALM_DISCOVERY_HALF_W,
  REALM_LANDMARK_HALF_H,
  REALM_LANDMARK_HALF_W,
  type RealmRegionSnapshot,
  type RealmRegionState,
} from "../net/realm-state.ts";
import { INPUT_QUEUE_CAP, type QueuedInput } from "./area.ts";

/** Six milliseconds of calibrated generator work per 20 Hz host frame. */
export const REALM_FRAME_BUDGET = 6_000;
/** One third of a 20 Hz frame: every 60 Hz reference tick gets the same
 * generation allowance regardless of the host's presentation rate. */
export const REALM_REF_TICK_BUDGET = REALM_FRAME_BUDGET / 3;
/** A 32-player realm keeps the worst-case 3x3 focus union below both the
 * chunk and region-plan residency caps. Admission must stop here instead of
 * letting MultiFocusWorld.setFocuses fail after the player was inserted. */
export const REALM_PLAYER_CAP = 32;
/** A cooperative delivery needs two different account identities. */
export const COOP_REQUIRED_PLAYERS = 2 as const;
/** A readiness claim is intentionally short-lived: enough for a second
 *  courier to press ready, but not a durable claim on a plaza. */
export const COOP_READY_TTL_MS = 30_000;
/** Spelling retained for storage/host code that calls it readiness. */
export const COOP_READINESS_TTL_MS = COOP_READY_TTL_MS;
export const COOP_IDENTITY_MAX = 128;

/** Persisted server-private readiness. Coordinates describe this player's
 *  own active offer and target; they are never included in public status. */
export interface CoopReady {
  offerRx: number;
  offerRy: number;
  targetRx: number;
  targetRy: number;
  readyAtMs: number;
  expiresAtMs: number;
}

export type CoopStatusKind = "inactive" | "traveling" | "waiting" | "cancelled" | "expired";
export type CoopReadyCount = 0 | 1 | typeof COOP_REQUIRED_PLAYERS;

/** JSON-safe recipient-only status. It exposes neither account identities
 *  nor another player's coordinates. `ready` additionally requires current
 *  authoritative presence; `savedReady` may survive a disconnect/move. */
export interface CoopStatus {
  status: CoopStatusKind;
  cooperative: boolean;
  ready: boolean;
  savedReady: boolean;
  presentReady: CoopReadyCount;
  required: typeof COOP_REQUIRED_PLAYERS;
  expiresAt: number | null;
  revision: number;
}

export interface PendingCoopStatus {
  /** Ephemeral arena id used only to route this private status. */
  playerId: number;
  status: CoopStatus;
}

export interface RealmPlayer {
  id: number;
  name: string;
  color: number;
  look: number;
  state: RealmState;
  buttons: number;
  lastSeq: number;
  queue: QueuedInput[];
  dropped: number;
  /** Authoritative fast mode: the fast bit of the last applied input. */
  fast: boolean;
  /** Private errand journey; every mutation happens here, never on a client. */
  journey: PlayerJourney;
  /** Bumped on every journey change. Hosts with storage overwrite it with
   *  the persisted per-account revision before sending. */
  journeyRevision: number;
  /** The journey changed since the host last persisted/sent it. */
  journeyDirty: boolean;
  /** Opaque account/session owner used only for distinct-player matching. */
  coopIdentity: string;
  /** Persistable readiness for the active cooperative delivery. */
  coopReady: CoopReady | null;
  /** The recipient-only cooperative JSON status needs sending. */
  coopDirty: boolean;
  /** One-shot reason for a READY claim ending while the errand stays active. */
  coopTransition: "cancelled" | "expired" | null;
  /** Monotonic recipient-only cooperative status revision. */
  coopRevision: number;
  /** Latest confirmed journey event (seq 0 = none yet). */
  event: JourneyEvent;
  /** Private landmark sightings, oldest first, exact, at most PLAYER_PROGRESS_MAX. */
  landmarks: JourneyPair[];
  progressRevision: number;
  progressDirty: boolean;
  /** Tile of the last landmark scan; the scan only reruns on a tile change. */
  scanX: number | null;
  scanY: number | null;
  /** Arena clock of the last accepted emote (rate limit floor). */
  lastEmoteAt: number;
  /** Where admission put the player relative to its anchor (diagnostics). */
  spawn: SpawnPick;
}

/** A pending emote the host broadcasts to the sender's AOI. */
export interface PendingEmote {
  from: RealmPlayer;
  emote: number;
}

/** Private state a host restores from storage when a player is admitted. */
export interface RealmPlayerRestore {
  journey?: PlayerJourney;
  journeyRevision?: number;
  landmarks?: readonly JourneyPair[];
  progressRevision?: number;
  coopIdentity?: string;
  coopReady?: CoopReady | null;
}

/** An authoritative gameplay fact before a storage-backed host attaches its
 * realm and captured UTC day. Keeping wall-clock attribution in the host
 * makes a contribution at midnight belong to exactly one atomic store call. */
export type RealmDailyContribution =
  | {
    /** Stable across replay of the same accepted journey fact. */
    sourceId: string;
    kind: "delivery";
    offerRx: number;
    offerRy: number;
    targetRx: number;
    targetRy: number;
  }
  | {
    /** Realm-global identity of the elected landmark-first fact. */
    sourceId: string;
    kind: "landmark";
    landmarkRx: number;
    landmarkRy: number;
  };

/** Storage-backed hosts intercept the shared facts a journey can create and
 *  the private cooperative readiness it can change. Region hooks return the
 *  authoritative row after compare-and-set (or null to refuse); readiness
 *  is a synchronous write-through. */
export interface RealmArenaHooks {
  improveRegion?(rx: number, ry: number, level: number, nowMs: number, player: RealmPlayer): RealmRegionState | null;
  landmarkFirst?(rx: number, ry: number, player: RealmPlayer, nowMs: number): RealmRegionState | null;
  /** Synchronous write-through for every readiness write or clear. */
  persistCoopReady?(player: RealmPlayer, ready: CoopReady | null): void;
  /** A fact already accepted by the authoritative reducer. Hosts may use it
   *  to advance a realm-owned aggregate; clients never submit goal credit. */
  contributeDaily?(contribution: RealmDailyContribution, nowMs: number, player: RealmPlayer): void;
}

export interface RealmArenaConfig {
  seed: number;
  hz: number;
  realmId?: string;
  epoch?: number;
  /** Tests and local deployments may lower, but never raise, the safe cap. */
  maxPlayers?: number;
  /** Wall clock injection for deterministic growth tests. */
  now?: () => number;
  hooks?: RealmArenaHooks;
}

/** Bounded cache of pure town plans the journey rules read (hub, residents,
 *  notice board). Independent of the streamed world cache, whose plans are
 *  mutated in place by shared improvements. */
const TOWN_PLAN_CAP = 64;

/** Chebyshev tolerance when the server validates a talk command: the client
 *  judged adjacency at its estimated clock, so the resident may have taken
 *  one more step by the time the command arrives. */
export const TALK_TOLERANCE = 2;

function coopInt32(value: number, label: string): number {
  if (!Number.isInteger(value) || value < -0x8000_0000 || value > 0x7fff_ffff) {
    throw new RangeError(`${label} must be an int32`);
  }
  return value;
}

function coopTime(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${label} must be a non-negative safe integer`);
  return value;
}

function checkedCoopReady(value: CoopReady): CoopReady {
  const readyAtMs = coopTime(value.readyAtMs, "coop readyAtMs");
  const expiresAtMs = coopTime(value.expiresAtMs, "coop expiresAtMs");
  const lifetime = expiresAtMs - readyAtMs;
  if (lifetime <= 0 || lifetime > COOP_READY_TTL_MS) throw new RangeError("coop readiness exceeds the fixed TTL");
  return {
    offerRx: coopInt32(value.offerRx, "coop offer rx"),
    offerRy: coopInt32(value.offerRy, "coop offer ry"),
    targetRx: coopInt32(value.targetRx, "coop target rx"),
    targetRy: coopInt32(value.targetRy, "coop target ry"),
    readyAtMs,
    expiresAtMs,
  };
}

function checkedCoopIdentity(value: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > COOP_IDENTITY_MAX) {
    throw new RangeError(`coop identity must contain 1..${COOP_IDENTITY_MAX} code units`);
  }
  return value;
}

function deliveryDailySourceId(player: RealmPlayer, journeyRevision: number, errand: Errand): string {
  if (errand.kind !== "deliver") throw new TypeError("daily delivery source requires a delivery errand");
  return `delivery:${player.coopIdentity}:${journeyRevision >>> 0}:${errand.orx}:${errand.ory}:${errand.trx}:${errand.try}`;
}

function heading(p: RealmPlayer): Pick<RealmFocus, "hx" | "hy"> {
  const dir = p.state.move.moving ? p.state.move.stepDir : p.state.move.facing;
  return {
    hx: dir === 1 ? -1 : dir === 3 ? 1 : 0,
    hy: dir === 2 ? -1 : dir === 0 ? 1 : 0,
  };
}

export class RealmArena {
  readonly seed: number;
  readonly hz: number;
  readonly realmId: string;
  readonly epoch: number;
  readonly maxPlayers: number;
  readonly ticksPerFrame: number;
  readonly world: MultiFocusWorld;
  readonly players = new Map<number, RealmPlayer>();
  refTicks = 0;
  frame = 0;
  realmRevision = 0;
  private nextId = 1;
  private readonly cells = new Map<number, Map<number, RealmPlayer[]>>();
  private readonly now: () => number;
  private readonly hooks: RealmArenaHooks;
  private readonly townPlans = new Map<string, RegionPlan>();
  /** Shared rows a journey changed since the host last drained them. */
  private changedRows: RealmRegionState[] = [];
  /** Accepted emotes since the host last drained them. */
  private pendingEmotes: PendingEmote[] = [];

  constructor(cfg: RealmArenaConfig) {
    this.seed = cfg.seed >>> 0;
    this.hz = cfg.hz;
    this.realmId = cfg.realmId ?? "realm-1";
    this.epoch = cfg.epoch ?? 1;
    const maxPlayers = cfg.maxPlayers ?? REALM_PLAYER_CAP;
    if (!Number.isInteger(maxPlayers) || maxPlayers < 1 || maxPlayers > REALM_PLAYER_CAP) {
      throw new RangeError(`realm maxPlayers must be an integer in 1..${REALM_PLAYER_CAP}`);
    }
    this.maxPlayers = maxPlayers;
    this.ticksPerFrame = motionTicksPerFrame(this.hz);
    this.world = new MultiFocusWorld(this.seed);
    this.now = cfg.now ?? Date.now;
    this.hooks = cfg.hooks ?? {};
  }

  /** Shared rows changed by journeys (improvements, landmark firsts) since
   *  the last drain, for the host to broadcast. */
  drainChangedRows(): RealmRegionState[] {
    const rows = this.changedRows;
    this.changedRows = [];
    return rows;
  }

  /** A town plan by region, cached and never mutated. */
  townPlan(rx: number, ry: number): RegionPlan {
    const key = `${rx},${ry}`;
    const cached = this.townPlans.get(key);
    if (cached) return cached;
    const plan = planRegion(this.seed, rx, ry);
    if (this.townPlans.size >= TOWN_PLAN_CAP) this.townPlans.delete(this.townPlans.keys().next().value!);
    this.townPlans.set(key, plan);
    return plan;
  }

  private focuses(): RealmFocus[] {
    return [...this.players.values()].map((p) => ({
      x: p.state.move.tx,
      y: p.state.move.ty,
      ...heading(p),
    }));
  }

  private nearbyCoords(player: RealmPlayer): { rx: number; ry: number }[] {
    const { tx, ty } = player.state.move;
    const rx0 = regionOf(tx - REALM_DISCOVERY_HALF_W), rx1 = regionOf(tx + REALM_DISCOVERY_HALF_W);
    const ry0 = regionOf(ty - REALM_DISCOVERY_HALF_H), ry1 = regionOf(ty + REALM_DISCOVERY_HALF_H);
    const out: { rx: number; ry: number }[] = [];
    for (let ry = ry0; ry <= ry1; ry++) for (let rx = rx0; rx <= rx1; rx++) out.push({ rx, ry });
    return out;
  }

  private discoverRegions(nowMs: number): void {
    const rows: RealmRegionState[] = [];
    for (const player of this.players.values()) {
      for (const { rx, ry } of this.nearbyCoords(player)) {
        if (this.world.regionState(rx, ry)) continue;
        const revision = ++this.realmRevision;
        rows.push({ rx, ry, discoveredAtMs: nowMs, improvementLevel: 0, revision, landmarkFirstName: "" });
      }
    }
    this.world.applyRegionState({ flags: 0, realmRevision: this.realmRevision, serverTimeMs: nowMs, rows });
  }

  /** Complete nearby snapshot sent on admission and periodically by the local
   * server. The hosted server supplies the same shape from SQLite. */
  regionSnapshotFor(player: RealmPlayer, flags: number): RealmRegionSnapshot {
    const rows: RealmRegionState[] = [];
    for (const { rx, ry } of this.nearbyCoords(player)) {
      const row = this.world.regionState(rx, ry);
      if (row) rows.push(row);
    }
    return { flags, realmRevision: this.realmRevision, serverTimeMs: this.now(), rows };
  }

  /** A tile no admitted player stands on. Mid-step movers count as being on
   *  their origin tile, like the AOI index. */
  private occupied(tx: number, ty: number, except?: RealmPlayer): boolean {
    for (const p of this.players.values()) {
      if (p === except) continue;
      if (p.state.move.tx === tx && p.state.move.ty === ty) return true;
    }
    return false;
  }

  /** The first free tile of the ring walk around `anchor` (net/spawn.ts):
   *  streamed collision at the current growth phase plus player occupancy.
   *  The anchor's chunk neighbourhood must already be primed. */
  private safeSlot(anchor: { tx: number; ty: number }, hash: number, except?: RealmPlayer): SpawnPick | null {
    return pickSpawn(anchor, hash, (tx, ty) => {
      const collision = this.world.collisionAt(tx, ty);
      return collision.ready && !collision.blocked && !this.occupied(tx, ty, except);
    });
  }

  /** Refuse before allocating an id, inserting a player or changing focus.
   *  `at` is the anchor (a stored checkpoint); without it the starter town
   *  hub is. The player lands on the first safe tile of the ring walk around
   *  the anchor, started at `spawnKey`'s stable hash (the account id on the
   *  hosted server); a checkpoint whose surroundings are all blocked falls
   *  back to the starter town. */
  tryAdd(
    name: string,
    color: number,
    look = 0,
    at?: { tx: number; ty: number; facing?: number },
    restore?: RealmPlayerRestore,
    spawnKey = name,
  ): RealmPlayer | null {
    if (this.players.size >= this.maxPlayers) return null;
    if (at?.facing !== undefined && (!Number.isInteger(at.facing) || at.facing < 0 || at.facing > 3)) {
      throw new RangeError("realm spawn facing must be an integer in 0..3");
    }
    const id = this.nextId++;
    const anchor = at ?? realmStart(this.seed);
    // Collision at the anchor needs its chunks and the growth phase of its
    // regions; the admission clock is advanced before either is read.
    const nowMs = this.now();
    this.expireCoopReadiness(nowMs);
    const coopBefore = this.captureCoopStatus(nowMs);
    this.world.setWorldTime(nowMs);
    this.world.prime([...this.focuses(), { x: anchor.tx, y: anchor.ty }], this.refTicks);
    const hash = spawnHash(spawnKey);
    let slot = this.safeSlot(anchor, hash);
    if (!slot && at) {
      const start = realmStart(this.seed);
      this.world.prime([...this.focuses(), { x: start.tx, y: start.ty }], this.refTicks);
      slot = this.safeSlot(start, hash);
    }
    // Every ring tile blocked and occupied: stand on the anchor rather than
    // refuse (a full 13x13 box of solid or occupied tiles is not a realm
    // this generator produces; the fallback only keeps admission total).
    const spawn: SpawnPick = slot ?? { tx: anchor.tx, ty: anchor.ty, ring: -1 };
    let state = startRealmState(this.seed);
    state = {
      ...state,
      move: {
        ...state.move,
        tx: spawn.tx,
        ty: spawn.ty,
        px: spawn.tx * 16,
        py: spawn.ty * 16,
        facing: at?.facing === undefined ? state.move.facing : at.facing as Dir4,
        phase: 0,
        moving: false,
        walking: false,
      },
    };
    const coopIdentity = restore?.coopIdentity !== undefined
      ? checkedCoopIdentity(restore.coopIdentity)
      : spawnKey.length >= 1 && spawnKey.length <= COOP_IDENTITY_MAX ? spawnKey : `player:${id}`;
    // READY belongs to the authenticated identity rather than a socket. A
    // storage-backed admission normally restores it from the same row; the
    // sibling fallback also keeps the in-memory loopback model truthful.
    const siblingCoopReady = restore?.coopIdentity !== undefined
      ? [...this.players.values()]
        .find((other) => other.coopIdentity === coopIdentity && other.coopReady)?.coopReady ?? null
      : null;
    const restoredCoopReady = restore?.coopReady
      ? checkedCoopReady(restore.coopReady)
      : siblingCoopReady ? checkedCoopReady(siblingCoopReady) : null;
    const player: RealmPlayer = {
      id,
      name,
      color: color & 0x0f,
      look: look & 0x3f,
      state,
      buttons: 0,
      lastSeq: 0,
      queue: [],
      dropped: 0,
      fast: false,
      journey: restore?.journey ?? emptyJourney(),
      journeyRevision: restore?.journeyRevision ?? 0,
      journeyDirty: false,
      coopIdentity,
      coopReady: restoredCoopReady,
      coopDirty: false,
      coopTransition: null,
      coopRevision: 0,
      event: { seq: 0, kind: JOURNEY_EVENT.none, rx: 0, ry: 0 },
      landmarks: [...(restore?.landmarks ?? [])],
      progressRevision: restore?.progressRevision ?? 0,
      progressDirty: false,
      scanX: null,
      scanY: null,
      lastEmoteAt: -Infinity,
      spawn,
    };
    this.players.set(id, player);
    if (player.coopReady && (player.coopReady.readyAtMs > nowMs || player.coopReady.expiresAtMs <= nowMs || !this.coopReadyMatchesJourney(player, player.coopReady))) {
      this.writeCoopReady(player, null);
    } else if (player.coopReady) {
      this.settleCoopIfReady(player, nowMs);
    }
    this.finishCoopStatusChange(coopBefore, nowMs);
    this.discoverRegions(nowMs);
    // Admission is rare and must leave the spawn's full authoritative ring
    // ready before WELCOME; steady movement stays on the per-frame budget.
    this.world.prime(this.focuses(), this.refTicks);
    this.scanLandmarks(player, nowMs);
    return player;
  }

  add(name: string, color: number, look = 0, at?: { tx: number; ty: number; facing?: number }, restore?: RealmPlayerRestore, spawnKey = name): RealmPlayer {
    const player = this.tryAdd(name, color, look, at, restore, spawnKey);
    if (!player) throw new RangeError(`realm is full (${this.maxPlayers} players)`);
    return player;
  }

  remove(id: number): void {
    const nowMs = this.now();
    this.expireCoopReadiness(nowMs);
    const coopBefore = this.captureCoopStatus(nowMs);
    this.players.delete(id);
    this.finishCoopStatusChange(coopBefore, nowMs);
    this.world.setFocuses(this.focuses(), this.refTicks);
    if (this.players.size === 0) this.world.clearCache();
  }

  pushInput(player: RealmPlayer, seq: number, buttons: number): void {
    if (seq <= player.lastSeq) return;
    const last = player.queue[player.queue.length - 1];
    if (last && seq <= last.seq) return;
    if (player.queue.length >= INPUT_QUEUE_CAP) {
      player.dropped++;
      return;
    }
    player.queue.push({ seq, buttons });
  }

  private refreshWorld(): void {
    this.world.setFocuses(this.focuses(), this.refTicks);
    this.world.runBudget(REALM_REF_TICK_BUDGET, this.refTicks);
  }

  stepRefTick(): void {
    const nowMs = this.now();
    this.expireCoopReadiness(nowMs);
    const trackCoopPresence = [...this.players.values()].some((p) => p.coopReady !== null);
    const coopBefore = trackCoopPresence ? this.captureCoopStatus(nowMs) : null;
    this.discoverRegions(nowMs);
    this.world.setWorldTime(nowMs);
    this.refreshWorld();
    for (const p of this.players.values()) {
      const input = p.queue.shift();
      if (input) {
        p.buttons = input.buttons;
        p.lastSeq = input.seq;
      }
      p.fast = (p.buttons & BTN.fast) !== 0;
      p.state = { ...p.state, move: stepRealmMovement(this.world, p.state.move, p.buttons) };
      this.scanLandmarks(p, nowMs);
      this.checkVisit(p, nowMs);
    }
    // A restored/temporarily absent readiness becomes countable again only
    // after its owner is authoritatively back on the target plaza.
    if (coopBefore) {
      for (const p of [...this.players.values()].sort((a, b) => a.id - b.id)) this.settleCoopIfReady(p, nowMs);
      this.finishCoopStatusChange(coopBefore, nowMs);
    }
    this.refTicks++;
  }

  // -- journeys ------------------------------------------------------------------

  private playerRegion(p: RealmPlayer): { rx: number; ry: number } {
    return { rx: regionOf(p.state.move.tx), ry: regionOf(p.state.move.ty) };
  }

  private onPlaza(p: RealmPlayer, plan: RegionPlan): boolean {
    if (plan.empty || !plan.hub.town) return false;
    const { tx, ty } = p.state.move;
    return Math.abs(tx - plan.hub.x) + Math.abs(ty - plan.hub.y) <= PLAZA_RADIUS;
  }

  private confirm(p: RealmPlayer, kind: JourneyEventKind, rx: number, ry: number): JourneyEventKind {
    p.event = { seq: (p.event.seq + 1) >>> 0, kind, rx, ry };
    p.journeyDirty = true;
    return kind;
  }

  private setJourney(p: RealmPlayer, journey: PlayerJourney): void {
    p.journey = journey;
    p.journeyRevision = (p.journeyRevision + 1) >>> 0;
    p.journeyDirty = true;
  }

  /** Resolve a valid active cooperative delivery. Persisted flags are never
   *  trusted without recomputing the deterministic offer. */
  private cooperativeDelivery(p: RealmPlayer): Errand | null {
    if (p.journey.cooperative !== true) return null;
    const errand = resolveErrand(this.seed, p.journey);
    return errand?.kind === "deliver" && isCooperativeErrand(this.seed, errand) ? errand : null;
  }

  private coopReadyMatchesJourney(p: RealmPlayer, ready: CoopReady): boolean {
    const errand = this.cooperativeDelivery(p);
    return !!errand
      && ready.offerRx === errand.orx
      && ready.offerRy === errand.ory
      && ready.targetRx === errand.trx
      && ready.targetRy === errand.try;
  }

  private savedCoopReady(p: RealmPlayer, nowMs: number): CoopReady | null {
    const ready = p.coopReady;
    return ready && ready.expiresAtMs > nowMs && this.coopReadyMatchesJourney(p, ready) ? ready : null;
  }

  /** One incarnation has one durable READY row even when it owns two live
   * sockets. Every sibling therefore observes the same claim and may cancel
   * it without having sent READY itself. */
  private identityCoopReady(p: RealmPlayer, nowMs: number): CoopReady | null {
    const own = this.savedCoopReady(p, nowMs);
    if (own) return own;
    for (const other of this.players.values()) {
      if (other === p || other.coopIdentity !== p.coopIdentity) continue;
      const ready = this.savedCoopReady(other, nowMs);
      if (ready && this.coopReadyMatchesJourney(p, ready)) return ready;
    }
    return null;
  }

  private presentForCoop(p: RealmPlayer, ready: CoopReady, nowMs: number): boolean {
    if (this.players.get(p.id) !== p || !this.savedCoopReady(p, nowMs)) return false;
    const here = this.playerRegion(p);
    if (here.rx !== ready.targetRx || here.ry !== ready.targetRy) return false;
    return this.onPlaza(p, this.townPlan(ready.targetRx, ready.targetRy));
  }

  private writeCoopReady(p: RealmPlayer, ready: CoopReady | null): void {
    p.coopReady = ready ? checkedCoopReady(ready) : null;
    this.hooks.persistCoopReady?.(p, p.coopReady ? { ...p.coopReady } : null);
    for (const other of this.players.values()) {
      if (other === p || other.coopIdentity !== p.coopIdentity) continue;
      other.coopReady = p.coopReady ? { ...p.coopReady } : null;
    }
  }

  private rawCoopStatusFor(p: RealmPlayer, nowMs: number): CoopStatus {
    const errand = this.cooperativeDelivery(p);
    const saved = errand ? this.identityCoopReady(p, nowMs) : null;
    const ready = !!saved && this.presentForCoop(p, saved, nowMs);
    const identities = new Set<string>();
    if (errand) {
      for (const other of this.players.values()) {
        const otherReady = this.savedCoopReady(other, nowMs);
        if (!otherReady
          || otherReady.offerRx !== errand.orx || otherReady.offerRy !== errand.ory
          || otherReady.targetRx !== errand.trx || otherReady.targetRy !== errand.try) continue;
        if (this.presentForCoop(other, otherReady, nowMs)) identities.add(other.coopIdentity);
      }
    }
    const presentReady = Math.min(COOP_REQUIRED_PLAYERS, identities.size) as CoopReadyCount;
    return {
      status: !errand ? "inactive" : p.coopTransition ?? (ready ? "waiting" : "traveling"),
      cooperative: !!errand,
      ready,
      savedReady: !!saved,
      presentReady,
      required: COOP_REQUIRED_PLAYERS,
      expiresAt: saved?.expiresAtMs ?? null,
      revision: p.coopRevision >>> 0,
    };
  }

  private coopStatusKey(p: RealmPlayer, nowMs: number): string {
    const { revision: _revision, ...status } = this.rawCoopStatusFor(p, nowMs);
    return JSON.stringify(status);
  }

  private captureCoopStatus(nowMs: number): Map<number, string> {
    const before = new Map<number, string>();
    for (const p of this.players.values()) before.set(p.id, this.coopStatusKey(p, nowMs));
    return before;
  }

  /** Mark every still-present recipient whose privacy-safe view changed. */
  private finishCoopStatusChange(before: ReadonlyMap<number, string>, nowMs: number): void {
    for (const p of this.players.values()) {
      if (before.get(p.id) === this.coopStatusKey(p, nowMs)) continue;
      p.coopRevision = (p.coopRevision + 1) >>> 0;
      p.coopDirty = true;
    }
  }

  /** Clear expired readiness using the injected arena clock. Every clear is
   *  synchronously written through to persistence. */
  expireCoopReadiness(nowMs = this.now()): number {
    const owners = new Set<number>();
    const offers = new Set<string>();
    let expired = 0;
    for (const p of this.players.values()) {
      if (!p.coopReady || p.coopReady.expiresAtMs > nowMs) continue;
      owners.add(p.id);
      offers.add(`${p.coopReady.offerRx},${p.coopReady.offerRy}:${p.coopReady.targetRx},${p.coopReady.targetRy}`);
      this.writeCoopReady(p, null);
      p.coopTransition = "expired";
      expired++;
    }
    if (expired > 0) {
      for (const p of this.players.values()) {
        const errand = this.cooperativeDelivery(p);
        if (!owners.has(p.id)
          && (!errand || !offers.has(`${errand.orx},${errand.ory}:${errand.trx},${errand.try}`))) continue;
        p.coopRevision = (p.coopRevision + 1) >>> 0;
        p.coopDirty = true;
      }
    }
    return expired;
  }

  /** Recipient-only JSON status. Expiry is processed first so callers can
   *  never publish a stale ready bit. */
  coopStatusFor(p: RealmPlayer, nowMs = this.now()): CoopStatus {
    this.expireCoopReadiness(nowMs);
    return this.rawCoopStatusFor(p, nowMs);
  }

  /** Dirty recipient statuses for a host to JSON-encode and route by arena
   *  id. Draining acknowledges only the status flag, not persistence. */
  drainCoopStatuses(nowMs = this.now()): PendingCoopStatus[] {
    this.expireCoopReadiness(nowMs);
    const out: PendingCoopStatus[] = [];
    for (const p of this.players.values()) {
      if (!p.coopDirty) continue;
      out.push({ playerId: p.id, status: this.rawCoopStatusFor(p, nowMs) });
      p.coopDirty = false;
      p.coopTransition = null;
    }
    return out;
  }

  /** Public notice-board aggregate for one complete deterministic offer.
   * Distinct identities are counted only while physically READY; no identity
   * or target position leaves the arena. */
  coopWaitingCountForOffer(offerRx: number, offerRy: number, nowMs = this.now()): CoopReadyCount {
    this.expireCoopReadiness(nowMs);
    const identities = new Set<string>();
    for (const player of this.players.values()) {
      const ready = this.savedCoopReady(player, nowMs);
      if (!ready || ready.offerRx !== offerRx || ready.offerRy !== offerRy) continue;
      if (this.presentForCoop(player, ready, nowMs)) identities.add(player.coopIdentity);
    }
    return Math.min(COOP_REQUIRED_PLAYERS, identities.size) as CoopReadyCount;
  }

  /** Anonymous count for the deterministic cooperative offer on the board
   * directly in front of `player`. This proximity gate prevents a client
   * from probing sparse activity across arbitrary realm coordinates. */
  coopBoardWaitingFor(player: RealmPlayer, offerRx: number, offerRy: number, nowMs = this.now()): CoopReadyCount | null {
    if (this.players.get(player.id) !== player) return null;
    const here = this.playerRegion(player);
    if (here.rx !== offerRx || here.ry !== offerRy) return null;
    const plan = this.townPlan(offerRx, offerRy);
    const board = plaqueOf(plan);
    const front = frontTile(player.state.move);
    if (!board || board.x !== front.x || board.y !== front.y) return null;
    const offer = townErrand(this.seed, offerRx, offerRy);
    if (!offer || !isCooperativeErrand(this.seed, offer)) return null;
    return this.coopWaitingCountForOffer(offerRx, offerRy, nowMs);
  }

  /** Settle one deterministic pair containing `player`, if two distinct
   *  identities are valid and physically present now. */
  private settleCoopIfReady(player: RealmPlayer, nowMs: number): boolean {
    const mine = this.savedCoopReady(player, nowMs);
    if (!mine || !this.presentForCoop(player, mine, nowMs)) return false;
    const candidates = [...this.players.values()]
      .filter((other) => {
        if (other === player || other.coopIdentity === player.coopIdentity) return false;
        const ready = this.savedCoopReady(other, nowMs);
        return !!ready
          && ready.offerRx === mine.offerRx
          && ready.offerRy === mine.offerRy
          && ready.targetRx === mine.targetRx
          && ready.targetRy === mine.targetRy
          && this.presentForCoop(other, ready, nowMs);
      })
      .sort((a, b) => {
        const at = a.coopReady!.readyAtMs - b.coopReady!.readyAtMs;
        return at || a.id - b.id;
      });
    const partner = candidates[0];
    if (!partner) return false;
    const mineErrand = this.cooperativeDelivery(player);
    const partnerErrand = this.cooperativeDelivery(partner);
    if (!mineErrand || !partnerErrand) return false;
    // The pre-completion journey revision is durable and stable if a host
    // crashes before checkpointing this settlement. Combined with the exact
    // incarnation and errand coordinates it identifies this accepted fact,
    // while a later accepted errand receives another revision.
    const sourceRevisions = new Map<RealmPlayer, number>([
      [partner, partner.journeyRevision],
      [player, player.journeyRevision],
    ]);

    // Clear both durable claims before changing either journey. A replay can
    // then observe neither an active cooperative errand nor a ready pair.
    this.writeCoopReady(partner, null);
    this.writeCoopReady(player, null);
    const partnerDone = journeyComplete(this.seed, partner.journey, partnerErrand);
    const mineDone = journeyComplete(this.seed, player.journey, mineErrand);
    this.setJourney(partner, partnerDone.journey);
    this.setJourney(player, mineDone.journey);
    this.confirm(partner, JOURNEY_EVENT.coopDelivered, mine.targetRx, mine.targetRy);
    this.confirm(player, JOURNEY_EVENT.coopDelivered, mine.targetRx, mine.targetRy);
    // A storage-backed host first guarantees that this physically occupied
    // target has a region row, so its compare-and-set cannot silently vanish.
    this.improve(mine.targetRx, mine.targetRy, 1, nowMs, player);
    for (const [courier, errand] of [[partner, partnerErrand], [player, mineErrand]] as const) {
      this.hooks.contributeDaily?.({
        sourceId: deliveryDailySourceId(courier, sourceRevisions.get(courier)!, errand),
        kind: "delivery",
        offerRx: errand.orx,
        offerRy: errand.ory,
        targetRx: errand.trx,
        targetRy: errand.try,
      }, nowMs, courier);
    }
    return true;
  }

  /** Validate and apply a client command against the authoritative mover
   *  and clock. Returns the confirmed event kind, or null when refused. An
   *  accepted emote is not a journey event: it is queued for the host
   *  (drainEmotes) and the call returns null like a refusal. */
  applyCommand(p: RealmPlayer, cmd: CommandMessage, nowMs = this.now()): JourneyEventKind | null {
    this.expireCoopReadiness(nowMs);
    const here = this.playerRegion(p);
    if (cmd.rx !== here.rx || cmd.ry !== here.ry) return null;
    if (cmd.kind === COMMAND.emote) {
      this.applyEmote(p, cmd.extra, nowMs);
      return null;
    }
    const plan = this.townPlan(here.rx, here.ry);
    if (cmd.kind === COMMAND.acceptErrand) {
      if (!this.onPlaza(p, plan)) return null;
      const accepted = journeyAccept(this.seed, p.journey, here.rx, here.ry);
      if (!accepted) return null;
      this.setJourney(p, accepted.journey);
      return this.confirm(p, JOURNEY_EVENT.accepted, here.rx, here.ry);
    }
    if (cmd.kind === COMMAND.acceptCoopErrand) {
      if (!this.onPlaza(p, plan)) return null;
      const before = this.captureCoopStatus(nowMs);
      const accepted = journeyAccept(this.seed, p.journey, here.rx, here.ry, true);
      if (!accepted) return null;
      if (p.coopReady) this.writeCoopReady(p, null);
      this.setJourney(p, accepted.journey);
      const event = this.confirm(p, JOURNEY_EVENT.accepted, here.rx, here.ry);
      this.finishCoopStatusChange(before, nowMs);
      return event;
    }
    if (cmd.kind === COMMAND.deliverErrand) {
      if (!this.onPlaza(p, plan)) return null;
      const errand = resolveErrand(this.seed, p.journey);
      if (p.journey.cooperative === true || !errand || errand.kind !== "deliver" || errand.trx !== here.rx || errand.try !== here.ry) return null;
      return this.complete(p, errand, JOURNEY_EVENT.delivered, nowMs);
    }
    if (cmd.kind === COMMAND.readyCoopErrand) {
      if (this.players.get(p.id) !== p) return null;
      const errand = this.cooperativeDelivery(p);
      if (!errand || errand.trx !== here.rx || errand.try !== here.ry || !this.onPlaza(p, plan)) return null;
      const existing = this.identityCoopReady(p, nowMs);
      // Replaying from any tab cannot replace the incarnation's fixed
      // deadline or emit a second friend notification.
      if (existing) return null;
      const before = this.captureCoopStatus(nowMs);
      p.coopTransition = null;
      const expiresAtMs = Math.min(Number.MAX_SAFE_INTEGER, nowMs + COOP_READY_TTL_MS);
      this.writeCoopReady(p, {
        offerRx: errand.orx,
        offerRy: errand.ory,
        targetRx: errand.trx,
        targetRy: errand.try,
        readyAtMs: expiresAtMs - COOP_READY_TTL_MS,
        expiresAtMs,
      });
      const settled = this.settleCoopIfReady(p, nowMs);
      const event = settled
        ? JOURNEY_EVENT.coopDelivered
        : this.confirm(p, JOURNEY_EVENT.coopWaiting, here.rx, here.ry);
      this.finishCoopStatusChange(before, nowMs);
      return event;
    }
    if (cmd.kind === COMMAND.cancelCoopErrand) {
      const ready = this.identityCoopReady(p, nowMs);
      if (!ready) return null;
      const before = this.captureCoopStatus(nowMs);
      // Readiness is persisted per account incarnation, not per socket. One
      // device cancelling therefore clears every live session of that same
      // identity; otherwise a second tab could resurrect the deleted claim.
      this.writeCoopReady(p, null);
      for (const other of this.players.values()) {
        if (other.coopIdentity !== p.coopIdentity) continue;
        other.coopTransition = "cancelled";
      }
      p.coopTransition = "cancelled";
      this.finishCoopStatusChange(before, nowMs);
      return null;
    }
    if (cmd.kind === COMMAND.talk) {
      if (plan.empty || !plan.hub.town) return null;
      const row = this.world.regionState(here.rx, here.ry);
      if (!row) return null;
      const residents = townResidentsAt(plan, ticksSinceDiscovery(row.discoveredAtMs, nowMs));
      const resident = residents.find((r) => r.n === cmd.extra);
      if (!resident || residentDistance(p.state.move, resident) > TALK_TOLERANCE) return null;
      const talked = journeyTalk(p.journey, here.rx, here.ry);
      if (talked.changed) this.setJourney(p, talked.journey);
      return this.confirm(p, JOURNEY_EVENT.talked, here.rx, here.ry);
    }
    return null;
  }

  // -- emotes and far players ---------------------------------------------------------

  /** Accept one preset emote: a known id and at least EMOTE_MIN_INTERVAL_MS
   *  since the player's last accepted one. Anything else is dropped. */
  applyEmote(p: RealmPlayer, emote: number, nowMs = this.now()): boolean {
    if (!isEmoteId(emote)) return false;
    if (nowMs - p.lastEmoteAt < EMOTE_MIN_INTERVAL_MS) return false;
    p.lastEmoteAt = nowMs;
    this.pendingEmotes.push({ from: p, emote });
    return true;
  }

  /** Emotes accepted since the last drain, for the host to broadcast. */
  drainEmotes(): PendingEmote[] {
    const out = this.pendingEmotes;
    this.pendingEmotes = [];
    return out;
  }

  /** Who sees an emote: every player whose Chebyshev AOI holds the sender,
   *  the sender included (it sees its own bubble only once confirmed). */
  emoteRecipients(from: RealmPlayer, aoi: number): RealmPlayer[] {
    const { tx, ty } = from.state.move;
    const out: RealmPlayer[] = [];
    for (const p of this.players.values()) {
      const m = p.state.move;
      if (Math.max(Math.abs(m.tx - tx), Math.abs(m.ty - ty)) <= aoi) out.push(p);
    }
    return out;
  }

  /** Coarse rows for a recipient: players strictly outside its AOI. */
  farRowsFor(recipient: RealmPlayer, aoi: number): FarRow[] {
    const { tx, ty } = recipient.state.move;
    return farRowsFor(tx, ty, recipient.id, this.farCandidates(), aoi);
  }

  private *farCandidates(): Iterable<{ id: number; tx: number; ty: number }> {
    for (const p of this.players.values()) yield { id: p.id, tx: p.state.move.tx, ty: p.state.move.ty };
  }

  private complete(p: RealmPlayer, errand: Errand, kind: JourneyEventKind, nowMs: number): JourneyEventKind {
    const done = journeyComplete(this.seed, p.journey, errand);
    if (errand.kind === "deliver") {
      this.hooks.contributeDaily?.({
        sourceId: deliveryDailySourceId(p, p.journeyRevision, errand),
        kind: "delivery",
        offerRx: errand.orx,
        offerRy: errand.ory,
        targetRx: errand.trx,
        targetRy: errand.try,
      }, nowMs, p);
    }
    this.setJourney(p, done.journey);
    if (done.newlyHelped) this.improve(done.hrx, done.hry, 1, nowMs, p);
    return this.confirm(p, kind, done.hrx, done.hry);
  }

  /** A visit errand completes on arrival, checked every reference tick. */
  private checkVisit(p: RealmPlayer, nowMs: number): void {
    if (!p.journey.errand) return;
    const errand = resolveErrand(this.seed, p.journey);
    if (!errand || errand.kind !== "visit") return;
    const { tx, ty } = p.state.move;
    if (Math.abs(tx - errand.ax) + Math.abs(ty - errand.ay) > VISIT_ARRIVE) return;
    this.complete(p, errand, JOURNEY_EVENT.visited, nowMs);
  }

  /** Raise a town's shared improvement once: the storage hook decides with
   *  a compare-and-set; in memory the level is simply monotonic. */
  private improve(rx: number, ry: number, level: number, nowMs: number, player: RealmPlayer): void {
    const current = this.world.regionState(rx, ry);
    let row: RealmRegionState | null;
    if (this.hooks.improveRegion) {
      row = this.hooks.improveRegion(rx, ry, level, nowMs, player);
    } else if (!current) {
      return;
    } else if (current.improvementLevel >= level) {
      return;
    } else {
      row = { ...current, improvementLevel: level, revision: ++this.realmRevision };
    }
    if (!row) return;
    if (!current || row.revision > current.revision) {
      this.world.applyRegionState({ flags: 0, realmRevision: this.realmRevision, serverTimeMs: nowMs, rows: [row] });
      this.changedRows.push(row);
    }
  }

  /** Host-owned shared appearance transition. Daily-goal settlement uses the
   * same compare-and-set/repaint path as ordinary journey flowers; it is not
   * exposed as a client command. */
  raiseSharedImprovement(player: RealmPlayer, rx: number, ry: number, level: number, nowMs = this.now()): void {
    if (this.players.get(player.id) !== player) throw new RangeError("shared improvement player is not admitted");
    if (!Number.isInteger(level) || level < 1 || level > 0xff) throw new RangeError("shared improvement level must be 1..255");
    this.improve(rx, ry, level, nowMs, player);
  }

  // -- landmarks --------------------------------------------------------------------

  private hasLandmark(p: RealmPlayer, rx: number, ry: number): boolean {
    return p.landmarks.some((l) => l.rx === rx && l.ry === ry);
  }

  /** Log every born landmark whose centre lies inside the fixed sighting
   *  box around the player; the first player to see one names it for the
   *  whole realm. Pure placement, no viewport, no client input. */
  private scanLandmarks(p: RealmPlayer, nowMs: number): void {
    const { tx, ty } = p.state.move;
    if (p.scanX === tx && p.scanY === ty) return;
    p.scanX = tx;
    p.scanY = ty;
    const prx = regionOf(tx), pry = regionOf(ty);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const lm = purePlacedLandmark(this.seed, prx + dx, pry + dy);
      if (!lm || this.hasLandmark(p, lm.rx, lm.ry)) continue;
      if (!this.landmarkVisible(lm, tx, ty, nowMs)) continue;
      if (p.landmarks.length >= PLAYER_PROGRESS_MAX) p.landmarks.shift();
      p.landmarks.push({ rx: lm.rx, ry: lm.ry });
      p.progressRevision = (p.progressRevision + 1) >>> 0;
      p.progressDirty = true;
      this.electFirst(lm.rx, lm.ry, p, nowMs);
    }
  }

  landmarkVisible(lm: Landmark, tx: number, ty: number, nowMs: number): boolean {
    const row = this.world.regionState(lm.rx, lm.ry);
    if (!row) return false;
    if (this.world.regionTick(lm.rx, lm.ry, nowMs) < lm.bornTick) return false;
    return Math.abs(lm.cx - tx) <= REALM_LANDMARK_HALF_W && Math.abs(lm.cy - ty) <= REALM_LANDMARK_HALF_H;
  }

  private electFirst(rx: number, ry: number, p: RealmPlayer, nowMs: number): void {
    const current = this.world.regionState(rx, ry);
    let row: RealmRegionState | null;
    if (this.hooks.landmarkFirst) {
      row = this.hooks.landmarkFirst(rx, ry, p, nowMs);
    } else if (!current || current.landmarkFirstName !== "") {
      row = null;
    } else {
      row = { ...current, landmarkFirstName: p.name, revision: ++this.realmRevision };
    }
    if (!row || (current && row.revision <= current.revision)) return;
    // A storage-backed landmark hook performs the first-writer CAS and owns
    // crediting its actual winner. Without that hook this arena elected the
    // winner itself, so the generic contribution callback is safe here.
    if (!this.hooks.landmarkFirst) {
      this.hooks.contributeDaily?.({
        sourceId: `landmark:${rx}:${ry}`,
        kind: "landmark",
        landmarkRx: rx,
        landmarkRy: ry,
      }, nowMs, p);
    }
    this.world.applyRegionState({ flags: 0, realmRevision: this.realmRevision, serverTimeMs: nowMs, rows: [row] });
    this.changedRows.push(row);
  }

  // -- private wire snapshots -------------------------------------------------------

  journeyMessage(p: RealmPlayer): PlayerJourneyMessage {
    return {
      revision: p.journeyRevision,
      eventSeq: p.event.seq,
      eventKind: p.event.kind,
      eventRx: p.event.rx,
      eventRy: p.event.ry,
      fast: p.fast,
      cooperative: p.journey.cooperative === true,
      errand: p.journey.errand ? { rx: p.journey.errand.rx, ry: p.journey.errand.ry } : null,
      helpedCount: p.journey.helpedCount,
      bloom: p.journey.bloom,
      helped: p.journey.helped,
      talked: p.journey.talked,
    };
  }

  progressMessage(p: RealmPlayer): PlayerProgressMessage {
    return { revision: p.progressRevision, landmarks: p.landmarks.map((l) => ({ rx: l.rx, ry: l.ry })) };
  }

  step(): void {
    for (let i = 0; i < this.ticksPerFrame; i++) this.stepRefTick();
    this.frame++;
  }

  /** Build a sparse signed-coordinate cell index once per broadcast. */
  indexPlayers(): void {
    this.cells.clear();
    for (const player of this.players.values()) {
      const { tx, ty } = player.state.move;
      let ys = this.cells.get(tx);
      if (!ys) {
        ys = new Map<number, RealmPlayer[]>();
        this.cells.set(tx, ys);
      }
      const list = ys.get(ty);
      if (list) list.push(player);
      else ys.set(ty, [player]);
    }
  }

  /** Self first, then Chebyshev rings; ties are stable by player id. */
  aoi(player: RealmPlayer, radius: number, cap = Infinity): RealmPlayer[] {
    const { tx, ty } = player.state.move;
    const out = [player];
    const ring: RealmPlayer[] = [];
    const visit = (x: number, y: number): void => {
      const list = this.cells.get(x)?.get(y);
      if (!list) return;
      for (const other of list) if (other.id !== player.id) ring.push(other);
    };
    for (let d = 0; d <= radius && out.length < cap; d++) {
      ring.length = 0;
      if (d === 0) visit(tx, ty);
      else {
        for (let x = tx - d; x <= tx + d; x++) {
          visit(x, ty - d);
          visit(x, ty + d);
        }
        for (let y = ty - d + 1; y <= ty + d - 1; y++) {
          visit(tx - d, y);
          visit(tx + d, y);
        }
      }
      ring.sort((a, b) => a.id - b.id);
      for (const other of ring) {
        if (out.length >= cap) break;
        out.push(other);
      }
    }
    return out;
  }

  digest(id: number): string {
    const p = this.players.get(id);
    if (!p) return "gone";
    const m = p.state.move;
    return `${this.frame}:${m.tx},${m.ty},${m.px},${m.py},${m.facing},${m.phase},${m.moving}`;
  }
}
