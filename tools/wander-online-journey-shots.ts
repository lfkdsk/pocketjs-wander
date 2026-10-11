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
import { isCooperativeErrand, JOURNEY_EVENT } from "../examples/wander-online/net/journey.ts";
import { plaqueOf } from "../examples/wander-online/net/npc.ts";
import { errandBarRect, noticeRect, type HudRect } from "../examples/wander-online/hud.ts";
import { planRegion } from "../examples/wander/region.ts";
import { regionHub } from "../examples/wander/world.ts";
import { townErrand } from "../examples/wander/towns.ts";
import type { OnlinePublished } from "../examples/wander-online/OnlineView.tsx";
import type { CommandMessage } from "../examples/wander-online/net/protocol.ts";
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
  selectedRowPixels: number;
  dialogPixels: number;
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

function cooperativeTown(): { rx: number; ry: number } {
  for (let radius = 0; radius <= 12; radius++) {
    for (let ry = -radius; ry <= radius; ry++) for (let rx = -radius; rx <= radius; rx++) {
      if (Math.max(Math.abs(rx), Math.abs(ry)) !== radius) continue;
      const errand = townErrand(SEED, rx, ry);
      if (regionHub(SEED, rx, ry).town && errand && isCooperativeErrand(SEED, errand)) {
        return { rx: rx || 0, ry: ry || 0 };
      }
    }
  }
  throw new Error("no deterministic cooperative town");
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

function rgbCountNearInRect(
  framebuffer: Uint8Array,
  width: number,
  rect: HudRect,
  red: number,
  green: number,
  blue: number,
  tolerance = 60,
): number {
  let count = 0;
  for (let y = Math.max(0, rect.y0); y < rect.y1; y++) {
    for (let x = Math.max(0, rect.x0); x < Math.min(width, rect.x1); x++) {
      const i = (y * width + x) * 4;
      if (Math.abs(framebuffer[i]! - red) <= tolerance
        && Math.abs(framebuffer[i + 1]! - green) <= tolerance
        && Math.abs(framebuffer[i + 2]! - blue) <= tolerance) count++;
    }
  }
  return count;
}

interface PixelMinimums {
  orange?: number;
  blue?: number;
  selectedRow?: number;
  dialog?: number;
}

async function coopShot(
  name: string,
  world: World,
  width: number,
  height: number,
  requiredText: readonly string[],
  minimums: PixelMinimums = { orange: 20, blue: 10 },
): Promise<void> {
  const tree = world.getTree();
  for (const text of requiredText) {
    if (!treeHasText(tree, text)) throw new Error(`${name} ${width}x${height}: missing text ${JSON.stringify(text)}`);
  }
  const framebuffer = world.render();
  // Semantic colors distinguish the live errand line, transient notice,
  // selected social row and notice-board dialog from the world underneath.
  // CJK glyphs are alpha blended by the host and therefore do not retain an
  // exact foreground RGB value. Restrict tolerant color checks to the actual
  // HUD bands so they remain semantic without rejecting blended glyph edges.
  const orangePixels = rgbCountNearInRect(
    framebuffer,
    width,
    errandBarRect(width, height),
    0xff,
    0xb3,
    0x7a,
  );
  const bluePixels = rgbCountNearInRect(
    framebuffer,
    width,
    noticeRect(width, height, false),
    0x8a,
    0xd0,
    0xff,
  );
  const selectedRowPixels = rgbCount(framebuffer, 0x35, 0x49, 0x68);
  const dialogPixels = rgbCount(framebuffer, 0x0b, 0x16, 0x26);
  // Keep the failing frame as evidence: visual assertions should be
  // diagnosable without temporarily weakening or reordering them.
  await shot(name, width, height, framebuffer);
  if (orangePixels < (minimums.orange ?? 0)) {
    throw new Error(`${name} ${width}x${height}: cooperative errand line did not paint`);
  }
  if (bluePixels < (minimums.blue ?? 0)) {
    throw new Error(`${name} ${width}x${height}: cooperative notice did not paint`);
  }
  if (selectedRowPixels < (minimums.selectedRow ?? 0)) {
    throw new Error(`${name} ${width}x${height}: waiting-friend row did not paint`);
  }
  if (dialogPixels < (minimums.dialog ?? 0)) {
    throw new Error(`${name} ${width}x${height}: notice-board dialog did not paint`);
  }
  coopReport.push({
    scene: name,
    viewport: `${width}x${height}`,
    requiredText,
    orangePixels,
    bluePixels,
    selectedRowPixels,
    dialogPixels,
    files: [`${name}.${width}x${height}.png`, `${name}.${width}x${height}-3x.png`],
  });
}

function han(...points: number[]): string {
  return String.fromCodePoint(...points);
}

async function coopScenes(width: number, height: number, locale: "en" | "zh"): Promise<void> {
  let socket: PocketSocket | null = null;
  const sentBinary: CommandMessage[] = [];
  const offer = { rx: 0, ry: 0 };
  const errand = townErrand(SEED, offer.rx, offer.ry);
  if (!errand || errand.kind !== "deliver") throw new Error("cooperative screenshot fixture lost its delivery");
  const world = await boot(realm(errand.tx, errand.ty, {
    name: locale === "zh" ? han(0x540c, 0x884c, 0x8005) : "Coop Scout",
    journey: { errand: offer, cooperative: true },
    sentBinary,
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
    coopPartnerFinding: true,
    discoveryLeaderboard: true,
  });
  const friend = locale === "zh"
    ? {
        name: han(0x5c71, 0x6d77, 0x4f19, 0x4f34),
        targetTown: han(0x82d4, 0x85d3, 0x5c71),
        item: han(0x5305, 0x88f9),
      }
    : { name: "Trail Friend", targetTown: "Moss Hill", item: "a parcel" };
  const friendWait = { targetTown: friend.targetTown, item: friend.item, expiresAt: GROWN_MS + 30_000 };
  pushText({
    type: "socialSnapshot",
    v: 1,
    visible: true,
    friends: [{
      githubId: 22,
      name: friend.name,
      presence: "online",
      realm: "realm-test",
      coopWaiting: { targetTown: friend.targetTown, item: friend.item, expiresAt: friendWait.expiresAt },
    }],
    incoming: [],
    outgoing: [],
  });
  pushText({
    type: "coopFriendWaiting",
    v: 1,
    realm: "realm-test",
    friend: { githubId: 22, name: friend.name },
    ...friendWait,
  });
  pump(world, 2);
  const label = locale === "zh" ? han(0x534f, 0x4f5c) : "COOP";
  const friendNotice = `${label} · ${friend.name} · ${friend.targetTown} · ${friend.item}`;
  if (state()?.notice !== friendNotice || state()?.coopWaitingFriends !== 1) {
    throw new Error(`${locale} ${width}x${height}: friend READY hint mismatch`);
  }
  await coopShot(`coop-${locale}-friend-waiting`, world, width, height, [friendNotice], { blue: 10 });

  press(world, BTN.SELECT);
  press(world, BTN.DOWN);
  if (!state()?.social) throw new Error(`${locale} ${width}x${height}: social panel did not open`);
  press(world, BTN.CIRCLE);
  if (state()?.socialScreen !== "friends") throw new Error(`${locale} ${width}x${height}: friends panel did not open`);
  const friendDetail = locale === "zh" ? han(0x5408, 0x4f5c, 0x7b49, 0x5f85) : "COOP WAIT";
  await coopShot(
    `coop-${locale}-friend-list`,
    world,
    width,
    height,
    ["FRIENDS · realm-test", friend.name, friendDetail],
    { selectedRow: 100 },
  );
  press(world, BTN.CROSS);
  press(world, BTN.CROSS);
  if (state()?.social) throw new Error(`${locale} ${width}x${height}: social panel did not close`);

  pushText({
    type: "coopErrand",
    v: 1,
    realm: "realm-test",
    revision: 100,
    status: "waiting",
    cooperative: true,
    ready: true,
    savedReady: 1,
    presentReady: 1,
    required: 2,
    expiresAt: GROWN_MS + 30_000,
  });
  pump(world, 12);
  const waitingNotice = locale === "zh"
    ? `${label} 1/2 · ${han(0x5c31, 0x7eea)}`
    : "COOP 1/2 · READY";
  if (!state()?.errand.includes(`${label} 1/2`)) {
    throw new Error(`${locale} ${width}x${height}: cooperative HUD is missing: ${JSON.stringify(state()?.errand)}`);
  }
  const remaining = state()?.coopRemaining ?? 0;
  const deadline = locale === "zh"
    ? `${remaining}${han(0x79d2)} · X ${han(0x53d6, 0x6d88)}`
    : `${remaining}s · X CANCEL`;
  if (!state()?.errand.includes(deadline)) {
    throw new Error(`${locale} ${width}x${height}: READY deadline/cancel action is missing`);
  }
  if (remaining < 29 || remaining > 30) throw new Error(`${locale} ${width}x${height}: READY countdown mismatch`);
  if (state()?.notice !== waitingNotice) throw new Error(`${locale} ${width}x${height}: waiting notice mismatch`);
  await coopShot(`coop-${locale}-ready-countdown`, world, width, height, [state()!.errand, waitingNotice]);

  press(world, BTN.CROSS);
  if (sentBinary.at(-1)?.kind !== COMMAND.cancelCoopErrand) {
    throw new Error(`${locale} ${width}x${height}: X did not send cancelCoopErrand`);
  }

  pushText({
    type: "coopErrand",
    v: 1,
    realm: "realm-test",
    revision: 101,
    status: "cancelled",
    cooperative: true,
    ready: false,
    savedReady: 0,
    presentReady: 0,
    required: 2,
    expiresAt: 0,
  });
  pump(world, 12);
  const cancelledNotice = locale === "zh"
    ? `${label} · ${han(0x5df2, 0x53d6, 0x6d88)}`
    : "COOP · CANCELLED";
  if (state()?.coopRemaining !== 0 || state()?.notice !== cancelledNotice) {
    throw new Error(`${locale} ${width}x${height}: cancel acknowledgement mismatch`);
  }
  await coopShot(`coop-${locale}-cancelled`, world, width, height, [state()!.errand, cancelledNotice]);

  pushText({
    type: "coopErrand",
    v: 1,
    realm: "realm-test",
    revision: 102,
    status: "completed",
    cooperative: true,
    ready: false,
    savedReady: 0,
    presentReady: 0,
    required: 2,
    expiresAt: 0,
  });
  pump(world, 12);
  const completedNotice = locale === "zh"
    ? `${label} · ${han(0x5b8c, 0x6210)}`
    : "COOP · COMPLETE";
  if (state()?.notice !== completedNotice) throw new Error(`${locale} ${width}x${height}: completion notice mismatch`);
  await coopShot(`coop-${locale}-completed`, world, width, height, [state()!.errand, completedNotice]);
  world.frame(0);
}

async function coopBoardScene(width: number, height: number, locale: "en" | "zh"): Promise<void> {
  const offer = cooperativeTown();
  const board = plaqueOf(planRegion(SEED, offer.rx, offer.ry));
  if (!board) throw new Error("cooperative board fixture lost its notice board");
  let socket: PocketSocket | null = null;
  const sent: Record<string, unknown>[] = [];
  const world = await boot(realm(board.x, board.y - 1, {
    name: locale === "zh" ? han(0x770b, 0x677f, 0x4eba) : "Board Scout",
    sent,
    onSocket: (value) => { socket = value; },
  }), width, height, locale);
  await enterWorld(world);
  const pushText = (message: Record<string, unknown>): void => {
    socket!.onMessage?.(JSON.stringify(message));
  };
  pushText({
    type: "realmFeatures",
    v: 1,
    realm: "realm-test",
    coopErrands: true,
    coopPartnerFinding: true,
    discoveryLeaderboard: true,
  });
  pump(world, 2);
  press(world, BTN.CIRCLE);
  const query = sent.findLast((message) => message.type === "coopBoardGet");
  if (!query || query.offerRx !== offer.rx || query.offerRy !== offer.ry
    || Object.keys(query).some((key) => ["githubId", "friend", "name", "targetRx", "targetRy"].includes(key))) {
    throw new Error(`${locale} ${width}x${height}: board query was not offer-scoped and anonymous`);
  }
  const response = {
    type: "coopBoard",
    v: 1,
    realm: "realm-test",
    offerRx: offer.rx,
    offerRy: offer.ry,
    waiting: 1,
    required: 2,
  };
  if (Object.keys(response).some((key) => ["githubId", "friend", "name", "targetRx", "targetRy"].includes(key))) {
    throw new Error(`${locale} ${width}x${height}: board count fixture leaked partner data`);
  }
  pushText(response);
  pump(world, 2);
  const line = locale === "zh"
    ? `${han(0x534f, 0x4f5c)} · 1/2 ${han(0x4eba, 0x7b49, 0x5f85)}`
    : "COOP · 1/2 WAITING";
  if (!state()?.dialog) throw new Error(`${locale} ${width}x${height}: board count dialog is closed`);
  await coopShot(`coop-${locale}-board-count`, world, width, height, [line, "O next"], { dialog: 500 });
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

    await coopBoardScene(w, h, "en");
    await coopBoardScene(w, h, "zh");
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
