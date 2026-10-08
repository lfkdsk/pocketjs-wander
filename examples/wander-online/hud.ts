// examples/wander-online/hud.ts — overlay geometry for the online view, in
// screen px. Every overlay OnlineView draws is positioned by a function in
// this file, so the layout tests can assert the same rects the view uses
// (in-bounds, mutually disjoint) instead of hard-coding numbers.

export interface HudRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function intersects(a: HudRect, b: HudRect): boolean {
  return !(a.x1 <= b.x0 || a.x0 >= b.x1 || a.y1 <= b.y0 || a.y0 >= b.y1);
}

export function contains(outer: HudRect, inner: HudRect): boolean {
  return inner.x0 >= outer.x0 && inner.y0 >= outer.y0 && inner.x1 <= outer.x1 && inner.y1 <= outer.y1;
}

/** The top-left status plate. It grows one line (12 px + padding) when the
 *  debug line is shown, so the notice band below it shifts with it. */
export function statusPlate(w: number, _h: number, debug: boolean): HudRect {
  // 360 px keeps a worst-case 12-code-point name plus
  // " · ROOM 32 · ALL 128" inside the 480 px baseline viewport.
  const W = Math.min(360, Math.max(208, w - 12));
  const H = debug ? 56 : 40;
  return { x0: 6, y0: 4, x1: 6 + W, y1: 4 + H };
}

/** The bottom-left controls hint strip. */
export function helpRect(w: number, h: number): HudRect {
  return { x0: 6, y0: h - 20, x1: Math.min(w - 6, 6 + 320), y1: h - 4 };
}

/** The transient notice band, centred just under the status plate. */
export function noticeRect(w: number, h: number, debug: boolean): HudRect {
  const top = statusPlate(w, h, debug).y1;
  return { x0: 0, y0: top + 2, x1: w, y1: top + 24 };
}

/** The SELECT menu box, centred horizontally, and vertically centred unless
 *  that would slide it under the notice band (the debug plate's band is the
 *  taller one, so it clears both). */
export function menuRect(w: number, h: number): HudRect {
  const W = 240;
  const H = 110;
  const x0 = Math.round((w - W) / 2);
  const y0 = Math.max(Math.round((h - H) / 2), noticeRect(w, h, true).y1 + 4);
  return { x0, y0, x1: x0 + W, y1: y0 + H };
}

/** The gate (sign-in / link-code) panel, centred. */
export function gateRect(w: number, h: number): HudRect {
  const W = Math.min(400, w - 16);
  const H = 76;
  const x0 = Math.round((w - W) / 2);
  const y0 = Math.round((h - H) / 2);
  return { x0, y0, x1: x0 + W, y1: y0 + H };
}

/** Desktop's controller-operated link-code keypad needs a taller gate. */
export function linkGateRect(w: number, h: number): HudRect {
  const W = Math.min(300, w - 16);
  const H = Math.min(248, h - 16);
  const x0 = Math.round((w - W) / 2);
  const y0 = Math.round((h - H) / 2);
  return { x0, y0, x1: x0 + W, y1: y0 + H };
}

/** One cell in the 3x4 device-code keypad, in screen coordinates. */
export function linkPadCell(gate: HudRect, index: number): HudRect {
  const gap = 4;
  const cellW = 52;
  const cellH = 30;
  const col = index % 3;
  const row = Math.floor(index / 3);
  const totalW = cellW * 3 + gap * 2;
  const x0 = Math.round((gate.x0 + gate.x1 - totalW) / 2) + col * (cellW + gap);
  const y0 = gate.y0 + 84 + row * (cellH + gap);
  return { x0, y0, x1: x0 + cellW, y1: y0 + cellH };
}

/** The desktop keypad help line, kept inside the gate with enough height for
 *  the 12 px font's full glyph cell at the 480x272 baseline. */
