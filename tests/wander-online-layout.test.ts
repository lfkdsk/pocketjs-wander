// tests/wander-online-layout.test.ts — the overlay geometry the online view
// draws, asserted from the same layout functions the view uses: every
// overlay stays inside the viewport, the persistent HUD pieces never
// overlap each other, and the creation scene's two panels fit side by side
// at both 480x272 and 960x544.
import { describe, expect, test } from "bun:test";
import {
  DIALOG_ROWS,
  DIALOG_ROW_H,
  contains,
  createEditBox,
  createLayout,
  createNameGrid,
  createTitleRect,
  dialogRect,
  errandBarRect,
  gateRect,
  helpRect,
  intersects,
  linkGateRect,
  linkHintRect,
  linkPadCell,
  logBarRect,
  menuRect,
  noticeRect,
  statusPlate,
  type HudRect,
} from "../examples/wander-online/hud.ts";

const SIZES: [number, number][] = [
  [480, 272],
  [960, 544],
];

describe("wander-online layout: world overlays", () => {
  for (const [w, h] of SIZES) {
    const screen: HudRect = { x0: 0, y0: 0, x1: w, y1: h };
    test(`${w}x${h}: every overlay stays inside the viewport`, () => {
      for (const debug of [false, true]) {
        expect(contains(screen, statusPlate(w, h, debug)), "status plate").toBe(true);
        expect(contains(screen, noticeRect(w, h, debug)), "notice band").toBe(true);
      }
      expect(contains(screen, helpRect(w, h)), "help strip").toBe(true);
      expect(contains(screen, logBarRect(w, h)), "log bar").toBe(true);
      expect(contains(screen, errandBarRect(w, h)), "errand bar").toBe(true);
      expect(contains(screen, dialogRect(w, h)), "dialog panel").toBe(true);
      expect(contains(screen, menuRect(w, h)), "menu box").toBe(true);
      expect(contains(screen, gateRect(w, h)), "gate panel").toBe(true);
      const linkGate = linkGateRect(w, h);
      expect(contains(screen, linkGate), "desktop link gate").toBe(true);
      expect(contains(linkGate, linkHintRect(linkGate)), "desktop link hint").toBe(true);
      for (let i = 0; i < 12; i++) {
        expect(contains(linkGate, linkPadCell(linkGate, i)), `link keypad cell ${i}`).toBe(true);
      }
    });

    test(`${w}x${h}: the persistent HUD pieces never overlap`, () => {
      for (const debug of [false, true]) {
        const plate = statusPlate(w, h, debug);
        expect(intersects(plate, helpRect(w, h)), "plate vs help").toBe(false);
        expect(intersects(plate, logBarRect(w, h)), "plate vs log bar").toBe(false);
        expect(intersects(plate, errandBarRect(w, h)), "plate vs errand bar").toBe(false);
        expect(intersects(noticeRect(w, h, debug), logBarRect(w, h)), "notice vs log bar").toBe(false);
        // The notice band sits directly below the plate; the menu must not
        // reach either (it is centred, the band is at the top).
        expect(intersects(menuRect(w, h), noticeRect(w, h, debug)), "menu vs notice").toBe(false);
        expect(intersects(menuRect(w, h), plate), "menu vs plate").toBe(false);
        expect(intersects(menuRect(w, h), helpRect(w, h)), "menu vs help").toBe(false);
        expect(intersects(menuRect(w, h), logBarRect(w, h)), "menu vs log bar").toBe(false);
        expect(intersects(menuRect(w, h), errandBarRect(w, h)), "menu vs errand bar").toBe(false);
      }
    });

    test(`${w}x${h}: the bottom bars stack above the help strip without touching`, () => {
      const log = logBarRect(w, h);
      const errand = errandBarRect(w, h);
      const help = helpRect(w, h);
      expect(intersects(log, errand), "log vs errand").toBe(false);
      expect(intersects(errand, help), "errand vs help").toBe(false);
      expect(intersects(log, help), "log vs help").toBe(false);
      expect(log.y1).toBeLessThanOrEqual(errand.y0);
      expect(errand.y1).toBeLessThanOrEqual(help.y0);
      // Each bar is one 12 px text row with 2 px of padding above and below.
      expect(log.y1 - log.y0).toBe(16);
      expect(errand.y1 - errand.y0).toBe(16);
      // The bars span the viewport width like the single-player field's.
      expect(log.x0).toBe(6);
      expect(log.x1).toBe(w - 6);
    });

    test(`${w}x${h}: the dialog panel holds four 12 px rows and a legend, clear of the plate and notice`, () => {
      const box = dialogRect(w, h);
      expect(box.y1 - box.y0).toBeGreaterThanOrEqual(6 + DIALOG_ROWS * DIALOG_ROW_H + 14);
      for (const debug of [false, true]) {
        expect(intersects(box, statusPlate(w, h, debug)), "dialog vs plate").toBe(false);
        expect(intersects(box, noticeRect(w, h, debug)), "dialog vs notice").toBe(false);
      }
      // It replaces the bottom bars (the view hides them while it is open):
      // docked to the same bottom edge, spanning the same width.
      expect(box.y1).toBe(helpRect(w, h).y1);
      expect(box.x0).toBe(logBarRect(w, h).x0);
      expect(box.x1).toBe(logBarRect(w, h).x1);
    });

    test(`${w}x${h}: the population plate reserves the worst-case name line width`, () => {
      const plate = statusPlate(w, h, false);
      expect(plate.x1 - plate.x0).toBe(360);
      // OnlineView starts text at x=12 and ends its explicit box 6 px before
      // the plate's right edge: 348 px at both acceptance resolutions.
      expect(plate.x1 - 18).toBe(348);
    });
  }

  test("the debug plate is taller than the normal plate and the notice band follows it", () => {
    for (const [w, h] of SIZES) {
      const normal = statusPlate(w, h, false);
      const debug = statusPlate(w, h, true);
      expect(debug.y1 - debug.y0).toBeGreaterThan(normal.y1 - normal.y0);
      expect(debug.y1).toBeGreaterThan(normal.y1);
      expect(noticeRect(w, h, true).y0).toBeGreaterThan(noticeRect(w, h, false).y0);
    }
  });
});

