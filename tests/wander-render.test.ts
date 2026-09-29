// tests/wander-render.test.ts — the endless world through the BUILT
// "wander" bundle on the deterministic wasm sim host. Pixels are asserted
// for meaning, and two frames are pinned byte-for-byte as goldens:
//
//   growth    the walk starts on a town that grows around the player: road
//             pixels multiply and residents appear within five seconds
//   gaps      no field pixel is ever the root's black background (a
//             missing fill block, a dropped cell or a torn stamp would be)
//   hz        the same virtual moment renders the same framebuffer at
//             60/30/20/4 Hz
//   stream    with a starved budget and fast travel, unready chunks show the
//             biome placeholder and fill in; nothing lingers
//   nodes     mounted nodes stay under the ring's hard cap, nothing is
//             dropped, and a desktop viewport needs far fewer than a node
//             per cell
//   input     a d-pad press shows "YOU HAVE CONTROL"; a tap, or a desktop
//             left click, walks there
//
// Regenerate the goldens with WANDER_UPDATE_GOLDENS=1 (then LOOK at them).

import { describe, expect, test } from "bun:test";
import { bootWorld, fnv1a, treeHasText } from "../vendor/pocketjs/hosts/sim/sim.ts";
import { __packTouch } from "../vendor/pocketjs/framework/src/touch.ts";
import { decodePng } from "../vendor/pocketjs/framework/compiler/pak.ts";
import { encodePNG } from "../vendor/pocketjs/tests/png.ts";
import { BTN } from "../vendor/pocketjs/contracts/spec/spec.ts";
import { CHUNK } from "../examples/wander/world.ts";
import type { WanderPublished } from "../examples/wander/WanderView.tsx";
import { appBundle, appPreflight } from "./helpers/boot.ts";

const preflight = appPreflight("wander");
if (!preflight.ok) console.warn(`wander sim tests skipped: ${preflight.reason}`);
const simDescribe = preflight.ok ? describe : describe.skip;

interface World {
  frame: (b: number, a?: number, t?: readonly number[]) => void;
  tick: () => void;
  render: () => Uint8Array;
  getTree: () => unknown;
  ticksPerFrame: number;
}

async function boot(width: number, height: number, hz = 60, globals: Record<string, unknown> = {}): Promise<World> {
  return (await bootWorld(appBundle("wander"), hz, globals, undefined, { width, height })) as unknown as World;
}
function pump(w: World, frames: number, mask = 0, touches?: readonly number[]): void {
  for (let f = 0; f < frames; f++) {
    w.frame(mask, undefined, touches);
    for (let t = 0; t < w.ticksPerFrame; t++) w.tick();
  }
}
const pub = (): WanderPublished => structuredClone((globalThis as { __wanderState?: WanderPublished }).__wanderState!);

function count(fb: Uint8Array, stride: number, pred: (r: number, g: number, b: number) => boolean, x0: number, x1: number, y0: number, y1: number): number {
  let n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = (y * stride + x) * 4;
    if (pred(fb[i]!, fb[i + 1]!, fb[i + 2]!)) n++;
  }
  return n;
}
// grow's road / plaza earth after PSM_4444 packing.
const road = (r: number, g: number, b: number) => r === 170 && g === 153 && b === 119;
const black = (r: number, g: number, b: number) => r === 0 && g === 0 && b === 0;
// The Ninja samurai villager's red-orange hat band.
const villagerHat = (r: number, g: number, b: number) => r >= 200 && g >= 120 && g <= 170 && b <= 90;

/** Field pixels outside the HUD plates (top 110 rows at the corners and the
 *  bottom help strip are overlays). */
function fieldBlack(fb: Uint8Array, w: number, h: number): number {
  return count(fb, w, black, 0, w, 110, h - 24) + count(fb, w, black, 220, w - 140, 0, 110);
}

async function golden(name: string, fb: Uint8Array, w: number, h: number): Promise<Uint8Array> {
  const url = new URL(`./goldens/${name}.png`, import.meta.url);
  if (process.env.WANDER_UPDATE_GOLDENS) await Bun.write(url, encodePNG(fb, w, h));
  return decodePng(new Uint8Array(await Bun.file(url).arrayBuffer())).rgba;
}

simDescribe("wander render: the world on screen", () => {
  test("480x272: the start town grows around the player; no gaps; golden", async () => {
    const w = await boot(480, 272);
    pump(w, 1);
    const early = w.render().slice();
    const earlyRoad = count(early, 480, road, 0, 480, 0, 272);
    pump(w, 299);
    const fb = w.render();
    const st = pub();
    expect(st.mode).toBe("auto");
    expect(st.frame).toBe(300);
    // Roads spread out from the plaza, then houses and residents.
    const lateRoad = count(fb, 480, road, 0, 480, 0, 272);
    expect(lateRoad).toBeGreaterThan(earlyRoad * 3);
    expect(count(fb, 480, villagerHat, 0, 480, 0, 272)).toBeGreaterThan(20);
    expect(fieldBlack(fb, 480, 272)).toBe(0);
    expect(st.dropped).toBe(0);
    expect(st.mounted).toBeLessThan(st.nodeCap);
    const g = await golden("wander.480.300", fb, 480, 272);
    expect(fnv1a(fb)).toBe(fnv1a(g));
    // Semantic check of the pinned frame itself.
    expect(count(g, 480, road, 0, 480, 0, 272)).toBe(lateRoad);
  });

  test("960x544: a grown town beside a snow border, walked into; golden", async () => {
    const w = await boot(960, 544);
    let maxMounted = 0;
    for (let f = 0; f < 2100; f += 100) {
      pump(w, 100);
      const st = pub();
      maxMounted = Math.max(maxMounted, st.mounted);
      expect(st.dropped).toBe(0);
      if (f % 500 === 0) expect(fieldBlack(w.render(), 960, 544)).toBe(0);
    }
    const fb = w.render();
    const st = pub();
    // 60 x 34 visible cells, three cell layers: the pooled ring uses well
    // under one node per visible cell.
    expect(maxMounted).toBeLessThan(60 * 34);
    expect(st.resident).toBeLessThanOrEqual(st.cap);
    expect(fieldBlack(fb, 960, 544)).toBe(0);
    // Snow fill, grass fill and a grown town (roofs and roads) together.
    const snow = count(fb, 960, (r, g, b) => r === 187 && g === 204 && b === 204, 0, 960, 0, 544);
    const grass = count(fb, 960, (r, g, b) => r === 153 && g === 170 && b === 119, 0, 960, 0, 544);
    const roof = count(fb, 960, (r, g, b) => r > 190 && g < 110 && b < 100, 0, 960, 0, 544);
    expect(snow).toBeGreaterThan(20_000);
    expect(grass).toBeGreaterThan(20_000);
    expect(roof).toBeGreaterThan(1_000);
    expect(count(fb, 960, road, 0, 960, 0, 544)).toBeGreaterThan(5_000);
    const g = await golden("wander.960.2100", fb, 960, 544);
    expect(fnv1a(fb)).toBe(fnv1a(g));
  }, 60_000);
});

