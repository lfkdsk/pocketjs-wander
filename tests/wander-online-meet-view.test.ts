// tests/wander-online-meet-view.test.ts — the D-phase meeting features on
// the online world screen, on the deterministic sim host: the far-player
// edge markers (octant + band word, a CJK name, gone once the player is in
// the exact snapshot or the report goes stale), the emote picker and the
// bubbles the server's echo draws (five seconds, rate-limited on the client
// too), the invite menu action with its notice and page event, and an
// invite token at boot that pins the realm and is consumed on admission.
import { describe, expect, test } from "bun:test";
import { bootWorld, treeHasText } from "../vendor/pocket-rpgkit/vendor/pocketjs/hosts/sim/sim.ts";
import { appBundle, appPreflight } from "./helpers/boot.ts";
import { fakeOnlineSocketFactory, type FakeOnlineOpts } from "./lib/fake-online-socket.ts";
import { BTN } from "@pocketjs/framework/input";
import type { PocketSocket } from "@pocketjs/framework/socket";
import {
  EMOTE_CELLS,
  FAR_LABEL_W,
  FAR_MARKER_SIZE,
  emoteBarRect,
  emoteCell,
  farMarkerPoint,
  farMarkerRect,
  helpRect,
  menuRect,
} from "../examples/wander-online/hud.ts";
import type { OnlinePublished, PageAuthEvent } from "../examples/wander-online/OnlineView.tsx";
import {
  COMMAND,
  encodeEmote,
  encodeFarPlayers,
  encodeRoster,
  encodeState4,
  type CommandMessage,
  type WireEntity,
} from "../examples/wander-online/net/protocol.ts";
import { EMOTE, EMOTE_SHOW_MS, EMOTE_TABLE } from "../examples/wander-online/net/emote.ts";
import { FAR_BAND_WORDS, FAR_TTL_MS, farVector } from "../examples/wander-online/net/far.ts";

const preflight = appPreflight("wander-online");
if (!preflight.ok) console.warn(`wander-online meet view tests skipped: ${preflight.reason}`);
const simDescribe = preflight.ok ? describe : describe.skip;

const SEED = 1593842689;
/** Region (4,0)'s hub: a grown town of the fixture seed. */
const HUB = { x: 438, y: 42 };
const GROWN_MS = 10_000_000;
const CJK_NAME = "一二三四五六七八九十一二";
const EPOCH = 5;

interface World {
  frame: (b: number, a?: number, t?: readonly number[]) => void;
  tick: () => void;
  render: () => Uint8Array;
  getTree: () => unknown;
  ticksPerFrame: number;
}

interface Fixture {
  opts: FakeOnlineOpts;
  sent: CommandMessage[];
  text: Record<string, unknown>[];
  urls: string[];
  socket: () => PocketSocket;
  /** Entities every heartbeat snapshot carries (mutable). */
  remotes: WireEntity[];
}

function fixture(extra: Partial<FakeOnlineOpts> = {}): Fixture {
  const sent: CommandMessage[] = [];
  const text: Record<string, unknown>[] = [];
  const urls: string[] = [];
  const remotes: WireEntity[] = [];
  let sock: PocketSocket | null = null;
  const opts: FakeOnlineOpts = {
    mode: "welcome4",
    name: "Octo",
    look: 3,
    ticket: "t1",
    realm: { tx: HUB.x, ty: HUB.y, seed: SEED, epoch: EPOCH, id: "realm-test" },
    serverTimeMs: GROWN_MS,
    heartbeat: true,
    heartbeatEntities: () => remotes,
    sentBinary: sent,
    sent: text,
    urls,
    onSocket: (s) => { sock = s; },
    ...extra,
  };
  return { opts, sent, text, urls, socket: () => sock!, remotes };
}

const pageEvents: PageAuthEvent[] = [];

