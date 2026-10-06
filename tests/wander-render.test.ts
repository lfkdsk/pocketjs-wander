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
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { bootWorld, fnv1a, treeHasText } from "../vendor/pocketjs/hosts/sim/sim.ts";
import { __packTouch } from "../vendor/pocketjs/framework/src/touch.ts";
import { decodePng } from "../vendor/pocketjs/framework/compiler/pak.ts";
import { encodePNG } from "../vendor/pocketjs/tests/png.ts";
import { BTN } from "../vendor/pocketjs/contracts/spec/spec.ts";
import { canStepFrom } from "../src/engine/passability.ts";
import { CHUNK } from "../examples/wander/world.ts";
import { WanderSim, type ScheduledInput } from "../examples/wander/wander-sim.ts";
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
const live = (): WanderSim => (globalThis as { __wanderSim?: WanderSim }).__wanderSim!;

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

/** Opaque player-palette pixels in the centred 16x16 walker cell. This is a
 *  semantic pixel check: terrain may move under the camera, but a capture
 *  called a movement frame must still contain the actual player sprite. */
function playerPixels(fb: Uint8Array, w: number, h: number): number {
  const colors = new Set([
    "20,12,28", "210,170,153", "117,113,97", "210,125,44",
    "133,76,48", "218,212,94", "222,238,214",
  ]);
  const x0 = (w >> 1) - 8, y0 = (h >> 1) - 8;
  return count(fb, w, (r, g, b) => colors.has(`${r},${g},${b}`), x0, x0 + 16, y0, y0 + 16);
}

function scale3(src: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h * 9 * 4);
  const stride = w * 3;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const at = (y * w + x) * 4;
    for (let dy = 0; dy < 3; dy++) for (let dx = 0; dx < 3; dx++) {
      const to = ((y * 3 + dy) * stride + x * 3 + dx) * 4;
      out.set(src.subarray(at, at + 4), to);
    }
  }
  return out;
}

