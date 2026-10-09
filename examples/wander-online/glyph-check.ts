// examples/wander-online/glyph-check.ts — tell a drawn glyph from what the
// text renderer leaves for a code point the font slot does not contain, by
// looking at one 12 px cell of a framebuffer or a browser capture.
//
// A cmap miss resolves to glyph 0, which the font baker draws as a 1 px
// hollow rectangle 7 wide and 8 tall, flush left in the cell and resting
// one row above the baseline (cell columns 0..6, rows 4..11), with the full
// 12 px advance; nothing else is inked in the cell. A real glyph (Latin or
// Han) inks pixels inside that rectangle's area and, for Han, past its
// right edge. Shared by the browser check (web-check.ts) so the demo's
// Chrome screenshot is judged by the same shape the framebuffer tests use.

/** The name font's cell size (the 12 px slot that bakes the name charset). */
export const NAME_FONT_PX = 12;

/** The replacement rectangle's size and place inside a cell. */
export const TOFU_W = 7;
export const TOFU_H = 8;
export const TOFU_TOP = 4;

export type GlyphVerdict = "glyph" | "box" | "blank";

/** Bright pixel test used for text ink on the dark HUD plate. */
function isInk(rgba: Uint8Array, stride: number, x: number, y: number): boolean {
  const i = (y * stride + x) * 4;
  return rgba[i]! + rgba[i + 1]! + rgba[i + 2]! > 330 && rgba[i + 3]! > 127;
}

/** Judge the `NAME_FONT_PX`-px cell whose top-left is (x0, y0) in a buffer
 *  drawn at `scale` (1 for the sim's framebuffer, the canvas's device
 *  pixels per logical pixel for a browser capture; may be fractional).
 *  Each logical pixel is sampled at its centre. `ring` counts how many of
 *  the replacement rectangle's 26 perimeter pixels are ink, `inside` how
 *  many of its 30 interior pixels are; `total` is the whole cell. */
export function glyphCellVerdict(
  rgba: Uint8Array,
  stride: number,
  x0: number,
  y0: number,
  scale = 1,
): { verdict: GlyphVerdict; ring: number; inside: number; total: number } {
  const at = (lx: number, ly: number): boolean =>
    isInk(rgba, stride, Math.floor(x0 + (lx + 0.5) * scale), Math.floor(y0 + (ly + 0.5) * scale));
  let total = 0;
  let ring = 0;
  let inside = 0;
  let outside = 0;
  for (let ly = 0; ly < NAME_FONT_PX; ly++) {
    for (let lx = 0; lx < NAME_FONT_PX; lx++) {
      if (!at(lx, ly)) continue;
      total++;
      const inRect = lx < TOFU_W && ly >= TOFU_TOP && ly < TOFU_TOP + TOFU_H;
      if (!inRect) outside++;
      else if (lx === 0 || lx === TOFU_W - 1 || ly === TOFU_TOP || ly === TOFU_TOP + TOFU_H - 1) ring++;
      else inside++;
    }
  }
  // The replacement shape: (nearly) the whole perimeter, an empty interior
  // and nothing beyond it. Fractional capture scales may lose a perimeter
  // pixel or two, so the ring is "at least 22 of 26".
  const box = ring >= 22 && inside === 0 && outside <= 1;
  const verdict: GlyphVerdict = box ? "box" : total >= 8 ? "glyph" : "blank";
  return { verdict, ring, inside, total };
}
