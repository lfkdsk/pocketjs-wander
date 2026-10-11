// tools/wander-online-social-shots.ts — capture the controller-first social
// menu through the built Wander Online bundle. Every scene is emitted at the
// 480x272 PSP viewport and the 960x544 desktop viewport, plus a nearest-neighbour
// 3x copy for visual review.
//
//   bun tools/wander-online-social-shots.ts [outdir]

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootWorld, treeHasText } from "../vendor/pocket-rpgkit/vendor/pocketjs/hosts/sim/sim.ts";
import { BTN } from "../vendor/pocket-rpgkit/vendor/pocketjs/framework/src/input-api.ts";
import { encodePNG } from "../vendor/pocket-rpgkit/vendor/pocketjs/tests/png.ts";
import type { PocketSocket } from "@pocketjs/framework/socket";
import type { OnlinePublished } from "../examples/wander-online/OnlineView.tsx";
import { encodeRoster } from "../examples/wander-online/net/protocol.ts";
import { appBundle } from "../tests/helpers/boot.ts";
import { fakeOnlineSocketFactory, type FakeOnlineOpts } from "../tests/lib/fake-online-socket.ts";

const out = process.argv[2] ?? "./wander-online-social-shots";
mkdirSync(out, { recursive: true });
const leaderboardReport: Array<{
  scene: string;
  viewport: string;
  requiredText: readonly string[];
  selectedRowPixels: number;
  files: string[];
}> = [];

const SEED = 1593842689;
const HUB = { x: 438, y: 42 };
const GROWN_MS = 10_000_000;

interface World {
  frame: (buttons: number) => void;
  tick: () => void;
  render: () => Uint8Array;
  getTree: () => unknown;
  ticksPerFrame: number;
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

async function waitFor(world: World, predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    pump(world, 1);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`social shots: timeout waiting for ${label}`);
}

function scale3(source: Uint8Array, width: number, height: number): Uint8Array {
  const scaledWidth = width * 3;
  const out = new Uint8Array(scaledWidth * height * 3 * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sourceIndex = (y * width + x) * 4;
      for (let dy = 0; dy < 3; dy++) {
        for (let dx = 0; dx < 3; dx++) {
          const targetIndex = ((y * 3 + dy) * scaledWidth + x * 3 + dx) * 4;
          out[targetIndex] = source[sourceIndex]!;
          out[targetIndex + 1] = source[sourceIndex + 1]!;
          out[targetIndex + 2] = source[sourceIndex + 2]!;
          out[targetIndex + 3] = 255;
        }
      }
    }
  }
  return out;
}

function rgbCount(framebuffer: Uint8Array, red: number, green: number, blue: number): number {
  let count = 0;
  for (let i = 0; i < framebuffer.length; i += 4) {
    if (framebuffer[i] === red && framebuffer[i + 1] === green && framebuffer[i + 2] === blue) count++;
  }
  return count;
}

function capture(world: World, name: string, width: number, height: number, requiredText: readonly string[]): void {
  const tree = world.getTree();
  for (const text of requiredText) {
    if (!treeHasText(tree, text)) throw new Error(`${name} ${width}x${height}: missing text ${JSON.stringify(text)}`);
  }
  const framebuffer = world.render();
  // The selected-row fill (#354968) is a semantic proof that the panel and
  // its controller cursor painted, not merely the underlying world.
  const selectedRowPixels = rgbCount(framebuffer, 0x35, 0x49, 0x68);
  if (selectedRowPixels < 100) {
    throw new Error(`${name} ${width}x${height}: selected social row did not paint`);
  }
  writeFileSync(join(out, `${name}.${width}x${height}.png`), encodePNG(framebuffer, width, height));
  writeFileSync(
    join(out, `${name}.${width}x${height}-3x.png`),
    encodePNG(scale3(framebuffer, width, height), width * 3, height * 3),
  );
  if (name.startsWith("leaderboard-")) {
    leaderboardReport.push({
      scene: name,
      viewport: `${width}x${height}`,
      requiredText,
      selectedRowPixels,
      files: [`${name}.${width}x${height}.png`, `${name}.${width}x${height}-3x.png`],
    });
  }
  console.log(`wrote ${name}.${width}x${height}.png (+3x)`);
}

