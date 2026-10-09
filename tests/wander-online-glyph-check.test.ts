// tests/wander-online-glyph-check.test.ts — the shared glyph-cell verdict
// used by the browser check: the renderer's replacement rectangle (a 7x8
// hollow ring at the left of a 12 px cell, rows 4..11) is "box", ink of any
// other shape is "glyph", nothing is "blank"; at 1x, 3x and a fractional
// capture scale.
import { describe, expect, test } from "bun:test";
import { glyphCellVerdict, NAME_FONT_PX, TOFU_H, TOFU_TOP, TOFU_W } from "../examples/wander-online/glyph-check.ts";

/** A dark buffer of `w`x`h` logical pixels drawn at `scale`, with `ink`
 *  returning whether logical (lx, ly) is lit. */
function paint(w: number, h: number, scale: number, ink: (lx: number, ly: number) => boolean): { rgba: Uint8Array; stride: number } {
  const W = Math.ceil(w * scale);
  const H = Math.ceil(h * scale);
  const rgba = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const lit = ink(Math.floor(x / scale), Math.floor(y / scale));
      rgba[i] = lit ? 0x9f : 0x0b;
      rgba[i + 1] = lit ? 0xd0 : 0x16;
      rgba[i + 2] = lit ? 0xff : 0x26;
      rgba[i + 3] = 255;
    }
  }
  return { rgba, stride: W };
}

const tofu = (lx: number, ly: number): boolean =>
  lx < TOFU_W && ly >= TOFU_TOP && ly < TOFU_TOP + TOFU_H &&
  (lx === 0 || lx === TOFU_W - 1 || ly === TOFU_TOP || ly === TOFU_TOP + TOFU_H - 1);
/** A Han-like glyph: strokes across the whole cell, including the ring's inside. */
const han = (lx: number, ly: number): boolean => ly === 2 || ly === 6 || ly === 10 || lx === 5;
/** A thin Latin "l": a vertical bar inside the ring's area. */
const latinL = (lx: number, ly: number): boolean => lx === 3 && ly >= 1 && ly < 12;

describe("wander-online glyph cell verdict", () => {
  for (const scale of [1, 3, 1.5, 2.25]) {
    test(`at ${scale}x: the replacement ring is a box, strokes are glyphs, an empty cell is blank`, () => {
      const cells = 4;
      const buf = paint(NAME_FONT_PX * cells, NAME_FONT_PX + 4, scale, (lx, ly) => {
        const cell = Math.floor(lx / NAME_FONT_PX);
        const cx = lx % NAME_FONT_PX;
        if (cell === 0) return tofu(cx, ly);
        if (cell === 1) return han(cx, ly);
        if (cell === 2) return latinL(cx, ly);
        return false;
      });
      const verdict = (cell: number) => glyphCellVerdict(buf.rgba, buf.stride, cell * NAME_FONT_PX * scale, 0, scale);
      expect(verdict(0).verdict).toBe("box");
      expect(verdict(0).ring).toBe(26);
      expect(verdict(0).inside).toBe(0);
      expect(verdict(1).verdict).toBe("glyph");
      expect(verdict(2).verdict).toBe("glyph");
      expect(verdict(3).verdict).toBe("blank");
    });
  }

  test("a ring with ink inside it is a glyph, and a ring missing a few perimeter pixels is still a box", () => {
    const buf = paint(NAME_FONT_PX * 2, NAME_FONT_PX, 1, (lx, ly) => {
      const cell = Math.floor(lx / NAME_FONT_PX);
      const cx = lx % NAME_FONT_PX;
      if (cell === 0) return tofu(cx, ly) || (cx === 3 && ly === 7);
      return tofu(cx, ly) && !(cx === 2 && ly === TOFU_TOP) && !(cx === 0 && ly === 8);
    });
    expect(glyphCellVerdict(buf.rgba, buf.stride, 0, 0, 1).verdict).toBe("glyph");
    expect(glyphCellVerdict(buf.rgba, buf.stride, NAME_FONT_PX, 0, 1).verdict).toBe("box");
  });
});
