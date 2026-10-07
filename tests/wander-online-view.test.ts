// tests/wander-online-view.test.ts — the online view on the deterministic
// sim host: the world renders real terrain (not a monochrome grid), the
// viewport fills the window at 480x272 and 960x544, the creation preview
// changes with the selected look, the HUD hides debug by default, and a
// tap on the charset grid types.
import { describe, expect, test } from "bun:test";
import { bootWorld, treeHasText } from "../vendor/pocketjs/hosts/sim/sim.ts";
import { __packTouch } from "../vendor/pocketjs/framework/src/touch.ts";
import { appBundle, appPreflight } from "./helpers/boot.ts";
import { fakeOnlineSocketFactory } from "./lib/fake-online-socket.ts";
import { BTN } from "@pocketjs/framework/input";
import { lookFrameRGBA } from "../examples/wander/look-assets.ts";
import { createLayout, createNameGrid } from "../examples/wander-online/hud.ts";
import type { OnlinePublished } from "../examples/wander-online/OnlineView.tsx";

const preflight = appPreflight("wander-online");
if (!preflight.ok) console.warn(`wander-online view tests skipped: ${preflight.reason}`);
const simDescribe = preflight.ok ? describe : describe.skip;

interface World {
  frame: (b: number, a?: number, t?: readonly number[]) => void;
  tick: () => void;
  render: () => Uint8Array;
  getTree: () => unknown;
  ticksPerFrame: number;
}

async function boot(
  auth: unknown,
  socketFactory: (url: string) => unknown,
  width = 480,
  height = 272,
): Promise<World> {
  return (await bootWorld(
    appBundle("wander-online"),
    60,
    {
      __onlineUrl: "ws://fake/ws",
      __onlineAuth: auth,
      __onlineSocketFactory: socketFactory,
    },
    undefined,
    { width, height },
  )) as unknown as World;
}

function pump(w: World, frames: number, mask = 0, touches?: readonly number[]): void {
  for (let f = 0; f < frames; f++) {
    w.frame(mask, undefined, touches);
    for (let t = 0; t < w.ticksPerFrame; t++) w.tick();
  }
}

const state = (): OnlinePublished | undefined =>
  (globalThis as { __onlineState?: OnlinePublished }).__onlineState;

