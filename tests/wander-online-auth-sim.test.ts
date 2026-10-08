// tests/wander-online-auth-sim.test.ts — the auth flow on the deterministic
// sim host, using a scripted in-memory socket (no real WebSockets): first
// login -> character creation -> world, returning player straight in, the
// desktop device-link keypad, and persisted web/desktop tickets.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { bootWorld } from "../vendor/pocketjs/hosts/sim/sim.ts";
import { createSimFsHost } from "../vendor/pocketjs/hosts/sim/fs.ts";
import { appBundle, appPreflight } from "./helpers/boot.ts";
import { fakeOnlineSocketFactory } from "./lib/fake-online-socket.ts";
import type { PocketSocket } from "@pocketjs/framework/socket";
import { BTN } from "@pocketjs/framework/input";
import type { OnlinePublished } from "../examples/wander-online/OnlineView.tsx";

setDefaultTimeout(30_000);

const WEB_TICKET_KEY = "pocket-rpgkit:wander-online:ticket";

const preflight = appPreflight("wander-online");
if (!preflight.ok) console.warn(`wander-online auth sim tests skipped: ${preflight.reason}`);
const simDescribe = preflight.ok ? describe : describe.skip;

interface World {
  frame: (b: number, a?: number) => void;
  tick: () => void;
  render: () => Uint8Array;
  ticksPerFrame: number;
}

async function boot(
  auth: unknown,
  socketFactory: (url: string) => unknown,
  width = 480,
  height = 272,
  extraGlobals: Record<string, unknown> = {},
): Promise<World> {
  return (await bootWorld(
    appBundle("wander-online"),
    60,
    {
      __onlineUrl: "ws://fake/ws",
      __onlineAuth: auth,
      __onlineSocketFactory: socketFactory,
      ...extraGlobals,
    },
    undefined,
    { width, height },
  )) as unknown as World;
}

function pump(w: World, frames: number, mask = 0): void {
  for (let f = 0; f < frames; f++) {
    w.frame(mask);
    for (let t = 0; t < w.ticksPerFrame; t++) w.tick();
  }
}

const state = (): OnlinePublished | undefined =>
  (globalThis as { __onlineState?: OnlinePublished }).__onlineState;

const authCommand = (): ((command: "signout") => void) | undefined =>
  (globalThis as { __pocketAuthCommand?: (command: "signout") => void }).__pocketAuthCommand;

