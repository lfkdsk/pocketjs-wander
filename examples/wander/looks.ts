// examples/wander/looks.ts — the character look pool: who is who, and which
// look a villager or the player gets. Pure and deterministic: the same
// (seed, town, villager) always resolves to the same look on every machine,
// which is what a future online profile / ROSTER entry stores.
//
// A look is a base character (one of the Ninja Adventure walkers) in one of
// four build-time palettes. The numeric id is `base * LOOK_PALETTES +
// palette` and is STABLE: once a look ships, its id must never be renumbered
// (saved profiles and the ROSTER persist it), and new looks may only be
// appended (a higher base count, or a higher palette count — the latter
// shifts existing ids, so the palette count is frozen at 4; grow the pool
// by adding bases at the end instead).
//
// The frames themselves are baked by examples/wander/gen-assets.ts into
// assets-wander.ts's WANDER_LOOKS, indexed by this same id.

/** Number of base characters in the pool. Append-only: never reorder. */
export const LOOK_BASES = 16;
/** Palettes per base. FROZEN at 4 — raising it renumbers every look id. */
export const LOOK_PALETTES = 4;
/** Total looks in the pool. */
export const LOOK_COUNT = LOOK_BASES * LOOK_PALETTES;

/**
 * The base characters in id order: base `i` is the walker whose Ninja
 * Adventure source sheet is `assets/src/ninja-adventure/walk/<name>.png`,
 * and gen-assets.ts must bake base `i` from that same sheet. This table is
 * the published semantic of the numeric base index — profiles and the
 * ROSTER persist ids, so an id must keep meaning the same character.
 *
 * APPEND-ONLY: never reorder, rename or delete an entry (a reorder silently
 * repoints every persisted id at a different character; the hash pins in
 * tests/wander-looks.test.ts fail if the generated art drifts from it). Grow
 * the pool by appending new bases at the end (and bump LOOK_BASES).
 */
export const LOOK_BASE_NAMES = [
  "Villager",
  "Villager2",
  "Villager3",
  "Villager4",
  "Boy",
  "Woman",
  "ManGreen",
  "OldMan",
  "OldMan2",
  "Monk",
  "Monk2",
  "Hunter",
  "Eskimo",
  "Noble",
  "Samurai",
  "SamuraiBlue",
] as const;

/** A character appearance: a base walker in one palette. */
export interface CharacterLook {
  /** Base character index, 0..LOOK_BASES-1 (see WANDER_LOOK_BASES). */
  base: number;
  /** Palette variant, 0..LOOK_PALETTES-1 (0 is the original art). */
  palette: number;
}

/** The stable, published numeric id of a look. */
export function lookId(look: CharacterLook): number {
  return look.base * LOOK_PALETTES + look.palette;
}

/** Recover a look from its published id (clamped to the pool). */
export function lookFromId(id: number): CharacterLook {
  const i = Math.max(0, Math.min(LOOK_COUNT - 1, Math.floor(id)));
  return { base: Math.floor(i / LOOK_PALETTES), palette: i % LOOK_PALETTES };
}

/** A small deterministic 32-bit integer mixer (splitmix32-style finalizer
 *  over folded inputs). Pure integer ops, so it agrees on every host. */
function mix32(...xs: number[]): number {
  let h = 0x9e3779b9 >>> 0;
  for (const x of xs) {
    h = Math.imul(h ^ (x >>> 0), 0x85ebca6b) >>> 0;
    h = ((h << 13) | (h >>> 19)) >>> 0;
  }
  h = Math.imul(h ^ (h >>> 16), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * The look of villager `villagerIndex` in town (rx, ry) of `seed`.
 *
 * The base walks a permutation of the pool as `villagerIndex` rises
 * (step 7, coprime to 16), so the first sixteen villagers of a town all
 * wear DIFFERENT base characters; the palette is an independent per-
 * villager pick. Two villagers in the same town therefore share a look
 * only once the base permutation wraps (16+ villagers) and the palette
 * also happens to match.
 */
export function lookFor(seed: number, rx: number, ry: number, villagerIndex: number): CharacterLook {
  const town = mix32(seed, rx, ry);
  const base = (town + Math.imul(villagerIndex >>> 0, 7)) % LOOK_BASES;
  const palette = mix32(seed, rx, ry, villagerIndex ^ 0x517cc1b7) % LOOK_PALETTES;
  return { base, palette };
}

/** The player's default look for a world: derived from the seed, so every
 *  world has a consistent hero and a re-roll (SQUARE) may change the face. */
export function playerLook(seed: number): CharacterLook {
  return {
    base: mix32(seed ^ 0x9e3779b9) % LOOK_BASES,
    palette: mix32(seed ^ 0x517cc1b7) % LOOK_PALETTES,
  };
}

/** Parse a wander resident id ("v<rx>_<ry>_<n>") into the (rx, ry, n) the
 *  look was assigned from. Returns null for ids that are not villagers
 *  (the town plaque, future actor kinds). */
export function parseVillagerId(id: string): { rx: number; ry: number; n: number } | null {
  const m = /^v(-?\d+)_(-?\d+)_(\d+)$/.exec(id);
  if (!m) return null;
  return { rx: Number(m[1]), ry: Number(m[2]), n: Number(m[3]) };
}
