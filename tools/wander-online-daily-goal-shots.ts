// Capture the realm daily goal on the live HUD and an ordinary town notice
// board in English and Chinese at the two supported desktop viewports.
// Native frames and nearest-neighbour 3x inspection copies are retained,
// together with semantic text, width and pixel evidence.
//
//   bun tools/wander-online-daily-goal-shots.ts [outdir]

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BTN } from "@pocketjs/framework/input";
import type { PocketSocket } from "@pocketjs/framework/socket";
import { bootWorld, treeHasText } from "../vendor/pocket-rpgkit/vendor/pocketjs/hosts/sim/sim.ts";
import { appBundle } from "../tests/helpers/boot.ts";
import { fakeOnlineSocketFactory, type FakeOnlineOpts } from "../tests/lib/fake-online-socket.ts";
import { encodePNG } from "../vendor/pocket-rpgkit/vendor/pocketjs/tests/png.ts";
import {
  dailyGoalLayout,
  dialogRect,
  type HudRect,
} from "../examples/wander-online/hud.ts";
import type { OnlinePublished } from "../examples/wander-online/OnlineView.tsx";
import {
  formatDailyGoal,
  generateDailyGoal,
  type DailyGoalSnapshot,
} from "../examples/wander-online/shared/daily-goal.ts";
import { SOCIAL_PROTOCOL_VERSION } from "../examples/wander-online/shared/social.ts";

const OUT = resolve(process.argv[2] ?? "dist/wander-online-daily-goal-shots");
const SEED = 1593842689;
const REALM = "realm-test";
const DAY = 0;
const SERVER_TIME_MS = 10_000_000;
const BOARD = { x: 439, y: 43 };

interface World {
  frame: (buttons: number) => void;
  tick: () => void;
  render: () => Uint8Array;
  getTree: () => unknown;
  ticksPerFrame: number;
}

interface Fixture {
  opts: FakeOnlineOpts;
  socket: () => PocketSocket;
}

interface SceneEvidence {
  locale: "en" | "zh";
  viewport: string;
  scene: "progress" | "board";
  goalText: string;
  countdownText: string;
  goalWidth: number;
  goalAvailable: number;
  countdownWidth: number;
  countdownAvailable: number;
  semanticPixels: Record<string, number>;
  files: string[];
}

const report: SceneEvidence[] = [];

function fixture(): Fixture {
  let socket: PocketSocket | null = null;
  return {
    opts: {
      mode: "welcome4",
      name: "Octo",
      look: 3,
      ticket: "t1",
      realm: {
        tx: BOARD.x,
        ty: BOARD.y - 1,
        seed: SEED,
        epoch: 5,
        id: REALM,
      },
      serverTimeMs: SERVER_TIME_MS,
      heartbeat: true,
      onSocket: (value) => { socket = value; },
    },
    socket: () => {
      if (!socket) throw new Error("daily-goal fixture socket is not connected");
      return socket;
    },
  };
}

async function boot(opts: FakeOnlineOpts, width: number, height: number, locale: "en" | "zh"): Promise<World> {
  (globalThis as { __onlineState?: OnlinePublished }).__onlineState = undefined;
  return (await bootWorld(
    appBundle("wander-online"),
    60,
    {
      __onlineUrl: "ws://fake/ws",
      __onlineAuth: { kind: "ticket", ticket: "t1" },
      __onlineSocketFactory: fakeOnlineSocketFactory(opts),
      __onlineLocale: locale,
    },
    undefined,
    { width, height },
  )) as unknown as World;
}

const state = (): OnlinePublished | undefined =>
  (globalThis as { __onlineState?: OnlinePublished }).__onlineState;

function pump(world: World, frames: number, buttons = 0): void {
  for (let frame = 0; frame < frames; frame++) {
    world.frame(buttons);
    for (let tick = 0; tick < world.ticksPerFrame; tick++) world.tick();
  }
}

function press(world: World, button: number): void {
  pump(world, 1, button);
  pump(world, 1);
}

const sleep = (ms: number) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

async function waitFor(world: World, predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    pump(world, 1);
    await sleep(5);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function enterWorld(world: World): Promise<void> {
  pump(world, 5);
  await waitFor(world, () => state()?.status === "joined", "realm admission");
  await waitFor(world, () => (state()?.villagers ?? 0) > 0, "town residents");
  pump(world, 6);
}

function pushText(f: Fixture, message: Record<string, unknown>): void {
  f.socket().onMessage?.(JSON.stringify(message));
}

function snapshot(): DailyGoalSnapshot {
  return {
    ...generateDailyGoal(SEED, REALM, DAY),
    progress: 2,
    completed: false,
    contributed: true,
    contributionDays: [DAY],
    revision: 2,
  };
}

function scale3(src: Uint8Array, width: number, height: number): Uint8Array {
  const dstWidth = width * 3;
  const dst = new Uint8Array(dstWidth * height * 3 * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const source = (y * width + x) * 4;
      for (let dy = 0; dy < 3; dy++) {
        for (let dx = 0; dx < 3; dx++) {
          const target = ((y * 3 + dy) * dstWidth + x * 3 + dx) * 4;
          dst[target] = src[source]!;
          dst[target + 1] = src[source + 1]!;
          dst[target + 2] = src[source + 2]!;
          dst[target + 3] = 255;
        }
      }
    }
  }
  return dst;
}

