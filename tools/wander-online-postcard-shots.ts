// Capture the mounted post-office controller in both supported locales and
// desktop viewports. Each native frame has a nearest-neighbour 3x inspection
// copy, plus machine-readable text-fit and semantic-colour evidence.
//
//   bun tools/wander-online-postcard-shots.ts [outdir]

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BTN } from "@pocketjs/framework/input";
import type { PocketSocket } from "@pocketjs/framework/socket";
import { bootWorld, treeHasText } from "../vendor/pocket-rpgkit/vendor/pocketjs/hosts/sim/sim.ts";
import { encodePNG } from "../vendor/pocket-rpgkit/vendor/pocketjs/tests/png.ts";
import type { OnlinePublished } from "../examples/wander-online/OnlineView.tsx";
import { postcardPanelLayout, type PostcardRect } from "../examples/wander-online/postcard-model.ts";
import { formatPostcardSentence, type PostcardLocale } from "../examples/wander-online/shared/postcard.ts";
import { appBundle } from "../tests/helpers/boot.ts";
import { fakeOnlineSocketFactory, type FakeOnlineOpts } from "../tests/lib/fake-online-socket.ts";

const OUT = resolve(process.argv[2] ?? "dist/wander-online-postcard-shots");
const SEED = 1593842689;
const REALM = "realm-test";
const BOARD = { x: 439, y: 43 };
const SERVER_TIME_MS = 10_000_000;

// These exact opaque colours are the presentation contract in PostcardPanel.
// Restricting counts to the panel prevents the underlying world from
// satisfying a check accidentally.
const SEMANTIC_COLOURS = {
  panel: "#17243b",
  title: "#ffe17a",
  ink: "#e8efff",
  accent: "#9fd0ff",
  selected: "#354968",
} as const;

const MIN_SEMANTIC_PIXELS: Record<keyof typeof SEMANTIC_COLOURS, number> = {
  panel: 500,
  title: 20,
  ink: 4,
  accent: 4,
  selected: 100,
};

type Scene = "unread" | "read" | "review";
type FitRegion = "header" | "label" | "detail" | "body";

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

interface FitExpectation {
  text: string;
  region: FitRegion;
}

interface FitEvidence extends FitExpectation {
  width: number;
  available: number;
}

interface SceneEvidence {
  locale: PostcardLocale;
  viewport: string;
  scene: Scene;
  requiredText: readonly string[];
  fit: FitEvidence[];
  semanticPixels: Record<keyof typeof SEMANTIC_COLOURS, number>;
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
      ticket: "postcard-shot-ticket",
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
      if (!socket) throw new Error("postcard fixture socket is not connected");
      return socket;
    },
  };
}

