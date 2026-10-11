// tools/wander-online-journey-shots.ts — capture the realm's gameplay
// overlays (the notice-board dialog, the ERRAND bar with an accepted
// notice, a travel-log page notice, the SELECT menu) at 480x272 and 960x544,
// 3x zoomed, with a 12-code-point CJK first-discoverer name on the status
// plate, plus one frame per size with a 12-code-point CJK local player name
// (name tag, HUD name line and FIRST suffix) and its English counterpart.
//
//   bun tools/wander-online-journey-shots.ts [outdir] [--nameplate-only]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootWorld, treeHasText } from "../vendor/pocket-rpgkit/vendor/pocketjs/hosts/sim/sim.ts";
import { appBundle } from "../tests/helpers/boot.ts";
import { fakeOnlineSocketFactory, type FakeOnlineOpts } from "../tests/lib/fake-online-socket.ts";
import { encodePNG } from "../vendor/pocket-rpgkit/vendor/pocketjs/tests/png.ts";
import { BTN } from "../vendor/pocket-rpgkit/vendor/pocketjs/framework/src/input-api.ts";
import { COMMAND } from "../examples/wander-online/net/protocol.ts";
import { JOURNEY_EVENT } from "../examples/wander-online/net/journey.ts";
import { regionHub } from "../examples/wander/world.ts";
import { townErrand } from "../examples/wander/towns.ts";
import type { OnlinePublished } from "../examples/wander-online/OnlineView.tsx";
import type { PocketSocket } from "@pocketjs/framework/socket";

const out = process.argv[2] ?? "./wander-online-journey-shots";
const nameplateOnly = process.argv.includes("--nameplate-only");
mkdirSync(out, { recursive: true });
const coopReport: Array<{
  scene: string;
  viewport: string;
  requiredText: readonly string[];
  orangePixels: number;
  bluePixels: number;
  files: string[];
}> = [];

/** The journey view test's realm: region (4,0) is West Roserest, hub
 *  (438,42), notice board (439,43), OLD CAMP at (464,23). */
const SEED = 1593842689;
const TOWN = { rx: 4, ry: 0, hub: { x: 438, y: 42 }, board: { x: 439, y: 43 } };
const GROWN_MS = 10_000_000;
const FIRST_NAME = "一二三四五六七八九十一二";
/** A 12-code-point local name of common characters (GB 2312 level 1). */
const CJK_LOCAL_NAME = "演示二号测试玩家名字一二";
const LATIN_LOCAL_NAME = "DemoPlayerXY";

function errandTown(): { rx: number; ry: number } {
  for (let r = 1; r <= 4; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const rx = TOWN.rx + dx, ry = TOWN.ry + dy;
        if (regionHub(SEED, rx, ry).town && townErrand(SEED, rx, ry)) return { rx, ry };
      }
    }
  }
  throw new Error("no errand town near the fixture");
}

function scale3(src: Uint8Array, w: number, h: number): Uint8Array {
  const dst = new Uint8Array(w * 3 * h * 3 * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = (y * w + x) * 4;
      for (let dy = 0; dy < 3; dy++) {
        for (let dx = 0; dx < 3; dx++) {
          const di = ((y * 3 + dy) * (w * 3) + (x * 3 + dx)) * 4;
          dst[di] = src[si]!;
          dst[di + 1] = src[si + 1]!;
          dst[di + 2] = src[si + 2]!;
          dst[di + 3] = 255;
        }
      }
    }
  }
  return dst;
}

interface World {
  frame: (b: number) => void;
  tick: () => void;
  render: () => Uint8Array;
  getTree: () => unknown;
  ticksPerFrame: number;
}

const state = (): OnlinePublished | undefined => (globalThis as { __onlineState?: OnlinePublished }).__onlineState;

async function boot(opts: FakeOnlineOpts, width: number, height: number, locale: "en" | "zh" = "en"): Promise<World> {
  (globalThis as { __onlineState?: OnlinePublished }).__onlineState = undefined;
  return (await bootWorld(
    appBundle("wander-online"),
    60,
    {
      __onlineUrl: "ws://fake/ws",
      __onlineAuth: { kind: "ticket", ticket: "t1" },
      __onlineLocale: locale,
      __onlineSocketFactory: fakeOnlineSocketFactory(opts),
    },
    undefined,
    { width, height },
  )) as unknown as World;
}

