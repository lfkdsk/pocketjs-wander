// examples/wander/gen-assets.ts — point the endless world at grow's art.
//
//   bun examples/wander/gen-assets.ts   (or `bun run gen-assets` for all)
//
// The wander example draws grow's committed PNGs (examples/grow/gen-assets.ts
// writes them). The build resolves an image literal relative to the entry's
// directory, so "../../vendor/pocket-rpgkit/examples/grow/assets/<file>.png" packs grow's own file under that
// literal key and nothing is copied.
//
// It also composites a few of those cells into larger images, because a
// native node costs far more on the desktop host's QuickJS than a bigger
// texture does (every node is a DOM-shaped mirror of ~45 JS objects, and the
// cycle collector walks all of them):
//
//   assets/stamp-<key>.png   every multi-cell Ninja stamp (trees, boulders,
//                            palms, markets, houses) as ONE image, so a tree
//                            is one node instead of four and a cottage one
//                            instead of twelve. The emitted manifest uses
//                            ../wander/assets/... so importing this module
//                            from another example still shares these files.
//   assets/fill64-<b>.png    4 x 4 tiles of a biome fill, likewise referenced
//                            through the shared ../wander/assets/... path
//
// Outputs (deterministic; rerunning reproduces them byte for byte):
//   assets/stamp-*.png, assets/fill64-*.png
//   assets/look/tilesets/*.pkts one CLUT8 TILESET per look base (what ships)
//   assets-wander.ts  the manifest WanderView reads (full literals)
//   images.json       PSM_4444 marks (grow's, re-keyed, plus the composites)
//   pak.json          the look TILESET blobs, spliced into dist/wander.pak
//
// The 768 look frames themselves are NOT written: look-assets.ts generates
// them in memory (a pure function of base/palette/pose/facing), both here
// for the TILESET cook and in tests/wander-looks.test.ts.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodePng, encodeTilesetEntry } from "../../vendor/pocket-rpgkit/vendor/pocketjs/framework/compiler/pak.ts";
import { TILESET_FLAG_RLE, keyTileset } from "../../vendor/pocket-rpgkit/vendor/pocketjs/contracts/spec/spec.ts";
import { encodePNG } from "../../vendor/pocket-rpgkit/vendor/pocketjs/tests/png.ts";
import { GROW_GROUND, GROW_NPC, GROW_PLAYER, GROW_TERRAIN, GROW_TERRAIN_BLOCK, GROW_UPPER } from "../../vendor/pocket-rpgkit/examples/grow/assets-grow.ts";
import { STAMP_LIST } from "../../vendor/pocket-rpgkit/examples/grow/grow-stamps.ts";
import { LOOK_BASES, LOOK_PALETTE_COUNT, LOOK_PALETTES, LOOK_POSE_BASE, LOOK_TILES_PER_BASE, POSES, lookPalette, lookTileWords } from "./look-assets.ts";

const HERE = new URL(".", import.meta.url).pathname;
const GROW = join(HERE, "../../vendor/pocket-rpgkit/examples/grow");
const ASSETS = join(HERE, "assets");
mkdirSync(ASSETS, { recursive: true });
const GROW_IMAGES = JSON.parse(await Bun.file(join(GROW, "images.json")).text()) as Record<string, { psm?: number }>;
const TILE = 16;

const rebase = (path: string): string => {
  if (!path.startsWith("assets/")) throw new Error(`wander gen-assets: unexpected grow asset path ${path}`);
  return `../../vendor/pocket-rpgkit/examples/grow/${path}`;
};
const shared = (path: string): string => {
  if (!path.startsWith("assets/")) throw new Error(`wander gen-assets: unexpected local asset path ${path}`);
  return `../wander/${path}`;
};
const readCell = async (path: string): Promise<Uint8Array> => {
  const png = decodePng(new Uint8Array(await Bun.file(join(GROW, path)).arrayBuffer()));
  if (png.width !== TILE || png.height !== TILE) throw new Error(`wander gen-assets: ${path} is not 16x16`);
  return png.rgba;
};
const blit = (dst: Uint8Array, dstW: number, x: number, y: number, cell: Uint8Array) => {
  for (let row = 0; row < TILE; row++) dst.set(cell.subarray(row * TILE * 4, (row + 1) * TILE * 4), ((y + row) * dstW + x) * 4);
};

const images: Record<string, { psm?: number }> = {};
for (const [path, meta] of Object.entries(GROW_IMAGES)) images[rebase(path)] = meta;

