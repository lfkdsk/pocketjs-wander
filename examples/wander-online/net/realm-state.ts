// Shared, wire-independent projection of a realm's sparse region facts.
//
// The RoomDO owns persistence and CAS.  Both the authoritative world and the
// client predictor consume the same monotonic projection so rendering and
// collision derive an identical growth phase from discoveredAtMs.

import { COMPLETE, UNDISCOVERED } from "../../wander/chunk.ts";
import { GROWTH_TICK_FRAMES } from "../../wander/region.ts";

export const WORLD_STATE_VERSION = 1;
/** Server-owned discovery footprint, matching the single-player Wander
 * growth ring without importing the full WanderSim/errand dependency graph. */
export const REALM_DISCOVERY_HALF_W = 22;
export const REALM_DISCOVERY_HALF_H = 14;
const REFERENCE_HZ = 60;

export interface RealmRegionState {
  rx: number;
  ry: number;
  discoveredAtMs: number;
  improvementLevel: number;
  revision: number;
  /** Display name only. Stable account ids never cross this boundary. */
  landmarkFirstName: string;
}

export interface RealmRegionSnapshot {
  flags: number;
  realmRevision: number;
  serverTimeMs: number;
  rows: readonly RealmRegionState[];
}

export interface AppliedRegionState {
  row: RealmRegionState;
  previous: RealmRegionState | null;
}

export function realmStateKey(rx: number, ry: number): string {
  return `${rx},${ry}`;
}

/** A bounded host decides which rows to load; this cache only enforces the
 * monotonic revision and clock contract shared by server and client. */
export class RealmStateCache {
  readonly regions = new Map<string, RealmRegionState>();
  realmRevision = 0;
  serverTimeMs = 0;

  get(rx: number, ry: number): RealmRegionState | undefined {
    return this.regions.get(realmStateKey(rx, ry));
  }

  /** World time never moves backwards, including after a delayed delta. */
  advanceClock(serverTimeMs: number): number {
    if (!Number.isFinite(serverTimeMs) || serverTimeMs < 0) {
      throw new RangeError(`invalid realm server time ${serverTimeMs}`);
    }
    this.serverTimeMs = Math.max(this.serverTimeMs, serverTimeMs);
    return this.serverTimeMs;
  }

  /** Apply only strictly newer per-region revisions. Equal packets are
   * idempotent and stale packets cannot roll back growth or improvements. */
  apply(snapshot: RealmRegionSnapshot): AppliedRegionState[] {
    this.advanceClock(snapshot.serverTimeMs);
    this.realmRevision = Math.max(this.realmRevision, snapshot.realmRevision >>> 0);
    const applied: AppliedRegionState[] = [];
    for (const source of snapshot.rows) {
      const key = realmStateKey(source.rx, source.ry);
      const previous = this.regions.get(key) ?? null;
      if (previous && source.revision <= previous.revision) continue;
      const row: RealmRegionState = {
        rx: source.rx,
        ry: source.ry,
        discoveredAtMs: source.discoveredAtMs,
        improvementLevel: previous
          ? Math.max(previous.improvementLevel, source.improvementLevel)
          : source.improvementLevel,
        revision: source.revision >>> 0,
        landmarkFirstName: source.landmarkFirstName,
      };
      this.regions.set(key, row);
      applied.push({ row, previous });
    }
    return applied;
  }

  /** Unknown regions have not been discovered. Known regions grow from one
   * persisted wall-clock timestamp without any per-tick storage write. */
  regionTick(rx: number, ry: number, nowMs = this.serverTimeMs): number {
    const row = this.get(rx, ry);
    if (!row) return UNDISCOVERED;
    const elapsedMs = Math.max(0, nowMs - row.discoveredAtMs);
    const referenceFrames = elapsedMs * REFERENCE_HZ / 1000;
    return Math.min(COMPLETE, Math.floor(referenceFrames / GROWTH_TICK_FRAMES));
  }
}