async function boot(opts: FakeOnlineOpts, width = 480, height = 272, globals: Record<string, unknown> = {}): Promise<World> {
  (globalThis as { __onlineState?: OnlinePublished }).__onlineState = undefined;
  (globalThis as { __onlineAutoWalk?: boolean }).__onlineAutoWalk = undefined;
  (globalThis as { __pocketInvite?: string }).__pocketInvite = undefined;
  (globalThis as { __onlineInvite?: string }).__onlineInvite = undefined;
  (globalThis as { __onlineRealm?: string }).__onlineRealm = undefined;
  pageEvents.length = 0;
  (globalThis as { __pocketAuthEvent?: (ev: PageAuthEvent) => void }).__pocketAuthEvent = (ev) => { pageEvents.push(ev); };
  return (await bootWorld(
    appBundle("wander-online"),
    60,
    {
      __onlineUrl: "ws://fake/ws",
      __onlineAuth: { kind: "ticket", ticket: "t1" },
      __onlineSocketFactory: fakeOnlineSocketFactory(opts),
      ...globals,
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

const state = (): OnlinePublished | undefined => (globalThis as { __onlineState?: OnlinePublished }).__onlineState;
const command = (): ((cmd: "signout" | "name" | "inviteEnd", value?: string) => void) | undefined =>
  (globalThis as { __pocketAuthCommand?: (cmd: "signout" | "name" | "inviteEnd", value?: string) => void }).__pocketAuthCommand;

const waitFor = async (w: World, pred: () => boolean, what: string, timeoutMs = 8000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    pump(w, 1);
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timeout waiting for ${what}`);
};

async function enterWorld(w: World): Promise<void> {
  pump(w, 5);
  await waitFor(w, () => state()?.status === "joined", "v4 joined");
  pump(w, 6);
}

function press(w: World, btn: number): void {
  pump(w, 1, btn);
  pump(w, 1, 0);
}

const push = (f: Fixture, buf: ArrayBuffer): void => { f.socket().onMessage?.(new Uint8Array(buf)); };
const unmount = (w: World): void => { w.frame(0); };

function count(fb: Uint8Array, stride: number, pred: (r: number, g: number, b: number) => boolean, x0: number, x1: number, y0: number, y1: number): number {
  let n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = (y * stride + x) * 4;
    if (pred(fb[i]!, fb[i + 1]!, fb[i + 2]!)) n++;
  }
  return n;
}

const measure = (text: string): number =>
  (globalThis as unknown as { ui: { measureText(value: string, slot: number): number } }).ui.measureText(text, 0);

const yellow = (r: number, g: number, b: number) => r === 0xff && g === 0xe9 && b === 0x7a;
const bubbleCream = (r: number, g: number, b: number) => r === 0xff && g === 0xf6 && b === 0xc4;

const remote = (id: number, tx: number, ty: number): WireEntity => ({
  id, tx, ty, px: 0, py: 0, dir: 0, phase: 0, stepDir: 0, moving: false, walking: false, color: 2,
});

simDescribe("wander-online meet view: far-player band", () => {
  for (const [W, H] of [[480, 272], [960, 544]] as const) {
    test(`${W}x${H}: a far player is an edge marker with its name and band word, never a walker; it leaves when the snapshot carries it or the report goes stale`, async () => {
      const f = fixture();
      const w = await boot(f.opts, W, H);
      await enterWorld(w);
      push(f, encodeRoster([{ id: 2, name: CJK_NAME, look: 5 }]));
      push(f, encodeFarPlayers([{ id: 2, dir: 1, band: 1 }]));
      pump(w, 3);
      expect(state()!.far).toEqual([{ id: 2, dir: 1, band: 1 }]);
      expect(state()!.remote).toEqual([]);
      const label = `${CJK_NAME} · ${FAR_BAND_WORDS[1]}`;
      expect(treeHasText(w.getTree(), label)).toBe(true);
      expect(measure(label), "far label fits its box").toBeLessThanOrEqual(FAR_LABEL_W);
      // The marker: a yellow square at the north-east edge of the inset box.
      const u = farVector(1);
      const at = farMarkerPoint(W, H, false, u.x, u.y);
      const box = farMarkerRect(W, H, false);
      const mx = Math.min(box.x1 - FAR_MARKER_SIZE, Math.max(box.x0, at.x - FAR_MARKER_SIZE / 2));
      const my = Math.min(box.y1 - FAR_MARKER_SIZE, Math.max(box.y0, at.y - FAR_MARKER_SIZE / 2));
      expect(mx).toBeGreaterThan(W / 2);
      expect(my).toBe(box.y0);
      const fb = w.render();
      expect(count(fb, W, yellow, mx, mx + FAR_MARKER_SIZE, my, my + FAR_MARKER_SIZE), "marker square ink").toBeGreaterThanOrEqual(20);
      // Its label sits to the left of the marker (the inner side), inked.
      expect(count(fb, W, yellow, mx - 4 - FAR_LABEL_W, mx - 4, my - 2, my + 12), "far label ink").toBeGreaterThan(40);
      // Mutation guard: the same region without the marker is not yellow.
      expect(count(fb, W, yellow, mx - FAR_MARKER_SIZE * 3, mx - FAR_MARKER_SIZE * 2, box.y1 - 40, box.y1 - 30)).toBe(0);

      // The player walks into the AOI: it is in STATE4 now, so the marker
      // goes and a walker with a name tag appears instead.
      f.remotes.push(remote(2, HUB.x + 2, HUB.y));
      await waitFor(w, () => state()!.remote.length === 1, "the walker in the exact snapshot");
      expect(state()!.far).toEqual([]);
      expect(state()!.remote.map((r) => r.id)).toEqual([2]);
      expect(treeHasText(w.getTree(), label)).toBe(false);

      // Back out of sight (the walker leaves the snapshots and ages out),
      // then the report stops: the marker expires.
      f.remotes.length = 0;
      await waitFor(w, () => state()!.remote.length === 0, "the walker gone from the snapshots");
      push(f, encodeFarPlayers([{ id: 2, dir: 6, band: 0 }]));
      pump(w, 3);
      expect(state()!.far).toEqual([{ id: 2, dir: 6, band: 0 }]);
      expect(treeHasText(w.getTree(), `${CJK_NAME} · ${FAR_BAND_WORDS[0]}`)).toBe(true);
      // The report's age is wall-clock time, like the snapshot freeze.
      await waitFor(w, () => state()!.far.length === 0, "the stale marker expired", FAR_TTL_MS + 3000);
      expect(state()!.far).toEqual([]);
      expect(treeHasText(w.getTree(), `${CJK_NAME} · ${FAR_BAND_WORDS[0]}`)).toBe(false);
      unmount(w);
    }, 30_000);
  }
});

simDescribe("wander-online meet view: emotes", () => {
  test("R opens the picker, LEFT/RIGHT choose, CIRCLE sends one COMMAND with the preset id; the echo draws a bubble for five seconds", async () => {
    const f = fixture();
    const w = await boot(f.opts);
    await enterWorld(w);
    expect(state()!.emoteBar).toBe(false);
    press(w, BTN.RTRIGGER);
    expect(state()!.emoteBar).toBe(true);
    for (const e of EMOTE_TABLE) expect(treeHasText(w.getTree(), `${e.glyph} ${e.word}`)).toBe(true);
    const bar = emoteBarRect(480, 272, false);
    for (let i = 0; i < EMOTE_CELLS; i++) {
      const cell = emoteCell(bar, i);
      expect(measure(`${EMOTE_TABLE[i]!.glyph} ${EMOTE_TABLE[i]!.word}`), `cell ${i} text fits`).toBeLessThanOrEqual(cell.x1 - cell.x0);
    }
    // The d-pad belongs to the picker: a held RIGHT moves the selection,
    // not the walker.
    const x0 = state()!.x;
    pump(w, 10, BTN.RIGHT); // one edge, then held
    pump(w, 1, 0);
    expect(state()!.x).toBe(x0);
    press(w, BTN.CIRCLE);
    expect(state()!.emoteBar).toBe(false);
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]).toMatchObject({ kind: COMMAND.emote, extra: EMOTE.cheer });
    expect(f.sent[0]!.rx).toBe(Math.floor(HUB.x / 96));
    expect(f.sent[0]!.ry).toBe(Math.floor(HUB.y / 96));
    // No bubble until the server echoes it.
    expect(state()!.emotes).toEqual({});
    expect(treeHasText(w.getTree(), "\\o/")).toBe(false);
    push(f, encodeEmote({ id: 1, emote: EMOTE.cheer }));
    pump(w, 2);
    expect(state()!.emotes).toEqual({ 1: EMOTE.cheer });
    expect(treeHasText(w.getTree(), "\\o/")).toBe(true);
    // The bubble: a cream plate above the local walker's name tag.
    const fb = w.render();
    expect(count(fb, 480, bubbleCream, 0, 480, 0, 272), "bubble plate ink").toBeGreaterThan(200);
    // A second request inside the client's own one-second floor is not sent.
    press(w, BTN.RTRIGGER);
    press(w, BTN.CIRCLE);
    expect(f.sent).toHaveLength(1);
    // Five seconds (wall clock) later the bubble is gone, nothing persisted.
    await waitFor(w, () => Object.keys(state()!.emotes).length === 0, "the bubble expired", EMOTE_SHOW_MS + 3000);
    expect(state()!.emotes).toEqual({});
    expect(treeHasText(w.getTree(), "\\o/")).toBe(false);
    expect(count(w.render(), 480, bubbleCream, 0, 480, 0, 272)).toBe(0);
    // After the floor, a new emote goes out; CROSS closes the picker.
    press(w, BTN.RTRIGGER);
    press(w, BTN.LEFT);
    press(w, BTN.CIRCLE);
    expect(f.sent).toHaveLength(2);
    expect(f.sent[1]).toMatchObject({ kind: COMMAND.emote, extra: EMOTE.wave });
    press(w, BTN.RTRIGGER);
    press(w, BTN.CROSS);
    expect(state()!.emoteBar).toBe(false);
    unmount(w);
  }, 30_000);

  for (const [W, H] of [[480, 272], [960, 544]] as const) {
    test(`${W}x${H}: a remote player's emote draws above its CJK name tag and nothing else changes`, async () => {
      const f = fixture();
      const w = await boot(f.opts, W, H);
      await enterWorld(w);
      push(f, encodeRoster([{ id: 2, name: CJK_NAME, look: 5 }]));
      f.remotes.push(remote(2, HUB.x + 3, HUB.y));
      await waitFor(w, () => state()!.remote.length === 1, "the remote walker");
      pump(w, 2);
      expect(state()!.remote.map((r) => r.id)).toEqual([2]);
      const before = w.render();
      expect(count(before, W, bubbleCream, 0, W, 0, H)).toBe(0);
      push(f, encodeEmote({ id: 2, emote: EMOTE.gather }));
      pump(w, 2);
      expect(state()!.emotes).toEqual({ 2: EMOTE.gather });
      expect(treeHasText(w.getTree(), "!!")).toBe(true);
      const after = w.render();
      // The remote walker is three tiles right of the centred local one;
      // its bubble sits above its name tag, i.e. above and right of centre.
      const cx = W / 2 + 3 * 16, cy = H / 2;
      expect(count(after, W, bubbleCream, cx - 24, cx + 40, cy - 48, cy - 8), "remote bubble plate ink").toBeGreaterThan(150);
      expect(count(after, W, bubbleCream, 0, W, 0, H) - count(after, W, bubbleCream, cx - 24, cx + 40, cy - 48, cy - 8), "no other cream plate").toBe(0);
      unmount(w);
    }, 30_000);
  }
});

