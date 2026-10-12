// Mounted player-card and achievement-notice acceptance on the deterministic
// PocketJS sim host. The server remains authoritative; this exercises the
// strict client boundary, modal input, replay dedupe and touch route.

import { describe, expect, test } from "bun:test";
import { BTN } from "@pocketjs/framework/input";
import type { PocketSocket } from "@pocketjs/framework/socket";
import { __packTouch } from "../vendor/pocket-rpgkit/vendor/pocketjs/framework/src/touch.ts";
import { treeHasText } from "../vendor/pocket-rpgkit/vendor/pocketjs/hosts/sim/sim.ts";
import { appBundle, appPreflight } from "./helpers/boot.ts";
import { fakeOnlineSocketFactory, type FakeOnlineOpts } from "./lib/fake-online-socket.ts";
import { socialPanelLayout, socialPanelRowRect } from "../examples/wander-online/social-model.ts";
import { SOCIAL_PROTOCOL_VERSION } from "../examples/wander-online/shared/social.ts";
import type { OnlinePublished } from "../examples/wander-online/OnlineView.tsx";

const preflight = appPreflight("wander-online");
if (!preflight.ok) console.warn(`wander-online profile view tests skipped: ${preflight.reason}`);
const simDescribe = preflight.ok ? describe : describe.skip;

interface World {
  frame: (buttons: number, analog?: number, touches?: readonly number[]) => void;
  tick: () => void;
  getTree: () => unknown;
  ticksPerFrame: number;
}

interface Fixture {
  opts: FakeOnlineOpts;
  sent: Record<string, unknown>[];
  socket: () => PocketSocket;
}

function fixture(): Fixture {
  const sent: Record<string, unknown>[] = [];
  let socket: PocketSocket | null = null;
  return {
    sent,
    socket: () => socket!,
    opts: {
      mode: "welcome4",
      name: "Alice",
      look: 7,
      ticket: "t1",
      realm: { id: "realm-test", tx: 640, ty: -640, seed: 0x5eed_0001, epoch: 7 },
      heartbeat: true,
      sent,
      onSocket: (value) => { socket = value; },
    },
  };
}

async function boot(f: Fixture, locale = "en", width = 480, height = 272): Promise<World> {
  (globalThis as { __onlineState?: OnlinePublished }).__onlineState = undefined;
  const { bootWorld } = await import("../vendor/pocket-rpgkit/vendor/pocketjs/hosts/sim/sim.ts");
  return await bootWorld(
    appBundle("wander-online"),
    60,
    {
      __onlineUrl: "ws://fake/ws",
      __onlineAuth: { kind: "ticket", ticket: "t1" },
      __onlineSocketFactory: fakeOnlineSocketFactory(f.opts),
      __onlineLocale: locale,
    },
    undefined,
    { width, height },
  ) as unknown as World;
}

function pump(world: World, frames: number, buttons = 0, touches?: readonly number[]): void {
  for (let frame = 0; frame < frames; frame++) {
    world.frame(buttons, undefined, touches);
    for (let tick = 0; tick < world.ticksPerFrame; tick++) world.tick();
  }
}

function press(world: World, button: number): void {
  pump(world, 1, button);
  pump(world, 1);
}

function tap(world: World, x: number, y: number): void {
  pump(world, 1, 0, [__packTouch(9, x, y)]);
  pump(world, 1, 0, []);
}

const state = (): OnlinePublished =>
  (globalThis as { __onlineState?: OnlinePublished }).__onlineState!;