// Whole stamps.
const stamps: { base: number; w: number; h: number; path: string }[] = [];
for (const st of STAMP_LIST) {
  if (st.w * st.h === 1) continue;
  // Pak images are power-of-two squares-or-strips: pad a 3 x 3 or 4 x 3
  // house onto a transparent 64 x 64 (the node is sized to the padding).
  const pow2 = (n: number) => 1 << Math.ceil(Math.log2(n));
  const W = pow2(st.w * TILE), H = pow2(st.h * TILE);
  const rgba = new Uint8Array(W * H * 4);
  for (let dy = 0; dy < st.h; dy++) for (let dx = 0; dx < st.w; dx++) {
    const cell = st.base + dy * st.w + dx;
    const src = GROW_UPPER[cell];
    if (!src) throw new Error(`wander gen-assets: stamp ${st.key} cell ${cell} has no grow art`);
    blit(rgba, W, dx * TILE, dy * TILE, await readCell(src));
  }
  const path = `assets/stamp-${st.key}.png`;
  writeFileSync(join(HERE, path), encodePNG(rgba, W, H));
  const ref = shared(path);
  images[ref] = { psm: 2 };
  stamps.push({ base: st.base, w: W, h: H, path: ref });
}

// 64 px biome fills.
const fills: string[] = [];
for (let b = 0; b < 4; b++) {
  const cell = await readCell(GROW_TERRAIN[b]!.fill);
  const rgba = new Uint8Array(64 * 64 * 4);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) blit(rgba, 64, x * TILE, y * TILE, cell);
  const path = `assets/fill64-${b}.png`;
  writeFileSync(join(HERE, path), encodePNG(rgba, 64, 64));
  const ref = shared(path);
  images[ref] = { psm: 2 };
  fills.push(ref);
}

// --- Character look pool: CLUT8 TILESET cooking ----------------------------
//
// The 768 look frames used to ship as 768 PSM_4444 IMG entries (~399 KB of
// pak). Each base now cooks to ONE TILESET entry: 48 tiles (4 palettes x 12
// frames) sharing one palette, with PackBits-RLE index streams, streamed on
// demand through the view's TileTextureCache (only visible villagers' frames
// are texture-resident). The frames come from look-assets.ts' pure
// lookFrameRGBA — the same function the look-pool tests call in memory — so
// no per-frame PNGs are written or committed.
//
// Pixel parity with the old PSM_4444 path: palette words are quantized to 4
// bits per channel exactly like encodeImageEntry's PSM_4444 path (c >> 4,
// GE-expanded n*17), so a CLUT8-rendered villager is byte-identical to a
// PSM_4444-rendered one (pinned by tests/wander-render.test.ts's goldens).

interface LookManifest {
  id: number; base: number; palette: number; name: string;
  tileset: string;
  frames: Record<(typeof POSES)[number], number[]>;
  thumb: number;
}
const lookManifests: LookManifest[] = [];
const lookTilesets: { key: string; file: string }[] = [];
mkdirSync(join(HERE, "assets", "look", "tilesets"), { recursive: true });
for (let b = 0; b < LOOK_BASES.length; b++) {
  const base = LOOK_BASES[b]!;
  const bb = String(b).padStart(2, "0");
  const tileWords = lookTileWords(b);
  for (let p = 0; p < LOOK_PALETTE_COUNT; p++) {
    const id = b * LOOK_PALETTE_COUNT + p;
    const frames: Record<string, number[]> = { idle: [], walkL: [], walkR: [] };
    for (const pose of POSES) for (let f = 0; f < 4; f++) frames[pose]!.push(p * 12 + LOOK_POSE_BASE[pose] + f);
    lookManifests.push({
      id, base: b, palette: p, name: base.name,
      tileset: keyTileset(`wander-look-b${bb}`),
      frames, thumb: p * 12,
    });
  }
  const { palette, indexByWord } = lookPalette(tileWords);
  const tiles = tileWords.map((words) => ({
    kind: "pixels" as const,
    indices: Uint8Array.from(words, (w) => indexByWord.get(w)!),
  }));
  const blob = encodeTilesetEntry({ tileW: TILE, tileH: TILE, cols: LOOK_TILES_PER_BASE, rows: 1, flags: TILESET_FLAG_RLE, palette, tiles });
  const file = `assets/look/tilesets/b${bb}.pkts`;
  writeFileSync(join(HERE, file), blob);
  lookTilesets.push({ key: keyTileset(`wander-look-b${bb}`), file });
}
const lookFrames = LOOK_BASES.length * LOOK_PALETTE_COUNT * 12;

const q = (s: string) => JSON.stringify(s);
const dense = (name: string, doc: string, rec: Record<number, string>): string => {
  const keys = Object.keys(rec).map(Number).sort((a, b) => a - b);
  const rows: string[] = [];
  for (let i = 0; i <= keys[keys.length - 1]!; i++) rows.push(rec[i] ? q(rebase(rec[i]!)) : "null");
  const lines: string[] = [];
  for (let i = 0; i < rows.length; i += 4) lines.push(`  ${rows.slice(i, i + 4).join(", ")},`);
  return `/** ${doc} */\nexport const ${name}: readonly (string | null)[] = [\n${lines.join("\n")}\n];\n`;
};

