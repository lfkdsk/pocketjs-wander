// tests/wander-online-journey-view.test.ts — the single-player gameplay on
// the online world screen, with the server as the authority: notice boards
// and resident dialogs read the exact single-player lines, the plaza action
// and talks go out as COMMAND frames and the server's PLAYER_JOURNEY reply
// drives the ERRAND bar and the notices, the travel log pages and announces
// private sightings, auto-walk is opt-in, TRIANGLE requests fast mode that
// only a snapshot confirms, and every HUD line fits its box with a
// 12-code-point CJK name at both acceptance resolutions.
import { describe, expect, test } from "bun:test";
import { bootWorld, treeHasText } from "../vendor/pocket-rpgkit/vendor/pocketjs/hosts/sim/sim.ts";
import { appBundle, appPreflight } from "./helpers/boot.ts";
import { fakeOnlineSocketFactory, type FakeOnlineOpts } from "./lib/fake-online-socket.ts";
import { BTN } from "@pocketjs/framework/input";
import type { PocketSocket } from "@pocketjs/framework/socket";
import { errandBarRect, logBarRect, statusPlate, NAME_LABEL_W, helpRect } from "../examples/wander-online/hud.ts";
import type { OnlinePublished } from "../examples/wander-online/OnlineView.tsx";
import {
  BTN as WIRE_BTN,
  COMMAND,
  encodePlayerProgress,
  encodeRoster,
  encodeState4,
  type CommandMessage,
} from "../examples/wander-online/net/protocol.ts";
import { JOURNEY_EVENT, errandHudText, journeyEventText } from "../examples/wander-online/net/journey.ts";
import { planRegion, regionName } from "../examples/wander/region.ts";
import { regionHub } from "../examples/wander/world.ts";
import { nearestLandmark } from "../examples/wander/landmarks.ts";
import { purePlacedLandmark, townErrand, townFacts, townPlaque, townTalk, type TownLookups } from "../examples/wander/towns.ts";

const preflight = appPreflight("wander-online");
if (!preflight.ok) console.warn(`wander-online journey view tests skipped: ${preflight.reason}`);
const simDescribe = preflight.ok ? describe : describe.skip;

/** A realm whose region (4,0) is the town West Roserest: hub (438,42), 12
 *  residents, the notice board at (439,43) and the OLD CAMP at (464,23). */
const SEED = 1593842689;
const TOWN = { rx: 4, ry: 0, hub: { x: 438, y: 42 }, board: { x: 439, y: 43 }, landmark: { kind: "OLD CAMP" } };
/** Far enough into growth that every region, board and resident is born. */
const GROWN_MS = 10_000_000;
const DPAD = WIRE_BTN.up | WIRE_BTN.right | WIRE_BTN.down | WIRE_BTN.left;
const CJK_NAME = "一二三四五六七八九十一二";
/** Twelve code points the 12 px name font does not hold (katakana is
 *  outside the GB 2312 level-1 name charset, so the server refuses such a
 *  name; the fake socket bypasses that). Every one of them resolves to the
 *  atlas's replacement glyph. */
const TOFU_NAME = "カイカイカイカイカイカイ";
const TILE = 16;

const lookups: TownLookups = {
  hubOf: (rx, ry) => regionHub(SEED, rx, ry),
  landmarkOf: (rx, ry) => purePlacedLandmark(SEED, rx, ry),
};

/** The nearest town to West Roserest that offers an errand (the town itself
 *  offers none). */
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

/** The single-player rumor line for a player tile and a found set. */
function rumorText(x: number, y: number, found: ReadonlySet<string>): string {
  const lm = nearestLandmark(x, y, 4, (rx, ry) => purePlacedLandmark(SEED, rx, ry), (rx, ry) => found.has(`${rx},${ry}`));
  if (!lm) return "RUMOR: nothing nearby";
  const dist = Math.abs(x - lm.cx) + Math.abs(y - lm.cy);
  const wx = Math.sign(lm.cx - x), wy = Math.sign(lm.cy - y);
  const dir = wy < 0 ? (wx < 0 ? "NW" : wx > 0 ? "NE" : "N") : wy > 0 ? (wx < 0 ? "SW" : wx > 0 ? "SE" : "S") : wx < 0 ? "W" : "E";
  return `RUMOR: ${lm.kindName} ${dir} ${dist}`;
}

interface World {
  frame: (b: number, a?: number, t?: readonly number[]) => void;
  tick: () => void;
  render: () => Uint8Array;
  getTree: () => unknown;
  ticksPerFrame: number;
}

