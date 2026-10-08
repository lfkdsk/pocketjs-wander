// examples/wander-online/shared/snapshot.ts — the broadcast inner loop,
// shared by the Bun area server (server/server.ts) and the Cloudflare Room
// Durable Object (server repo). Pure: no node:*, no Bun/Worker APIs, so
// wrangler/esbuild bundles it into the Worker verbatim.
//
// One broadcast = index every player by tile once, then build one full
// idempotent AOI snapshot per recipient. The wire format lives in
// net/protocol.ts; this module only decides WHO is in each snapshot.

import type { Arena, ArenaPlayer } from "../server/area.ts";
import type { RealmArena, RealmPlayer } from "../server/realm-area.ts";
import { MAX_AOI, encodeState, encodeState4, type WireEntity } from "../net/protocol.ts";

const TILE_PX = 16; // kit tiles are 16x16 pixels

/** One player's wire entity: absolute mover pixels become a tile plus an
 *  i8 offset from it (the client reconstructs absolute pixels). */
export function entityFor(p: ArenaPlayer | RealmPlayer): WireEntity {
  const m = p.state.move;
  return {
    id: p.id, tx: m.tx, ty: m.ty,
    px: m.px - m.tx * TILE_PX, py: m.py - m.ty * TILE_PX,
    dir: m.facing, phase: m.phase, stepDir: m.stepDir,
    moving: m.moving, walking: m.walking, color: p.color,
  };
}

/** One recipient's STATE snapshot: its AOI (Chebyshev radius, wire-capped)
 *  as full idempotent entities, acked at the recipient's input watermark.
 *  Optional room/service counts become the backwards-compatible population
 *  tail; omit both to produce the byte-identical legacy STATE. Call
 *  arena.indexPlayers() once before a batch of these. */
export function snapshotFor(
  arena: Arena,
  recipient: ArenaPlayer,
  aoi: number,
  roomOnline?: number,
  allOnline?: number,
): ArrayBuffer {
  const view = arena.aoi(recipient, aoi, MAX_AOI);
  const population = roomOnline === undefined && allOnline === undefined
    ? undefined
    : {
        roomOnline: roomOnline ?? view.length,
        allOnline: allOnline ?? roomOnline ?? view.length,
      };
  return encodeState(arena.frame, recipient.lastSeq, view.map(entityFor), population);
}

/** v4 full AOI snapshot. Entity selection is identical to v3, while the
 * codec keeps signed world tiles and carries the connection epoch. */
export function snapshotForRealm(
  arena: RealmArena,
  recipient: RealmPlayer,
  aoi: number,
  roomOnline?: number,
  allOnline?: number,
): ArrayBuffer {
  const view = arena.aoi(recipient, aoi, MAX_AOI);
  const population = roomOnline === undefined && allOnline === undefined
    ? undefined
    : {
        roomOnline: roomOnline ?? view.length,
        allOnline: allOnline ?? roomOnline ?? view.length,
      };
  return encodeState4(arena.frame, recipient.lastSeq, arena.epoch, view.map(entityFor), population);
}