async function boot(opts: FakeOnlineOpts, width: number, height: number, locale: PostcardLocale): Promise<World> {
  (globalThis as { __onlineState?: OnlinePublished }).__onlineState = undefined;
  return (await bootWorld(
    appBundle("wander-online"),
    60,
    {
      __onlineUrl: "ws://fake/ws",
      __onlineAuth: { kind: "ticket", ticket: "postcard-shot-ticket" },
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
  throw new Error(`postcard shots: timed out waiting for ${what}`);
}

async function enterWorld(world: World): Promise<void> {
  pump(world, 5);
  await waitFor(world, () => state()?.status === "joined", "realm admission");
  await waitFor(world, () => (state()?.villagers ?? 0) > 0, "town plan");
  pump(world, 6);
}

function pushText(world: World, f: Fixture, message: Record<string, unknown>): void {
  f.socket().onMessage?.(JSON.stringify(message));
  pump(world, 2);
}

function scale3(source: Uint8Array, width: number, height: number): Uint8Array {
  const scaledWidth = width * 3;
  const scaled = new Uint8Array(scaledWidth * height * 3 * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sourceIndex = (y * width + x) * 4;
      for (let dy = 0; dy < 3; dy++) {
        for (let dx = 0; dx < 3; dx++) {
          const targetIndex = ((y * 3 + dy) * scaledWidth + x * 3 + dx) * 4;
          scaled[targetIndex] = source[sourceIndex]!;
          scaled[targetIndex + 1] = source[sourceIndex + 1]!;
          scaled[targetIndex + 2] = source[sourceIndex + 2]!;
          scaled[targetIndex + 3] = 255;
        }
      }
    }
  }
  return scaled;
}

function countColor(
  framebuffer: Uint8Array,
  width: number,
  height: number,
  rect: PostcardRect,
  hex: string,
): number {
  const red = Number.parseInt(hex.slice(1, 3), 16);
  const green = Number.parseInt(hex.slice(3, 5), 16);
  const blue = Number.parseInt(hex.slice(5, 7), 16);
  let count = 0;
  for (let y = Math.max(0, Math.floor(rect.y)); y < Math.min(height, Math.ceil(rect.y + rect.h)); y++) {
    for (let x = Math.max(0, Math.floor(rect.x)); x < Math.min(width, Math.ceil(rect.x + rect.w)); x++) {
      const offset = (y * width + x) * 4;
      if (framebuffer[offset] === red
        && framebuffer[offset + 1] === green
        && framebuffer[offset + 2] === blue) count++;
    }
  }
  return count;
}

function measure(text: string): number {
  return (globalThis as unknown as { ui: { measureText: (value: string, slot: number) => number } })
    .ui.measureText(text, 0);
}

function fitAvailable(region: FitRegion, width: number, height: number): number {
  const layout = postcardPanelLayout(width, height);
  switch (region) {
    case "header": return layout.header.w;
    case "label": return Math.max(0, layout.labelWidth - 6 * layout.scale);
    case "detail": return Math.max(0, layout.detailWidth - 8 * layout.scale);
    case "body": return Math.max(0, layout.body.w - 12 * layout.scale);
  }
}

function writeShot(name: string, width: number, height: number, framebuffer: Uint8Array): string[] {
  const native = `${name}.${width}x${height}.png`;
  const zoomed = `${name}.${width}x${height}-3x.png`;
  writeFileSync(join(OUT, native), encodePNG(framebuffer, width, height));
  writeFileSync(join(OUT, zoomed), encodePNG(scale3(framebuffer, width, height), width * 3, height * 3));
  console.log(`${native} + ${zoomed}`);
  return [native, zoomed];
}

function capture(
  world: World,
  width: number,
  height: number,
  locale: PostcardLocale,
  scene: Scene,
  requiredText: readonly string[],
  expectedFit: readonly FitExpectation[],
): void {
  const expectedScreen = scene === "unread" ? "inbox" : scene;
  if (state()?.postcardScreen !== expectedScreen) {
    throw new Error(`${locale} ${width}x${height}: expected ${expectedScreen} controller screen`);
  }
  const tree = world.getTree();
  for (const text of requiredText) {
    if (!treeHasText(tree, text)) {
      throw new Error(`${locale} ${width}x${height} ${scene}: missing text ${JSON.stringify(text)}`);
    }
  }

  const fit = expectedFit.map((expectation): FitEvidence => {
    const widthUsed = measure(expectation.text);
    const available = fitAvailable(expectation.region, width, height);
    if (widthUsed > available) {
      throw new Error(
        `${locale} ${width}x${height} ${scene}: ${JSON.stringify(expectation.text)} `
        + `uses ${widthUsed}px in a ${available}px ${expectation.region}`,
      );
    }
    return { ...expectation, width: widthUsed, available };
  });

  const framebuffer = world.render();
  const panel = postcardPanelLayout(width, height).panel;
  const semanticPixels = Object.fromEntries(
    Object.entries(SEMANTIC_COLOURS).map(([name, hex]) => [
      name,
      countColor(framebuffer, width, height, panel, hex),
    ]),
  ) as Record<keyof typeof SEMANTIC_COLOURS, number>;
  for (const name of Object.keys(SEMANTIC_COLOURS) as Array<keyof typeof SEMANTIC_COLOURS>) {
    if (semanticPixels[name] < MIN_SEMANTIC_PIXELS[name]) {
      throw new Error(
        `${locale} ${width}x${height} ${scene}: ${name} ${SEMANTIC_COLOURS[name]} `
        + `painted ${semanticPixels[name]} pixels; expected at least ${MIN_SEMANTIC_PIXELS[name]}`,
      );
    }
  }

  const files = writeShot(`postcard-${locale}-${scene}`, width, height, framebuffer);
  report.push({
    locale,
    viewport: `${width}x${height}`,
    scene,
    requiredText,
    fit,
    semanticPixels,
    files,
  });
}

function copy(locale: PostcardLocale) {
  const sentence = formatPostcardSentence("thanks", locale);
  const greeting = formatPostcardSentence("hello", locale);
  if (locale === "zh") {
    return {
      unread: {
        required: ["信箱", "Alice", "未读", "Carol", "已读"],
        fit: [
          { text: "信箱", region: "header" },
          { text: "Alice", region: "label" },
          { text: "未读", region: "detail" },
          { text: "Carol", region: "label" },
          { text: "已读", region: "detail" },
        ],
      },
      read: {
        required: ["信箱", "寄件人", "Alice", sentence, "邮戳: Ancient Tree"],
        fit: [
          { text: "信箱", region: "header" },
          { text: "寄件人", region: "label" },
          { text: "Alice", region: "detail" },
          { text: sentence, region: "body" },
          { text: "邮戳: Ancient Tree", region: "body" },
        ],
      },
      review: {
        required: ["确认明信片", "收件人", "Bob", `正文: ${greeting}`, "邮戳: 不附邮戳", "确认寄出"],
        fit: [
          { text: "确认明信片", region: "header" },
          { text: "收件人", region: "label" },
          { text: "Bob", region: "detail" },
          { text: `正文: ${greeting}`, region: "body" },
          { text: "邮戳: 不附邮戳", region: "body" },
          { text: "确认寄出", region: "body" },
        ],
      },
    } as const;
  }
  return {
    unread: {
      required: ["MAILBOX", "Alice", "NEW", "Carol", "READ"],
      fit: [
        { text: "MAILBOX", region: "header" },
        { text: "Alice", region: "label" },
        { text: "NEW", region: "detail" },
        { text: "Carol", region: "label" },
        { text: "READ", region: "detail" },
      ],
    },
    read: {
      required: ["MAILBOX", "FROM", "Alice", sentence, "POSTMARK: Ancient Tree"],
      fit: [
        { text: "MAILBOX", region: "header" },
        { text: "FROM", region: "label" },
        { text: "Alice", region: "detail" },
        { text: sentence, region: "body" },
        { text: "POSTMARK: Ancient Tree", region: "body" },
      ],
    },
    review: {
      required: [
        "REVIEW POSTCARD",
        "TO",
        "Bob",
        `MESSAGE: ${greeting}`,
        "POSTMARK: NO POSTMARK",
        "SEND NOW",
      ],
      fit: [
        { text: "REVIEW POSTCARD", region: "header" },
        { text: "TO", region: "label" },
        { text: "Bob", region: "detail" },
        { text: `MESSAGE: ${greeting}`, region: "body" },
        { text: "POSTMARK: NO POSTMARK", region: "body" },
        { text: "SEND NOW", region: "body" },
      ],
    },
  } as const;
}

async function captureViewport(width: number, height: number, locale: PostcardLocale): Promise<void> {
  const f = fixture();
  const world = await boot(f.opts, width, height, locale);
  await enterWorld(world);

  pushText(world, f, {
    type: "realmFeatures",
    v: 1,
    realm: REALM,
    coopErrands: false,
    coopPartnerFinding: false,
    discoveryLeaderboard: false,
    dailyGoals: false,
    postcards: true,
  });
  pushText(world, f, {
    type: "postcardStatus",
    v: 1,
    revision: 2,
    unread: 1,
    total: 2,
    dailyRemaining: 4,
  });

  press(world, BTN.CROSS);
  if (!state()?.postcard || state()?.postcardScreen !== "home") {
    throw new Error(`${locale} ${width}x${height}: town post office did not open`);
  }
  pushText(world, f, {
    type: "socialSnapshot",
    v: 1,
    visible: true,
    friends: [{ githubId: 7, name: "Bob", presence: "offline", realm: null }],
    incoming: [],
    outgoing: [],
  });
  pushText(world, f, {
    type: "postcardMailbox",
    v: 1,
    revision: 2,
    unread: 1,
    total: 2,
    dailyRemaining: 4,
    postcards: [
      {
        id: "pc_unread1234",
        senderName: "Alice",
        sentenceId: "thanks",
        postmark: "Ancient Tree",
        sentAt: 1_000_000,
        expiresAt: 20_000_000,
        read: false,
      },
      {
        id: "pc_read5678",
        senderName: "Carol",
        sentenceId: "memory",
        postmark: null,
        sentAt: 900_000,
        expiresAt: 20_000_000,
        read: true,
      },
    ],
  });

  const words = copy(locale);
  press(world, BTN.CIRCLE); // home -> inbox
  capture(world, width, height, locale, "unread", words.unread.required, words.unread.fit);

  press(world, BTN.CIRCLE); // unread postcard -> read
  capture(world, width, height, locale, "read", words.read.required, words.read.fit);

  press(world, BTN.CROSS); // read -> inbox
  press(world, BTN.CROSS); // inbox -> home
  press(world, BTN.DOWN); // SEND A POSTCARD
  press(world, BTN.CIRCLE); // recipients
  press(world, BTN.CIRCLE); // Bob
  press(world, BTN.CIRCLE); // default greeting
  press(world, BTN.CIRCLE); // no postmark
  capture(world, width, height, locale, "review", words.review.required, words.review.fit);
  world.frame(0);
}

mkdirSync(OUT, { recursive: true });
for (const [width, height] of [[480, 272], [960, 544]] as const) {
  for (const locale of ["en", "zh"] as const) await captureViewport(width, height, locale);
}
writeFileSync(join(OUT, "report.json"), `${JSON.stringify({
  verdict: "PASS",
  scale: 3,
  seed: SEED,
  realm: REALM,
  semanticColours: SEMANTIC_COLOURS,
  scenes: report,
}, null, 2)}\n`);
console.log(`PASS: ${report.length} bilingual postcard scenes captured in ${OUT}`);