async function f3Shot(name: string, fb: Uint8Array, w: number, h: number): Promise<void> {
  const dir = process.env.WANDER_F3_SHOT_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await Bun.write(join(dir, `${name}.png`), encodePNG(fb, w, h));
  await Bun.write(join(dir, `${name}-3x.png`), encodePNG(scale3(fb, w, h), w * 3, h * 3));
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
  test("manual corner slide and blocked-wall facing are visible at PSP and 2x desktop sizes", async () => {
    for (const [width, height] of [[480, 272], [960, 544]] as const) {
      const w = await boot(width, height);
      pump(w, 300);
      const sim = live();
      const table = sim.session.tables.get("wander")!;

      // The start-town plaque is a natural blocked corner immediately right
      // of the player. Keeping RIGHT held must take one safe side cell within
      // the ordinary eight-tick tile step.
      expect([sim.state.move.tx, sim.state.move.ty]).toEqual([50, 45]);
      expect(canStepFrom(table, 50, 45, 3)).toBe(false);
      const slideBefore = w.render().slice();
      const before = pub();
      pump(w, 8, BTN.RIGHT);
      const after = pub();
      expect(after.mode).toBe("manual");
      expect(after.x).toBe(before.x);
      expect(Math.abs(after.y - before.y)).toBe(1);
      expect(sim.state.move).toMatchObject({ phase: 0, moving: false });
      pump(w, 4); // let the six-frame HUD cadence publish the landed tile
      const slideAfter = w.render().slice();
      expect(playerPixels(slideBefore, width, height)).toBeGreaterThan(70);
      expect(playerPixels(slideAfter, width, height)).toBeGreaterThan(70);
      await f3Shot(`f3-${width}-slide-before`, slideBefore, width, height);
      await f3Shot(`f3-${width}-slide-after`, slideAfter, width, height);

      // A natural one-cell pocket beside the same plaza is blocked ahead and
      // on both sides. UP turns the walker toward the wall but cannot drift.
      sim.mode = "manual";
      sim.idle = 0;
      sim.driver.reset();
      const state = sim.state;
      sim.state = {
        ...state,
        move: {
          ...state.move,
          tx: 53, ty: 43, px: 53 * 16, py: 43 * 16,
          facing: 0, phase: 0, moving: false, walking: false, stepDir: 0,
        },
      };
      expect(canStepFrom(table, 53, 43, 2)).toBe(false);
      expect(canStepFrom(table, 53, 43, 1)).toBe(false);
      expect(canStepFrom(table, 53, 43, 3)).toBe(false);
      pump(w, 1); // let the camera and render ring follow the teleported fixture
      const wallAt = pub();
      pump(w, 8, BTN.UP);
      const wallEnd = pub();
      const wall = w.render().slice();
      expect([wallEnd.x, wallEnd.y]).toEqual([wallAt.x, wallAt.y]);
      expect(sim.state.move).toMatchObject({ facing: 2, phase: 0, moving: false, walking: false });
      expect(playerPixels(wall, width, height)).toBeGreaterThan(70);
      await f3Shot(`f3-${width}-wall`, wall, width, height);
    }
  }, 60_000);

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

  test("a same-frame SQUARE|TRIANGLE fires TRIANGLE at the new session's tick 0", async () => {
    // Review probe 1: SQUARE and TRIANGLE pressed in one host frame, TRIANGLE
    // not held before. The reseed restarts the clock at 0, so the TRIANGLE
    // edge must fire at the new session's tick 0 — the old code enqueued it
    // at the old session's now, so it sat at the tape's front until the new
    // session caught up and the short press vanished (fast never toggled).
    const w = await boot(480, 272);
    const sim = (globalThis as { __wanderSim?: WanderSim }).__wanderSim!;
    const tape = (globalThis as { __wanderTape?: ScheduledInput[] }).__wanderTape!;
    pump(w, 360);
    expect(sim.fast).toBe(false);
    expect(sim.segment).toBe(1);
    pump(w, 1, BTN.SQUARE | BTN.TRIANGLE);
    expect(sim.segment).toBe(2);
    expect(sim.fast).toBe(true); // edge at new tick 0
    pump(w, 1); // release
    expect(sim.fast).toBe(true); // still on after release
    // The exported tape: reseed at the old tick, then TRIANGLE at new tick 0,
    // then the release at new tick 1.
    const reseedIdx = tape.findIndex((e) => e.reseed);
    expect(reseedIdx).toBeGreaterThanOrEqual(0);
    const rest = tape.slice(reseedIdx + 1);
    expect(rest[0]).toMatchObject({ at: 0, buttons: BTN.TRIANGLE });
    expect(rest[1]).toMatchObject({ at: 1, buttons: 0 });
  }, 60_000);

  test("a key held across a live reseed keeps holding without a fresh press", async () => {
    // Review probe 2: hold TRIANGLE (fast on), then press SQUARE while still
    // holding. The held mask carries into the new session, so fast stays on —
    // the old code re-queued the hold at tick 0 against a cleared edge
    // baseline, re-firing it as a press and toggling fast back off.
    const w = await boot(480, 272);
    const sim = (globalThis as { __wanderSim?: WanderSim }).__wanderSim!;
    pump(w, 360);
    pump(w, 2, BTN.TRIANGLE); // press + hold
    expect(sim.fast).toBe(true);
    expect(sim.segment).toBe(1);
    pump(w, 1, BTN.TRIANGLE | BTN.SQUARE); // reseed while held
    expect(sim.segment).toBe(2);
    expect(sim.fast).toBe(true); // no phantom re-press
    pump(w, 30, BTN.TRIANGLE); // keep holding
    expect(sim.fast).toBe(true);
    pump(w, 1); // release
    expect(sim.fast).toBe(true);
  }, 60_000);

  test("a reseeding frame routes a d-pad, a field tap and SELECT at the new session's tick 0", async () => {
    // Each of SQUARE+d-pad, SQUARE+tap and SQUARE+SELECT must enqueue the
    // non-SQUARE input at the new session's tick 0 (not the old session's
    // now), so its effect lands there.
    // SQUARE|RIGHT: the takeover lands at new tick 0.
    {
      const w = await boot(480, 272);
      const sim = (globalThis as { __wanderSim?: WanderSim }).__wanderSim!;
      const tape = (globalThis as { __wanderTape?: ScheduledInput[] }).__wanderTape!;
      pump(w, 360);
      pump(w, 1, BTN.SQUARE | BTN.RIGHT);
      expect(sim.segment).toBe(2);
      expect(sim.mode).toBe("manual"); // RIGHT edge at new tick 0 took over
      pump(w, 1); // release
      expect(sim.mode).toBe("manual"); // idle resume is 10 s, still manual
      const rest = tape.slice(tape.findIndex((e) => e.reseed) + 1);
      expect(rest[0]).toMatchObject({ at: 0, buttons: BTN.RIGHT });
      expect(rest[1]).toMatchObject({ at: 1, buttons: 0 });
    }
    // SQUARE|field tap: the goto is enqueued at new tick 0 and walks the new
    // world (its screen cell maps through the pre-reseed camera, so the exact
    // target tile is not asserted — the contract is the enqueue tick and that
    // the tap took effect).
    {
      const w = await boot(480, 272);
      const sim = (globalThis as { __wanderSim?: WanderSim }).__wanderSim!;
      const tape = (globalThis as { __wanderTape?: ScheduledInput[] }).__wanderTape!;
      pump(w, 360);
      pump(w, 1, BTN.SQUARE, [__packTouch(0, 240 + 5 * 16, 136)]);
      expect(sim.segment).toBe(2);
      expect(sim.mode).toBe("goto"); // tap at new tick 0
      const rest = tape.slice(tape.findIndex((e) => e.reseed) + 1);
      expect(rest[0].at).toBe(0);
      expect(rest[0].goto).toBeDefined();
    }
    // SQUARE|SELECT: enqueued at new tick 0; the edge is processed (mode is
    // auto) and the release leaves no phantom.
    {
      const w = await boot(480, 272);
      const sim = (globalThis as { __wanderSim?: WanderSim }).__wanderSim!;
      const tape = (globalThis as { __wanderTape?: ScheduledInput[] }).__wanderTape!;
      pump(w, 360);
      pump(w, 1, BTN.SQUARE | BTN.SELECT);
      expect(sim.segment).toBe(2);
      expect(sim.mode).toBe("auto");
      const rest = tape.slice(tape.findIndex((e) => e.reseed) + 1);
      expect(rest[0]).toMatchObject({ at: 0, buttons: BTN.SELECT });
      pump(w, 1); // release
      expect(sim.mode).toBe("auto");
    }
  }, 90_000);

  test("a live session exports a tape that replays tick-for-tick at 60/30/20/4 Hz", async () => {
    // Play one session through the shipped live path — auto, a tap, a SQUARE
    // reseed, a d-pad takeover, TRIANGLE fast travel, SELECT — recording a
    // rich snapshot at every reference tick. Each live control's effect is
    // asserted on the live path at its exact tick (not just "live == replay",
    // which stays green when a control is dropped from both), then the
    // exported tape replays the session tick-for-tick at every host rate.
    const w = await boot(480, 272);
    const liveSim = (globalThis as { __wanderSim?: WanderSim }).__wanderSim!;
    const recorded: string[] = [];
    interface LSnap { now: number; segment: number; mode: string; fast: boolean; x: number; y: number }
    const snaps: LSnap[] = [];
    liveSim.onTick = () => {
      recorded.push(liveSim.digest());
      const p = liveSim.playerTile;
      snaps.push({ now: liveSim.now, segment: liveSim.segment, mode: liveSim.mode, fast: liveSim.fast, x: p.x, y: p.y });
    };
    pump(w, 360); // auto, segment 1
    // Tap: walk to a field cell east of the player. Compute the expected
    // world tile from the screen coordinate (the view's camera math), so a
    // tap that lands one tile off is caught, not absorbed by the assertion.
    const pp = liveSim.playerPx;
    const camX = Math.floor(pp.x + 8 - 240), camY = Math.floor(pp.y + 8 - 136);
    const expectedGoal = { x: Math.floor((camX + 240 + 5 * 16) / 16), y: Math.floor((camY + 136) / 16) };
    pump(w, 1, 0, [__packTouch(0, 240 + 5 * 16, 136)]);
    expect(liveSim.driver.target!.x).toBe(expectedGoal.x);
    expect(liveSim.driver.target!.y).toBe(expectedGoal.y);
    const goal = { ...liveSim.driver.target! }; // captured before arrival
    expect(goal.town).toBe(false);
    pump(w, 120); // walk there and arrive (mode -> manual)
    pump(w, 1, BTN.SQUARE); // grow a new seed
    // Scout an open direction in the NEW world for the takeover below.
    const table = liveSim.session.tables.get("wander")!;
    const mv = liveSim.state.move;
    const dirs: [number, number, number][] = [[BTN.UP, 0, -1], [BTN.DOWN, 0, 1], [BTN.LEFT, -1, 0], [BTN.RIGHT, 1, 0]];
    const [dir, ddx, ddy] = dirs.find(([, dx, dy]) => table.overrides[(mv.ty + dy) * 96 + mv.tx + dx] === 0)!;
    const dirStart = { ...liveSim.playerTile };
    pump(w, 30, dir); // d-pad takeover in the new world, held half a second
    const dirEnd = { ...liveSim.playerTile };
    pump(w, 2, BTN.TRIANGLE); // fast travel on
    pump(w, 2, BTN.SELECT); // hand back to the driver
    pump(w, 444); // 960 frames = 16 s total
    expect(recorded.length).toBe(960);

    // --- per-control exact-tick assertions on the LIVE path ---
    // Tap: mode becomes goto at the tap's tick (360), and the walker arrives.
    const gotoSnap = snaps.find((s) => s.segment === 1 && s.mode === "goto")!;
    expect(gotoSnap.now).toBe(361); // tap fired at tick 360
    const lastSeg1 = snaps.filter((s) => s.segment === 1).pop()!;
    expect(lastSeg1.mode).toBe("manual"); // arrived, then waits
    // The driver declares arrival when the step's origin is within 1 tile and
    // the step finishes, so the player rests within 2 tiles of the goal.
    expect(Math.abs(lastSeg1.x - goal.x) + Math.abs(lastSeg1.y - goal.y)).toBeLessThanOrEqual(2);
    // Reseed: segment 2 starts at now=1, right after segment 1's last tick.
    const firstSeg2 = snaps.find((s) => s.segment === 2)!;
    expect(firstSeg2.now).toBe(1);
    expect(snaps.indexOf(firstSeg2)).toBe(snaps.indexOf(lastSeg1) + 1);
    expect(liveSim.seed).toBe((0x5eed_0001 + 0x9e37_79b9) >>> 0);
    // Direction: the takeover lands at new tick 1 and walks the pressed way.
    const manualSnap = snaps.find((s) => s.segment === 2 && s.mode === "manual")!;
    expect(manualSnap.now).toBe(2); // edge at new tick 1
    expect((dirEnd.x - dirStart.x) * ddx + (dirEnd.y - dirStart.y) * ddy).toBeGreaterThan(0);
    // TRIANGLE: fast toggles on at exactly its pressed tick (new tick 31).
    const fastSnap = snaps.find((s) => s.segment === 2 && s.fast)!;
    expect(fastSnap.now).toBe(32); // edge at tick 31
    // SELECT: hands back to auto at exactly its pressed tick (new tick 33).
    const autoSnap = snaps.find((s) => s.segment === 2 && s.now >= 34 && s.mode === "auto")!;
    expect(autoSnap.now).toBe(34); // edge at tick 33

    // The exported tape has every control, and replays tick-for-tick at
    // 60/30/20/4 Hz.
    const tape = (globalThis as { __wanderTape?: ScheduledInput[] }).__wanderTape!;
    expect(tape.some((e) => e.goto)).toBe(true);
    expect(tape.some((e) => e.reseed)).toBe(true);
    expect(tape.filter((e) => e.buttons !== undefined).length).toBeGreaterThan(3);
    const replay = (hz: number): string[] => {
      const sim = new WanderSim({ seed: 0x5eed_0001, hz, viewW: 480, viewH: 272 });
      sim.schedule(tape);
      const digests: string[] = [];
      sim.onTick = (d) => digests.push(d);
      for (let f = 0; f < 16 * hz; f++) sim.step(0);
      return digests;
    };
    for (const hz of [60, 30, 20, 4]) expect(replay(hz)).toEqual(recorded);
  }, 90_000);
});