function countNear(
  framebuffer: Uint8Array,
  width: number,
  rect: HudRect,
  red: number,
  green: number,
  blue: number,
  tolerance = 48,
): number {
  let count = 0;
  for (let y = Math.max(0, rect.y0); y < rect.y1; y++) {
    for (let x = Math.max(0, rect.x0); x < Math.min(width, rect.x1); x++) {
      const offset = (y * width + x) * 4;
      if (Math.abs(framebuffer[offset]! - red) <= tolerance
        && Math.abs(framebuffer[offset + 1]! - green) <= tolerance
        && Math.abs(framebuffer[offset + 2]! - blue) <= tolerance) count++;
    }
  }
  return count;
}

function writeShot(name: string, width: number, height: number, framebuffer: Uint8Array): string[] {
  const native = `${name}.${width}x${height}.png`;
  const zoomed = `${name}.${width}x${height}-3x.png`;
  writeFileSync(join(OUT, native), encodePNG(framebuffer, width, height));
  writeFileSync(join(OUT, zoomed), encodePNG(scale3(framebuffer, width, height), width * 3, height * 3));
  console.log(`${native} + ${zoomed}`);
  return [native, zoomed];
}

function measure(text: string): number {
  return (globalThis as unknown as { ui: { measureText: (value: string, slot: number) => number } })
    .ui.measureText(text, 0);
}

async function capture(width: number, height: number, locale: "en" | "zh"): Promise<void> {
  const f = fixture();
  const world = await boot(f.opts, width, height, locale);
  await enterWorld(world);

  pushText(f, {
    type: "realmFeatures",
    v: SOCIAL_PROTOCOL_VERSION,
    realm: REALM,
    coopErrands: false,
    coopPartnerFinding: false,
    discoveryLeaderboard: false,
    dailyGoals: true,
  });
  const goal = snapshot();
  pushText(f, { type: "dailyGoal", v: SOCIAL_PROTOCOL_VERSION, ...goal, completedNow: false });
  pump(world, 7);

  const expectedGoal = formatDailyGoal(goal, locale);
  const countdown = state()?.dailyGoalCountdown ?? "";
  const layout = dailyGoalLayout(width, height);
  const goalWidth = measure(expectedGoal);
  const countdownWidth = measure(countdown);
  const goalAvailable = layout.goalText.x1 - layout.goalText.x0;
  const countdownAvailable = layout.countdownText.x1 - layout.countdownText.x0;
  if (state()?.dailyGoalText !== expectedGoal || !treeHasText(world.getTree(), expectedGoal)) {
    throw new Error(`${locale} ${width}x${height}: full daily goal text is absent`);
  }
  if (!countdown || !treeHasText(world.getTree(), countdown)) {
    throw new Error(`${locale} ${width}x${height}: UTC countdown is absent`);
  }
  if (goalWidth > goalAvailable || countdownWidth > countdownAvailable) {
    throw new Error(`${locale} ${width}x${height}: daily HUD text is wider than its layout`);
  }

  const progressFrame = world.render();
  const progressPixels = {
    goalGreen: countNear(progressFrame, width, layout.goalText, 0x8f, 0xe3, 0xb0),
    countdownBlue: countNear(progressFrame, width, layout.countdownText, 0x9f, 0xd0, 0xff),
  };
  if (progressPixels.goalGreen < 8 || progressPixels.countdownBlue < 8) {
    throw new Error(`${locale} ${width}x${height}: daily HUD semantic colors did not paint`);
  }
  const progressFiles = writeShot(`daily-${locale}-progress`, width, height, progressFrame);
  report.push({
    locale,
    viewport: `${width}x${height}`,
    scene: "progress",
    goalText: expectedGoal,
    countdownText: countdown,
    goalWidth,
    goalAvailable,
    countdownWidth,
    countdownAvailable,
    semanticPixels: progressPixels,
    files: progressFiles,
  });

  press(world, BTN.CIRCLE);
  pump(world, 2);
  if (!state()?.dialog || !treeHasText(world.getTree(), expectedGoal)) {
    throw new Error(`${locale} ${width}x${height}: notice board omits the daily goal`);
  }
  const boardFrame = world.render();
  const boardBox = dialogRect(width, height);
  const boardPixels = {
    dialogText: countNear(boardFrame, width, boardBox, 0xe7, 0xed, 0xf8),
    nextLegendBlue: countNear(boardFrame, width, boardBox, 0x8a, 0xd0, 0xff),
    opaquePanel: countNear(boardFrame, width, boardBox, 0x0b, 0x16, 0x26, 0),
  };
  if (boardPixels.dialogText < 20 || boardPixels.nextLegendBlue < 4 || boardPixels.opaquePanel < 500) {
    throw new Error(`${locale} ${width}x${height}: notice-board dialog did not paint`);
  }
  const boardFiles = writeShot(`daily-${locale}-board`, width, height, boardFrame);
  report.push({
    locale,
    viewport: `${width}x${height}`,
    scene: "board",
    goalText: expectedGoal,
    countdownText: countdown,
    goalWidth,
    goalAvailable,
    countdownWidth,
    countdownAvailable,
    semanticPixels: boardPixels,
    files: boardFiles,
  });
  world.frame(0);
}

mkdirSync(OUT, { recursive: true });
for (const [width, height] of [[480, 272], [960, 544]] as const) {
  for (const locale of ["en", "zh"] as const) await capture(width, height, locale);
}
writeFileSync(join(OUT, "report.json"), `${JSON.stringify({
  verdict: "PASS",
  scale: 3,
  seed: SEED,
  realm: REALM,
  day: DAY,
  scenes: report,
}, null, 2)}\n`);
console.log(`PASS: ${report.length} bilingual daily-goal scenes captured in ${OUT}`);
