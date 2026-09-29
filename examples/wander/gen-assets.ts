// examples/wander/gen-assets.ts — point the endless world at grow's art.
//
//   bun examples/wander/gen-assets.ts   (or `bun run gen-assets` for all)
//
// The wander example draws grow's committed PNGs (examples/grow/gen-assets.ts
// writes them). The build resolves an image literal relative to the entry's
// directory, so "../grow/assets/<file>.png" packs grow's own file under that
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
//                            instead of twelve
//   assets/fill64-<b>.png    4 x 4 tiles of a biome fill, so a mixed 16 x 16
//                            fill block costs one node per uniform 4 x 4
//                            patch instead of one per cell
//
// Outputs (deterministic; rerunning reproduces them byte for byte):
//   assets/stamp-*.png, assets/fill64-*.png
//   assets-wander.ts  the manifest WanderView reads (full literals)
//   images.json       PSM_4444 marks (grow's, re-keyed, plus the composites)

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodePng } from "../../vendor/pocketjs/framework/compiler/pak.ts";
import { encodePNG } from "../../vendor/pocketjs/tests/png.ts";
import { GROW_GROUND, GROW_NPC, GROW_PLAYER, GROW_TERRAIN, GROW_TERRAIN_BLOCK, GROW_UPPER } from "../grow/assets-grow.ts";
import { STAMP_LIST } from "../grow/grow-stamps.ts";

const HERE = new URL(".", import.meta.url).pathname;
const GROW = join(HERE, "../grow");
const ASSETS = join(HERE, "assets");
mkdirSync(ASSETS, { recursive: true });
const GROW_IMAGES = JSON.parse(await Bun.file(join(GROW, "images.json")).text()) as Record<string, { psm?: number }>;
const TILE = 16;

const rebase = (path: string): string => {
  if (!path.startsWith("assets/")) throw new Error(`wander gen-assets: unexpected grow asset path ${path}`);
  return `../grow/${path}`;
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
  images[path] = { psm: 2 };
  stamps.push({ base: st.base, w: W, h: H, path });
}

// 64 px biome fills.
const fills: string[] = [];
for (let b = 0; b < 4; b++) {
  const cell = await readCell(GROW_TERRAIN[b]!.fill);
  const rgba = new Uint8Array(64 * 64 * 4);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) blit(rgba, 64, x * TILE, y * TILE, cell);
  const path = `assets/fill64-${b}.png`;
  writeFileSync(join(HERE, path), encodePNG(rgba, 64, 64));
  images[path] = { psm: 2 };
  fills.push(path);
}

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
// referenced in place ("../grow/assets/..." resolves against this example's
// directory at build time), plus whole-stamp and 64 px fill composites of
// it. Full literals let tools/build.ts bake them.

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
// 2 up, 3 right.
export const WANDER_PLAYER = {
  idle: [${GROW_PLAYER.idle.map((p) => q(rebase(p))).join(", ")}],
  walkL: [${GROW_PLAYER.walkL.map((p) => q(rebase(p))).join(", ")}],
  walkR: [${GROW_PLAYER.walkR.map((p) => q(rebase(p))).join(", ")}],
} as const;
`;
writeFileSync(join(HERE, "assets-wander.ts"), out);
writeFileSync(join(HERE, "images.json"), JSON.stringify(images, null, 2) + "\n");
console.log(`wander gen-assets: ${stamps.length} stamps, ${fills.length} fills, ${Object.keys(images).length} image marks`);