interface VillagerProbe {
  look: number;
  pose: number;
  facing: number;
  x: number;
  y: number;
  sx: number;
  sy: number;
}

interface Fixture {
  opts: FakeOnlineOpts;
  sent: CommandMessage[];
  inputs: number[];
  socket: () => PocketSocket;
}

/** A grown realm at `tx,ty` with command/input capture and a heartbeat so
 *  long pumps never trip the client's snapshot freeze. */
function fixture(tx: number, ty: number, extra: Partial<FakeOnlineOpts> = {}): Fixture {
  const sent: CommandMessage[] = [];
  const inputs: number[] = [];
  let sock: PocketSocket | null = null;
  const opts: FakeOnlineOpts = {
    mode: "welcome4",
    name: "Octo",
    look: 3,
    ticket: "t1",
    realm: { tx, ty, seed: SEED, epoch: 5 },
    serverTimeMs: GROWN_MS,
    heartbeat: true,
    sentBinary: sent,
    sentInputs: inputs,
    onSocket: (s) => { sock = s; },
    ...extra,
  };
  return { opts, sent, inputs, socket: () => sock! };
}

async function boot(opts: FakeOnlineOpts, width = 480, height = 272, globals: Record<string, unknown> = {}): Promise<World> {
  (globalThis as { __onlineState?: OnlinePublished }).__onlineState = undefined;
  (globalThis as { __onlineVillagerPositions?: Record<string, VillagerProbe> }).__onlineVillagerPositions = undefined;
  (globalThis as { __onlineAutoWalk?: boolean }).__onlineAutoWalk = undefined;
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
const probes = (): Record<string, VillagerProbe> =>
  (globalThis as { __onlineVillagerPositions?: Record<string, VillagerProbe> }).__onlineVillagerPositions ?? {};

const waitFor = async (w: World, pred: () => boolean, what: string, timeoutMs = 8000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    pump(w, 1);
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timeout waiting for ${what}`);
};

/** Join and let the spawn region's plan and residents come up. */
async function enterWorld(w: World): Promise<void> {
  pump(w, 5);
  await waitFor(w, () => state()?.status === "joined", "v4 joined");
  await waitFor(w, () => (state()?.villagers ?? 0) >= 1, "residents of the spawn town");
  pump(w, 6);
}

function press(w: World, btn: number): void {
  pump(w, 1, btn);
  pump(w, 1, 0);
}

function count(fb: Uint8Array, stride: number, pred: (r: number, g: number, b: number) => boolean, x0: number, x1: number, y0: number, y1: number): number {
  let n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = (y * stride + x) * 4;
    if (pred(fb[i]!, fb[i + 1]!, fb[i + 2]!)) n++;
  }
  return n;
}

/** Width in the 12 px regular slot (slot 0), the slot every HUD line and
 *  name tag uses. */
const measure = (text: string): number =>
  (globalThis as unknown as { ui: { measureText(value: string, slot: number): number } }).ui.measureText(text, 0);

// -- glyph cells vs the replacement glyph ------------------------------------
//
// A code point the slot's atlas does not map resolves to gid 0 (the core's
// `glyph` in engine/core/src/text.rs) with the full 12 px cell advance, so a
// name outside the font still MEASURES 12 px per code point: only the
// pixels tell. gid 0 is baked by bake-font.ts `tofu`: a one-pixel hollow
// ring round(12 * 0.55) = 7 px wide and round(12 * 0.7) = 8 px tall, flush
// with the pen, its bottom row one above the baseline, nothing else in the
// cell. A real Han glyph of the name font inks its interior and reaches
// past column 6; none is a bare 7x8 ring.

/** Whether the framebuffer pixel at (x, y) carries the text's ink. */
type Ink = (x: number, y: number) => boolean;

const CELL_W = 12;
/** Rows scanned for a 12 px line's glyph cell: the 15 px cell is centred
 *  on the 12 px line, so it starts one row above the line's top, and its
 *  baseline is row 12; Han glyphs and the ring never ink below it (the
 *  rows past the baseline are left out so a line at the bottom of its
 *  plate does not scan the world beneath). */
const CELL_ROWS = 13;
const TOFU_W = 7;
const TOFU_H = 8;
/** Ink a drawn glyph must carry to count as painted (the thinnest Han
 *  glyph of the names here, 一, is a single 10 px stroke). */
const GLYPH_MIN_INK = 8;

interface CellInk {
  count: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Ink count and inclusive bounding box inside the 12 px cell whose line
 *  top is (x0, y0). */
function cellInk(ink: Ink, x0: number, y0: number): CellInk {
  const box: CellInk = { count: 0, x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (let y = y0 - 1; y < y0 - 1 + CELL_ROWS; y++) for (let x = x0; x < x0 + CELL_W; x++) {
    if (!ink(x, y)) continue;
    box.count++;
    box.x0 = Math.min(box.x0, x);
    box.y0 = Math.min(box.y0, y);
    box.x1 = Math.max(box.x1, x);
    box.y1 = Math.max(box.y1, y);
  }
  return box;
}

/** The cell is the replacement glyph: its ink is exactly a hollow 7x8
 *  rectangle, every ring pixel inked and nothing inside or beside it. */
function cellLooksLikeTofu(ink: Ink, x0: number, y0: number): boolean {
  const box = cellInk(ink, x0, y0);
  if (box.count === 0 || box.x1 - box.x0 + 1 !== TOFU_W || box.y1 - box.y0 + 1 !== TOFU_H) return false;
  for (let y = box.y0; y <= box.y1; y++) for (let x = box.x0; x <= box.x1; x++) {
    const ring = x === box.x0 || x === box.x1 || y === box.y0 || y === box.y1;
    if (ink(x, y) !== ring) return false;
  }
  return true;
}

/** The cell paints a real glyph: enough ink, and not the replacement ring. */
function cellIsGlyph(ink: Ink, x0: number, y0: number): boolean {
  return cellInk(ink, x0, y0).count >= GLYPH_MIN_INK && !cellLooksLikeTofu(ink, x0, y0);
}

/** Ink over a dark plate: the pixel is brighter than `min` (r + g + b). */
const inkBrighterThan = (fb: Uint8Array, stride: number, min: number): Ink => (x, y) => {
  const i = (y * stride + x) * 4;
  return fb[i]! + fb[i + 1]! + fb[i + 2]! > min;
};

/** Ink of white text over an arbitrary background, given the same frame
 *  rendered without the text: the pixel moved at least `min` of the way
 *  from its blank-frame value toward 255 on the channel with the most
 *  headroom (an anti-aliased stroke edge at a third coverage is not ink,
 *  a half-covered one is, matching the plate threshold above). */
const inkCoveredOver = (fb: Uint8Array, blank: Uint8Array, stride: number, min: number): Ink => (x, y) => {
  const i = (y * stride + x) * 4;
  let best = 0;
  for (let c = 0; c < 3; c++) {
    const head = 255 - blank[i + c]!;
    if (head >= 64) best = Math.max(best, (fb[i + c]! - blank[i + c]!) / head);
  }
  return best >= min;
};

/** Pixels that differ between two frames in rows [y0, y1), outside the
 *  columns [skipX0, skipX1). */
function differingOutside(a: Uint8Array, b: Uint8Array, stride: number, y0: number, y1: number, skipX0: number, skipX1: number): number {
  let n = 0;
  for (let y = y0; y < y1; y++) for (let x = 0; x < stride; x++) {
    if (x >= skipX0 && x < skipX1) continue;
    const i = (y * stride + x) * 4;
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) n++;
  }
  return n;
}

/** The local walker's name tag (OnlineView `syncWorld`): the sprite sits
 *  at the viewport centre (the realm camera centres the mover), the
 *  NAME_LABEL_W label is centred on the sprite 14 px above it, and the
 *  text is centred in the label. Returns the label box and the text's
 *  left edge / line top. */
function nameTag(W: number, H: number, text: string): { x0: number; x1: number; y0: number; textX: number } {
  const spriteX = Math.floor(W / 2) - TILE / 2, spriteY = Math.floor(H / 2) - TILE / 2;
  const x0 = spriteX + TILE / 2 - NAME_LABEL_W / 2;
  return { x0, x1: x0 + NAME_LABEL_W, y0: spriteY - 14, textX: x0 + Math.floor((NAME_LABEL_W - measure(text)) / 2) };
}

const unmount = (w: World): void => { w.frame(0); };

simDescribe("wander-online journey view: talk and notice boards", () => {
  test("CIRCLE facing the notice board shows the single-player plaque lines and blocks movement", async () => {
    // Spawn one tile above the board, facing down: the board is in front.
    const f = fixture(TOWN.board.x, TOWN.board.y - 1);
    const w = await boot(f.opts);
    await enterWorld(w);
    expect(state()!.dialog).toBe(false);
    press(w, BTN.CIRCLE);
    pump(w, 2);
    expect(state()!.dialog).toBe(true);
    const plan = planRegion(SEED, TOWN.rx, TOWN.ry);
    const lines = townPlaque(SEED, plan, townFacts(SEED, plan, lookups), townErrand(SEED, TOWN.rx, TOWN.ry), false);
    expect(lines[0]).toBe(`<${plan.name}>`);
    for (const line of lines) expect(treeHasText(w.getTree(), line), line).toBe(true);
    // Reading the board is not a conversation: no command goes out.
    expect(f.sent).toHaveLength(0);
    // Movement is blocked while the panel is open: the held d-pad never
    // reaches the lockstep stream and the tile does not change.
    const before = { x: state()!.x, y: state()!.y, sent: f.inputs.length };
    pump(w, 30, BTN.RIGHT);
    expect(state()!.x).toBe(before.x);
    expect(state()!.y).toBe(before.y);
    expect(f.inputs.length).toBeGreaterThan(before.sent);
    for (const mask of f.inputs.slice(before.sent)) expect(mask & DPAD).toBe(0);
    // The bottom bars are hidden under the panel, CIRCLE closes it.
    expect(treeHasText(w.getTree(), "ERRAND: none")).toBe(false);
    press(w, BTN.CIRCLE);
    pump(w, 2);
    expect(state()!.dialog).toBe(false);
    expect(treeHasText(w.getTree(), lines[1]!)).toBe(false);
    expect(treeHasText(w.getTree(), "ERRAND: none   HELPED 0")).toBe(true);
    unmount(w);
  }, 30_000);

  test("CIRCLE facing a resident shows its single-player lines and sends a talk command", async () => {
    // Spawn above the first resident's door, facing down; residents walk
    // their routes on the realm clock, so wait until one stands on the
    // tile in front (or the player's own tile), early in its step.
    const plan = planRegion(SEED, TOWN.rx, TOWN.ry);
    const door = plan.villagers[0]!;
    const me = { tx: door.x, ty: door.y - 1 };
    const f = fixture(me.tx, me.ty);
    const w = await boot(f.opts, 480, 272, { __onlineVillagerPositions: {} });
    await enterWorld(w);
    const DX = [0, -1, 0, 1], DY = [1, 0, -1, 0];
    const fromTile = (v: VillagerProbe): { x: number; y: number; off: number } => {
      // A resident occupies its step's start tile for the whole step.
      const x = DX[v.facing] < 0 ? Math.ceil(v.x / 16) : Math.floor(v.x / 16);
      const y = DY[v.facing] < 0 ? Math.ceil(v.y / 16) : Math.floor(v.y / 16);
      return { x, y, off: Math.abs(v.x - x * 16) + Math.abs(v.y - y * 16) };
    };
    let target: { n: number; house: number } | null = null;
    await waitFor(w, () => {
      const p = probes();
      for (let n = 0; n < plan.villagers.length; n++) {
        const v = p[plan.villagers[n]!.id];
        if (!v) continue;
        const t = fromTile(v);
        const adjacent = (t.x === me.tx && t.y === me.ty + 1) || (t.x === me.tx && t.y === me.ty);
        if (adjacent && t.off <= 8) {
          target = { n, house: plan.villagers[n]!.house };
          return true;
        }
      }
      return false;
    }, "a resident in front of the player", 25_000);
    expect(target).not.toBeNull();
    pump(w, 1, BTN.CIRCLE);
    pump(w, 1, 0);
    expect(state()!.dialog).toBe(true);
    const { lines } = townTalk(SEED, plan, target!.house, townFacts(SEED, plan, lookups), townErrand(SEED, TOWN.rx, TOWN.ry), false);
    expect(lines).toHaveLength(4);
    for (const line of lines) expect(treeHasText(w.getTree(), line), line).toBe(true);
    expect(f.sent).toEqual([{ kind: COMMAND.talk, rx: TOWN.rx, ry: TOWN.ry, extra: target!.n }]);
    press(w, BTN.CIRCLE);
    pump(w, 2);
    expect(state()!.dialog).toBe(false);
    unmount(w);
  }, 40_000);
});

simDescribe("wander-online journey view: plaza errands", () => {
  test("CROSS near a hub sends accept; the server's journey reply fills the ERRAND bar and the notice", async () => {
    const town = errandTown();
    const hub = regionHub(SEED, town.rx, town.ry);
    const errand = townErrand(SEED, town.rx, town.ry)!;
    const f = fixture(hub.x, hub.y, {
      commandReply: (cmd) => cmd.kind === COMMAND.acceptErrand
        ? { revision: 1, eventSeq: 1, eventKind: JOURNEY_EVENT.accepted, eventRx: cmd.rx, eventRy: cmd.ry, errand: { rx: cmd.rx, ry: cmd.ry } }
        : null,
    });
    const w = await boot(f.opts);
    await enterWorld(w);
    expect(treeHasText(w.getTree(), errandHudText(null, 0))).toBe(true);
    press(w, BTN.CROSS);
    expect(f.sent).toEqual([{ kind: COMMAND.acceptErrand, rx: town.rx, ry: town.ry, extra: 0 }]);
    // The scripted PLAYER_JOURNEY reply lands on the next task.
    await new Promise((r) => setTimeout(r, 5));
    pump(w, 8);
    const accepted = journeyEventText(SEED, { seq: 1, kind: JOURNEY_EVENT.accepted, rx: town.rx, ry: town.ry });
    expect(accepted.startsWith("ERRAND: ")).toBe(true);
    expect(state()!.notice).toBe(accepted);
    expect(treeHasText(w.getTree(), accepted)).toBe(true);
    const bar = errandHudText(errand, 0);
    expect(state()!.errand).toBe(bar);
    expect(treeHasText(w.getTree(), bar)).toBe(true);
    // With the errand active and its target elsewhere, CROSS here sends
    // nothing (the single-player plaza action is a no-op too).
    press(w, BTN.CROSS);
    pump(w, 2);
    expect(f.sent).toHaveLength(1);
    unmount(w);
  }, 30_000);
});

simDescribe("wander-online journey view: travel log", () => {
  test("CROSS away from a plaza pages the log; a progress delta announces FOUND", async () => {
    // Far from the hub (Manhattan 76), still inside region (4,0).
    const me = { x: 400, y: 80 };
    const f = fixture(me.x, me.y);
    const w = await boot(f.opts);
    await enterWorld(w);
    expect(treeHasText(w.getTree(), `LOG 0 · —    ${rumorText(me.x, me.y, new Set())}`)).toBe(true);
    press(w, BTN.CROSS);
    expect(f.sent).toHaveLength(0);
    expect(state()!.notice).toBe("LOG: nothing found yet");
    // The server records a sighting: a new key in the private progress.
    f.socket().onMessage?.(new Uint8Array(encodePlayerProgress({ revision: 1, landmarks: [{ rx: TOWN.rx, ry: TOWN.ry }] })));
    pump(w, 8);
    expect(state()!.logCount).toBe(1);
    expect(state()!.notice).toBe(`FOUND: ${TOWN.landmark.kind}`);
    const found = new Set([`${TOWN.rx},${TOWN.ry}`]);
    expect(treeHasText(w.getTree(), `LOG 1 · ${TOWN.landmark.kind}    ${rumorText(me.x, me.y, found)}`)).toBe(true);
    press(w, BTN.CROSS);
    expect(state()!.notice).toBe(`LOG 1/1: ${TOWN.landmark.kind} @ ${regionName(SEED, TOWN.rx, TOWN.ry)}`);
    // A second sighting: the log pages through both, oldest first.
    let second: { rx: number; ry: number; kind: string } | null = null;
    for (let dy = -4; dy <= 4 && !second; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        if (dx === 0 && dy === 0) continue;
        const lm = purePlacedLandmark(SEED, TOWN.rx + dx, TOWN.ry + dy);
        if (lm) { second = { rx: lm.rx, ry: lm.ry, kind: lm.kindName }; break; }
      }
    }
    expect(second).not.toBeNull();
    f.socket().onMessage?.(new Uint8Array(encodePlayerProgress({ revision: 2, landmarks: [{ rx: TOWN.rx, ry: TOWN.ry }, { rx: second!.rx, ry: second!.ry }] })));
    pump(w, 8);
    expect(state()!.notice).toBe(`FOUND: ${second!.kind}`);
    expect(state()!.logCount).toBe(2);
    press(w, BTN.CROSS);
    expect(state()!.notice).toBe(`LOG 2/2: ${second!.kind} @ ${regionName(SEED, second!.rx, second!.ry)}`);
    press(w, BTN.CROSS);
    expect(state()!.notice).toBe(`LOG 1/2: ${TOWN.landmark.kind} @ ${regionName(SEED, TOWN.rx, TOWN.ry)}`);
    unmount(w);
  }, 30_000);
});

simDescribe("wander-online journey view: auto-walk and fast", () => {
  test("auto-walk is off by default: 15 s of frames move nothing and send no d-pad bits", async () => {
    const f = fixture(TOWN.hub.x, TOWN.hub.y);
    const w = await boot(f.opts);
    await enterWorld(w);
    const start = { x: state()!.x, y: state()!.y };
    expect(start).toEqual(TOWN.hub);
    pump(w, 15 * 60);
    expect(state()!.status).toBe("joined");
    expect(state()!.auto).toBe(false);
    expect(state()!.autoWalk).toBe(false);
    expect(state()!.x).toBe(start.x);
    expect(state()!.y).toBe(start.y);
    expect(f.inputs.length).toBeGreaterThan(100);
    for (const mask of f.inputs) expect(mask & DPAD).toBe(0);
    unmount(w);
  }, 60_000);

  test("the boot hook turns auto-walk on and the player moves", async () => {
    const f = fixture(TOWN.hub.x, TOWN.hub.y);
    const w = await boot(f.opts, 480, 272, { __onlineAutoWalk: true });
    await enterWorld(w);
    expect(state()!.auto).toBe(true);
    const start = { x: state()!.x, y: state()!.y };
    await waitFor(w, () => state()!.x !== start.x || state()!.y !== start.y, "the auto walker to move", 15_000);
    expect(f.inputs.some((mask) => (mask & DPAD) !== 0)).toBe(true);
    unmount(w);
  }, 40_000);

  test("TRIANGLE requests fast mode; the HUD says FAST only after a snapshot confirms it", async () => {
    const f = fixture(TOWN.hub.x, TOWN.hub.y);
    const w = await boot(f.opts);
    await enterWorld(w);
    const line = (mode: string) => `X ${TOWN.hub.x}  Y ${TOWN.hub.y}  ${mode}`;
    expect(treeHasText(w.getTree(), line("YOU"))).toBe(true);
    expect(f.inputs.every((mask) => (mask & WIRE_BTN.fast) === 0)).toBe(true);
    const before = f.inputs.length;
    press(w, BTN.TRIANGLE);
    pump(w, 8);
    // Every input since the press carries the fast bit (the request).
    expect(f.inputs.length).toBeGreaterThan(before + 3);
    expect(f.inputs.slice(before + 3).every((mask) => (mask & WIRE_BTN.fast) !== 0)).toBe(true);
    // Not confirmed yet: the HUD keeps YOU.
    expect(state()!.fast).toBe(false);
    expect(treeHasText(w.getTree(), line("YOU"))).toBe(true);
    expect(treeHasText(w.getTree(), line("FAST"))).toBe(false);
    f.socket().onMessage?.(new Uint8Array(encodeState4(1000, 0, 5, [{
      id: 1, tx: TOWN.hub.x, ty: TOWN.hub.y, px: 0, py: 0,
      dir: 0, phase: 0, stepDir: 0, moving: false, walking: false, fast: true, color: 0,
    }])));
    pump(w, 8);
    expect(state()!.fast).toBe(true);
    expect(treeHasText(w.getTree(), line("FAST"))).toBe(true);
    // TRIANGLE again drops the request; the snapshot still says fast
    // until the server's next one, so the HUD keeps FAST.
    const again = f.inputs.length;
    press(w, BTN.TRIANGLE);
    pump(w, 4);
    expect(f.inputs.slice(again + 3).every((mask) => (mask & WIRE_BTN.fast) === 0)).toBe(true);
    expect(state()!.fast).toBe(true);
    unmount(w);
  }, 30_000);
});

simDescribe("wander-online journey view: text fits", () => {
  for (const [W, H] of [[480, 272], [960, 544]] as const) {
    test(`${W}x${H}: a CJK first/local name, a long log line and the errand line fit their boxes and paint`, async () => {
      const town = errandTown();
      const errand = townErrand(SEED, town.rx, town.ry)!;
      const f = fixture(TOWN.hub.x, TOWN.hub.y, {
        name: CJK_NAME,
        landmarkFirstName: CJK_NAME,
        progress: [{ rx: TOWN.rx, ry: TOWN.ry }],
        journey: { errand: { rx: town.rx, ry: town.ry }, helpedCount: 3 },
      });
      const w = await boot(f.opts, W, H);
      await enterWorld(w);
      pump(w, 12);
      const plate = statusPlate(W, H, false);
      const logBar = logBarRect(W, H);
      const errandBar = errandBarRect(W, H);
      const fb = w.render();

      // Name line: 12 CJK code points plus the population suffix.
      const nameLine = `${CJK_NAME} · ROOM 1 · ALL 1`;
      expect(treeHasText(w.getTree(), nameLine)).toBe(true);
      expect(measure(nameLine), "name line fits the plate's text box").toBeLessThanOrEqual(plate.x1 - 18);
      expect(count(fb, W, (r, g, b) => r === 0x9f && g === 0xd0 && b === 0xff, 12, 12 + measure(nameLine), plate.y0 + 15, plate.y0 + 27), "name line ink").toBeGreaterThan(20);
      // Each of the 12 CJK cells paints a glyph, not the replacement ring
      // (see cellLooksLikeTofu; the width cannot tell, a cmap miss keeps
      // the 12 px advance). Mutation: break the fonts.json fallback and
      // every cell becomes the ring.
      expect(measure(CJK_NAME), "CJK cells are 12 px wide").toBe(12 * 12);
      const plateInk = inkBrighterThan(fb, W, 330);
      for (let i = 0; i < 12; i++) {
        expect(cellLooksLikeTofu(plateInk, 12 + i * 12, plate.y0 + 15), `name cell ${i} (${CJK_NAME[i]}) is the replacement ring`).toBe(false);
        expect(cellIsGlyph(plateInk, 12 + i * 12, plate.y0 + 15), `name cell ${i} (${CJK_NAME[i]}) paints a glyph`).toBe(true);
      }

      // Status line with the CJK first discoverer as the suffix.
      const posLine = `X ${TOWN.hub.x}  Y ${TOWN.hub.y}  YOU  FIRST ${CJK_NAME}`;
      expect(treeHasText(w.getTree(), posLine)).toBe(true);
      expect(12 + measure(posLine), "status line stays inside the viewport").toBeLessThanOrEqual(W);
      const suffixX0 = 12 + measure(posLine.slice(0, -CJK_NAME.length));
      const suffixX1 = 12 + measure(posLine);
      expect(count(fb, W, (r, g, b) => r === 0xc8 && g === 0xd6 && b === 0xea, suffixX0, suffixX1, plate.y0 + 28, plate.y0 + 40), "FIRST suffix ink").toBeGreaterThan(20);
      for (let i = 0; i < 12; i++) {
        expect(cellLooksLikeTofu(plateInk, suffixX0 + i * 12, plate.y0 + 28), `FIRST cell ${i} (${CJK_NAME[i]}) is the replacement ring`).toBe(false);
        expect(cellIsGlyph(plateInk, suffixX0 + i * 12, plate.y0 + 28), `FIRST cell ${i} (${CJK_NAME[i]}) paints a glyph`).toBe(true);
      }
      // The local name tag holds the whole name (its pixels are checked in
      // the control test below, over a static background).
      expect(measure(CJK_NAME)).toBeLessThanOrEqual(NAME_LABEL_W - 8);

      // LOG / RUMOR bar: the actual line and the worst-case line both fit.
      const found = new Set([`${TOWN.rx},${TOWN.ry}`]);
      const logLine = `LOG 1 · ${TOWN.landmark.kind}    ${rumorText(TOWN.hub.x, TOWN.hub.y, found)}`;
      expect(treeHasText(w.getTree(), logLine)).toBe(true);
      expect(measure(logLine), "log line fits its bar").toBeLessThanOrEqual(logBar.x1 - 12);
      expect(measure("LOG 1024 · STANDING STONES    RUMOR: STANDING STONES SW 1000"), "worst-case log line fits its bar").toBeLessThanOrEqual(logBar.x1 - 12);
      expect(count(fb, W, (r, g, b) => r === 0xff && g === 0xe9 && b === 0x7a, logBar.x0, logBar.x1, logBar.y0, logBar.y1), "log line ink").toBeGreaterThan(40);

      // ERRAND bar from the server's journey.
      const errandLine = errandHudText(errand, 3);
      expect(state()!.errand).toBe(errandLine);
      expect(state()!.helpedCount).toBe(3);
      expect(treeHasText(w.getTree(), errandLine)).toBe(true);
      expect(measure(errandLine), "errand line fits its bar").toBeLessThanOrEqual(errandBar.x1 - 12);
      expect(count(fb, W, (r, g, b) => r === 0xff && g === 0xb3 && b === 0x7a, errandBar.x0, errandBar.x1, errandBar.y0, errandBar.y1), "errand line ink").toBeGreaterThan(40);

      // The help line fits its strip.
      const help = "D-PAD MOVE · O TALK · X ACT/LOG · TRI FAST · R EMOTE · SEL MENU";
      expect(treeHasText(w.getTree(), help)).toBe(true);
      expect(12 + measure(help)).toBeLessThanOrEqual(helpRect(W, H).x1);
      unmount(w);
    }, 30_000);

    test(`${W}x${H}: a name outside the font paints the replacement ring where the CJK name paints glyphs (name line, FIRST suffix, name tag)`, async () => {
      // Positive control for the detector. Open country of the fixture
      // region (the travel-log spot): no resident or plaza structure is in
      // view, so the world under the name tag is static while the roster
      // swaps the name, and a blank-name frame gives the tag's background.
      const me = { x: 400, y: 80 };
      const f = fixture(me.x, me.y, {
        name: TOFU_NAME,
        landmarkFirstName: TOFU_NAME,
        progress: [{ rx: TOWN.rx, ry: TOWN.ry }],
      });
      const w = await boot(f.opts, W, H);
      await enterWorld(w);
      pump(w, 12);
      const plate = statusPlate(W, H, false);
      // Width never tells: a cmap miss keeps the 12 px cell advance.
      expect(measure(TOFU_NAME)).toBe(measure(CJK_NAME));
      const fbTofu = w.render().slice();
      const plateInk = inkBrighterThan(fbTofu, W, 330);

      // HUD name line: every cell is the ring, none a glyph.
      expect(treeHasText(w.getTree(), `${TOFU_NAME} · ROOM 1 · ALL 1`)).toBe(true);
      for (let i = 0; i < 12; i++) {
        expect(cellLooksLikeTofu(plateInk, 12 + i * 12, plate.y0 + 15), `name cell ${i} is the replacement ring`).toBe(true);
        expect(cellIsGlyph(plateInk, 12 + i * 12, plate.y0 + 15), `name cell ${i} is not a glyph`).toBe(false);
      }
      // FIRST suffix: the same.
      const posLine = `X ${me.x}  Y ${me.y}  YOU  FIRST ${TOFU_NAME}`;
      expect(treeHasText(w.getTree(), posLine)).toBe(true);
      const suffixX0 = 12 + measure(posLine.slice(0, -TOFU_NAME.length));
      for (let i = 0; i < 12; i++) {
        expect(cellLooksLikeTofu(plateInk, suffixX0 + i * 12, plate.y0 + 28), `FIRST cell ${i} is the replacement ring`).toBe(true);
        expect(cellIsGlyph(plateInk, suffixX0 + i * 12, plate.y0 + 28), `FIRST cell ${i} is not a glyph`).toBe(false);
      }

      // Name tag: blank the name through the roster for the background,
      // then show the CJK name. The band of rows the tag occupies is
      // identical across the three frames outside the label box.
      const tag = nameTag(W, H, TOFU_NAME);
      expect(nameTag(W, H, CJK_NAME).textX).toBe(tag.textX);
      const roster = (name: string) => {
        f.socket().onMessage?.(new Uint8Array(encodeRoster([{ id: 1, name, look: f.opts.look! }])));
        pump(w, 2);
      };
      roster(" ");
      const fbBlank = w.render().slice();
      roster(CJK_NAME);
      const fbCjk = w.render().slice();
      const bandY0 = tag.y0 - 1, bandY1 = tag.y0 - 1 + CELL_ROWS;
      expect(differingOutside(fbTofu, fbBlank, W, bandY0, bandY1, tag.x0, tag.x1), "static world beside the tag (tofu vs blank)").toBe(0);
      expect(differingOutside(fbCjk, fbBlank, W, bandY0, bandY1, tag.x0, tag.x1), "static world beside the tag (CJK vs blank)").toBe(0);
      const tofuInk = inkCoveredOver(fbTofu, fbBlank, W, 0.5);
      const cjkInk = inkCoveredOver(fbCjk, fbBlank, W, 0.5);
      for (let i = 0; i < 12; i++) {
        expect(cellLooksLikeTofu(tofuInk, tag.textX + i * 12, tag.y0), `tag cell ${i} of the missing name is the replacement ring`).toBe(true);
        expect(cellIsGlyph(tofuInk, tag.textX + i * 12, tag.y0), `tag cell ${i} of the missing name is not a glyph`).toBe(false);
        expect(cellLooksLikeTofu(cjkInk, tag.textX + i * 12, tag.y0), `tag cell ${i} (${CJK_NAME[i]}) is the replacement ring`).toBe(false);
        expect(cellIsGlyph(cjkInk, tag.textX + i * 12, tag.y0), `tag cell ${i} (${CJK_NAME[i]}) paints a glyph`).toBe(true);
      }
      unmount(w);
    }, 40_000);
  }
});
