// examples/wander-online/net/spawn.ts — safe spawn slots. Every admission
// anchors at a tile (the starter town hub for a new player, the stored
// checkpoint for a returning one) and then takes the first free tile of a
// small ring walk around it: not blocked by the streamed world at the
// current growth phase, and not under another player's feet. The walk
// starts at an offset derived from a stable per-account hash, so a crowd
// arriving together spreads over the ring instead of piling onto one tile
// and then cascading, and the same account tends to get the same slot.

/** Chebyshev radius of the ring walk. A 13x13 box has 169 candidates, five
 *  times the 32-player realm cap, so a full realm always finds a free tile
 *  on an open plaza. */
export const SPAWN_RING_RADIUS = 6;

/** FNV-1a over the UTF-16 code units: stable across hosts, no crypto. */
export function spawnHash(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** The tiles at exact Chebyshev distance d from the origin, clockwise from
 *  the top-left corner. d = 0 is the origin alone. */
export function spawnRing(d: number): { dx: number; dy: number }[] {
  if (d === 0) return [{ dx: 0, dy: 0 }];
  const out: { dx: number; dy: number }[] = [];
  for (let x = -d; x <= d; x++) out.push({ dx: x, dy: -d });
  for (let y = -d + 1; y <= d; y++) out.push({ dx: d, dy: y });
  for (let x = d - 1; x >= -d; x--) out.push({ dx: x, dy: d });
  for (let y = d - 1; y >= -d + 1; y--) out.push({ dx: -d, dy: y });
  return out;
}

export interface SpawnPick {
  tx: number;
  ty: number;
  /** Chebyshev distance from the anchor (0 = the anchor itself was free). */
  ring: number;
}

/** First free tile of the ring walk around the anchor, or null when every
 *  tile within the radius is blocked or occupied. */
export function pickSpawn(
  anchor: { tx: number; ty: number },
  hash: number,
  free: (tx: number, ty: number) => boolean,
  radius = SPAWN_RING_RADIUS,
): SpawnPick | null {
  for (let d = 0; d <= radius; d++) {
    const ring = spawnRing(d);
    const start = ring.length === 1 ? 0 : (hash >>> 0) % ring.length;
    for (let i = 0; i < ring.length; i++) {
      const cell = ring[(start + i) % ring.length]!;
      const tx = anchor.tx + cell.dx, ty = anchor.ty + cell.dy;
      if (free(tx, ty)) return { tx, ty, ring: d };
    }
  }
  return null;
}
