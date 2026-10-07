// examples/wander/look-assets.ts — the character look pool: pure frame
// generation and CLUT8 TILESET cooking, shared by two consumers:
//
//   - gen-assets.ts cooks the 16 shipped TILESET blobs from these frames;
//   - tests/wander-looks.test.ts calls lookFrameRGBA in memory instead of
//     reading generated per-frame PNGs (which are no longer committed).
//
// Sixteen Ninja Adventure walkers (Pixel-Boy & AAA, CC0) in four palettes
// each = 64 looks. Every look is twelve 16x16 frames (idle / walk-L /
// walk-R x down / left / up / right), sliced from the pack's 4x4 Walk.png:
//
//   columns (Godot FrameDirection): 0 down, 1 up, 2 left, 3 right
//   rows    (Godot Anim.MOVING):     0 idle, 1 walk1, 2 walk2, 3 walk3
//
// so idle is row 0 and the two step extremes are rows 1 and 3 (row 2 is the
// passing pose, which the engine's idle/step-L/step-R cycle does not need).
// The engine facing order is 0 down, 1 left, 2 up, 3 right, hence the
// column remap [0, 2, 1, 3] below. The cut is verified against the Godot
// project's own sprite_character.gd (hframes=4, MOVING:[0,1,2,3]).
//
// Palettes: palette 0 is the original art; palettes 1..3 replace one
// GARMENT index (the dominant torso color that is not skin, outline or eye)
// and, where the character has visible hair or headwear, one HAIR index.
// The indices were picked per character by region (head vs torso) from the
// sheet's own 8-11 color palette: skin tones, the shared near-black outline
// (20,27,27) and eye white are never swapped. Bald characters (Monk, Monk2,
// the headbanded Villager) swap the garment only. Replacement is an exact
// RGB match, so flat cell shading is preserved with no halo or bleed.

import { readFileSync } from "node:fs";
import { decodePng } from "../../vendor/pocket-rpgkit/vendor/pocketjs/framework/compiler/pak.ts";

const TILE = 16;

export const POSES = ["idle", "walkL", "walkR"] as const;
export type LookPose = (typeof POSES)[number];
export const FACING_CH = ["d", "l", "u", "r"] as const;
export type LookFacing = (typeof FACING_CH)[number];

type RGB = readonly [number, number, number];
interface LookBase {
  name: string;
  file: string;
  /** Dominant torso garment index (replaced in palettes 1..3). */
  garment: RGB;
  /** Hair / headwear index, or null for a bald or hoodless character. */
  hair: RGB | null;
}
export const LOOK_BASES: readonly LookBase[] = [
  { name: "Villager", file: "Villager.png", garment: [209, 75, 52], hair: null },
  { name: "Villager2", file: "Villager2.png", garment: [143, 62, 86], hair: [78, 72, 74] },
  { name: "Villager3", file: "Villager3.png", garment: [150, 83, 64], hair: [78, 72, 74] },
  { name: "Villager4", file: "Villager4.png", garment: [209, 75, 52], hair: [241, 196, 113] },
  { name: "Boy", file: "Boy.png", garment: [150, 83, 64], hair: [209, 75, 52] },
  { name: "Woman", file: "Woman.png", garment: [84, 135, 137], hair: [241, 196, 113] },
  { name: "ManGreen", file: "ManGreen.png", garment: [168, 161, 41], hair: [86, 134, 76] },
  { name: "OldMan", file: "OldMan.png", garment: [78, 72, 74], hair: [95, 113, 96] },
  { name: "OldMan2", file: "OldMan2.png", garment: [143, 62, 86], hair: [224, 57, 76] },
  { name: "Monk", file: "Monk.png", garment: [59, 54, 67], hair: null },
  { name: "Monk2", file: "Monk2.png", garment: [209, 75, 52], hair: null },
  { name: "Hunter", file: "Hunter.png", garment: [143, 62, 86], hair: [209, 75, 52] },
  { name: "Eskimo", file: "Eskimo.png", garment: [45, 105, 123], hair: [84, 135, 137] },
  { name: "Noble", file: "Noble.png", garment: [78, 72, 74], hair: [59, 54, 67] },
  { name: "Samurai", file: "Samurai.png", garment: [224, 57, 76], hair: [78, 72, 74] },
  { name: "SamuraiBlue", file: "SamuraiBlue.png", garment: [59, 54, 67], hair: [78, 72, 74] },
];
/** Palette targets: [name, garment target, hair target] (null = unchanged).
 *  Palette 0 keeps the original indices; 1..3 are coordinated recolors. */