const kinds = ["fill", "transition", "blend", "fringe"] as const;
let out = `// AUTO-GENERATED by examples/wander/gen-assets.ts — grow's committed art,
// referenced in place ("../../vendor/pocket-rpgkit/examples/grow/assets/..." resolves against an importing
// example's directory at build time), plus shared whole-stamp and 64 px fill
// composites under "../wander/assets/...". Full literals let tools/build.ts
// bake them without copying art into each importing example.

/** [biome][seam kind]: fill, transition, blend, fringe (16 px). */
export const WANDER_TERRAIN: readonly (readonly string[])[] = [
${[0, 1, 2, 3].map((b) => `  [${kinds.map((k) => q(rebase(GROW_TERRAIN[b]![k]))).join(", ")}],`).join("\n")}
];

/** 256 px biome fill blocks (16 x 16 tiles). */
export const WANDER_BLOCK: readonly string[] = [
${[0, 1, 2, 3].map((b) => `  ${q(rebase(GROW_TERRAIN_BLOCK[b]!))},`).join("\n")}
];

/** 64 px biome fills (4 x 4 tiles). */
export const WANDER_FILL64: readonly string[] = [
${fills.map((p) => `  ${q(p)},`).join("\n")}
];

`;
out += dense("WANDER_GROUND", "Developed ground cells by GROW_TILE id (16 px).", GROW_GROUND) + "\n";
out += dense("WANDER_UPPER", "Upper cells (props, houses, Ninja stamps) by cell id (16 px).", GROW_UPPER) + "\n";
out += `/** Whole multi-cell stamps: [base cell id, image width px, image height px,
 *  image] (power-of-two images; houses are padded transparent). */
export const WANDER_STAMPS: readonly (readonly [number, number, number, string])[] = [
${stamps.map((s) => `  [${s.base}, ${s.w}, ${s.h}, ${q(s.path)}],`).join("\n")}
];

export const WANDER_VILLAGER = ${q(rebase(GROW_NPC.villager!))};

// Player walker frames (Sharm "Tiny 16"), facing order 0 down, 1 left,
// 2 up, 3 right. Kept as an alternate player look; the default player look
// comes from the WANDER_LOOKS pool (see WanderView).
export const WANDER_PLAYER = {
  idle: [${GROW_PLAYER.idle.map((p) => q(rebase(p))).join(", ")}],
  walkL: [${GROW_PLAYER.walkL.map((p) => q(rebase(p))).join(", ")}],
  walkR: [${GROW_PLAYER.walkR.map((p) => q(rebase(p))).join(", ")}],
} as const;

// The character look pool: ${LOOK_BASES.length} Ninja Adventure walkers x
// ${LOOK_PALETTE_COUNT} palettes = ${lookManifests.length} looks, indexed by
// the stable id base*${LOOK_PALETTE_COUNT}+palette (see examples/wander/looks.ts).
// Each look's twelve frames are tile indices into its base's CLUT8 TILESET
// (tile = palette*12 + pose*4 + facing); the pak ships one TILESET per base,
// streamed on demand (see examples/wander/gen-assets.ts).
export const WANDER_LOOK_BASES = [
${LOOK_BASES.map((b, i) => `  ${q(b.name)}, // ${i}`).join("\n")}
] as const;

export const WANDER_LOOK_PALETTES = [
${LOOK_PALETTES.map(([n], i) => `  ${q(n)}, // ${i}`).join("\n")}
] as const;

export interface WanderLook {
  /** Stable published id: base * ${LOOK_PALETTE_COUNT} + palette. Never reorder. */
  id: number;
  base: number;
  palette: number;
  name: string;
  /** TILESET pak key holding this base's 48 frames (ui:tile.wander-look-b<NN>). */
  tileset: string;
  /** Tile index per pose and facing (0 down, 1 left, 2 up, 3 right):
   *  palette*12 + pose*4 + facing. */
  frames: {
    idle: readonly [number, number, number, number];
    walkL: readonly [number, number, number, number];
    walkR: readonly [number, number, number, number];
  };
  /** Tile index of the down-facing idle frame, for the create-character scene and ROSTER. */
  thumb: number;
}

export const WANDER_LOOKS: readonly WanderLook[] = [
${lookManifests.map((l) => `  { id: ${l.id}, base: ${l.base}, palette: ${l.palette}, name: ${q(l.name)}, tileset: ${q(l.tileset)}, frames: { idle: [${l.frames.idle!.join(", ")}], walkL: [${l.frames.walkL!.join(", ")}], walkR: [${l.frames.walkR!.join(", ")}] }, thumb: ${l.thumb} },`).join("\n")}
];
`;
writeFileSync(join(HERE, "assets-wander.ts"), out);
writeFileSync(join(HERE, "images.json"), JSON.stringify(images, null, 2) + "\n");
writeFileSync(join(HERE, "pak.json"), JSON.stringify(lookTilesets, null, 2) + "\n");
console.log(`wander gen-assets: ${stamps.length} stamps, ${fills.length} fills, ${lookFrames} look frames cooked into ${lookTilesets.length} tilesets (${LOOK_BASES.length} bases x ${LOOK_PALETTE_COUNT} palettes), ${Object.keys(images).length} image marks`);
