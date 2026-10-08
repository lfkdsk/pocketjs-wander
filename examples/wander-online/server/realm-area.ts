// Authoritative v4 arena over the endless, signed-coordinate Wander world.
// Networking cadence and input queue semantics intentionally match the v3
// Arena; only the movement/collision source and sparse AOI index differ.

import { motionTicksPerFrame } from "../../../vendor/pocket-rpgkit/src/engine/motion-clock.ts";
import type { Dir4 } from "../../../vendor/pocket-rpgkit/src/engine/passability.ts";
import { regionOf } from "../../wander/world.ts";
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
  tryAdd(name: string, color: number, look = 0, at?: { tx: number; ty: number; facing?: number }): RealmPlayer | null {
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
    };
    this.players.set(id, player);
    this.discoverRegions(this.now());
    // Admission is rare and must leave the spawn's full authoritative ring
    // ready before WELCOME; steady movement stays on the per-frame budget.
    this.world.prime(this.focuses(), this.refTicks);
    return player;
  }

  /** Add at the deterministic starter tile. Tests may supply another signed
   * coordinate to exercise separated residents without mutating internals. */
  add(name: string, color: number, look = 0, at?: { tx: number; ty: number; facing?: number }): RealmPlayer {
    const player = this.tryAdd(name, color, look, at);
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
      p.state = { ...p.state, move: stepRealmMovement(this.world, p.state.move, p.buttons) };
    }
    this.refTicks++;
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
