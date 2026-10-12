// tests/wander-online-daily-goal-view.test.ts — capability-gated daily goals
// on the online HUD and every town notice board.
import { describe, expect, test } from "bun:test";
import { BTN } from "@pocketjs/framework/input";
import type { PocketSocket } from "@pocketjs/framework/socket";
import { bootWorld, treeHasText } from "../vendor/pocket-rpgkit/vendor/pocketjs/hosts/sim/sim.ts";
import { appBundle, appPreflight } from "./helpers/boot.ts";
import { fakeOnlineSocketFactory, type FakeOnlineOpts } from "./lib/fake-online-socket.ts";
import { dailyGoalLayout } from "../examples/wander-online/hud.ts";
import type { OnlinePublished } from "../examples/wander-online/OnlineView.tsx";
import { encodeWelcome4 } from "../examples/wander-online/net/protocol.ts";
import {
  formatDailyGoal,
  generateDailyGoal,
  type DailyGoalSnapshot,
} from "../examples/wander-online/shared/daily-goal.ts";
import { SOCIAL_PROTOCOL_VERSION } from "../examples/wander-online/shared/social.ts";

const preflight = appPreflight("wander-online");
if (!preflight.ok) console.warn(`wander-online daily-goal view tests skipped: ${preflight.reason}`);
const simDescribe = preflight.ok ? describe : describe.skip;

const SEED = 1593842689;
const REALM = "realm-test";
const TOWN = { board: { x: 439, y: 43 } };
const GROWN_MS = 10_000_000;

interface World {
  frame: (buttons: number) => void;
  tick: () => void;
  getTree: () => unknown;
  ticksPerFrame: number;
}

interface Fixture {
  opts: FakeOnlineOpts;
  socket: () => PocketSocket;
}

function fixture(): Fixture {
  let socket: PocketSocket | null = null;
  return {
    opts: {
      mode: "welcome4",
      name: "Octo",
      look: 3,
      ticket: "t1",
      realm: { tx: TOWN.board.x, ty: TOWN.board.y - 1, seed: SEED, epoch: 5, id: REALM },
      serverTimeMs: GROWN_MS,
      heartbeat: true,
      onSocket: (value) => { socket = value; },
    },
    socket: () => socket!,
  };
}