function pump(w: World, frames: number, mask = 0): void {
  for (let i = 0; i < frames; i++) {
    w.frame(mask);
    for (let t = 0; t < w.ticksPerFrame; t++) w.tick();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(w: World, pred: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (pred()) return;
    pump(w, 1);
    await sleep(5);
  }
  throw new Error(`timeout waiting for ${what}`);
}

async function enterWorld(w: World): Promise<void> {
  pump(w, 5);
  await waitFor(w, () => state()?.status === "joined", "joined");
  await waitFor(w, () => (state()?.villagers ?? 0) >= 1, "residents");
  pump(w, 12);
}

async function enterRealm(w: World): Promise<void> {
  pump(w, 5);
  await waitFor(w, () => state()?.status === "joined", "joined");
  pump(w, 12);
}

function press(w: World, btn: number): void {
  pump(w, 1, btn);
  pump(w, 1, 0);
}

function realm(tx: number, ty: number, extra: Partial<FakeOnlineOpts> = {}): FakeOnlineOpts {
  return {
    mode: "welcome4",
    name: "Octo",
    look: 3,
    ticket: "t1",
    realm: { tx, ty, seed: SEED, epoch: 5 },
    serverTimeMs: GROWN_MS,
    landmarkFirstName: FIRST_NAME,
    heartbeat: true,
    ...extra,
  };
}

async function shot(name: string, w: number, h: number, fb: Uint8Array): Promise<void> {
  writeFileSync(join(out, `${name}.${w}x${h}.png`), encodePNG(fb, w, h));
  writeFileSync(join(out, `${name}.${w}x${h}-3x.png`), encodePNG(scale3(fb, w, h), w * 3, h * 3));
  console.log(`${name}.${w}x${h}.png`);
}

async function shot3x(name: string, w: number, h: number, fb: Uint8Array): Promise<void> {
  writeFileSync(join(out, `${name}.${w}x${h}-3x.png`), encodePNG(scale3(fb, w, h), w * 3, h * 3));
  console.log(`${name}.${w}x${h}-3x.png`);
}

function rgbCount(framebuffer: Uint8Array, red: number, green: number, blue: number): number {
  let count = 0;
  for (let i = 0; i < framebuffer.length; i += 4) {
    if (framebuffer[i] === red && framebuffer[i + 1] === green && framebuffer[i + 2] === blue) count++;
  }
  return count;
}

async function coopShot(name: string, world: World, width: number, height: number, requiredText: readonly string[]): Promise<void> {
  const tree = world.getTree();
  for (const text of requiredText) {
    if (!treeHasText(tree, text)) throw new Error(`${name} ${width}x${height}: missing text ${JSON.stringify(text)}`);
  }
  const framebuffer = world.render();
  // Semantic colors prove both the cooperative errand line (orange) and the
  // transient server notice (blue) painted over the live world.
  const orangePixels = rgbCount(framebuffer, 0xff, 0xb3, 0x7a);
  const bluePixels = rgbCount(framebuffer, 0x8a, 0xd0, 0xff);
  if (orangePixels < 20) {
    throw new Error(`${name} ${width}x${height}: cooperative errand line did not paint`);
  }
  if (bluePixels < 10) {
    throw new Error(`${name} ${width}x${height}: cooperative notice did not paint`);
  }
  await shot(name, width, height, framebuffer);
  coopReport.push({
    scene: name,
    viewport: `${width}x${height}`,
    requiredText,
    orangePixels,
    bluePixels,
    files: [`${name}.${width}x${height}.png`, `${name}.${width}x${height}-3x.png`],
  });
}

function han(...points: number[]): string {
  return String.fromCodePoint(...points);
}

async function coopScenes(width: number, height: number, locale: "en" | "zh"): Promise<void> {
  let socket: PocketSocket | null = null;
  const offer = { rx: 0, ry: 0 };
  const errand = townErrand(SEED, offer.rx, offer.ry);
  if (!errand || errand.kind !== "deliver") throw new Error("cooperative screenshot fixture lost its delivery");
  const world = await boot(realm(errand.tx, errand.ty, {
    name: locale === "zh" ? han(0x540c, 0x884c, 0x8005) : "Coop Scout",
    journey: { errand: offer, cooperative: true },
    onSocket: (value) => { socket = value; },
  }), width, height, locale);
  await enterRealm(world);
  const pushText = (message: Record<string, unknown>): void => {
    socket!.onMessage?.(JSON.stringify(message));
  };
  pushText({
    type: "realmFeatures",
    v: 1,
    realm: "realm-test",
    coopErrands: true,
    discoveryLeaderboard: true,
  });
  pushText({
    type: "coopErrand",
    v: 1,
    realm: "realm-test",
    revision: 1,
    status: "waiting",
    cooperative: true,
    ready: true,
    savedReady: 1,
    presentReady: 1,
    required: 2,
    expiresAt: GROWN_MS + 30_000,
  });
  pump(world, 2);
  const label = locale === "zh" ? han(0x534f, 0x4f5c) : "COOP";
  const waitingNotice = locale === "zh"
    ? `${label} 1/2 · ${han(0x5c31, 0x7eea)}`
    : "COOP 1/2 · READY";
  if (!state()?.errand.includes(`${label} 1/2`)) throw new Error(`${locale} ${width}x${height}: cooperative HUD is missing`);
  if (state()?.notice !== waitingNotice) throw new Error(`${locale} ${width}x${height}: waiting notice mismatch`);
  await coopShot(`coop-${locale}-waiting`, world, width, height, [state()!.errand, waitingNotice]);

  pushText({
    type: "coopErrand",
    v: 1,
    realm: "realm-test",
    revision: 2,
    status: "completed",
    cooperative: true,
    ready: false,
    savedReady: 0,
    presentReady: 0,
    required: 2,
    expiresAt: 0,
  });
  pump(world, 2);
  const completedNotice = locale === "zh"
    ? `${label} · ${han(0x5b8c, 0x6210)}`
    : "COOP · COMPLETE";
  if (state()?.notice !== completedNotice) throw new Error(`${locale} ${width}x${height}: completion notice mismatch`);
  await coopShot(`coop-${locale}-completed`, world, width, height, [state()!.errand, completedNotice]);
  world.frame(0);
}

async function main() {
  const town = errandTown();
  const hub = regionHub(SEED, town.rx, town.ry);
  for (const [w, h] of [[480, 272], [960, 544]] as const) {
    if (nameplateOnly) {
      // The deterministic snow-field fixture is the worst case for a white
      // local name; capture only the requested 3x acceptance frames.
      const world = await boot(realm(-358, -396, { name: CJK_LOCAL_NAME }), w, h);
      await enterRealm(world);
      await shot3x("snow-nameplate", w, h, world.render());
      world.frame(0);
      continue;
    }
    // (a) The notice board's dialog, read from one tile above it.
    {
      const world = await boot(realm(TOWN.board.x, TOWN.board.y - 1), w, h);
      await enterWorld(world);
      press(world, BTN.CIRCLE);
      pump(world, 2);
      if (!state()?.dialog) throw new Error(`board dialog ${w}x${h}: no dialog opened`);
      await shot("board-dialog", w, h, world.render());
      world.frame(0);
    }

    // (b) The ERRAND bar after the server accepted the plaza offer, with
    // the accepted notice still up.
    {
      const world = await boot(realm(hub.x, hub.y, {
        commandReply: (cmd) => cmd.kind === COMMAND.acceptErrand
          ? { revision: 1, eventSeq: 1, eventKind: JOURNEY_EVENT.accepted, eventRx: cmd.rx, eventRy: cmd.ry, errand: { rx: cmd.rx, ry: cmd.ry } }
          : null,
      }), w, h);
      await enterWorld(world);
      press(world, BTN.CROSS);
      await sleep(5);
      pump(world, 8);
      if (!state()?.notice.startsWith("ERRAND: ")) throw new Error(`errand ${w}x${h}: no accepted notice`);
      await shot("errand-accepted", w, h, world.render());
      world.frame(0);
    }

    // (e) The local walker's name tag and HUD name line with a 12-code-point
    // CJK name, and the same frame with a Latin name, on the plaza among the
    // residents.
    for (const [tag, name] of [["cjk-name", CJK_LOCAL_NAME], ["latin-name", LATIN_LOCAL_NAME]] as const) {
      const world = await boot(realm(TOWN.hub.x, TOWN.hub.y, { name }), w, h);
      await enterWorld(world);
      pump(world, 4);
      await shot(tag, w, h, world.render());
      world.frame(0);
    }

    // (c) A travel-log page notice over the LOG bar.
    {
      const world = await boot(realm(400, 80, { progress: [{ rx: TOWN.rx, ry: TOWN.ry }] }), w, h);
      await enterWorld(world);
      press(world, BTN.CROSS);
      pump(world, 2);
      if (!state()?.notice.startsWith("LOG 1/1")) throw new Error(`log ${w}x${h}: no log notice`);
      await shot("log-page", w, h, world.render());
      // (d) The SELECT menu with its debug and auto-walk toggles.
      press(world, BTN.SELECT);
      pump(world, 2);
      await shot("menu", w, h, world.render());
      world.frame(0);
    }

    await coopScenes(w, h, "en");
    await coopScenes(w, h, "zh");
  }
}

await main();
if (!nameplateOnly) {
  writeFileSync(join(out, "coop-report.json"), `${JSON.stringify({
    verdict: "PASS",
    scale: 3,
    scenes: coopReport,
  }, null, 2)}\n`);
}