export const LOOK_PALETTES: readonly (readonly [string, RGB | null, RGB | null])[] = [
  ["original", null, null],
  ["rust", [180, 72, 60], [56, 48, 52]],
  ["azure", [66, 98, 160], [116, 80, 52]],
  ["forest", [88, 138, 78], [188, 176, 150]],
];
export const LOOK_PALETTE_COUNT = 4;

/** Engine facing order (down, left, up, right) -> Walk.png column. */
const NINJA_COL = [0, 2, 1, 3] as const;
/** Engine pose (idle, walkL, walkR) -> Walk.png row. */
const NINJA_ROW = { idle: 0, walkL: 1, walkR: 3 } as const;

const rgbKey = (c: RGB): string => `${c[0]},${c[1]},${c[2]}`;
const swapTable = (base: LookBase, palette: number): Map<string, RGB> => {
  const [, gTarget, hTarget] = LOOK_PALETTES[palette]!;
  const swaps = new Map<string, RGB>();
  if (palette !== 0) {
    if (gTarget) swaps.set(rgbKey(base.garment), gTarget);
    if (base.hair && hTarget) swaps.set(rgbKey(base.hair), hTarget);
  }
  return swaps;
};

/** Cut one 16x16 cell from a 64x64 Walk.png, applying exact-RGB swaps. */
function cutFrame(sheet: Uint8Array, row: number, col: number, swaps: Map<string, RGB>): Uint8Array {
  const out = new Uint8Array(TILE * TILE * 4);
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const si = ((row * TILE + y) * 64 + (col * TILE + x)) * 4;
      const di = (y * TILE + x) * 4;
      const a = sheet[si + 3]!;
      if (a === 0) continue;
      const key = `${sheet[si]},${sheet[si + 1]},${sheet[si + 2]}`;
      const to = swaps.get(key);
      if (to) { out[di] = to[0]; out[di + 1] = to[1]; out[di + 2] = to[2]; }
      else { out[di] = sheet[si]!; out[di + 1] = sheet[si + 1]!; out[di + 2] = sheet[si + 2]!; }
      out[di + 3] = a;
    }
  }
  return out;
}

// Source sheets are committed fixtures; decoding one is deterministic, so a
// module-level cache keeps lookFrameRGBA cheap when a test asks for hundreds
// of frames without making the function impure.
const sheetCache = new Map<number, Uint8Array>();
function lookSheetRGBA(base: number): Uint8Array {
  const hit = sheetCache.get(base);
  if (hit) return hit;
  const meta = LOOK_BASES[base];
  if (!meta) throw new Error(`look-assets: base ${base} out of range (0..${LOOK_BASES.length - 1})`);
  const png = decodePng(new Uint8Array(readFileSync(new URL(`assets/src/ninja-adventure/walk/${meta.file}`, import.meta.url))));
  if (png.width !== 64 || png.height !== 64) throw new Error(`look-assets: ${meta.file} is not 64x64`);
  sheetCache.set(base, png.rgba);
  return png.rgba;
}

/** One 16x16 look frame as RGBA: the Walk.png cell for (pose, facing) with
 *  the palette's exact-RGB garment/hair swaps applied. Pure: the output is a
 *  deterministic function of (base, palette, pose, facing) alone. */
