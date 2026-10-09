// tests/wander-online-auth-sim.test.ts — the auth flow on the deterministic
// sim host, using a scripted in-memory socket (no real WebSockets): first
// login -> character creation -> world, returning player straight in, the
// desktop device-link keypad, and persisted web/desktop tickets.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { bootWorld, treeHasText } from "../vendor/pocket-rpgkit/vendor/pocketjs/hosts/sim/sim.ts";
import { createSimFsHost } from "../vendor/pocket-rpgkit/vendor/pocketjs/hosts/sim/fs.ts";
import { appBundle, appPreflight } from "./helpers/boot.ts";
import { fakeOnlineSocketFactory } from "./lib/fake-online-socket.ts";
import { encodeRoster } from "../examples/wander-online/net/protocol.ts";
import type { PocketSocket } from "@pocketjs/framework/socket";
import { BTN } from "@pocketjs/framework/input";
import type { OnlinePublished, PageAuthEvent } from "../examples/wander-online/OnlineView.tsx";
import { NAME_ASCII_CHARSET } from "../examples/wander-online/shared/name-charset.ts";
import { CREATE_ERROR_TEXT_EN, CREATE_ERROR_TEXT_ZH } from "../examples/wander-online/create-text.ts";

setDefaultTimeout(30_000);

const WEB_TICKET_KEY = "pocket-rpgkit:wander-online:ticket";

const preflight = appPreflight("wander-online");
if (!preflight.ok) console.warn(`wander-online auth sim tests skipped: ${preflight.reason}`);
const simDescribe = preflight.ok ? describe : describe.skip;

interface World {
  frame: (b: number, a?: number) => void;
  tick: () => void;
  render: () => Uint8Array;
  getTree: () => unknown;
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

const authCommand = (): ((command: "signout" | "name", value?: string) => void) | undefined =>
  (globalThis as { __pocketAuthCommand?: (command: "signout" | "name", value?: string) => void }).__pocketAuthCommand;

/** The creation grid: 10 columns of the shared ASCII charset, then BACK,
 *  OK and CANCEL. Cells are addressed by index; the cursor starts at 0
 *  whenever the scene is (re-)armed. */
const GRID_COLS = 10;
const GRID_OK = NAME_ASCII_CHARSET.length + 1;
let gridCursor = 0;
function gridMoveTo(w: World, index: number): void {
  const row = Math.floor(index / GRID_COLS);
  const col = index % GRID_COLS;
  const curRow = Math.floor(gridCursor / GRID_COLS);
  const curCol = gridCursor % GRID_COLS;
  for (let i = curRow; i < row; i++) press(w, BTN.DOWN);
  for (let i = curRow; i > row; i--) press(w, BTN.UP);
  for (let i = curCol; i < col; i++) press(w, BTN.RIGHT);
  for (let i = curCol; i > col; i--) press(w, BTN.LEFT);
  gridCursor = index;
}
/** Type one grid character (cursor moves to its cell, CIRCLE). */
function gridType(w: World, ch: string): void {
  const index = NAME_ASCII_CHARSET.indexOf(ch);
  if (index < 0) throw new Error(`${JSON.stringify(ch)} is not a grid cell`);
  gridMoveTo(w, index);
  press(w, BTN.CIRCLE);
}
/** Confirm the buffer with the grid's OK cell. */
function gridOk(w: World): void {
  gridMoveTo(w, GRID_OK);
  press(w, BTN.CIRCLE);
}
/** Delete the last buffer character with the grid's BACK cell. */
function gridBack(w: World): void {
  gridMoveTo(w, GRID_OK - 1);
  press(w, BTN.CIRCLE);
}

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
    // Confirm the prefilled name with the grid's OK cell.
    gridCursor = 0;
    gridOk(w);
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
      { __pocketWeb: true, __pocketAuth: { token: "gho_web" }, __pocketWebStore: bridge },
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
      { __pocketWeb: true, __pocketWebStore: bridge },
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
        __pocketWebStore: bridge,
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
      { __pocketWeb: true, __pocketAuthEvent: pageEvent, __pocketWebStore: bridge },
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
        __pocketWebStore: bridge,
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

    // Submit the default name: navigate the grid to OK (66 chars + 3
    // actions on a 10-col grid, so OK sits at row 6, col 7).
    gridCursor = 0;
    gridOk(w);
    pump(w, 30);

    // The server refused the name: the client stays on the creation
    // screen, the rejection reason is visible, and the submit lock is
    // released (creating is false again).
    await waitFor(w, () => state()?.screen === "creating" && !!state()?.createError, "createError shown");
    expect(state()!.screen).toBe("creating");
    expect(state()!.createError).toContain("not allowed");

    // Fix the name: the scene was re-armed with the same buffer and the
    // cursor back at the first grid cell. Append a character, then OK.
    gridCursor = 0;
    gridType(w, "A");
    gridOk(w);
    pump(w, 30);

    // The second CREATE is accepted: the client enters the world and the
    // error is cleared.
    await waitFor(w, () => state()?.screen === "world" && state()?.status === "joined", "world joined");
    expect(state()!.createError).toBe("");
    w.frame(0);
  });
});

