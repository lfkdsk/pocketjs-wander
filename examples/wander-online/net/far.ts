// examples/wander-online/net/far.ts — the coarse "someone is over there"
// signal for realm players outside the AOI, shared by both servers and the
// client. A far row is an octant (8 compass directions) and a distance band;
// it never carries a coordinate, so a player's position cannot be
// reconstructed from it beyond "north-east of me, between 64 and 256 tiles".

/** Compass octants, clockwise from north. */
export const FAR_DIR_NAMES = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;

/** Chebyshev distance (tiles) upper bounds of bands 0..2; band 3 is beyond. */
export const FAR_BANDS: readonly number[] = [64, 256, 1024];
export const FAR_BAND_COUNT = 4;
export const FAR_BAND_WORDS = ["near", "far", "distant", "remote"] as const;

/** Servers send FAR_PLAYERS once per this many seconds. */
export const FAR_INTERVAL_SEC = 1;
/** A far marker the client has not heard about for this long disappears. */
export const FAR_TTL_MS = 3000;

export interface FarRow {
  id: number;
  dir: number;
  band: number;
}

/** Octant of (dx, dy) in tile space (screen y grows downwards). The 8 cones
 *  are 45 degrees wide and centred on the compass directions. */
export function farDir(dx: number, dy: number): number {
  if (dx === 0 && dy === 0) return 0;
  // atan2 with north = 0, clockwise: angle of (dx, -dy) measured from +y.
  const angle = Math.atan2(dx, -dy); // -PI..PI, 0 = north, +PI/2 = east
  const octant = Math.round(angle / (Math.PI / 4));
  return ((octant % 8) + 8) % 8;
}

export function farBand(dist: number): number {
  for (let i = 0; i < FAR_BANDS.length; i++) if (dist <= FAR_BANDS[i]!) return i;
  return FAR_BANDS.length;
}

/** The coarse rows a recipient at (tx, ty) learns about: every other player
 *  strictly outside the Chebyshev AOI radius, in stable id order. Players
 *  inside the AOI are in the exact STATE4 snapshot and get no row. */
export function farRowsFor(
  tx: number,
  ty: number,
  selfId: number,
  others: Iterable<{ id: number; tx: number; ty: number }>,
  aoi: number,
): FarRow[] {
  const rows: FarRow[] = [];
  for (const other of others) {
    if (other.id === selfId) continue;
    const dx = other.tx - tx, dy = other.ty - ty;
    const dist = Math.max(Math.abs(dx), Math.abs(dy));
    if (dist <= aoi) continue;
    rows.push({ id: other.id, dir: farDir(dx, dy), band: farBand(dist) });
  }
  rows.sort((a, b) => a.id - b.id);
  return rows;
}

/** Unit screen vector of an octant (x right, y down). */
export function farVector(dir: number): { x: number; y: number } {
  const d = ((dir % 8) + 8) % 8;
  const diag = Math.SQRT1_2;
  switch (d) {
    case 0: return { x: 0, y: -1 };
    case 1: return { x: diag, y: -diag };
    case 2: return { x: 1, y: 0 };
    case 3: return { x: diag, y: diag };
    case 4: return { x: 0, y: 1 };
    case 5: return { x: -diag, y: diag };
    case 6: return { x: -1, y: 0 };
    default: return { x: -diag, y: -diag };
  }
}
