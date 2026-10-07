// examples/wander/hud.ts — the field HUD's bar geometry, in screen px.
//
// Mirrors the overlay layout in WanderView.tsx (the seed/ring plates and the
// bottom LOG / ERRAND / help strips). A landmark screenshot must keep the
// landmark's whole footprint clear of these bars: the anchor-point band
// check let a 3x3 footprint slide under the LOG bar by a fraction of a px.

export interface HudRect { x0: number; y0: number; x1: number; y1: number }

/** The HUD bars the field draws over the world. The FOUND notice is not a
 *  bar: it is a transient caption the f1-found shot wants on screen together
 *  with the landmark, so it is deliberately not listed. */
export function hudBarRects(w: number, h: number): HudRect[] {
  const plateW = w >= 900 ? 206 : 158;
  return [
    { x0: 6, y0: 4, x1: 6 + plateW, y1: 47 }, // seed plate (top-left)
    { x0: w - 134, y0: 4, x1: w - 6, y1: 102 }, // ring plate (top-right; MM_H 48 + 50)
    { x0: 6, y0: h - 60, x1: w - 6, y1: h - 44 }, // LOG / RUMOR bar
    { x0: 6, y0: h - 40, x1: w - 6, y1: h - 24 }, // ERRAND bar
    { x0: 6, y0: h - 20, x1: 306, y1: h - 4 }, // help strip
  ];
}

/** Whether a screen-px box is disjoint from every HUD bar. */
export function clearOfHud(box: HudRect, w: number, h: number): boolean {
  return hudBarRects(w, h).every((r) => box.x1 <= r.x0 || box.x0 >= r.x1 || box.y1 <= r.y0 || box.y0 >= r.y1);
}

/** A landmark's 3 x 3 tile footprint centred on its centre cell, in screen
 *  px (every kind fills at least a 3 x 3 box; 3 tiles = 48 px). */
export function landmarkBox(centrePxX: number, centrePxY: number): HudRect {
  return { x0: centrePxX - 24, y0: centrePxY - 24, x1: centrePxX + 24, y1: centrePxY + 24 };
}