simDescribe("wander-online auth: the creation grid and the shared name rule", () => {
  test("the grid types the separators the server accepts (space and underscore) and a digit", async () => {
    const sent: Record<string, unknown>[] = [];
    const w = await boot(
      { kind: "github", token: "gho_test" },
      fakeOnlineSocketFactory({ mode: "needCreate", login: "octo", ticket: "dev-ticket", name: "octo _1", sent }),
    );
    pump(w, 30);
    await waitFor(w, () => state()?.screen === "creating", "creating screen");
    gridCursor = 0;
    gridType(w, " ");
    gridType(w, "_");
    gridType(w, "1");
    gridOk(w);
    pump(w, 30);
    await waitFor(w, () => state()?.screen === "world" && state()?.status === "joined", "world joined");
    const create = sent.find((msg) => msg.type === "create");
    expect(create?.name).toBe("octo _1");
    expect(state()!.createError).toBe("");
    w.frame(0);
  });

  test("a blocked name is refused on the client, in both languages, before any CREATE is sent", async () => {
    const sent: Record<string, unknown>[] = [];
    const w = await boot(
      { kind: "github", token: "gho_test" },
      fakeOnlineSocketFactory({ mode: "needCreate", login: "kys", ticket: "dev-ticket", name: "ok", sent }),
    );
    pump(w, 30);
    await waitFor(w, () => state()?.screen === "creating", "creating screen");
    // The login prefills the buffer: "kys" is on the blocklist.
    gridCursor = 0;
    gridOk(w);
    pump(w, 10);
    expect(state()!.screen).toBe("creating");
    expect(state()!.createError).toContain(CREATE_ERROR_TEXT_EN["name-blocked"]!);
    expect(state()!.createError).toContain(CREATE_ERROR_TEXT_ZH["name-blocked"]!);
    expect(sent.some((msg) => msg.type === "create")).toBe(false);
    // The scene is re-armed with the buffer kept: erase it and type a
    // name that passes; the CREATE goes out and the world opens.
    gridCursor = 0;
    for (let i = 0; i < 3; i++) gridBack(w);
    gridType(w, "o");
    gridType(w, "k");
    gridOk(w);
    pump(w, 30);
    await waitFor(w, () => state()?.screen === "world" && state()?.status === "joined", "world joined");
    expect(sent.find((msg) => msg.type === "create")?.name).toBe("ok");
    expect(state()!.createError).toBe("");
    w.frame(0);
  });
});

simDescribe("wander-online auth: the world after creation", () => {
  /** Lit pixels in the field between the HUD plate and the bottom bars. */
  function worldInk(fb: Uint8Array): number {
    let n = 0;
    for (let y = 70; y < 200; y++) {
      for (let x = 0; x < 480; x++) {
        const i = (y * 480 + x) * 4;
        if (fb[i]! + fb[i + 1]! + fb[i + 2]! > 30) n++;
      }
    }
    return n;
  }

  test("the realm paints after character creation exactly as it does for a returning player", async () => {
    // Returning player: the world is drawn straight away.
    const direct = await boot(
      { kind: "github", token: "gho_test" },
      fakeOnlineSocketFactory({ mode: "welcome4", name: "Direct", ticket: "t", realm: { tx: 503, ty: 154 } }),
    );
    await waitFor(direct, () => state()?.screen === "world" && state()?.status === "joined", "direct world");
    pump(direct, 60);
    const directInk = worldInk(direct.render());
    direct.frame(0);
    expect(directInk).toBeGreaterThan(20_000);

    // First login: the creation screen comes first, then the same world.
    // The field is an imperative node; it must survive the creation screen
    // (mutation: mount it under the world screen's Show and this frame is
    // black).
    const created = await boot(
      { kind: "github", token: "gho_test" },
      fakeOnlineSocketFactory({ mode: "needCreate4", login: "octo", ticket: "t", name: "Created", realm: { tx: 503, ty: 154 } }),
    );
    pump(created, 30);
    await waitFor(created, () => state()?.screen === "creating", "creating screen");
    gridCursor = 0;
    gridOk(created);
    await waitFor(created, () => state()?.screen === "world" && state()?.status === "joined", "created world");
    pump(created, 60);
    const createdInk = worldInk(created.render());
    created.frame(0);
    expect(createdInk).toBe(directInk);
  });
});