async function waitFor(world: World, predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    pump(world, 1);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timeout waiting for ${what}`);
}

function push(f: Fixture, message: Record<string, unknown>): void {
  f.socket().onMessage?.(JSON.stringify(message));
}

function features(enabled = true): Record<string, unknown> {
  return {
    type: "realmFeatures",
    v: SOCIAL_PROTOCOL_VERSION,
    realm: "realm-test",
    coopErrands: false,
    discoveryLeaderboard: false,
    playerProfiles: enabled,
  };
}

function card(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "profileSnapshot",
    v: SOCIAL_PROTOCOL_VERSION,
    self: true,
    card: {
      name: "Alice",
      look: 7,
      joinedAt: Date.UTC(2026, 9, 12) / 1000,
      achievements: ["errands-1"],
      showcasePostmark: "Old Stones",
      postmarkOptions: ["Old Stones", "Lone Tower"],
    },
    newAchievements: [],
    ...overrides,
  };
}

async function enter(world: World, f: Fixture): Promise<void> {
  pump(world, 5);
  await waitFor(world, () => state()?.status === "joined", "realm admission");
  push(f, features(true));
  pump(world, 2);
}

simDescribe("wander-online mounted player cards", () => {
  test("controller opens self and friend cards, ignores forged payloads, and preserves friend requests across owner refreshes", async () => {
    const f = fixture();
    const world = await boot(f);
    await enter(world, f);
    push(f, {
      type: "socialSnapshot", v: SOCIAL_PROTOCOL_VERSION, visible: true,
      friends: [{ githubId: 22, name: "Bob", presence: "offline", realm: null }],
      incoming: [], outgoing: [],
    });
    pump(world, 1);

    press(world, BTN.SELECT);
    press(world, BTN.DOWN);
    press(world, BTN.DOWN);
    press(world, BTN.DOWN);
    press(world, BTN.CIRCLE);
    expect(state().socialScreen).toBe("profile");
    expect(f.sent.at(-1)).toEqual({ type: "profileGet", githubId: null, v: SOCIAL_PROTOCOL_VERSION });

    // Unknown achievement ids are client forgery and cannot enter the card.
    push(f, card({
      card: {
        name: "Forged", look: 63, joinedAt: 1,
        achievements: ["client-god-mode"], showcasePostmark: null, postmarkOptions: [],
      },
    }));
    pump(world, 1);
    expect(treeHasText(world.getTree(), "Forged")).toBe(false);
    expect(treeHasText(world.getTree(), "CARD UNAVAILABLE")).toBe(true);

    push(f, card());
    pump(world, 2);
    expect(treeHasText(world.getTree(), "Alice")).toBe(true);
    expect(treeHasText(world.getTree(), "2026-10-12")).toBe(true);
    expect(treeHasText(world.getTree(), "First Bloom")).toBe(true);
    expect(treeHasText(world.getTree(), "Old Stones")).toBe(true);

    // Owner-only stamp cycling is sent as a choice, never as a forged option set.
    press(world, BTN.DOWN);
    press(world, BTN.DOWN);
    press(world, BTN.CIRCLE);
    expect(f.sent.at(-1)).toEqual({
      type: "profilePostmarkSet", postmark: "Lone Tower", v: SOCIAL_PROTOCOL_VERSION,
    });

    press(world, BTN.CROSS); // profile -> home
    press(world, BTN.CIRCLE); // friends
    press(world, BTN.TRIANGLE); // Bob's card
    expect(f.sent.at(-1)).toEqual({ type: "profileGet", githubId: 22, v: SOCIAL_PROTOCOL_VERSION });

    // An achievement-triggered owner refresh must not replace the friend card
    // response currently in flight.
    push(f, card({ newAchievements: ["errands-1"] }));
    pump(world, 1);
    expect(treeHasText(world.getTree(), "CARD UNAVAILABLE")).toBe(true);
    expect(treeHasText(world.getTree(), "Old Stones")).toBe(false);
    push(f, card({
      self: false,
      card: {
        name: "Bob", look: 19, joinedAt: Date.UTC(2025, 0, 2) / 1000,
        achievements: ["sightings-1"], showcasePostmark: null, postmarkOptions: [],
      },
      newAchievements: [],
    }));
    pump(world, 2);
    expect(treeHasText(world.getTree(), "Bob")).toBe(true);
    expect(treeHasText(world.getTree(), "Eyes on the Horizon")).toBe(true);

    // Friendship can disappear between list load and card read: the server's
    // forbidden response clears the card instead of retaining stale data.
    press(world, BTN.CROSS);
    press(world, BTN.TRIANGLE);
    push(f, { type: "profileError", v: SOCIAL_PROTOCOL_VERSION, reason: "forbidden" });
    pump(world, 2);
    expect(treeHasText(world.getTree(), "Bob")).toBe(false);
    expect(state().notice).toBe("PLAYER CARD: FRIENDS ONLY");
  }, 30_000);

  test("server unlock edges queue once, and a replay cannot create a second notice", async () => {
    const f = fixture();
    const world = await boot(f);
    await enter(world, f);
    const unlock = card({ newAchievements: ["errands-1"] });
    push(f, unlock);
    pump(world, 1);
    expect(state().notice).toBe("ACHIEVEMENT · First Bloom");
    push(f, unlock);
    pump(world, 1);
    globalThis.__pocketAuthCommand?.("inviteEnd");
    pump(world, 2);
    expect(state().notice).toBe("");

    push(f, card({
      card: {
        name: "Alice", look: 7, joinedAt: Date.UTC(2026, 9, 12) / 1000,
        achievements: ["errands-1", "errands-5", "errands-25"],
        showcasePostmark: null, postmarkOptions: [],
      },
      newAchievements: ["errands-5", "errands-25"],
    }));
    pump(world, 1);
    expect(state().notice).toBe("ACHIEVEMENT · Roadside Kindness");
    globalThis.__pocketAuthCommand?.("inviteEnd");
    pump(world, 1);
    expect(state().notice).toBe("ACHIEVEMENT · A Road Remembered");
  }, 30_000);

  test("touch opens the owner card route and the footer returns without movement input", async () => {
    const f = fixture();
    const world = await boot(f);
    await enter(world, f);
    press(world, BTN.SELECT);
    press(world, BTN.DOWN);
    const layout = socialPanelLayout(480, 272);
    const profile = socialPanelRowRect(layout, 2);
    tap(world, profile.x + profile.w / 2, profile.y + profile.h / 2);
    expect(state().socialScreen).toBe("profile");
    expect(f.sent.at(-1)).toEqual({ type: "profileGet", githubId: null, v: SOCIAL_PROTOCOL_VERSION });
    push(f, card());
    pump(world, 1);
    tap(world, layout.footer.x + 4, layout.footer.y + 4);
    expect(state().socialScreen).toBe("home");
  }, 30_000);
});
