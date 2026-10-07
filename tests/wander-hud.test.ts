// tests/wander-hud.test.ts — the landmark/HUD occlusion judgment itself.
//
// The f1-found render test (tests/wander-render.test.ts) gates its capture
// on clearOfHud(landmarkBox(...)), but the frames it happens to catch satisfy
// both the full-footprint check and an anchor-only check, so mutating
// landmarkBox() back to a zero-size point left that render test green. This
// file pins the judgment directly: a landmark whose ANCHOR sits in the clear
// field band but whose 48 x 48 footprint reaches into a HUD bar must be
// judged not visible, from every side (up/down/left/right), at both PSP and
// desktop view sizes. The anchor-only mutation makes every "blocked" case
// below go red.

import { describe, expect, test } from "bun:test";
import { clearOfHud, hudBarRects, landmarkBox, type HudRect } from "../examples/wander/hud.ts";

/** A zero-size box on the anchor: true when the anchor point alone is clear
 *  of every HUD bar (the "anchor in the view band" condition). */
function anchorClear(cx: number, cy: number, w: number, h: number): boolean {
  return clearOfHud({ x0: cx, y0: cy, x1: cx, y1: cy }, w, h);
}

/** Whether two boxes intersect (the footprint is hidden when it does). */
function intersects(a: HudRect, b: HudRect): boolean {
  return !(a.x1 <= b.x0 || a.x0 >= b.x1 || a.y1 <= b.y0 || a.y0 >= b.y1);
}

interface Case {
  tag: string;
  w: number;
  h: number;
  cx: number;
  cy: number;
  visible: boolean;
  /** For blocked cases, which HUD bar the footprint reaches into. */
  bar?: string;
}

const CASES: Case[] = [
  // --- 480 x 272 (PSP) -----------------------------------------------------
  // Anchor clear of every bar, footprint reaches UP into the seed plate.
  { tag: "480 up", w: 480, h: 272, cx: 80, cy: 60, visible: false, bar: "seed plate" },
  // Anchor clear, footprint reaches DOWN into the LOG/RUMOR bar.
  { tag: "480 down", w: 480, h: 272, cx: 240, cy: 200, visible: false, bar: "LOG/RUMOR bar" },
  // Anchor clear (just right of the seed plate), footprint reaches LEFT into
  // the seed plate's right edge.
  { tag: "480 left", w: 480, h: 272, cx: 180, cy: 25, visible: false, bar: "seed plate" },
  // Anchor clear (just left of the ring plate), footprint reaches RIGHT into
  // the ring plate's left edge.
  { tag: "480 right", w: 480, h: 272, cx: 330, cy: 50, visible: false, bar: "ring plate" },
  // Fully visible: dead centre of the field.
  { tag: "480 centre", w: 480, h: 272, cx: 240, cy: 136, visible: true },
  // Fully visible: mid-left field, well inside every bar.
  { tag: "480 mid-left", w: 480, h: 272, cx: 100, cy: 150, visible: true },
  // --- 960 x 544 (2x desktop) ---------------------------------------------
  { tag: "960 up", w: 960, h: 544, cx: 100, cy: 60, visible: false, bar: "seed plate" },
  { tag: "960 down", w: 960, h: 544, cx: 480, cy: 470, visible: false, bar: "LOG/RUMOR bar" },
  { tag: "960 left", w: 960, h: 544, cx: 230, cy: 25, visible: false, bar: "seed plate" },
  { tag: "960 right", w: 960, h: 544, cx: 810, cy: 50, visible: false, bar: "ring plate" },
  { tag: "960 centre", w: 960, h: 544, cx: 480, cy: 272, visible: true },
];

describe("wander HUD: landmark occlusion judgment", () => {
  test("a landmark whose anchor is clear but whose 48x48 footprint reaches a HUD bar is judged hidden (up/down/left/right, both sizes)", () => {
    const blocked = CASES.filter((c) => !c.visible);
    expect(blocked.length).toBe(8); // four sides x two sizes
    for (const c of blocked) {
      // The anchor itself sits in the clear field band...
      expect(anchorClear(c.cx, c.cy, c.w, c.h), `${c.tag}: anchor clear`).toBe(true);
      // ...yet the footprint intersects the named HUD bar...
      const box = landmarkBox(c.cx, c.cy);
      const bars = hudBarRects(c.w, c.h);
      const hit = bars.find((r) => intersects(box, r));
      expect(hit, `${c.tag}: footprint reaches a HUD bar`).toBeDefined();
      // ...so the judgment must say hidden. This is the line the anchor-only
      // mutation flips: with a zero-size box the anchor is clear, so the
      // mutated code returns true here and the case goes red.
      expect(clearOfHud(box, c.w, c.h), `${c.tag}: footprint hidden`).toBe(false);
    }
  });

  test("a landmark whose whole footprint is in the field band is judged visible", () => {
    for (const c of CASES.filter((c) => c.visible)) {
      expect(anchorClear(c.cx, c.cy, c.w, c.h), `${c.tag}: anchor clear`).toBe(true);
      const box = landmarkBox(c.cx, c.cy);
      expect(clearOfHud(box, c.w, c.h), `${c.tag}: footprint visible`).toBe(true);
    }
  });

  test("the footprint is a 48x48 box centred on the anchor", () => {
    // Pins the geometry the blocked cases rely on: 3 tiles = 48 px, centred.
    const box = landmarkBox(100, 100);
    expect(box.x1 - box.x0).toBe(48);
    expect(box.y1 - box.y0).toBe(48);
    expect((box.x0 + box.x1) / 2).toBe(100);
    expect((box.y0 + box.y1) / 2).toBe(100);
  });
});