const waitFor = async (w: World, pred: () => boolean, what: string, timeoutMs = 8000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    pump(w, 1);
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timeout waiting for ${what}`);
};

function press(w: World, btn: number): void {
  pump(w, 1, btn);
  pump(w, 1, 0);
}

function count(fb: Uint8Array, stride: number, pred: (r: number, g: number, b: number) => boolean, x0: number, x1: number, y0: number, y1: number): number {
  let n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = (y * stride + x) * 4;
    if (pred(fb[i]!, fb[i + 1]!, fb[i + 2]!)) n++;
  }
  return n;
}

const black = (r: number, g: number, b: number) => r === 0 && g === 0 && b === 0;

/** The opaque PSM_4444-quantized colors of a look's every frame (any pose,
 *  any facing): the player sprite must show some of them. */
function playerColors(look: number): Set<string> {
  const base = Math.floor(look / 4);
  const palette = look % 4;
  const colors = new Set<string>();
  for (const pose of ["idle", "walkL", "walkR"] as const) {
    for (const facing of ["d", "l", "u", "r"] as const) {
      const rgba = lookFrameRGBA(base, palette, pose, facing);
      for (let i = 0; i < rgba.length; i += 4) {
        if (rgba[i + 3]! < 128) continue;
        const q = (c: number) => (c >> 4) * 17;
        colors.add(`${q(rgba[i]!)},${q(rgba[i + 1]!)},${q(rgba[i + 2]!)}`);
      }
    }
  }
  return colors;
}

const welcome = () => fakeOnlineSocketFactory({ mode: "welcome", name: "Octo", look: 3, ticket: "t1" });
const needCreate = () => fakeOnlineSocketFactory({ mode: "needCreate", login: "octo", ticket: "t1" });

simDescribe("wander-online view: the world on screen", () => {
  for (const [W, H] of [[480, 272], [960, 544]] as const) {
    test(`${W}x${H}: real terrain (not monochrome), fills the window, player visible`, async () => {
      const w = await boot({ kind: "ticket", ticket: "t1" }, welcome(), W, H);
      pump(w, 5);
      await waitFor(w, () => state()?.status === "joined", "joined");
      pump(w, 30);
      const fb = w.render();
      // The field is real terrain: many distinct colors, not a flat grid.
      const seen = new Set<string>();
      for (let i = 0; i < fb.length; i += 4) {
        if (fb[i + 3]! < 128) continue;
        seen.add(`${fb[i]! >> 4},${fb[i + 1]! >> 4},${fb[i + 2]! >> 4}`);
      }
      expect(seen.size, "distinct terrain colors").toBeGreaterThan(30);
      // No black gaps: the ring covers the whole viewport (the window is
      // bigger than either viewport, and the camera clamps to it).
      expect(count(fb, W, black, 0, W, 0, H), "black pixels").toBe(0);
      // The player's walker is on screen near the centre.
      const colors = playerColors(3);
      const match = count(
        fb,
        W,
        (r, g, b) => colors.has(`${r},${g},${b}`),
        Math.max(0, W / 2 - 40),
        Math.min(W, W / 2 + 40),
        Math.max(0, H / 2 - 40),
        Math.min(H, H / 2 + 40),
      );
      expect(match, "player sprite pixels near centre").toBeGreaterThan(8);
      // The name label is in the tree.
      expect(treeHasText(w.getTree(), "Octo")).toBe(true);
      expect(state()!.villagers, "mature frozen town has villagers").toBeGreaterThanOrEqual(1);
      w.frame(0);
    });
  }
});

simDescribe("wander-online view: HUD", () => {
  test("debug info is hidden by default; TRIANGLE toggles it; name and status always show", async () => {
    const w = await boot({ kind: "ticket", ticket: "t1" }, welcome());
    pump(w, 5);
    await waitFor(w, () => state()?.status === "joined", "joined");
    pump(w, 12);
    expect(treeHasText(w.getTree(), "Octo")).toBe(true);
    expect(treeHasText(w.getTree(), "ONLINE")).toBe(true);
    expect(treeHasText(w.getTree(), "RTT")).toBe(false);
    press(w, BTN.TRIANGLE);
    pump(w, 12);
    expect(treeHasText(w.getTree(), "RTT")).toBe(true);
    expect(treeHasText(w.getTree(), "CORR")).toBe(true);
    w.frame(0);
  });
});

simDescribe("wander-online view: character creation", () => {
  test("the look preview changes with the selection and shows n / 64", async () => {
    const w = await boot({ kind: "github", token: "x" }, needCreate());
    pump(w, 5);
    await waitFor(w, () => state()?.screen === "creating", "creating");
    pump(w, 10);
    const tree = w.getTree();
    expect(treeHasText(tree, "1 / 64")).toBe(true);
    // The preview box holds the walker (non-background pixels).
    const l = createLayout(480, 272);
    const fb0 = w.render();
    const boxPixels = count(
      fb0,
      480,
      (r, g, b) => !(r === 11 && g === 22 && b === 38),
      l.previewBox.x0,
      l.previewBox.x1,
      l.previewBox.y0,
      l.previewBox.y1,
    );
    expect(boxPixels, "walker drawn in the preview").toBeGreaterThan(40);
    // L1 focuses the look, RIGHT cycles the base character (look + 4).
    const before = fb0.slice();
    press(w, BTN.LTRIGGER);
    press(w, BTN.RIGHT);
    pump(w, 2);
    expect(treeHasText(w.getTree(), "5 / 64")).toBe(true);
    const after = w.render();
    let changed = 0;
    for (let y = l.previewBox.y0; y < l.previewBox.y1; y++) {
      for (let x = l.previewBox.x0; x < l.previewBox.x1; x++) {
        const i = (y * 480 + x) * 4;
        if (before[i] !== after[i] || before[i + 1] !== after[i + 1] || before[i + 2] !== after[i + 2]) changed++;
      }
    }
    expect(changed, "preview pixels change with the selected base").toBeGreaterThan(40);
    w.frame(0);
  });

  test("a tap on a charset cell types that character", async () => {
    const w = await boot({ kind: "github", token: "x" }, needCreate());
    pump(w, 5);
    await waitFor(w, () => state()?.screen === "creating", "creating");
    pump(w, 10);
    // Tap the centre of the 'B' cell (index 1: row 0, col 1).
    const l = createLayout(480, 272);
    const g = createNameGrid(l);
    const tx = g.x + 1 * g.cellW + (g.cellW >> 1);
    const ty = g.y + 0 * g.cellH + (g.cellH >> 1);
    pump(w, 1, 0, [__packTouch(0, tx, ty)]);
    pump(w, 2);
    expect(treeHasText(w.getTree(), "octoB")).toBe(true);
    w.frame(0);
  });
});