simDescribe("wander-online auth: the web page's name text box", () => {
  const CJK = "\u6f14\u793a\u7f51\u9875"; // 演示网页, common simplified Chinese

  test("a Chinese name typed into the page box is created and shown in the HUD", async () => {
    const values = new Map<string, string>();
    const events: PageAuthEvent[] = [];
    const sent: Record<string, unknown>[] = [];
    let latest: PocketSocket | null = null;
    const w = await boot(
      undefined,
      fakeOnlineSocketFactory({ mode: "needCreate", login: "octo", ticket: "dev-ticket", name: CJK, sent, onSocket: (sock) => { latest = sock; } }),
      480,
      272,
      {
        __pocketWeb: true,
        __pocketAuth: { token: "gho_octo" },
        __pocketAuthEvent: (event: PageAuthEvent) => { events.push(event); },
        __pocketWebStore: webStore(values),
      },
    );
    pump(w, 30);
    await waitFor(w, () => state()?.screen === "creating", "creating screen");
    // Opening the creation screen opens the page's box, prefilled with the
    // grid buffer and capped at the shared length.
    const opened = events.find((event) => event.type === "nameInput");
    expect(opened).toEqual({ type: "nameInput", title: "Your Name", maxLength: 12, value: "octo", error: "" });
    expect(events.some((event) => event.type === "nameInputEnd")).toBe(false);

    authCommand()!("name", ` ${CJK} `);
    pump(w, 30);
    await waitFor(w, () => state()?.screen === "world" && state()?.status === "joined", "world joined");
    const create = sent.find((msg) => msg.type === "create");
    expect(create?.name).toBe(CJK);
    expect(create?.look).toBe(0);
    expect(events.at(-1)?.type === "nameInputEnd" || events.at(-1)?.type === "login").toBe(true);
    expect(events.some((event) => event.type === "nameInputEnd")).toBe(true);
    expect(state()!.createError).toBe("");
    // The created name is what the roster and the HUD show.
    pump(w, 10);
    expect(state()!.roster[state()!.myId]?.name).toBe(CJK);
    expect(treeHasText(w.getTree(), CJK)).toBe(true);
    // A later ROSTER announces only the newcomer; the published roster
    // keeps every name known this epoch, our own included (the demo's
    // name check reads it after other clients rejoin).
    latest!.onMessage?.(new Uint8Array(encodeRoster([{ id: 9, name: "Late", look: 1 }])));
    pump(w, 2);
    expect(state()!.roster[state()!.myId]?.name).toBe(CJK);
    expect(state()!.roster[9]?.name).toBe("Late");
    // The page sees the login too, and the box is closed only once.
    expect(events.filter((event) => event.type === "nameInputEnd")).toHaveLength(1);
    w.frame(0);
  });

  test("a name the shared rule refuses never leaves the client: the box shows why, then a fixed name is created", async () => {
    const values = new Map<string, string>();
    const events: PageAuthEvent[] = [];
    const sent: Record<string, unknown>[] = [];
    const w = await boot(
      undefined,
      fakeOnlineSocketFactory({ mode: "needCreate", login: "octo", ticket: "dev-ticket", name: "Octo-2", sent }),
      480,
      272,
      {
        __pocketWeb: true,
        __pocketAuth: { token: "gho_octo" },
        __pocketAuthEvent: (event: PageAuthEvent) => { events.push(event); },
        __pocketWebStore: webStore(values),
      },
    );
    pump(w, 30);
    await waitFor(w, () => state()?.screen === "creating", "creating screen");

    const refused: Array<[string, string]> = [
      ["bad!name", "name-charset"], // the old grid offered "!"; the server refuses it
      ["\u30ab\u30a4", "name-charset"], // katakana: not in the name font
      ["admin", "name-blocked"],
      ["\u4e00".repeat(13), "name-too-long"],
    ];
    for (const [text, reason] of refused) {
      authCommand()!("name", text);
      pump(w, 10);
      expect(state()!.screen, text).toBe("creating");
      expect(state()!.createError, text).toContain(CREATE_ERROR_TEXT_EN[reason]!);
      expect(state()!.createError, text).toContain(CREATE_ERROR_TEXT_ZH[reason]!);
      const last = events.at(-1);
      expect(last?.type).toBe("nameInput");
      expect((last as { error?: string }).error).toBe(state()!.createError);
    }
    expect(sent.some((msg) => msg.type === "create")).toBe(false);

    // A whitespace-only submit is refused as empty.
    authCommand()!("name", "   ");
    pump(w, 10);
    expect(state()!.createError).toContain(CREATE_ERROR_TEXT_EN["name-empty"]!);
    expect(sent.some((msg) => msg.type === "create")).toBe(false);

    authCommand()!("name", "Octo-2");
    pump(w, 30);
    await waitFor(w, () => state()?.screen === "world" && state()?.status === "joined", "world joined");
    expect(sent.find((msg) => msg.type === "create")?.name).toBe("Octo-2");
    expect(state()!.createError).toBe("");
    w.frame(0);
  });

  test("the page command is ignored outside the creation screen", async () => {
    const values = new Map<string, string>();
    const sent: Record<string, unknown>[] = [];
    const w = await boot(
      undefined,
      fakeOnlineSocketFactory({ mode: "welcome", name: "Returning", ticket: "ready-ticket", sent }),
      480,
      272,
      { __pocketWeb: true, __pocketAuth: { token: "gho_back" }, __pocketWebStore: webStore(values) },
    );
    await waitFor(w, () => state()?.status === "joined", "world joined");
    authCommand()!("name", "Someone");
    pump(w, 10);
    expect(sent.some((msg) => msg.type === "create")).toBe(false);
    expect(state()!.screen).toBe("world");
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
      { __pocketWeb: true, __pocketWebStore: webStore(values) },
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
