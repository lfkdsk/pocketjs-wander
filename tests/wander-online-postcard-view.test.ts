// Mounted postcard client: a town notice board doubles as the physical post
// office while mailbox state and all send/read outcomes stay server-owned.
import { describe, expect, test } from "bun:test";
import { BTN } from "@pocketjs/framework/input";
import type { PocketSocket } from "@pocketjs/framework/socket";
import { bootWorld, treeHasText } from "../vendor/pocket-rpgkit/vendor/pocketjs/hosts/sim/sim.ts";
import { appBundle, appPreflight } from "./helpers/boot.ts";
import { fakeOnlineSocketFactory } from "./lib/fake-online-socket.ts";
import type { OnlinePublished } from "../examples/wander-online/OnlineView.tsx";

const preflight = appPreflight("wander-online");
if (!preflight.ok) console.warn(`wander-online postcard view tests skipped: ${preflight.reason}`);
const simDescribe = preflight.ok ? describe : describe.skip;

const SEED = 1593842689;
const REALM = "realm-test";
const BOARD = { x: 439, y: 43 };

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

simDescribe("wander-online postcard view", () => {
  test("shows authoritative unread mail and sends only preset/offline-friend controls at a post office", async () => {
    let socket: PocketSocket | null = null;
    const sent: Record<string, unknown>[] = [];
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
          realm: { id: REALM, seed: SEED, tx: BOARD.x, ty: BOARD.y - 1, epoch: 5 },
          serverTimeMs: 10_000_000,
          heartbeat: true,
          sent,
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
      type: "realmFeatures", v: 1, realm: REALM,
      coopErrands: false, coopPartnerFinding: false, discoveryLeaderboard: false,
      dailyGoals: false, postcards: true,
    });
    expect(sent).toContainEqual({ type: "postcardStatusGet", v: 1 });
    push({ type: "postcardStatus", v: 1, revision: 2, unread: 1, total: 1, dailyRemaining: 4 });
    expect(state().postcardUnread).toBe(1);
    expect(treeHasText(world.getTree(), "MAIL 1")).toBe(true);

    // A future-version response and an older valid response cannot replace
    // the newest authoritative count.
    push({ type: "postcardStatus", v: 2, revision: 9, unread: 0, total: 0, dailyRemaining: 5 });
    push({ type: "postcardStatus", v: 1, revision: 1, unread: 0, total: 0, dailyRemaining: 5 });
    expect(state().postcardUnread).toBe(1);

    press(world, BTN.CROSS);
    expect(state().postcard).toBe(true);
    expect(state().postcardScreen).toBe("home");
    expect(sent).toContainEqual({ type: "postcardGet", v: 1 });
    expect(sent).toContainEqual({ type: "socialGet", v: 1 });

    push({
      type: "socialSnapshot", v: 1, visible: true,
      friends: [{ githubId: 7, name: "Bob", presence: "offline", realm: null }],
      incoming: [], outgoing: [],
    });
    push({
      type: "postcardMailbox", v: 1, revision: 2, unread: 1, total: 1, dailyRemaining: 4,
      postcards: [{
        id: "pc_abcdefgh1234", senderName: "Alice", sentenceId: "thanks",
        postmark: "Ancient Tree", sentAt: 1_000, expiresAt: 2_000, read: false,
      }],
    });
    press(world, BTN.CIRCLE); // home -> inbox
    press(world, BTN.CIRCLE); // inbox -> read
    expect(state().postcardScreen).toBe("read");
    expect(sent).toContainEqual({ type: "postcardRead", v: 1, id: "pc_abcdefgh1234" });
    expect(treeHasText(world.getTree(), "Thank you for helping me on our journey!")).toBe(true);

    push({ type: "postcardResult", v: 1, operation: "read", ok: true });
    expect(sent.at(-1)).toEqual({ type: "postcardGet", v: 1 });
    push({
      type: "postcardMailbox", v: 1, revision: 3, unread: 0, total: 1, dailyRemaining: 4,
      postcards: [{
        id: "pc_abcdefgh1234", senderName: "Alice", sentenceId: "thanks",
        postmark: "Ancient Tree", sentAt: 1_000, expiresAt: 2_000, read: true,
      }],
    });
    expect(state().postcardUnread).toBe(0);
    expect(treeHasText(world.getTree(), "MAIL 1")).toBe(false);

    press(world, BTN.CROSS); // read -> inbox
    press(world, BTN.CROSS); // inbox -> home
    press(world, BTN.DOWN);
    press(world, BTN.CIRCLE); // recipient list
    press(world, BTN.CIRCLE); // Bob
    press(world, BTN.DOWN);
    press(world, BTN.DOWN);
    press(world, BTN.CIRCLE); // thanks
    press(world, BTN.CIRCLE); // no postmark
    press(world, BTN.CIRCLE); // send now
    expect(sent.at(-1)).toEqual({
      type: "postcardSend", v: 1, targetGithubId: 7, sentenceId: "thanks", postmark: null,
    });
    expect(Object.hasOwn(sent.at(-1)!, "body"), "no free text crosses the wire").toBe(false);
  }, 30_000);
});