const waitFor = async (w: World, pred: () => boolean, what: string, timeoutMs = 8000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    pump(w, 1); // keep pumping so microtask replies get published
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timeout waiting for ${what}`);
};

/** Press a button (one frame held, one released) for an edge. */
function press(w: World, btn: number): void {
  pump(w, 1, btn);
  pump(w, 1, 0);
}

function webStore(values: Map<string, string>) {
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

function moveLinkCursorTo(w: World, target: number): void {
  for (let guard = 0; state()?.linkCursor !== target; guard++) {
    if (guard >= 12) throw new Error(`could not move link cursor to ${target}`);
    const cursor = state()?.linkCursor ?? 0;
    const col = cursor % 3;
    const targetCol = target % 3;
    press(w, col === targetCol ? BTN.DOWN : BTN.RIGHT);
  }
}

function enterLinkCode(w: World, code: string): void {
  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "back", "0", "submit"];
  for (const digit of code) {
    moveLinkCursorTo(w, keys.indexOf(digit));
    press(w, BTN.CIRCLE);
  }
}

function submitLinkCode(w: World): void {
  moveLinkCursorTo(w, 11);
  press(w, BTN.CIRCLE);
}

/** Wrap a fake socket factory so the first CREATE is refused with a
 *  scripted createError; later CREATEs pass through to the wrapped factory
 *  (which answers createOk). */
function rejectFirstCreate(
  factory: (url: string) => PocketSocket,
  reason: string,
): (url: string) => PocketSocket {
  return (url) => {
    const sock = factory(url);
    const origSend = sock.send.bind(sock);
    let rejected = false;
    sock.send = (data) => {
      if (!rejected && typeof data === "string") {
        let msg: { type?: string };
        try {
          msg = JSON.parse(data) as { type?: string };
        } catch {
          msg = {};
        }
        if (msg.type === "create") {
          rejected = true;
          queueMicrotask(() => {
            sock.onMessage?.(JSON.stringify({ type: "createError", reason }));
          });
          return true;
        }
      }
      return origSend(data);
    };
    return sock;
  };
}

beforeEach(() => {
  (globalThis as { __onlineState?: OnlinePublished }).__onlineState = undefined;
  (globalThis as { __pocketAuth?: unknown }).__pocketAuth = undefined;
  (globalThis as { __pocketAuthCommand?: unknown }).__pocketAuthCommand = undefined;
  (globalThis as { __pocketAuthEvent?: unknown }).__pocketAuthEvent = undefined;
  try {
    localStorage.removeItem("pocket-rpgkit:wander-online:ticket");
  } catch {
    // no localStorage in this host
  }
});

afterEach(() => {
  // drop any pending socket
});

simDescribe("wander-online auth: first login -> create -> world", () => {
  test("a GitHub token login reaches the creation screen, then the world", async () => {
    const fake = fakeOnlineSocketFactory({ mode: "needCreate", login: "octo", ticket: "dev-ticket" });
    const w = await boot({ kind: "github", token: "gho_test" }, fake);
    pump(w, 30);
    await waitFor(w, () => state()?.screen === "creating", "creating screen");
    expect(state()!.login).toBe("octo");
    // Navigate the name-input grid to OK (67 chars + 3 actions, 10 cols).
    for (let i = 0; i < 6; i++) press(w, BTN.DOWN);
    for (let i = 0; i < 8; i++) press(w, BTN.RIGHT);
    press(w, BTN.CIRCLE);
    pump(w, 30);
    await waitFor(w, () => state()?.screen === "world" && state()?.status === "joined", "world joined");
    expect(state()!.myId).toBeGreaterThan(0);
    expect(state()!.roster[1]?.name).toBeTruthy();
    w.frame(0);
  });

  test("a returning player with a ticket goes straight to the world", async () => {
    const fake = fakeOnlineSocketFactory({ mode: "welcome", name: "Returner", look: 3, ticket: "dev-ticket" });
    const w = await boot({ kind: "ticket", ticket: "dev-ticket" }, fake);
    pump(w, 30);
    await waitFor(w, () => state()?.screen === "world" && state()?.status === "joined", "world");
    expect(state()!.roster[1]?.name).toBe("Returner");
    w.frame(0);
  });
});

simDescribe("wander-online auth: the login gate", () => {
  test("with no credential the game stays on the gate", async () => {
    const fake = fakeOnlineSocketFactory({ mode: "welcome" });
    const w = await boot(null, fake);
    pump(w, 30);
    // No client is started; the gate publishes its own screen.
    expect(state()?.screen).toBe("gate");
    expect(state()?.status).toBe("idle");
    w.frame(0);
  });

  test("desktop keypad corrects a six-digit code and retries after linkError", async () => {
    const sent: Record<string, unknown>[] = [];
    const fake = fakeOnlineSocketFactory({
      mode: "welcome",
      name: "Linked Player",
      ticket: "linked-ticket",
      sent,
      linkReplies: [
        { type: "linkError", reason: "invalid" },
        { type: "linked", ticket: "linked-ticket", login: "linked-user" },
      ],
    });
    const w = await boot(null, fake);
    pump(w, 5);
    expect(state()?.screen).toBe("gate");
    expect(state()?.linkCode).toBe("");
    expect(state()?.linkCursor).toBe(0);

    enterLinkCode(w, "907219");
    expect(state()?.linkCode).toBe("907219");
    press(w, BTN.CROSS);
    expect(state()?.linkCode).toBe("90721");
    enterLinkCode(w, "8");
    expect(state()?.linkCode).toBe("907218");
    submitLinkCode(w);

    await waitFor(
      w,
      () => state()?.screen === "gate" && state()?.linkCode === "" && state()?.linkCursor === 0,
      "linkError reset",
    );
    expect(sent.filter((msg) => msg.type === "linkr").map((msg) => msg.code)).toEqual(["907218"]);

    enterLinkCode(w, "078912");
    submitLinkCode(w);
    await waitFor(w, () => state()?.screen === "world" && state()?.status === "joined", "linked world");
    expect(sent.filter((msg) => msg.type === "linkr").map((msg) => msg.code)).toEqual(["907218", "078912"]);
    expect(sent.some((msg) => msg.type === "join" && msg.ticket === "linked-ticket")).toBe(true);
    expect(state()?.login).toBe("Linked Player");
    w.frame(0);
  });
});

simDescribe("wander-online auth: ticket persistence across boots", () => {
  test("web reboots with a ready ticket from the same storage bridge", async () => {
    const values = new Map<string, string>();
    const bridge = webStore(values);
    const firstSent: Record<string, unknown>[] = [];
    const first = await boot(
      undefined,
      fakeOnlineSocketFactory({ mode: "welcome", ticket: "web-ticket", sent: firstSent }),
      480,
      272,
      { __pocketWeb: true, __pocketAuth: { token: "gho_web" }, __wanderOnlineWebStore: bridge },
    );
    await waitFor(
      first,
      () => state()?.status === "joined" && values.has(WEB_TICKET_KEY),
      "web ticket saved",
    );
    expect(firstSent.some((msg) => msg.type === "join" && msg.github === "gho_web")).toBe(true);
    expect(values.get(WEB_TICKET_KEY)).toBe(JSON.stringify({ ticket: "web-ticket" }));

    const secondSent: Record<string, unknown>[] = [];
    const second = await boot(
      undefined,
      fakeOnlineSocketFactory({ mode: "welcome", ticket: "web-ticket", sent: secondSent }),
      480,
      272,
      { __pocketWeb: true, __wanderOnlineWebStore: bridge },
    );
    await waitFor(second, () => state()?.screen === "world" && state()?.status === "joined", "web ticket reboot");
    expect(secondSent.some((msg) => msg.type === "join" && msg.ticket === "web-ticket")).toBe(true);
    expect(secondSent.some((msg) => msg.type === "join" && typeof msg.github === "string")).toBe(false);
    second.frame(0);
  });

  test("web sign-out clears the ticket across refresh and a new login still works", async () => {
    const values = new Map<string, string>();
    const bridge = webStore(values);
    const events: Array<{ type: string; login?: string }> = [];
    const pageEvent = (event: { type: string; login?: string }) => { events.push(event); };
    const firstSent: Record<string, unknown>[] = [];
    const first = await boot(
      undefined,
      fakeOnlineSocketFactory({ mode: "welcome", name: "First Login", ticket: "first-ticket", sent: firstSent }),
      480,
      272,
      {
        __pocketWeb: true,
        __pocketAuth: { token: "gho_first" },
        __pocketAuthEvent: pageEvent,
        __wanderOnlineWebStore: bridge,
      },
    );
    await waitFor(first, () => state()?.status === "joined" && values.has(WEB_TICKET_KEY), "first web login");
    expect(firstSent.some((msg) => msg.type === "join" && msg.github === "gho_first")).toBe(true);
    expect(events.some((event) => event.type === "login" && event.login === "First Login")).toBe(true);

    expect(authCommand()).toBeTypeOf("function");
    authCommand()!("signout");
    pump(first, 1);
    expect(state()?.screen).toBe("gate");
    expect(values.has(WEB_TICKET_KEY)).toBe(false);
    expect(events.at(-1)).toEqual({ type: "logout" });

    let refreshSocketCount = 0;
    const refreshBase = fakeOnlineSocketFactory({ mode: "welcome", name: "Should Not Join", ticket: "stale-ticket" });
    const refreshed = await boot(
      undefined,
      (url) => {
        refreshSocketCount++;
        return refreshBase(url);
      },
      480,
      272,
      { __pocketWeb: true, __pocketAuthEvent: pageEvent, __wanderOnlineWebStore: bridge },
    );
    pump(refreshed, 5);
    expect(state()?.screen).toBe("gate");
    expect(refreshSocketCount).toBe(0);
    expect(values.has(WEB_TICKET_KEY)).toBe(false);

    const againSent: Record<string, unknown>[] = [];
    const again = await boot(
      undefined,
      fakeOnlineSocketFactory({ mode: "welcome", name: "Second Login", ticket: "second-ticket", sent: againSent }),
      480,
      272,
      {
        __pocketWeb: true,
        __pocketAuth: { token: "gho_second" },
        __pocketAuthEvent: pageEvent,
        __wanderOnlineWebStore: bridge,
      },
    );
    await waitFor(again, () => state()?.status === "joined" && values.get(WEB_TICKET_KEY)?.includes("second-ticket") === true, "second web login");
    expect(againSent.some((msg) => msg.type === "join" && msg.github === "gho_second")).toBe(true);
    expect(events.at(-1)).toEqual({ type: "login", login: "Second Login" });
    again.frame(0);
  });

  test("desktop reboots with a linked ticket from the same fs namespace", async () => {
    const fsHost = createSimFsHost();
    try {
      const firstSent: Record<string, unknown>[] = [];
      const first = await boot(
        { kind: "link", code: "907218" },
        fakeOnlineSocketFactory({
          mode: "welcome",
          ticket: "desktop-ticket",
          sent: firstSent,
          linkReplies: [{ type: "linked", ticket: "desktop-ticket", login: "desktop-user" }],
        }),
        480,
        272,
        { fs: fsHost.ns },
      );
      await waitFor(first, () => state()?.screen === "world" && state()?.status === "joined", "desktop linked world");
      expect(firstSent.some((msg) => msg.type === "linkr" && msg.code === "907218")).toBe(true);
      expect(fsHost.log.some((line) => line.startsWith("op write wander-online-ticket.json"))).toBe(true);

      const secondSent: Record<string, unknown>[] = [];
      const second = await boot(
        undefined,
        fakeOnlineSocketFactory({ mode: "welcome", ticket: "desktop-ticket", sent: secondSent }),
        480,
        272,
        { fs: fsHost.ns },
      );
      await waitFor(second, () => state()?.screen === "world" && state()?.status === "joined", "desktop ticket reboot");
      expect(secondSent.some((msg) => msg.type === "join" && msg.ticket === "desktop-ticket")).toBe(true);
      expect(secondSent.some((msg) => msg.type === "linkr")).toBe(false);
      second.frame(0);
    } finally {
      fsHost.dispose();
    }
  });
});

simDescribe("wander-online auth: rejected character creation", () => {
  test("a createError keeps the player on the creation screen; a fixed name then enters the world", async () => {
    const fake = rejectFirstCreate(
      fakeOnlineSocketFactory({ mode: "needCreate", login: "octo", ticket: "dev-ticket" }),
      "name-blocked",
    );
    const w = await boot({ kind: "github", token: "gho_test" }, fake);
    pump(w, 30);
    await waitFor(w, () => state()?.screen === "creating", "creating screen");

    // Submit the default name: navigate the grid to OK (67 chars + 3
    // actions on a 10-col grid, so OK sits at row 6, col 8).
    for (let i = 0; i < 6; i++) press(w, BTN.DOWN);
    for (let i = 0; i < 8; i++) press(w, BTN.RIGHT);
    press(w, BTN.CIRCLE);
    pump(w, 30);

    // The server refused the name: the client stays on the creation
    // screen, the rejection reason is visible, and the submit lock is
    // released (creating is false again).
    await waitFor(w, () => state()?.screen === "creating" && !!state()?.createError, "createError shown");
    expect(state()!.screen).toBe("creating");
    expect(state()!.createError).toContain("not allowed");

    // Fix the name: the scene was re-armed with the same buffer and the
    // cursor back at the first grid cell. Append a character, then OK.
    press(w, BTN.CIRCLE); // append charset[0] ('A')
    for (let i = 0; i < 6; i++) press(w, BTN.DOWN);
    for (let i = 0; i < 8; i++) press(w, BTN.RIGHT);
    press(w, BTN.CIRCLE);
    pump(w, 30);

    // The second CREATE is accepted: the client enters the world and the
    // error is cleared.
    await waitFor(w, () => state()?.screen === "world" && state()?.status === "joined", "world joined");
    expect(state()!.createError).toBe("");
    w.frame(0);
  });
});

simDescribe("wander-online auth: profile delete", () => {
  /** Open the world menu, arm delete, confirm: SELECT, SQUARE, SQUARE. */
  async function deleteProfile(w: World): Promise<void> {
    press(w, BTN.SELECT);
    press(w, BTN.SQUARE); // arm
    press(w, BTN.SQUARE); // confirm -> sends {"type":"delete"}
    pump(w, 10);
  }

  test("a deleteError keeps the player signed in and shows why", async () => {
    const fake = fakeOnlineSocketFactory({
      mode: "welcome",
      name: "Returner",
      look: 3,
      ticket: "dev-ticket",
      deleteReply: { type: "deleteError", reason: "delete-unavailable" },
    });
    const w = await boot({ kind: "ticket", ticket: "dev-ticket" }, fake);
    pump(w, 30);
    await waitFor(w, () => state()?.screen === "world" && state()?.status === "joined", "world joined");
    await deleteProfile(w);
    await waitFor(w, () => (state()?.notice ?? "").includes("try again"), "deleteError notice");
    expect(state()!.notice).toContain("try again");
    // The delete was not confirmed: still in the world, still joined.
    expect(state()!.screen).toBe("world");
    expect(state()!.status).toBe("joined");
    w.frame(0);
  });

  test("a confirmed delete signs the player out and clears its persisted ticket", async () => {
    const values = new Map<string, string>();
    const fake = fakeOnlineSocketFactory({
      mode: "welcome",
      name: "Returner",
      look: 3,
      ticket: "dev-ticket",
      deleteReply: { type: "deleted" },
    });
    const w = await boot(
      { kind: "ticket", ticket: "dev-ticket" },
      fake,
      480,
      272,
      { __pocketWeb: true, __wanderOnlineWebStore: webStore(values) },
    );
    pump(w, 30);
    await waitFor(w, () => state()?.screen === "world" && state()?.status === "joined", "world joined");
    expect(values.get(WEB_TICKET_KEY)).toBe(JSON.stringify({ ticket: "dev-ticket" }));
    await deleteProfile(w);
    // The client shows "Profile deleted", then signs out after a short delay.
    await waitFor(w, () => state()?.screen === "gate", "signed out to gate");
    expect(values.has(WEB_TICKET_KEY)).toBe(false);
    w.frame(0);
  });
});