async function scene(width: number, height: number): Promise<void> {
  let socket: PocketSocket | null = null;
  const opts: FakeOnlineOpts = {
    mode: "welcome4",
    name: "社交演示",
    look: 40,
    ticket: "social-shot-ticket",
    realm: { tx: HUB.x, ty: HUB.y, seed: SEED, epoch: 5, id: "plaza-1" },
    serverTimeMs: GROWN_MS,
    heartbeat: true,
    onSocket: (value) => { socket = value; },
  };
  (globalThis as { __onlineState?: OnlinePublished }).__onlineState = undefined;
  const world = (await bootWorld(
    appBundle("wander-online"),
    60,
    {
      __onlineUrl: "ws://fake/ws",
      __onlineAuth: { kind: "ticket", ticket: "social-shot-ticket" },
      __onlineSocketFactory: fakeOnlineSocketFactory(opts),
    },
    undefined,
    { width, height },
  )) as unknown as World;

  const pushText = (message: Record<string, unknown>): void => {
    socket!.onMessage?.(JSON.stringify(message));
  };
  pump(world, 5);
  await waitFor(world, () => state()?.status === "joined", "joined realm");
  socket!.onMessage?.(new Uint8Array(encodeRoster([
    { id: 2, name: "身边玩家", look: 9 },
  ])));
  press(world, BTN.SELECT);
  press(world, BTN.DOWN);
  if (!state()?.social) throw new Error(`${width}x${height}: social panel did not open`);

  pushText({
    type: "socialSnapshot",
    v: 1,
    visible: false,
    friends: [
      { githubId: 101, name: "在线好友", presence: "online", realm: "plaza-2" },
      { githubId: 102, name: "隐身好友", presence: "hidden", realm: null },
      { githubId: 103, name: "Offline Friend", presence: "offline", realm: null },
    ],
    incoming: [{ githubId: 201, name: "新的好友请求" }],
    outgoing: [{ githubId: 301, name: "Pending Friend" }],
  });
  pushText({
    type: "worlds",
    v: 1,
    worlds: [
      { realm: "plaza-1", band: "lively", joinable: true },
      { realm: "plaza-2", band: "quiet", joinable: true },
      { realm: "plaza-full", band: "full", joinable: false },
      { realm: "snowfield", band: "empty", joinable: true },
    ],
  });
  pushText({
    type: "selfData",
    v: 1,
    data: {
      profile: { login: "social-demo", name: "社交演示", look: 40 },
      friends: 3,
      incoming: 1,
      outgoing: 1,
      visible: false,
      realms: [
        { realm: "plaza-1", discoveries: 12, helped: 4, updatedAt: 1000 },
        { realm: "plaza-2", discoveries: 7, helped: 2, updatedAt: 2000 },
      ],
    },
  });
  pump(world, 2);

  press(world, BTN.CIRCLE);
  capture(world, "social-friends", width, height, ["FRIENDS · plaza-1", "新的好友请求", "身边玩家"]);

  press(world, BTN.CROSS);
  press(world, BTN.DOWN);
  press(world, BTN.CIRCLE);
  capture(world, "social-worlds", width, height, ["WORLDS · plaza-1", "plaza-2", "plaza-full"]);

  press(world, BTN.CROSS);
  press(world, BTN.DOWN);
  press(world, BTN.DOWN);
  press(world, BTN.CIRCLE);
  capture(world, "social-my-data", width, height, ["MY DATA · plaza-1", "PRESENCE", "plaza-1"]);

  press(world, BTN.SQUARE);
  capture(world, "social-delete-confirm", width, height, ["DELETE ALL DATA? · plaza-1", "PRESS DELETE AGAIN"]);
  world.frame(0);
}

function han(...points: number[]): string {
  return String.fromCodePoint(...points);
}

