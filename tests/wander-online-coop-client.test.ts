// tests/wander-online-coop-client.test.ts — additive JSON capability wiring
// in the mounted client: old servers hide Discovery, realm/revision guards
// reject stale data, and equal revisions may authoritatively change listing.
import { describe, expect, test } from "bun:test";
import { BTN } from "@pocketjs/framework/input";
import type { PocketSocket } from "@pocketjs/framework/socket";
import { bootWorld, treeHasText } from "../vendor/pocket-rpgkit/vendor/pocketjs/hosts/sim/sim.ts";
import type { OnlinePublished } from "../examples/wander-online/OnlineView.tsx";
import { appBundle, appPreflight } from "./helpers/boot.ts";
import { fakeOnlineSocketFactory } from "./lib/fake-online-socket.ts";
import { planRegion } from "../examples/wander/region.ts";
import { regionHub } from "../examples/wander/world.ts";
import { townErrand } from "../examples/wander/towns.ts";
import { isCooperativeErrand } from "../examples/wander-online/net/journey.ts";
import { plaqueOf } from "../examples/wander-online/net/npc.ts";
import { COMMAND, type CommandMessage } from "../examples/wander-online/net/protocol.ts";

const preflight = appPreflight("wander-online");
if (!preflight.ok) console.warn(`wander-online co-op client test skipped: ${preflight.reason}`);
const simDescribe = preflight.ok ? describe : describe.skip;