async function boot(opts: FakeOnlineOpts, width = 480, height = 272, locale = "en"): Promise<World> {
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

const state = (): OnlinePublished => (globalThis as { __onlineState?: OnlinePublished }).__onlineState!;

const waitFor = async (world: World, predicate: () => boolean, what: string): Promise<void> => {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    pump(world, 1);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timeout waiting for ${what}`);
};

async function enterWorld(world: World): Promise<void> {
  pump(world, 5);
  await waitFor(world, () => state()?.status === "joined", "v4 joined");
  await waitFor(world, () => (state()?.villagers ?? 0) > 0, "town residents");
  pump(world, 6);
}

function pushText(f: Fixture, message: Record<string, unknown>): void {
  f.socket().onMessage?.(JSON.stringify(message));
}

function features(dailyGoals: boolean): Record<string, unknown> {
  return {
    type: "realmFeatures",
    v: SOCIAL_PROTOCOL_VERSION,
    realm: REALM,
    coopErrands: false,
    coopPartnerFinding: false,
    discoveryLeaderboard: false,
    dailyGoals,
  };
}

function snapshot(day: number, overrides: Partial<DailyGoalSnapshot> = {}): DailyGoalSnapshot {
  const goal = generateDailyGoal(SEED, REALM, day);
  return {
    ...goal,
    progress: 0,
    completed: false,
    contributed: false,
    contributionDays: [],
    revision: 0,
    ...overrides,
  };
}

function dailyMessage(goal: DailyGoalSnapshot, completedNow = false): Record<string, unknown> {
  return { type: "dailyGoal", v: SOCIAL_PROTOCOL_VERSION, ...goal, completedNow };
}

const measure = (text: string): number =>
  (globalThis as unknown as { ui: { measureText(value: string, slot: number): number } }).ui.measureText(text, 0);

simDescribe("wander-online daily-goal client", () => {
  test("accepts only current capable snapshots, stays monotonic within a day, rolls over, and clears on realm change", async () => {
    const f = fixture();
    const world = await boot(f.opts);
    await enterWorld(world);
    const day0 = snapshot(0, { progress: 1, revision: 4 });

    // A valid-looking payload is still ignored until this realm advertises
    // the additive capability, and future protocol versions fail closed.
    pushText(f, dailyMessage(day0));
    pump(world, 1);
    expect(state().dailyGoal).toBeNull();
    pushText(f, features(true));
    pushText(f, { ...dailyMessage(day0), v: SOCIAL_PROTOCOL_VERSION + 1 });
    pump(world, 1);
    expect(state().dailyGoal).toBeNull();

    pushText(f, dailyMessage(day0));
    pump(world, 1);
    expect(state().dailyGoal?.progress).toBe(1);
    expect(state().dailyGoalText).toBe(formatDailyGoal(day0, "en"));

    // Neither an older revision nor an equal-revision mutation may roll the
    // current day's aggregate backward or sideways.
    pushText(f, dailyMessage({ ...day0, progress: 0, revision: 3 }));
    pushText(f, dailyMessage({ ...day0, progress: 2, revision: 4 }));
    pushText(f, dailyMessage({ ...day0, realm: "other-realm", revision: 5 }));
    pump(world, 1);
    expect(state().dailyGoal?.progress).toBe(1);
    expect(state().dailyGoal?.revision).toBe(4);

    const advanced = { ...day0, progress: 2, revision: 5 };
    pushText(f, dailyMessage(advanced));
    pump(world, 1);
    expect(state().dailyGoal?.progress).toBe(2);

    // A new UTC day is a new monotonic sequence, so revision zero is valid;
    // a delayed message from yesterday remains rejected afterward.
    const day1 = snapshot(1);
    pushText(f, dailyMessage(day1));
    pushText(f, dailyMessage({ ...day0, revision: 100 }));
    pump(world, 1);
    expect(state().dailyGoal?.day).toBe(1);
    expect(state().dailyGoal?.revision).toBe(0);

    // A fresh realm admission clears every prior realm's daily surface.
    f.socket().onMessage?.(new Uint8Array(encodeWelcome4({
      you: 1,
      seed: SEED,
      generatorVersion: 1,
      epoch: 6,
      realmId: "other-realm",
      realmRevision: 0,
      serverTimeMs: GROWN_MS,
      mover: { tx: 0, ty: 0, px: 0, py: 0, dir: 0, phase: 0, stepDir: 0, moving: false, walking: false },
    })));
    pump(world, 1);
    expect(state().dailyGoal).toBeNull();
    expect(state().dailyGoalText).toBe("");
    expect(state().dailyGoalRemaining).toBe(0);
  }, 30_000);

  test("completion notices require completedNow and dedupe an exact goal revision", async () => {
    const f = fixture();
    const world = await boot(f.opts);
    await enterWorld(world);
    pushText(f, features(true));
    const base = snapshot(0);
    const complete = snapshot(0, {
      progress: base.required,
      completed: true,
      contributed: true,
      contributionDays: [0],
      revision: 7,
    });

    pushText(f, dailyMessage(complete, false));
    pump(world, 1);
    expect(state().notice).toBe("");
    pushText(f, dailyMessage(complete, true));
    pump(world, 1);
    expect(state().notice).toBe(`DAILY COMPLETE · ${complete.targetName}`);

    globalThis.__pocketAuthCommand?.("inviteEnd");
    pump(world, 1);
    expect(state().notice).toBe("");
    pushText(f, dailyMessage(complete, true));
    pump(world, 1);
    expect(state().notice).toBe("");
  }, 30_000);

  for (const [width, height] of [[480, 272], [960, 544]] as const) {
    for (const locale of ["en", "zh"] as const) {
      test(`${width}x${height}: ${locale} HUD and ordinary notice board show the complete daily copy without truncation`, async () => {
        const f = fixture();
        const world = await boot(f.opts, width, height, locale);
        await enterWorld(world);
        pushText(f, features(true));
        const goal = snapshot(0, { progress: 2, revision: 1 });
        pushText(f, dailyMessage(goal));
        pump(world, 7);

        const layout = dailyGoalLayout(width, height);
        const expected = formatDailyGoal(goal, locale);
        expect(state().dailyGoalText).toBe(expected);
        expect(treeHasText(world.getTree(), expected)).toBe(true);
        expect(treeHasText(world.getTree(), state().dailyGoalCountdown)).toBe(true);
        expect(measure(expected)).toBeLessThanOrEqual(layout.goalText.x1 - layout.goalText.x0);
        expect(measure(state().dailyGoalCountdown)).toBeLessThanOrEqual(layout.countdownText.x1 - layout.countdownText.x0);

        // Partner finding is disabled, proving the daily line is not limited
        // to the co-op-board branch.
        press(world, BTN.CIRCLE);
        expect(state().dialog).toBe(true);
        expect(treeHasText(world.getTree(), expected)).toBe(true);
      }, 30_000);
    }
  }
});
