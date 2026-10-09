// tests/wander-online-cjk-font.test.ts — a display name renders as glyphs
// on every host: the name charset (shared/name-charset.ts), the committed
// Noto Sans CJK SC subset and fonts.json agree with each other and with the
// 12 px atlas the build bakes into the online pak, and every accepted name
// fits its HUD line and name tag.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FONT_CMAP_ENTRY_SIZE, FONT_HEADER_SIZE, FONT_MAGIC } from "../vendor/pocket-rpgkit/vendor/pocketjs/contracts/spec/spec.ts";
import { unpack } from "../vendor/pocket-rpgkit/vendor/pocketjs/framework/compiler/pak.ts";
import { NAME_MAX, validateName } from "../examples/wander-online/shared/auth.ts";
import { decodeHanDeltas, encodeHanDeltas, hanLevel1, hanLevel1Text, nameCodePointAllowed } from "../examples/wander-online/shared/name-charset.ts";
import { HAN_LEVEL1_DELTAS } from "../examples/wander-online/shared/han-level1.generated.ts";
import { NAME_LABEL_W, statusPlate } from "../examples/wander-online/hud.ts";
import { checkAssets, gb2312Level1, HAN_LEVEL1_EXPECTED, NAME_FONT_PX, subsetCoverage } from "../tools/wander-online-cjk-font.ts";

const PAK = join(import.meta.dir, "..", "dist", "wander-online.pak");

interface Atlas {
  slot: number;
  cellW: number;
  cellH: number;
  /** codepoint -> logical advance */
  advance: Map<number, number>;
}

function readAtlas(slot: number): Atlas {
  const blob = unpack(new Uint8Array(readFileSync(PAK))).find((b) => b.key === `ui:font.${slot}`);
  if (!blob) throw new Error(`pak has no ui:font.${slot}`);
  const bytes = blob.data;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(dv.getUint32(0, true)).toBe(FONT_MAGIC);
  const glyphCount = dv.getUint16(6, true);
  const advance = new Map<number, number>();
  for (let i = 0; i < glyphCount; i++) {
    const o = FONT_HEADER_SIZE + i * FONT_CMAP_ENTRY_SIZE;
    const cp = dv.getUint32(o, true);
    const gid = dv.getUint16(o + 4, true);
    if (gid > 0) advance.set(cp, bytes[o + 6]!);
  }
  return { slot, cellW: bytes[8]!, cellH: bytes[9]!, advance };
}

describe("wander-online name charset", () => {
  test("is GB 2312 level 1 plus ASCII letters, digits and four separators", () => {
    const want = gb2312Level1();
    expect(want).toHaveLength(HAN_LEVEL1_EXPECTED);
    expect([...hanLevel1()].sort((a, b) => a - b)).toEqual(want);
    expect(decodeHanDeltas(HAN_LEVEL1_DELTAS)).toEqual(want);
    expect(encodeHanDeltas(want)).toBe(HAN_LEVEL1_DELTAS);
    expect(/^[0-9A-Za-z+-]+$/.test(HAN_LEVEL1_DELTAS), "the table is plain ASCII, so it never enters the font scan").toBe(true);
    expect(hanLevel1Text()).toBe(String.fromCodePoint(...want));
    const ascii = [...Array(128).keys()].filter(nameCodePointAllowed).map((cp) => String.fromCodePoint(cp)).join("");
    expect(ascii).toBe(" -.0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz");
    // Nothing between ASCII and the Han block, nothing above it.
    for (let cp = 128; cp < 0x4e00; cp += 97) expect(nameCodePointAllowed(cp)).toBe(false);
    expect(nameCodePointAllowed(0x9fa6)).toBe(false);
    expect(nameCodePointAllowed(0x20bb7)).toBe(false);
  });

  test("the committed font assets are consistent (tool --check)", () => {
    expect(checkAssets()).toEqual([]);
    const covered = subsetCoverage();
    for (const cp of hanLevel1()) expect(covered.has(cp)).toBe(true);
  });
});

describe("wander-online name font in the built pak", () => {
  const built = existsSync(PAK);
  const maybe = built ? test : test.skip;

  maybe("the 12 px slot bakes a glyph for every character a name may contain, and only that slot", () => {
    const atlas = readAtlas(0);
    expect(atlas.cellW).toBe(NAME_FONT_PX);
    let han = 0;
    for (const cp of hanLevel1()) {
      expect(atlas.advance.has(cp), `U+${cp.toString(16)} is baked`).toBe(true);
      // A CJK glyph is a full em: the cell width.
      expect(atlas.advance.get(cp)).toBe(NAME_FONT_PX);
      han++;
    }
    expect(han).toBe(HAN_LEVEL1_EXPECTED);
    for (let cp = 32; cp < 127; cp++) expect(atlas.advance.has(cp)).toBe(true);
    // What the validator refuses is not baked either: refusing it is what
    // keeps every accepted name out of the replacement box.
    for (const ch of "カ한Ωé龘國") expect(atlas.advance.has(ch.codePointAt(0)!)).toBe(false);
    expect(validateName("カ")).toBe("name-charset");
    // The fallback is restricted to the name slot; the other slots stay
    // ASCII-sized (mutation: a plain string fallback bakes CJK everywhere).
    for (const slot of [1, 2, 19]) expect(readAtlas(slot).advance.size).toBeLessThan(200);
  });

  maybe("every accepted name fits the name tag and the status plate at 480x272", () => {
    const atlas = readAtlas(0);
    const widest = Math.max(...[...atlas.advance.entries()].filter(([cp]) => nameCodePointAllowed(cp)).map(([, adv]) => adv));
    expect(widest).toBe(NAME_FONT_PX);
    expect(NAME_MAX * widest).toBeLessThanOrEqual(NAME_LABEL_W - 8);
    const measure = (text: string): number => [...text].reduce((w, ch) => w + (atlas.advance.get(ch.codePointAt(0)!) ?? atlas.cellW), 0);
    const plate = statusPlate(480, 272, false);
    const worstName = "一".repeat(NAME_MAX);
    expect(validateName(worstName)).toBeNull();
    expect(measure(`${worstName} · ROOM 32 · ALL 128`)).toBeLessThanOrEqual(plate.x1 - 18);
    expect(12 + measure(`X -99999  Y -99999  AUTO  FIRST ${worstName}`)).toBeLessThanOrEqual(480);
  });
});