interface World {
  frame: (buttons: number) => void;
  tick: () => void;
  getTree: () => unknown;
  ticksPerFrame: number;
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

const state = (): OnlinePublished | undefined =>
  (globalThis as { __onlineState?: OnlinePublished }).__onlineState;

const SEED = 1593842689;
const GROWN_MS = 10_000_000;

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

const waitFor = async (world: World, predicate: () => boolean, what: string): Promise<void> => {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    pump(world, 1);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timeout waiting for ${what}`);
};

simDescribe("wander-online realm feature client wiring", () => {
  test("a delayed feature cannot turn a cooperative offer into a solo acceptance", async () => {
    const offer = cooperativeTown();
    const hub = regionHub(SEED, offer.rx, offer.ry);
    const sentBinary: CommandMessage[] = [];
    let socket: PocketSocket | null = null;
    const world = await bootWorld(
      appBundle("wander-online"),
      60,
      {
        __onlineUrl: "ws://fake/ws",
        __onlineAuth: { kind: "ticket", ticket: "t1" },
        __onlineSocketFactory: fakeOnlineSocketFactory({
          mode: "welcome4",
          name: "Octo",
          ticket: "t1",
          realm: { id: "realm-test", seed: SEED, tx: hub.x, ty: hub.y, epoch: 5 },
          serverTimeMs: GROWN_MS,
          heartbeat: true,
          sentBinary,
          onSocket: (value) => { socket = value; },
        }),
      },
      undefined,
      { width: 480, height: 272 },
    ) as unknown as World;
    pump(world, 5);
    await waitFor(world, () => state()?.status === "joined", "realm join");
    await waitFor(world, () => (state()?.villagers ?? 0) > 0, "town plan");

    press(world, BTN.CROSS);
    expect(sentBinary).toEqual([]);
    expect(state()?.notice).toBe("CHECKING WORLD FEATURES…");

    socket!.onMessage?.(JSON.stringify({
      type: "realmFeatures", v: 1, realm: "realm-test",
      coopErrands: false, coopPartnerFinding: false, discoveryLeaderboard: false,
    }));
    pump(world, 2);
    press(world, BTN.CROSS);
    expect(sentBinary.at(-1)?.kind).toBe(COMMAND.acceptErrand);

    socket!.onMessage?.(JSON.stringify({
      type: "realmFeatures", v: 1, realm: "realm-test",
      coopErrands: true, coopPartnerFinding: true, discoveryLeaderboard: false,
    }));
    pump(world, 2);
    press(world, BTN.CROSS);
    expect(sentBinary.at(-1)?.kind).toBe(COMMAND.acceptCoopErrand);
  }, 30_000);

  test("board aggregate, friend prompt/list, countdown and cancel remain realm scoped", async () => {
    const offer = cooperativeTown();
    const plan = planRegion(SEED, offer.rx, offer.ry);
    const board = plaqueOf(plan)!;
    const sent: Record<string, unknown>[] = [];
    const sentBinary: CommandMessage[] = [];
    let socket: PocketSocket | null = null;
    const world = await bootWorld(
      appBundle("wander-online"),
      60,
      {
        __onlineUrl: "ws://fake/ws",
        __onlineAuth: { kind: "ticket", ticket: "t1" },
        __onlineSocketFactory: fakeOnlineSocketFactory({
          mode: "welcome4",
          name: "Octo",
          ticket: "t1",
          realm: { id: "realm-test", seed: SEED, tx: board.x, ty: board.y - 1, epoch: 5 },
          serverTimeMs: GROWN_MS,
          heartbeat: true,
          sent,
          sentBinary,
          onSocket: (value) => { socket = value; },
        }),
      },
      undefined,
      { width: 480, height: 272 },
    ) as unknown as World;
    pump(world, 5);
    await waitFor(world, () => state()?.status === "joined", "realm join");
    await waitFor(world, () => (state()?.villagers ?? 0) > 0, "town plan");
    const push = (message: Record<string, unknown>): void => {
      socket!.onMessage?.(JSON.stringify(message));
      pump(world, 2);
    };
    push({
      type: "realmFeatures", v: 1, realm: "realm-test",
      coopErrands: true, coopPartnerFinding: true, discoveryLeaderboard: false,
    });

    press(world, BTN.CIRCLE);
    expect(sent).toContainEqual({ type: "coopBoardGet", v: 1, offerRx: offer.rx, offerRy: offer.ry });
    expect(treeHasText(world.getTree(), "COOP · CHECKING WAITERS…")).toBe(true);
    push({ type: "coopBoard", v: 1, realm: "other", offerRx: offer.rx, offerRy: offer.ry, waiting: 1, required: 2 });
    push({ type: "coopBoard", v: 1, realm: "realm-test", offerRx: offer.rx + 1, offerRy: offer.ry, waiting: 1, required: 2 });
    expect(treeHasText(world.getTree(), "COOP · 1/2 WAITING")).toBe(false);
    push({ type: "coopBoard", v: 1, realm: "realm-test", offerRx: offer.rx, offerRy: offer.ry, waiting: 1, required: 2 });
    expect(treeHasText(world.getTree(), "COOP · 1/2 WAITING")).toBe(true);
    press(world, BTN.CIRCLE);

    const waiting = { targetTown: "Moss Hill", item: "a parcel", expiresAt: GROWN_MS + 30_000 };
    push({
      type: "socialSnapshot", v: 1, visible: true,
      friends: [{ githubId: 22, name: "Alice", presence: "online", realm: "realm-test", coopWaiting: waiting }],
      incoming: [], outgoing: [],
    });
    expect(state()?.coopWaitingFriends).toBe(1);
    push({ type: "coopFriendWaiting", v: 1, realm: "realm-test", friend: { githubId: 22, name: "Alice" }, ...waiting });
    expect(state()?.notice).toBe("COOP · Alice · Moss Hill · a parcel");

    push({
      type: "coopErrand", v: 1, realm: "realm-test", revision: 1,
      status: "waiting", cooperative: true, ready: true, savedReady: 1,
      presentReady: 1, required: 2, expiresAt: GROWN_MS + 30_000,
    });
    pump(world, 6);
    expect(state()?.coopRemaining).toBeGreaterThanOrEqual(29);
    expect(state()?.coopRemaining).toBeLessThanOrEqual(30);
    expect(state()?.errand).toContain("X CANCEL");
    press(world, BTN.CROSS);
    expect(sentBinary.at(-1)?.kind).toBe(COMMAND.cancelCoopErrand);
    expect(state()?.coopRemaining).toBeGreaterThan(0);

    push({
      type: "coopErrand", v: 1, realm: "realm-test", revision: 2,
      status: "cancelled", cooperative: true, ready: false, savedReady: 0,
      presentReady: 0, required: 2, expiresAt: 0,
    });
    expect(state()?.coopRemaining).toBe(0);
    expect(state()?.notice).toBe("COOP · CANCELLED");
    push({ type: "coopFriendWaiting", v: 1, realm: "realm-test", friend: { githubId: 22, name: "Alice" }, ...waiting });
    expect(state()?.notice, "the same READY deadline is not announced twice").toBe("COOP · CANCELLED");

    press(world, BTN.SELECT);
    press(world, BTN.DOWN);
    press(world, BTN.CIRCLE);
    expect(treeHasText(world.getTree(), "COOP WAIT")).toBe(true);
  }, 30_000);

  test("Discovery refresh and listing obey capability, realm and monotonic revision", async () => {
    let socket: PocketSocket | null = null;
    const sent: Record<string, unknown>[] = [];
    const factory = fakeOnlineSocketFactory({
      mode: "welcome4",
      name: "Octo",
      ticket: "t1",
      realm: { id: "realm-test", seed: 1593842689, tx: 438, ty: 42, epoch: 5 },
      heartbeat: true,
      sent,
      onSocket: (value) => { socket = value; },
    });
    (globalThis as { __onlineState?: OnlinePublished }).__onlineState = undefined;
    const world = await bootWorld(
      appBundle("wander-online"),
      60,
      {
        __onlineUrl: "ws://fake/ws",
        __onlineAuth: { kind: "ticket", ticket: "t1" },
        __onlineSocketFactory: factory,
        __onlineLocale: "zh-CN",
      },
      undefined,
      { width: 480, height: 272 },
    ) as unknown as World;
    pump(world, 5);
    await waitFor(world, () => state()?.status === "joined", "realm join");
    pump(world, 4);
    const push = (message: Record<string, unknown>): void => {
      socket!.onMessage?.(JSON.stringify(message));
      pump(world, 2);
    };

    // A wrong-realm advertisement does not add the route and refresh stays
    // compatible with an old server (the existing three requests only).
    push({ type: "realmFeatures", v: 1, realm: "other-realm", coopErrands: true, discoveryLeaderboard: true });
    press(world, BTN.SELECT);
    press(world, BTN.DOWN);
    expect(state()?.socialScreen).toBe("home");
    expect(sent.some((message) => message.type === "leaderboardGet")).toBe(false);

    // A valid capability received while the panel is open immediately asks
    // for its private/public snapshot, and uses the injected Chinese locale.
    push({ type: "realmFeatures", v: 1, realm: "realm-test", coopErrands: true, discoveryLeaderboard: true });
    expect(sent.filter((message) => message.type === "leaderboardGet")).toEqual([
      { type: "leaderboardGet", v: 1 },
    ]);
    const discovery = String.fromCodePoint(0x53d1, 0x73b0, 0x699c);
    expect(treeHasText(world.getTree(), discovery)).toBe(true);

    push({
      type: "discoveryLeaderboard", v: 1, realm: "realm-test", revision: 5, listed: false,
      mine: { rank: 9, firsts: 3 }, leaders: [{ rank: 1, name: "Alice", firsts: 10 }],
    });
    press(world, BTN.DOWN);
    press(world, BTN.DOWN);
    press(world, BTN.CIRCLE);
    expect(state()?.socialScreen).toBe("discovery");
    const you = String.fromCodePoint(0x4f60);
    expect(treeHasText(world.getTree(), `${you} · #9`)).toBe(true);
    expect(treeHasText(world.getTree(), "#1 Alice")).toBe(true);

    press(world, BTN.TRIANGLE);
    push({
      type: "discoveryLeaderboard", v: 1, realm: "realm-test", revision: 4, listed: true,
      mine: { rank: 99, firsts: 0 }, leaders: [],
    });
    press(world, BTN.TRIANGLE);
    push({
      type: "discoveryLeaderboard", v: 1, realm: "realm-test", revision: 5, listed: true,
      mine: { rank: 9, firsts: 3 }, leaders: [{ rank: 1, name: "Alice", firsts: 10 }],
    });
    press(world, BTN.TRIANGLE);
    push({
      type: "discoveryLeaderboard", v: 1, realm: "other-realm", revision: 6, listed: false,
      mine: { rank: 1, firsts: 99 }, leaders: [],
    });
    press(world, BTN.TRIANGLE);
    expect(sent.filter((message) => message.type === "leaderboardSet")).toEqual([
      { type: "leaderboardSet", listed: true, v: 1 },
      { type: "leaderboardSet", listed: true, v: 1 },
      { type: "leaderboardSet", listed: false, v: 1 },
      { type: "leaderboardSet", listed: false, v: 1 },
    ]);
  }, 30_000);
});