export function linkHintRect(gate: HudRect): HudRect {
  return { x0: gate.x0 + 16, y0: gate.y1 - 24, x1: gate.x1 - 16, y1: gate.y1 - 8 };
}

// -- character creation ------------------------------------------------------

export interface CreateLayout {
  /** Integer scale (1 at 480x272, 2 at 960x544). */
  s: number;
  namePanel: HudRect;
  previewPanel: HudRect;
  /** The walker preview box (square), centred in the preview panel. */
  previewBox: HudRect;
  /** The "n / 64" counter, below the preview box. */
  counterRect: HudRect;
  /** The base-name line, below the counter. */
  baseNameRect: HudRect;
  /** The controls hint, at the bottom of the preview panel. */
  hintRect: HudRect;
}

/**
 * The creation scene: the name-input panel on the left, the look preview on
 * the right. The charset is a 10-column grid (the name-input rules move the
 * cursor by 10 on up/down), the actions its 8th row.
 */
export function createLayout(w: number, h: number): CreateLayout {
  const s = Math.max(1, Math.min(Math.floor(w / 480), Math.floor(h / 272)));
  const u = (n: number): number => n * s;
  // 480-wide design: 8 + 296 + 4 + 164 + 8.
  const namePanel: HudRect = { x0: u(8), y0: u(8), x1: u(8 + 296), y1: u(8 + 256) };
  const previewPanel: HudRect = { x0: u(8 + 296 + 4), y0: u(8), x1: u(8 + 296 + 4 + 164), y1: u(8 + 256) };
  const box = u(64);
  const px0 = Math.round((previewPanel.x0 + previewPanel.x1 - box) / 2);
  const previewBox: HudRect = { x0: px0, y0: previewPanel.y0 + u(28), x1: px0 + box, y1: previewPanel.y0 + u(28) + box };
  const counterRect: HudRect = {
    x0: previewPanel.x0 + u(8),
    y0: previewBox.y1 + u(10),
    x1: previewPanel.x1 - u(8),
    y1: previewBox.y1 + u(10) + u(14),
  };
  const baseNameRect: HudRect = {
    x0: previewPanel.x0 + u(8),
    y0: counterRect.y1 + u(4),
    x1: previewPanel.x1 - u(8),
    y1: counterRect.y1 + u(4) + u(14),
  };
  const hintRect: HudRect = {
    x0: previewPanel.x0 + u(8),
    y0: previewPanel.y1 - u(40),
    x1: previewPanel.x1 - u(8),
    y1: previewPanel.y1 - u(6),
  };
  return { s, namePanel, previewPanel, previewBox, counterRect, baseNameRect, hintRect };
}

/** The name-input panel's inner grid geometry (charset + action row). */
export function createNameGrid(layout: CreateLayout): {
  x: number;
  y: number;
  cols: number;
  cellW: number;
  cellH: number;
  rows: number;
} {
  const pad = 14 * layout.s;
  const x = layout.namePanel.x0 + pad;
  const y = layout.namePanel.y0 + 68 * layout.s;
  const cellW = 27 * layout.s;
  const cellH = 20 * layout.s;
  return { x, y, cols: 10, cellW, cellH, rows: 8 };
}

/** The name-input panel's edit box. */
export function createEditBox(layout: CreateLayout): HudRect {
  const pad = 14 * layout.s;
  const x0 = layout.namePanel.x0 + pad;
  const y0 = layout.namePanel.y0 + 36 * layout.s;
  return { x0, y0, x1: layout.namePanel.x1 - pad, y1: y0 + 24 * layout.s };
}

/** The name-input panel's title line. */
export function createTitleRect(layout: CreateLayout): HudRect {
  const pad = 14 * layout.s;
  const y0 = layout.namePanel.y0 + 14 * layout.s;
  return { x0: layout.namePanel.x0 + pad, y0, x1: layout.namePanel.x1 - pad, y1: y0 + 18 * layout.s };
}
