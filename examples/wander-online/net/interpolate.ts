// examples/wander-online/net/interpolate.ts — remote entity interpolation,
// pure logic.
//
// The server broadcasts AOI snapshots at ~10 Hz. Rendering remote players
// directly from the latest snapshot would make them hop 10 times a second.
// Instead the client keeps a short buffer of snapshots and renders every
// remote entity at render time = now - DELAY_MS, interpolating between the
// two snapshots bracketing that time. With a 100 ms delay and 10 Hz
// snapshots there is always a future snapshot to move toward, so motion is
// smooth and one dropped packet costs nothing (snapshots are idempotent).
// An entity absent from a snapshot holds its last known position; an entity
// absent for too long is dropped (the server sends BYE on disconnect, but
// AOI exits also remove entities).

import type { WireEntity } from "./protocol.ts";

/** How far behind real time remote entities are rendered. One snapshot
 *  interval at the server's 10 Hz broadcast rate. */
export const INTERP_DELAY_MS = 100;
/** Snapshots older than this (relative to the newest) are discarded. */
const BUFFER_MS = 1000;
/** An entity unseen for this long is removed (it left the AOI or died). */
const ENTITY_TTL_MS = 2000;

interface TimedEntity extends WireEntity {
  /** Last time this entity was seen in a snapshot. */
  seenAt: number;
}

interface TimedSnapshot {
  at: number;
  entities: Map<number, WireEntity>;
}

export interface RenderPos {
  x: number;
  y: number;
  dir: number;
  moving: boolean;
  color: number;
}

export class Interpolator {
  private snaps: TimedSnapshot[] = [];
  /** Last known position per entity, for hold-on-drop and TTL. */
  private last = new Map<number, TimedEntity>();
  private readonly delayMs: number;

  constructor(delayMs = INTERP_DELAY_MS) {
    this.delayMs = delayMs;
  }

  /** Drop every snapshot and known entity. Called on a fresh join epoch so
   *  a previous session's entities can never render or interpolate against
   *  the new session's snapshots. */
  reset(): void {
    this.snaps = [];
    this.last.clear();
  }

  /** Add a received snapshot. `at` is the local receive time. */
  push(entities: WireEntity[], at: number): void {
    const map = new Map<number, WireEntity>();
    for (const e of entities) {
      map.set(e.id, e);
      this.last.set(e.id, { ...e, seenAt: at });
    }
    this.snaps.push({ at, entities: map });
    // Keep the buffer small: drop snapshots older than BUFFER_MS.
    while (this.snaps.length > 2 && this.snaps[0]!.at < at - BUFFER_MS) this.snaps.shift();
    // Expire entities not seen recently.
    for (const [id, e] of this.last) {
      if (at - e.seenAt > ENTITY_TTL_MS) this.last.delete(id);
    }
  }

  /** Interpolated render position for entity `id` at time `now`, or null
   *  when the entity is not (or no longer) known. */
  renderAt(id: number, now: number): RenderPos | null {
    const known = this.last.get(id);
    if (!known || now - known.seenAt > ENTITY_TTL_MS) {
      if (known) this.last.delete(id);
      return null;
    }
    const t = now - this.delayMs;
    // Find the last snapshot at or before t (i), and the one after (i+1).
    let i = this.snaps.length - 1;
    while (i > 0 && this.snaps[i]!.at > t) i--;
    const a = this.snaps[i];
    if (!a) return null;
    const ea = a.entities.get(id);
    if (!ea) return this.posOf(known);
    const b = this.snaps[i + 1];
    if (!b) return this.posOf(ea);
    const eb = b.entities.get(id);
    if (!eb) return this.posOf(ea);
    const span = b.at - a.at;
    const f = span <= 0 ? 1 : Math.min(1, Math.max(0, (t - a.at) / span));
    return {
      x: ea.tx * 16 + ea.px + (eb.tx * 16 + eb.px - (ea.tx * 16 + ea.px)) * f,
      y: ea.ty * 16 + ea.py + (eb.ty * 16 + eb.py - (ea.ty * 16 + ea.py)) * f,
      dir: f < 0.5 ? ea.dir : eb.dir,
      moving: f < 0.5 ? ea.moving : eb.moving,
      color: ea.color,
    };
  }

  /** Ids of all entities currently known (for view node pooling). */
  ids(): number[] {
    return [...this.last.keys()];
  }

  private posOf(e: WireEntity): RenderPos {
    return { x: e.tx * 16 + e.px, y: e.ty * 16 + e.py, dir: e.dir, moving: e.moving, color: e.color };
  }
}