async function leaderboardScene(width: number, height: number, locale: "en" | "zh"): Promise<void> {
  let socket: PocketSocket | null = null;
  const sent: Record<string, unknown>[] = [];
  const opts: FakeOnlineOpts = {
    mode: "welcome4",
    name: locale === "zh" ? han(0x5c71, 0x6d77, 0x5ba2) : "Trail Scout",
    look: 40,
    ticket: `leaderboard-${locale}`,
    realm: { tx: HUB.x, ty: HUB.y, seed: SEED, epoch: 5, id: "plaza-1" },
    serverTimeMs: GROWN_MS,
    heartbeat: true,
    sent,
    onSocket: (value) => { socket = value; },
  };
  (globalThis as { __onlineState?: OnlinePublished }).__onlineState = undefined;
  const world = (await bootWorld(
    appBundle("wander-online"),
    60,
    {
      __onlineUrl: "ws://fake/ws",
      __onlineAuth: { kind: "ticket", ticket: opts.ticket },
      __onlineLocale: locale,
      __onlineSocketFactory: fakeOnlineSocketFactory(opts),
    },
    undefined,
    { width, height },
  )) as unknown as World;
  const pushText = (message: Record<string, unknown>): void => {
    socket!.onMessage?.(JSON.stringify(message));
  };
  const leaderboard = (revision: number, listed: boolean): Record<string, unknown> => ({
    type: "discoveryLeaderboard",
    v: 1,
    realm: "plaza-1",
    revision,
    listed,
    mine: { rank: 3, firsts: 7 },
    leaders: [
      { rank: 1, name: locale === "zh" ? han(0x661f, 0x6cb3, 0x65c5, 0x4eba) : "River Sage", firsts: 12 },
      { rank: 2, name: locale === "zh" ? han(0x677e, 0x98ce) : "Moss Finch", firsts: 9 },
    ],
  });

  pump(world, 5);
  await waitFor(world, () => state()?.status === "joined", `leaderboard ${locale} joined realm`);
  pushText({
    type: "realmFeatures",
    v: 1,
    realm: "plaza-1",
    coopErrands: true,
    discoveryLeaderboard: true,
  });
  pushText(leaderboard(1, false));
  pump(world, 2);

  press(world, BTN.SELECT);
  press(world, BTN.DOWN);
  if (!state()?.social) throw new Error(`${locale} ${width}x${height}: social panel did not open`);
  press(world, BTN.DOWN);
  press(world, BTN.DOWN);
  press(world, BTN.CIRCLE);
  if (state()?.socialScreen !== "discovery") throw new Error(`${locale} ${width}x${height}: discovery route did not open`);

  const mine = locale === "zh" ? `${han(0x4f60)} · #3` : "YOU · #3";
  const mineScore = locale === "zh" ? `7 ${han(0x6b21)}` : "7 FIRSTS";
  const leader = locale === "zh" ? `#1 ${han(0x661f, 0x6cb3, 0x65c5, 0x4eba)}` : "#1 River Sage";
  capture(world, `leaderboard-${locale}-private`, width, height, ["FIRST FINDERS", mine, mineScore, leader, "TRIANGLE LIST · CROSS BACK"]);

  press(world, BTN.TRIANGLE);
  const optIn = sent.findLast((message) => message.type === "leaderboardSet");
  if (optIn?.listed !== true) throw new Error(`${locale} ${width}x${height}: opt-in command was not sent`);
  pushText(leaderboard(2, true));
  pump(world, 2);
  capture(world, `leaderboard-${locale}-listed`, width, height, ["FIRST FINDERS", mine, mineScore, leader, "TRIANGLE UNLIST · CROSS BACK"]);

  press(world, BTN.TRIANGLE);
  const optOut = sent.findLast((message) => message.type === "leaderboardSet");
  if (optOut?.listed !== false) throw new Error(`${locale} ${width}x${height}: opt-out command was not sent`);
  pushText(leaderboard(3, false));
  pump(world, 2);
  capture(world, `leaderboard-${locale}-opted-out`, width, height, ["FIRST FINDERS", mine, mineScore, leader, "TRIANGLE LIST · CROSS BACK"]);
  world.frame(0);
}

for (const [width, height] of [[480, 272], [960, 544]] as const) {
  await scene(width, height);
  await leaderboardScene(width, height, "en");
  await leaderboardScene(width, height, "zh");
}
writeFileSync(join(out, "leaderboard-report.json"), `${JSON.stringify({
  verdict: "PASS",
  scale: 3,
  scenes: leaderboardReport,
}, null, 2)}\n`);
