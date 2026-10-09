// Authoritative v4 arena over the endless, signed-coordinate Wander world.
// Networking cadence and input queue semantics intentionally match the v3
// Arena; only the movement/collision source and sparse AOI index differ.

import { motionTicksPerFrame } from "../../../vendor/pocket-rpgkit/src/engine/motion-clock.ts";
import type { Dir4 } from "../../../vendor/pocket-rpgkit/src/engine/passability.ts";
import { regionOf } from "../../wander/world.ts";
import { planRegion, type RegionPlan } from "../../wander/region.ts";
import { purePlacedLandmark, type Errand } from "../../wander/towns.ts";
import type { Landmark } from "../../wander/landmarks.ts";
import {
  emptyJourney,
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
import { residentDistance, ticksSinceDiscovery, townResidentsAt } from "../net/npc.ts";
import { BTN, COMMAND, PLAYER_PROGRESS_MAX, type CommandMessage, type PlayerJourneyMessage, type PlayerProgressMessage } from "../net/protocol.ts";
import {
  MultiFocusWorld,
  startRealmState,
  stepRealmMovement,
  type RealmFocus,
  type RealmState,
} from "../net/realm-world.ts";
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
  /** Latest confirmed journey event (seq 0 = none yet). */
  event: JourneyEvent;
  /** Private landmark sightings, oldest first, exact, at most PLAYER_PROGRESS_MAX. */
  landmarks: JourneyPair[];
  progressRevision: number;
  progressDirty: boolean;
  /** Tile of the last landmark scan; the scan only reruns on a tile change. */
  scanX: number | null;
  scanY: number | null;
}

/** Private state a host restores from storage when a player is admitted. */
export interface RealmPlayerRestore {
  journey?: PlayerJourney;
  journeyRevision?: number;
  landmarks?: readonly JourneyPair[];
  progressRevision?: number;
}

/** Storage-backed hosts intercept the two shared facts a journey can
 *  create. Each returns the authoritative row after its compare-and-set (or
 *  the unchanged row), or null to refuse; the arena then applies and queues
 *  it for broadcast. Without hooks the arena keeps the facts in memory. */
export interface RealmArenaHooks {
  improveRegion?(rx: number, ry: number, level: number, nowMs: number): RealmRegionState | null;
  landmarkFirst?(rx: number, ry: number, player: RealmPlayer, nowMs: number): RealmRegionState | null;
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

  /** Refuse before allocating an id, inserting a player or changing focus. */
  tryAdd(
    name: string,
    color: number,
    look = 0,
    at?: { tx: number; ty: number; facing?: number },
    restore?: RealmPlayerRestore,
  ): RealmPlayer | null {
    if (this.players.size >= this.maxPlayers) return null;
    if (at?.facing !== undefined && (!Number.isInteger(at.facing) || at.facing < 0 || at.facing > 3)) {
      throw new RangeError("realm spawn facing must be an integer in 0..3");
    }
    const id = this.nextId++;
    let state = startRealmState(this.seed);
    if (at) {
      state = {
        ...state,
        move: {
          ...state.move,
          tx: at.tx,
          ty: at.ty,
          px: at.tx * 16,
          py: at.ty * 16,
          facing: at.facing === undefined ? state.move.facing : at.facing as Dir4,
          phase: 0,
          moving: false,
          walking: false,
        },
      };
    }
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
      event: { seq: 0, kind: JOURNEY_EVENT.none, rx: 0, ry: 0 },
      landmarks: [...(restore?.landmarks ?? [])],
      progressRevision: restore?.progressRevision ?? 0,
      progressDirty: false,
      scanX: null,
      scanY: null,
    };
    this.players.set(id, player);
    const nowMs = this.now();
    this.discoverRegions(nowMs);
    // Admission is rare and must leave the spawn's full authoritative ring
    // ready before WELCOME; steady movement stays on the per-frame budget.
    this.world.prime(this.focuses(), this.refTicks);
    this.scanLandmarks(player, nowMs);
    return player;
  }

  add(name: string, color: number, look = 0, at?: { tx: number; ty: number; facing?: number }, restore?: RealmPlayerRestore): RealmPlayer {
    const player = this.tryAdd(name, color, look, at, restore);
    if (!player) throw new RangeError(`realm is full (${this.maxPlayers} players)`);
    return player;
  }

  remove(id: number): void {
    this.players.delete(id);
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

  /** Validate and apply a client command against the authoritative mover
   *  and clock. Returns the confirmed event kind, or null when refused. */
  applyCommand(p: RealmPlayer, cmd: CommandMessage, nowMs = this.now()): JourneyEventKind | null {
    const here = this.playerRegion(p);
    if (cmd.rx !== here.rx || cmd.ry !== here.ry) return null;
    const plan = this.townPlan(here.rx, here.ry);
    if (cmd.kind === COMMAND.acceptErrand) {
      if (!this.onPlaza(p, plan)) return null;
      const accepted = journeyAccept(this.seed, p.journey, here.rx, here.ry);
      if (!accepted) return null;
      this.setJourney(p, accepted.journey);
      return this.confirm(p, JOURNEY_EVENT.accepted, here.rx, here.ry);
    }
    if (cmd.kind === COMMAND.deliverErrand) {
      if (!this.onPlaza(p, plan)) return null;
      const errand = resolveErrand(this.seed, p.journey);
      if (!errand || errand.kind !== "deliver" || errand.trx !== here.rx || errand.try !== here.ry) return null;
      return this.complete(p, errand, JOURNEY_EVENT.delivered, nowMs);
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

  private complete(p: RealmPlayer, errand: Errand, kind: JourneyEventKind, nowMs: number): JourneyEventKind {
    const done = journeyComplete(this.seed, p.journey, errand);
    this.setJourney(p, done.journey);
    if (done.newlyHelped) this.improve(done.hrx, done.hry, 1, nowMs);
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
  private improve(rx: number, ry: number, level: number, nowMs: number): void {
    const current = this.world.regionState(rx, ry);
    let row: RealmRegionState | null;
    if (this.hooks.improveRegion) {
      row = this.hooks.improveRegion(rx, ry, level, nowMs);
    } else if (!current || current.improvementLevel >= level) {
      row = null;
    } else {
      row = { ...current, improvementLevel: level, revision: ++this.realmRevision };
    }
    if (!row || (current && row.revision <= current.revision)) return;
    this.world.applyRegionState({ flags: 0, realmRevision: this.realmRevision, serverTimeMs: nowMs, rows: [row] });
    this.changedRows.push(row);
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