simDescribe("wander render: rate portability", () => {
  test("the same virtual moment renders the same framebuffer at 60/30/20/4 Hz", async () => {
    for (const seconds of [3, 9]) {
      const hashes: string[] = [];
      const states: string[] = [];
      for (const hz of [60, 30, 20, 4]) {
        const w = await boot(480, 272, hz);
        pump(w, seconds * hz);
        hashes.push(fnv1a(w.render()));
        const st = pub();
        states.push(JSON.stringify([st.now, st.x, st.y, st.windowX, st.windowY, st.resident, st.generatedTotal, st.towns]));
      }
      expect(new Set(states).size).toBe(1);
      expect(new Set(hashes).size).toBe(1);
    }
  }, 60_000);
});

simDescribe("wander render: streaming under a starved budget", () => {
  test("unready chunks draw the biome placeholder, then fill in; nothing lingers", async () => {
    // One slice per tick and fast travel: generation falls behind on purpose.
    const w = await boot(480, 272, 60, { __wanderFast: true, __wanderBudget: 420 });
    let sawQueue = false, placeholderFrames = 0;
    for (let f = 0; f < 1800; f++) {
      pump(w, 1);
      const st = pub();
      if (st.queued > 0) sawQueue = true;
      const sim = (globalThis as { __wanderSim?: { res: { chunk(x: number, y: number): unknown } } }).__wanderSim!;
      const cx0 = Math.floor((st.x - 16) / CHUNK), cx1 = Math.floor((st.x + 16) / CHUNK);
      const cy0 = Math.floor((st.y - 9) / CHUNK), cy1 = Math.floor((st.y + 9) / CHUNK);
      let missing = false;
      for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) if (!sim.res.chunk(cx, cy)) missing = true;
      if (missing) {
        placeholderFrames++;
        // A placeholder is a biome fill block, never the black background.
        expect(fieldBlack(w.render(), 480, 272)).toBe(0);
      }
      expect(st.budgetViolations).toBe(0);
      expect(st.maxFrameUnits).toBeLessThanOrEqual(420);
    }
    expect(sawQueue).toBe(true);
    expect(placeholderFrames).toBeGreaterThan(0);
    // Stop and let the queue drain: every visible chunk arrives and is drawn.
    pump(w, 1, BTN.RIGHT);
    for (let f = 0; f < 600 && pub().queued > 0; f++) pump(w, 1);
    const st = pub();
    expect(st.queued).toBe(0);
    expect(fieldBlack(w.render(), 480, 272)).toBe(0);
  }, 90_000);
});

simDescribe("wander render: input", () => {
  test("a d-pad press takes over with a notice; a tap walks to the tapped tile", async () => {
    const w = await boot(480, 272);
    pump(w, 360);
    expect(pub().mode).toBe("auto");
    pump(w, 2, BTN.UP);
    expect(pub().mode).toBe("manual");
    expect(treeHasText(w.getTree(), "YOU HAVE CONTROL")).toBe(true);
    pump(w, 30);
    // Tap a field cell to the right of the player (screen centre + 5 tiles).
    const touch = [__packTouch(0, 240 + 5 * 16, 136)];
    pump(w, 1, 0, touch);
    expect(pub().mode).toBe("goto");
    pump(w, 1);
    for (let f = 0; f < 600 && pub().mode === "goto"; f++) pump(w, 1);
    expect(pub().mode).toBe("manual");
  }, 30_000);

  test("a desktop left click (mouse service line) walks there too", async () => {
    // The desktop host sends serde_json lines with sorted keys.
    const queue: string[] = [];
    const w = (await bootWorld(appBundle("wander"), 60, {}, (ops) => {
      ops.svcPoll = () => (queue.length ? queue.splice(0).join("\n") : undefined);
    }, { width: 480, height: 272 })) as unknown as World;
    pump(w, 360);
    expect(pub().mode).toBe("auto");
    queue.push('{"b":0,"d":false,"sh":false,"t":"mouse","x":300,"y":100}');
    pump(w, 1);
    expect(pub().mode).toBe("auto"); // a move without the button is no tap
    queue.push('{"b":0,"d":true,"sh":false,"t":"mouse","x":320,"y":136}', '{"b":0,"d":true,"sh":false,"t":"mouse","x":322,"y":137}');
    pump(w, 1);
    expect(pub().mode).toBe("goto");
  }, 30_000);
});
