// examples/wander-online/shared/snapshot.ts — the broadcast inner loop,
// shared by the Bun area server (server/server.ts) and the Cloudflare Room
// Durable Object (server repo). Pure: no node:*, no Bun/Worker APIs, so
// wrangler/esbuild bundles it into the Worker verbatim.
//
// One broadcast = index every player by tile once, then build one full
// idempotent AOI snapshot per recipient. The wire format lives in
// net/protocol.ts; this module only decides WHO is in each snapshot.

import type { Arena, ArenaPlayer } from "../server/area.ts";
import { MAX_AOI, encodeState, type WireEntity } from "../net/protocol.ts";

const TILE_PX = 16; // kit tiles are 16x16 pixels

/** One player's wire entity: absolute mover pixels become a tile plus an
 *  i8 offset from it (the client reconstructs absolute pixels). */
export function entityFor(p: ArenaPlayer): WireEntity {
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
 *  Call arena.indexPlayers() once before a batch of these. */
export function snapshotFor(arena: Arena, recipient: ArenaPlayer, aoi: number): ArrayBuffer {
  const view = arena.aoi(recipient, aoi, MAX_AOI);
  return encodeState(arena.frame, recipient.lastSeq, view.map(entityFor));
}