simDescribe("wander-online meet view: invites and the realm pin", () => {
  test("menu L mints an invite: the notice shows the token and the page gets a link event; the page can dismiss it", async () => {
    const f = fixture({ inviteReply: { type: "invite", code: "ABCDEFGH", realm: "realm-test", expiresIn: 3600 } });
    const w = await boot(f.opts);
    await enterWorld(w);
    expect(state()!.realmPin).toBe("realm-test");
    press(w, BTN.SELECT);
    expect(treeHasText(w.getTree(), "L: invite a friend")).toBe(true);
    expect(treeHasText(w.getTree(), "R: any world · CROSS: close")).toBe(true);
    const menu = menuRect(480, 272);
    expect(measure("R: any world · CROSS: close")).toBeLessThanOrEqual(menu.x1 - menu.x0 - 20);
    press(w, BTN.LTRIGGER);
    await waitFor(w, () => state()!.invite !== "", "invite token");
    expect(f.text.filter((m) => m.type === "inviteq")).toHaveLength(1);
    expect(state()!.invite).toBe("realm-test.ABCDEFGH");
    const notice = "INVITE realm-test.ABCDEFGH · 60 min";
    expect(state()!.notice).toBe(notice);
    expect(treeHasText(w.getTree(), notice)).toBe(true);
    expect(pageEvents.filter((e) => e.type === "invite")).toEqual([{ type: "invite", token: "realm-test.ABCDEFGH", expiresIn: 3600 }]);
    command()!("inviteEnd");
    pump(w, 2);
    expect(state()!.notice).toBe("");
    // The help line fits with the new R EMOTE entry.
    const help = "D-PAD MOVE · O TALK · X ACT/LOG · TRI FAST · R EMOTE · SEL MENU";
    expect(treeHasText(w.getTree(), help)).toBe(true);
    expect(12 + measure(help)).toBeLessThanOrEqual(helpRect(480, 272).x1);
    unmount(w);
  }, 30_000);

  test("an invite token at boot joins with ?realm=&invite=, pins the realm and is consumed; menu R drops the pin", async () => {
    const f = fixture();
    const w = await boot(f.opts, 480, 272, { __pocketInvite: "realm-test.ABCDEFGH" });
    await enterWorld(w);
    expect(f.urls[0]).toBe("ws://fake/ws/v4?realm=realm-test&invite=ABCDEFGH");
    expect(state()!.realmPin).toBe("realm-test");
    expect(pageEvents.filter((e) => e.type === "inviteConsumed")).toHaveLength(1);
    // "Any world": the next connection carries no pin at all.
    press(w, BTN.SELECT);
    press(w, BTN.RTRIGGER);
    expect(state()!.notice).toBe("Joining any world…");
    await waitFor(w, () => f.urls.length >= 2, "reconnect without the pin");
    expect(f.urls[1]).toBe("ws://fake/ws/v4");
    await waitFor(w, () => state()!.status === "joined", "rejoined");
    expect(state()!.realmPin).toBe("realm-test");
    unmount(w);
  }, 30_000);
});