describe("wander-online layout: creation scene", () => {
  for (const [w, h] of SIZES) {
    const screen: HudRect = { x0: 0, y0: 0, x1: w, y1: h };
    test(`${w}x${h}: the name and preview panels fit side by side, in bounds`, () => {
      const l = createLayout(w, h);
      expect(contains(screen, l.namePanel), "name panel").toBe(true);
      expect(contains(screen, l.previewPanel), "preview panel").toBe(true);
      expect(intersects(l.namePanel, l.previewPanel), "panels disjoint").toBe(false);
      expect(contains(l.previewPanel, l.previewBox), "preview box in panel").toBe(true);
      expect(contains(l.previewPanel, l.counterRect), "counter in panel").toBe(true);
      expect(contains(l.previewPanel, l.baseNameRect), "base name in panel").toBe(true);
      expect(contains(l.previewPanel, l.hintRect), "hint in panel").toBe(true);
      // The preview box is square and large (>= 64 px).
      expect(l.previewBox.x1 - l.previewBox.x0).toBe(l.previewBox.y1 - l.previewBox.y0);
      expect(l.previewBox.x1 - l.previewBox.x0).toBeGreaterThanOrEqual(64);
    });

    test(`${w}x${h}: the charset grid fits inside the name panel`, () => {
      const l = createLayout(w, h);
      const g = createNameGrid(l);
      const grid: HudRect = {
        x0: g.x,
        y0: g.y,
        x1: g.x + g.cols * g.cellW,
        y1: g.y + g.rows * g.cellH,
      };
      expect(contains(l.namePanel, grid), "grid in panel").toBe(true);
      expect(contains(l.namePanel, createEditBox(l)), "edit box in panel").toBe(true);
      expect(contains(l.namePanel, createTitleRect(l)), "title in panel").toBe(true);
      // The grid does not collide with the edit box above it.
      expect(intersects(grid, createEditBox(l))).toBe(false);
    });
  }

  test("the scale doubles at 960x544", () => {
    expect(createLayout(480, 272).s).toBe(1);
    expect(createLayout(960, 544).s).toBe(2);
  });
});