export function lookFrameRGBA(base: number, palette: number, pose: LookPose, facing: LookFacing): Uint8Array {
  if (base < 0 || base >= LOOK_BASES.length) throw new Error(`look-assets: base ${base} out of range (0..${LOOK_BASES.length - 1})`);
  if (palette < 0 || palette >= LOOK_PALETTE_COUNT) throw new Error(`look-assets: palette ${palette} out of range (0..${LOOK_PALETTE_COUNT - 1})`);
  const f = FACING_CH.indexOf(facing);
  return cutFrame(lookSheetRGBA(base), NINJA_ROW[pose], NINJA_COL[f]!, swapTable(LOOK_BASES[base]!, palette));
}

// --- CLUT8 TILESET cooking -------------------------------------------------
//
// Each base cooks to ONE TILESET entry: 48 tiles (4 palettes x 12 frames)
// sharing one palette, with PackBits-RLE index streams. Pixel parity with
// the old PSM_4444 path: palette words are quantized to 4 bits per channel
// exactly like encodeImageEntry's PSM_4444 path (c >> 4, GE-expanded n*17),
// so a CLUT8-rendered villager is byte-identical to a PSM_4444-rendered one
// (pinned by tests/wander-render.test.ts's goldens).

const q4444 = (c: number): number => (c >> 4) * 17;
const abgrWord = (r: number, g: number, b: number, a: number): number =>
  ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;

/** Quantize one frame's RGBA to 4444-expanded ABGR words (transparent = 0). */
export function quantizedWords(rgba: Uint8Array): Uint32Array {
  const words = new Uint32Array(rgba.length >> 2);
  for (let i = 0; i < words.length; i++) {
    const o = i << 2;
    words[i] = rgba[o + 3] === 0 ? 0 : abgrWord(q4444(rgba[o]!), q4444(rgba[o + 1]!), q4444(rgba[o + 2]!), 255);
  }
  return words;
}

/** A <=256-entry palette plus a word->index map, colours ranked by frequency
 *  (flat-shaded art uses a few dozen colours, so everything is retained). */
export function lookPalette(frames: Uint32Array[]): { palette: Uint32Array; indexByWord: Map<number, number> } {
  const census = new Map<number, number>();
  for (const f of frames) for (let i = 0; i < f.length; i++) census.set(f[i]!, (census.get(f[i]!) ?? 0) + 1);
  const transparent = census.has(0);
  const ranked = [...census.entries()].filter(([w]) => !transparent || w !== 0).sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const capacity = transparent ? 255 : 256;
  if (ranked.length > capacity) throw new Error("look-assets: a look base has more than 256 colours");
  const palette = new Uint32Array(256);
  const indexByWord = new Map<number, number>();
  let cursor = 0;
  if (transparent) { indexByWord.set(0, 0); cursor = 1; }
  for (const [w] of ranked) { palette[cursor] = w; indexByWord.set(w, cursor); cursor++; }
  return { palette, indexByWord };
}

/** Tile index of a frame: palette * 12 + pose base + facing (pose base:
 *  idle 0, walkL 4, walkR 8). The view asks the TILESET for this index. */
export const LOOK_POSE_BASE = { idle: 0, walkL: 4, walkR: 8 } as const;
export const LOOK_TILES_PER_BASE = LOOK_PALETTE_COUNT * 12;

/** The 48 quantized frames of one base, in tile order
 *  (palette*12 + LOOK_POSE_BASE[pose] + facing). */
export function lookTileWords(base: number): Uint32Array[] {
  const words: Uint32Array[] = new Array(LOOK_TILES_PER_BASE);
  for (let p = 0; p < LOOK_PALETTE_COUNT; p++) {
    for (const pose of POSES) {
      for (let f = 0; f < 4; f++) {
        words[p * 12 + LOOK_POSE_BASE[pose] + f] = quantizedWords(lookFrameRGBA(base, p, pose, FACING_CH[f]!));
      }
    }
  }
  return words;
}
