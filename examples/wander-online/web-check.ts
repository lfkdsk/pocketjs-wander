// examples/wander-online/web-check.ts — drive a headless chrome tab running
// the wander-online web build through the Chrome DevTools Protocol and
// assert the acceptance case by STATE, not screenshots:
//
//   1. the web client joins (status "joined", myId assigned),
//   2. it sees the other two clients (online === 3, two remote players) and
//      the expected whole-service population (`allOnline`),
//   3. someone moves (local or a remote player changes position).
//
// Then it writes a 3x screenshot and prints one WEBCHECK JSON line.
//
// Watch mode (--watch) additionally waits for the connection to drop (a
// server restart in the demo) and for a fresh rejoin that satisfies the
// same three assertions — the restart-recovery phase.
//
//   bun run examples/wander-online/web-check.ts \
//     --cdp http://127.0.0.1:9222 --page http://127.0.0.1:9003/wander-online/ \
//     --out web.png [--wide-out web-wide.png] [--watch] [--expect 3] \
//     [--expect-all 3] [--expect-realm local] [--ticket value] \
//     [--expect-first] [--expect-progress 1] [--expect-improvement 1] \
//     [--auto-walk] [--create-name 演示网页 --create-look 40] \
//     [--expect-name 演示网页] [--invite plaza-2.K7MQ2XJ4] [--mint-invite] \
//     [--meet-prefix /path/to/cf-web] [--expect-reject "WORLD FULL"]
//     [--close-page]
//     [--timeout-ms 60000]
//
// --auto-walk turns the client's opt-in auto-walk driver on at boot (the
// movement assertion then needs no remote player to move).
//
// --create-name drives character creation the way a browser player does:
// the ticket has no profile yet, so the game shows its creation screen and
// the page's control bar shows the name text box (the input-method path for
// a Chinese name). The script picks --create-look with real key events on
// the game screen (R toggles to the look panel, arrows cycle it), inserts
// the name into the page box through Chrome's text-input path and clicks
// Create. --expect-name then requires the roster entry of this client to
// carry that exact name, and the 480x272 screenshot's HUD name line is
// checked cell by cell for real glyphs (no replacement boxes).
//
// Exit 0 on success, 1 on any failed assertion or timeout. The DevTools
// endpoint is chrome's own loopback listener; this script never opens a
// non-loopback socket.

import { decodePng } from "../../vendor/pocket-rpgkit/vendor/pocketjs/framework/compiler/pak.ts";
import { FAR_LABEL_W, FAR_MARKER_SIZE, farMarkerPoint, farMarkerRect, statusPlate } from "./hud.ts";
import { farVector } from "./net/far.ts";
import { glyphCellVerdict, NAME_FONT_PX } from "./glyph-check.ts";

interface RemotePos {
  id: number;
  x: number;
  y: number;
}

interface PublishedState {
  status: string;
  screen: string;
  myId: number;
  online: number;
  allOnline: number;
  rtt: number;
  corrections: number;
  unacked: number;
  realmId: string;
  generatorVersion: number;
  landmarkFirstName: string;
  progressCount: number;
  improvementLevel: number;
  epoch: number;
  x: number;
  y: number;
  moving: boolean;
  auto: boolean;
  autoWalk: boolean;
  fast: boolean;
  helpedCount: number;
  errand: string;
  logCount: number;
  dialog: boolean;
  createError: string;
  rejectText: string;
  look: number;
  roster: Record<string, { name: string; look: number }>;
  remote: RemotePos[];
  far: { id: number; dir: number; band: number }[];
  emotes: Record<string, number>;
  emoteBar: boolean;
  /** The last invite token this client minted ("" until then). */
  invite: string;
  /** The realm the client asks for on (re)connect. */
  realmPin: string;
}

export interface WebCheckFlags {
  cdp: string;
  page: string;
  out: string;
  /** Optional second 960x544 logical viewport capture. */
  wideOut: string | null;
  watch: boolean;
  expect: number;
  expectAll: number;
  timeoutMs: number;
  expectRealm: string | null;
  expectFirst: boolean;
  expectProgress: number;
  expectImprovement: number;
  /** Auth ticket injected into the page, never included in WEBCHECK output. */
  ticket: string | null;
  /** Boot the page with the auto-walk driver on (`__onlineAutoWalk`). */
  autoWalk: boolean;
  /** Create the character through the page's name box with this name. */
  createName: string | null;
  /** The look to pick with key events before creating (0..63). */
  createLook: number;
  /** The roster name this client must carry once joined. */
  expectName: string | null;
  /** An invite token (`<realm>.<CODE>`) supplied through the real
   *  `#invite=` page entry path: the client joins that realm with it. */
  invite: string | null;
  /** After joining, mint an invite with real key events (SELECT, then L)
   *  and require the page's invite link box to show it. */
  mintInvite: boolean;
  /** Exercise one real preset emote and walk beyond the server AOI, writing
   *  480x272 and 960x544 3x captures for both states under this prefix. */
  meetPrefix: string | null;
  /** Alternate mode: require this explicit refusal instead of joining. */
  expectReject: string | null;
  /** Navigate away after all assertions so hosted demos close cleanly. */
  closePage: boolean;
}

export function parseFlags(args: readonly string[]): WebCheckFlags {
  const get = (name: string, def: string): string => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? (args[i + 1] ?? def) : def;
  };
  const expect = Number(get("expect", "3"));
  return {
    cdp: get("cdp", "http://127.0.0.1:9222"),
    page: get("page", "http://127.0.0.1:9003/wander-online/"),
    out: get("out", "web.png"),
    wideOut: get("wide-out", "") || null,
    watch: args.includes("--watch"),
    expect,
    expectAll: Number(get("expect-all", String(expect))),
    timeoutMs: Number(get("timeout-ms", "60000")),
    expectRealm: get("expect-realm", "") || null,
    expectFirst: args.includes("--expect-first"),
    expectProgress: Number(get("expect-progress", "0")),
    expectImprovement: Number(get("expect-improvement", "0")),
    ticket: get("ticket", "") || null,
    autoWalk: args.includes("--auto-walk"),
    createName: get("create-name", "") || null,
    createLook: Number(get("create-look", "0")),
    expectName: get("expect-name", "") || null,
    invite: get("invite", "") || null,
    mintInvite: args.includes("--mint-invite"),
    meetPrefix: get("meet-prefix", "") || null,
    expectReject: get("expect-reject", "") || null,
    closePage: args.includes("--close-page"),
  };
}

/** Build the same invitation URL a player receives from the in-game menu.
 * Existing fragment parameters survive so this remains a faithful browser
 * entry path even when another page option is present. */
export function pageUrl(page: string, invite: string | null): string {
  if (!invite) return page;
  const url = new URL(page);
  const fragment = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
  fragment.set("invite", invite);
  url.hash = fragment.toString();
  return url.toString();
}

export function inviteLinkHasToken(link: unknown, token: string): link is string {
  return typeof link === "string" && link.endsWith(`#invite=${token}`);
}

const flags = parseFlags(process.argv.slice(2));

const deadline = Date.now() + flags.timeoutMs;
const timeLeft = () => deadline - Date.now();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fail(message: string): never {
  console.error(`web-check: ${message}`);
  process.exit(1);
}

interface RemoteValue {
  type?: unknown;
  value?: unknown;
  description?: unknown;
}

function remoteValueText(value: RemoteValue): string {
  if (typeof value.value === "string") return value.value;
  if (value.value !== undefined) {
    try {
      return JSON.stringify(value.value);
    } catch {
      // Fall through to the protocol description.
    }
  }
  if (typeof value.description === "string") return value.description;
  return typeof value.type === "string" ? value.type : "unknown";
}

/** Turn browser error events into stable diagnostics. Warnings and ordinary
 * console output are intentionally ignored: this gate rejects console.error
 * and uncaught page exceptions, which are the two actionable failure paths. */
export function browserErrorFromEvent(method: string, params: unknown): string | null {
  if (method === "Runtime.consoleAPICalled") {
    const event = params as { type?: unknown; args?: unknown };
    if (event?.type !== "error") return null;
    const args = Array.isArray(event.args) ? event.args as RemoteValue[] : [];
    return `console.error: ${args.map(remoteValueText).join(" ") || "(no message)"}`;
  }
  if (method === "Runtime.exceptionThrown") {
    const event = params as {
      exceptionDetails?: {
        text?: unknown;
        exception?: RemoteValue;
        url?: unknown;
        lineNumber?: unknown;
      };
    };
    const details = event?.exceptionDetails;
    const message = details?.exception ? remoteValueText(details.exception) : details?.text;
    const at = typeof details?.url === "string" && details.url
      ? ` at ${details.url}:${Number(details.lineNumber ?? 0) + 1}`
      : "";
    return `uncaught exception: ${typeof message === "string" ? message : "unknown"}${at}`;
  }
  return null;
}

/** One CDP connection: JSON requests with matching ids over WebSocket. */
class Cdp {
  private nextId = 1;
  private readonly pending = new Map<number, (r: unknown) => void>();
  private readonly listeners = new Map<string, Array<(params: unknown) => void>>();

  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data)) as {
        id?: number;
        result?: unknown;
        method?: string;
        params?: unknown;
      };
      if (msg.id !== undefined) {
        const wake = this.pending.get(msg.id);
        if (wake) {
          this.pending.delete(msg.id);
          wake(msg.result);
        }
      } else if (msg.method) {
        for (const listener of this.listeners.get(msg.method) ?? []) listener(msg.params);
      }
    });
  }

  static async connect(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error(`cdp connect failed: ${url}`)));
    });
    return new Cdp(ws);
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`cdp timeout: ${method}`));
      }, 10_000);
      this.pending.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method: string, listener: (params: unknown) => void): void {
    const listeners = this.listeners.get(method);
    if (listeners) listeners.push(listener);
    else this.listeners.set(method, [listener]);
  }
}

interface Target {
  type: string;
  url?: string;
  webSocketDebuggerUrl: string;
}

async function attach(): Promise<Cdp> {
  // Chrome may still be starting: retry the target list.
  let last = "";
  while (timeLeft() > 0) {
    try {
      const res = await fetch(`${flags.cdp}/json`);
      const targets = (await res.json()) as Target[];
      // Prefer the blank tab Chrome was started with: newer headless Chrome
      // also lists internal pages, and navigating one of those never answers.
      // Without a blank tab, open a fresh one.
      let page = targets.find((t) => t.type === "page" && t.url === "about:blank" && t.webSocketDebuggerUrl);
      if (!page) {
        const created = await fetch(`${flags.cdp}/json/new?about:blank`, { method: "PUT" });
        if (created.ok) page = (await created.json()) as Target;
      }
      if (page?.webSocketDebuggerUrl) return Cdp.connect(page.webSocketDebuggerUrl);
      last = "no page target yet";
    } catch (err) {
      last = String(err);
    }
    await sleep(250);
  }
  fail(`chrome devtools endpoint never appeared at ${flags.cdp} (${last})`);
}

async function readState(cdp: Cdp): Promise<PublishedState | null> {
  const res = (await cdp.send("Runtime.evaluate", {
    expression: "JSON.stringify(globalThis.__onlineState || null)",
    returnByValue: true,
  })) as { result?: { value?: string } };
  const raw = res.result?.value;
  return raw ? (JSON.parse(raw) as PublishedState) : null;
}

const joinedExpected = (s: PublishedState | null): boolean =>
  s !== null &&
  s.status === "joined" &&
  s.myId > 0 &&
  (!flags.expectName || s.roster[String(s.myId)]?.name === flags.expectName) &&
  s.online === flags.expect &&
  s.allOnline === flags.expectAll &&
  (!flags.expectRealm || (s.realmId === flags.expectRealm && s.generatorVersion === 1)) &&
  (!flags.expectFirst || s.landmarkFirstName.length > 0) &&
  s.progressCount >= flags.expectProgress &&
  s.improvementLevel >= flags.expectImprovement &&
  s.remote.length === flags.expect - 1;

const posKey = (s: PublishedState): string =>
  `${s.x},${s.y}|` + s.remote.map((r) => `${r.id}:${r.x},${r.y}`).join(";");

/** Page errors seen so far (filled by main's listeners) and the page
 *  player's own liveness, for timeout diagnostics: a stopped page loop
 *  keeps reporting its last state forever. */
const browserErrors: string[] = [];
async function liveness(cdp: Cdp): Promise<string> {
  const read = () => evaluate(cdp, `JSON.stringify({ state: globalThis.__pocketPlayer?.state ?? null, frames: globalThis.__pocketPlayer?.frames ?? -1, hidden: document.hidden, focused: document.hasFocus(), active: document.activeElement?.id ?? "" })`);
  const a = String(await read());
  await sleep(1000);
  const b = String(await read());
  return `player before ${a}, 1 s later ${b}, errors ${JSON.stringify(browserErrors)}`;
}

/** Poll until `pred` holds, sampling every 300 ms. */
async function waitFor(cdp: Cdp, pred: (s: PublishedState | null) => boolean, what: string): Promise<PublishedState> {
  let last: PublishedState | null = null;
  let lastTrace = 0;
  while (timeLeft() > 0) {
    last = await readState(cdp);
    if (last && pred(last)) return last;
    if (process.env.WEBCHECK_TRACE && Date.now() - lastTrace > 2000 && last) {
      lastTrace = Date.now();
      console.log(`WEBCHECK_TRACE ${JSON.stringify({ t: Date.now(), status: last.status, epoch: last.epoch, myId: last.myId, online: last.online, allOnline: last.allOnline, remotes: last.remote.length, roster: Object.keys(last.roster), unacked: last.unacked, rtt: last.rtt, x: last.x, y: last.y })}`);
    }
    await sleep(300);
  }
  const live = await liveness(cdp).catch((err) => `liveness unavailable: ${String(err)}`);
  fail(`timed out waiting for ${what}; last state: ${JSON.stringify(last)}; ${live}`);
}

/** Poll until some position (local or either remote) changed since `first`. */
async function waitForMovement(cdp: Cdp, first: PublishedState): Promise<void> {
  const start = posKey(first);
  while (timeLeft() > 0) {
    const s = await readState(cdp);
    if (s && joinedExpected(s) && posKey(s) !== start) return;
    await sleep(300);
  }
  fail("timed out waiting for anyone to move");
}

/** One real key press on the game screen (the page maps `code` to a pad
 *  button); held for a few frames so the game sees a clean edge. */
async function pressKey(cdp: Cdp, code: string, key: string, vk: number): Promise<void> {
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", code, key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  await sleep(70);
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", code, key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  await sleep(70);
}

async function holdKey(cdp: Cdp, code: string, key: string, vk: number, ms: number): Promise<void> {
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", code, key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  await sleep(ms);
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", code, key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  await sleep(120);
}

/** A bounded probe used while trying walk directions. Unlike waitFor it does
 * not consume the whole command deadline when one direction hits a wall. */
async function waitForWithin(
  cdp: Cdp,
  pred: (s: PublishedState | null) => boolean,
  timeoutMs: number,
): Promise<PublishedState | null> {
  const until = Math.min(deadline, Date.now() + timeoutMs);
  while (Date.now() < until) {
    const state = await readState(cdp);
    if (pred(state)) return state;
    await sleep(200);
  }
  return null;
}

async function setViewport(
  cdp: Cdp,
  width: number,
  height: number,
): Promise<CanvasPlacement> {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 3,
    mobile: false,
  });
  await sleep(500);
  return canvasPlacement(cdp);
}

async function captureAt(
  cdp: Cdp,
  path: string,
  width: number,
  height: number,
): Promise<CanvasPlacement> {
  const canvas = await setViewport(cdp, width, height);
  await screenshot(cdp, path);
  return canvas;
}

interface LogicalRect { x0: number; y0: number; x1: number; y1: number }

interface CanvasPlacement {
  /** Device-pixel origin and device pixels per game logical pixel. */
  x: number;
  y: number;
  scale: number;
  /** Actual game viewport selected by the responsive player. */
  width: number;
  height: number;
}

async function exactColorInLogicalRect(
  path: string,
  canvas: CanvasPlacement,
  rect: LogicalRect,
  rgb: readonly [number, number, number],
): Promise<number> {
  const image = decodePng(new Uint8Array(await Bun.file(path).arrayBuffer()));
  const x0 = Math.max(0, Math.floor(canvas.x + rect.x0 * canvas.scale));
  const y0 = Math.max(0, Math.floor(canvas.y + rect.y0 * canvas.scale));
  const x1 = Math.min(image.width, Math.ceil(canvas.x + rect.x1 * canvas.scale));
  const y1 = Math.min(image.height, Math.ceil(canvas.y + rect.y1 * canvas.scale));
  let count = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = (y * image.width + x) * 4;
    if (image.rgba[i] === rgb[0] && image.rgba[i + 1] === rgb[1] && image.rgba[i + 2] === rgb[2]) count++;
  }
  return count;
}

async function checkEmotePixels(
  path: string,
  canvas: CanvasPlacement,
): Promise<number> {
  // The local walker is camera-centred; its 30x14 bubble starts 38 px above
  // the centre. Sample the plate interior, excluding its one-pixel border.
  const count = await exactColorInLogicalRect(path, canvas, {
    x0: canvas.width / 2 - 14,
    y0: canvas.height / 2 - 37,
    x1: canvas.width / 2 + 14,
    y1: canvas.height / 2 - 25,
  }, [0xff, 0xf6, 0xc4]);
  const minimum = Math.max(20, Math.floor(80 * canvas.scale * canvas.scale));
  if (count < minimum) fail(`${path}: emote bubble has ${count} cream pixels, expected at least ${minimum}`);
  return count;
}

async function checkRejectPixels(path: string, canvas: CanvasPlacement): Promise<number> {
  const plate = statusPlate(canvas.width, canvas.height, false);
  // The refusal occupies the status plate's first 12 px line. Count the
  // exact HUD yellow there so a black, not-yet-admitted world cannot pass
  // merely because the surrounding web page has colorful controls.
  const count = await exactColorInLogicalRect(path, canvas, {
    x0: plate.x0 + 4,
    y0: plate.y0 + 2,
    x1: plate.x1 - 4,
    y1: plate.y0 + 14,
  }, [0xff, 0xe9, 0x7a]);
  const minimum = Math.max(12, Math.floor(16 * canvas.scale * canvas.scale));
  if (count < minimum) fail(`${path}: WORLD FULL status has ${count} yellow pixels, expected at least ${minimum}`);
  return count;
}

async function checkFarPixels(
  path: string,
  state: PublishedState,
  canvas: CanvasPlacement,
): Promise<{ marker: number; label: number }> {
  const marker = state.far[0];
  if (!marker) fail(`${path}: no far-player row at capture time`);
  const box = farMarkerRect(canvas.width, canvas.height, false);
  const unit = farVector(marker.dir);
  const at = farMarkerPoint(canvas.width, canvas.height, false, unit.x, unit.y);
  const mx = Math.min(box.x1 - FAR_MARKER_SIZE, Math.max(box.x0, at.x - FAR_MARKER_SIZE / 2));
  const my = Math.min(box.y1 - FAR_MARKER_SIZE, Math.max(box.y0, at.y - FAR_MARKER_SIZE / 2));
  const onRight = at.x > (box.x0 + box.x1) / 2;
  const lx = onRight ? mx - 4 - FAR_LABEL_W : mx + FAR_MARKER_SIZE + 4;
  const ly = Math.min(box.y1 - 12, Math.max(box.y0, my - 2));
  const yellow = [0xff, 0xe9, 0x7a] as const;
  const markerInk = await exactColorInLogicalRect(path, canvas, { x0: mx, y0: my, x1: mx + FAR_MARKER_SIZE, y1: my + FAR_MARKER_SIZE }, yellow);
  const labelInk = await exactColorInLogicalRect(path, canvas, { x0: lx, y0: ly, x1: lx + FAR_LABEL_W, y1: ly + 12 }, yellow);
  const markerMin = Math.max(6, Math.floor(12 * canvas.scale * canvas.scale));
  const labelMin = Math.max(12, Math.floor(12 * canvas.scale * canvas.scale));
  if (markerInk < markerMin || labelInk < labelMin) {
    fail(`${path}: far marker pixels marker=${markerInk}/${markerMin} label=${labelInk}/${labelMin}`);
  }
  return { marker: markerInk, label: labelInk };
}

async function exerciseMeeting(cdp: Cdp, prefix: string): Promise<Record<string, unknown>> {
  await evaluate(cdp, `document.getElementById("stage").focus()`);

  // R opens the picker and A sends its first preset. The client deliberately
  // draws nothing until the real Room echoes EMOTE back.
  await pressKey(cdp, "KeyE", "e", 69);
  await waitFor(cdp, (s) => s?.emoteBar === true, "the emote picker");
  await pressKey(cdp, "Enter", "Enter", 13);
  const echoed = await waitFor(cdp, (s) => s !== null && Object.hasOwn(s.emotes, String(s.myId)), "the server-confirmed emote bubble");
  const emote = echoed.emotes[String(echoed.myId)]!;
  const emote480 = `${prefix}-emote-480x272-3x.png`;
  const emote960 = `${prefix}-emote-960x544-3x.png`;
  const emoteCanvas480 = await captureAt(cdp, emote480, 480, 272);
  const emoteInk480 = await checkEmotePixels(emote480, emoteCanvas480);
  const emoteCanvas960 = await captureAt(cdp, emote960, 960, 544);
  const emoteInk960 = await checkEmotePixels(emote960, emoteCanvas960);
  console.log(`WEBCHECK_EMOTE ${JSON.stringify({ id: echoed.myId, emote, images: [emote480.split("/").at(-1), emote960.split("/").at(-1)], cream: [emoteInk480, emoteInk960] })}`);

  await setViewport(cdp, 480, 272);
  await waitForWithin(cdp, (s) => s !== null && Object.keys(s.emotes).length === 0, 6_000);
  const start = (await readState(cdp))!;
  const peer = start.remote[0];
  if (!peer) fail("meeting exercise lost the nearby invite host before walking");
  const dx = start.x * 16 - peer.x;
  const dy = start.y * 16 - peer.y;
  const away = Math.abs(dx) >= Math.abs(dy)
    ? (dx >= 0 ? ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"] : ["ArrowLeft", "ArrowDown", "ArrowRight", "ArrowUp"])
    : (dy >= 0 ? ["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft"] : ["ArrowUp", "ArrowRight", "ArrowDown", "ArrowLeft"]);
  const keys: Record<string, { key: string; vk: number }> = {
    ArrowRight: { key: "ArrowRight", vk: 39 },
    ArrowDown: { key: "ArrowDown", vk: 40 },
    ArrowLeft: { key: "ArrowLeft", vk: 37 },
    ArrowUp: { key: "ArrowUp", vk: 38 },
  };
  await pressKey(cdp, "KeyX", "x", 88); // TRIANGLE: server-confirmed fast mode.
  const fast = await waitForWithin(cdp, (s) => s?.fast === true, 3_000);
  if (!fast) fail("meeting exercise could not enable fast movement");
  let far: PublishedState | null = null;
  for (const code of away) {
    const key = keys[code]!;
    await holdKey(cdp, code, key.key, key.vk, 1_200);
    far = await waitForWithin(cdp, (s) => s !== null && s.far.length > 0 && s.remote.length === 0, 2_000);
    if (far) break;
  }
  if (!far) fail("meeting exercise could not walk beyond the host's AOI");

  const far480 = `${prefix}-far-480x272-3x.png`;
  const far960 = `${prefix}-far-960x544-3x.png`;
  const farCanvas480 = await setViewport(cdp, 480, 272);
  const farState480 = await waitFor(cdp, (s) => s !== null && s.far.length > 0 && s.remote.length === 0, "the far marker at 480x272");
  await screenshot(cdp, far480);
  const farInk480 = await checkFarPixels(far480, farState480, farCanvas480);
  const farCanvas960 = await setViewport(cdp, 960, 544);
  const farState960 = await waitFor(cdp, (s) => s !== null && s.far.length > 0 && s.remote.length === 0, "the far marker at 960x544");
  await screenshot(cdp, far960);
  const farInk960 = await checkFarPixels(far960, farState960, farCanvas960);
  const row = farState960.far[0]!;
  const name = farState960.roster[String(row.id)]?.name ?? "";
  if (!name) fail("far marker has no roster name");
  console.log(`WEBCHECK_FAR ${JSON.stringify({ id: row.id, name, dir: row.dir, band: row.band, from: [start.x, start.y], to: [farState960.x, farState960.y], images: [far480.split("/").at(-1), far960.split("/").at(-1)], ink: [farInk480, farInk960] })}`);
  return { emote, far: { id: row.id, name, dir: row.dir, band: row.band } };
}

/** Mint an invite the way a browser player does: SELECT opens the menu,
 *  L asks the server. The token must show in the game's state and the
 *  page must offer it as a link ending in `#invite=<token>`. */
async function mintInvite(cdp: Cdp): Promise<{ token: string; link: string }> {
  await evaluate(cdp, `document.getElementById("stage").focus()`);
  await pressKey(cdp, "ShiftLeft", "Shift", 16); // SELECT: the menu
  await pressKey(cdp, "KeyQ", "q", 81); // LTRIGGER: invite a friend
  const state = await waitFor(cdp, (s) => s !== null && typeof s.invite === "string" && s.invite.length > 0, "the invite token");
  const token = state.invite;
  const link = await evaluate(cdp, `(() => {
    const box = document.getElementById("auth-invite-box");
    const input = document.getElementById("auth-invite");
    if (!box || box.hidden || !input) return "";
    return input.value;
  })()`);
  if (!inviteLinkHasToken(link, token)) {
    fail(`the page did not show the invite link for ${token} (got ${JSON.stringify(link)})`);
  }
  console.log(`WEBCHECK_INVITE ${JSON.stringify({ token, link })}`);
  // Close through the page's real control before taking game screenshots.
  // Leaving the share panel open makes the responsive page push most of the
  // game canvas below a 480x272 viewport, hiding the bubble being checked.
  const closed = await evaluate(cdp, `(() => {
    document.getElementById("auth-invite-close")?.click();
    return document.getElementById("auth-invite-box")?.hidden === true;
  })()`);
  if (closed !== true) fail("the page did not close its invite link box");
  return { token, link };
}

async function evaluate(cdp: Cdp, expression: string): Promise<unknown> {
  const res = (await cdp.send("Runtime.evaluate", { expression, returnByValue: true })) as { result?: { value?: unknown } };
  return res.result?.value;
}

/** Character creation as a browser player does it: pick the look with key
 *  events on the game screen, type the name into the page's text box and
 *  press Create. Returns once the game has left the creation screen. */
async function createCharacter(cdp: Cdp, name: string, look: number): Promise<void> {
  await waitFor(cdp, (s) => s !== null && s.screen === "creating", "the creation screen");
  const boxShown = await evaluate(cdp, `(() => { const b = document.getElementById("auth-name-box"); return !!b && !b.hidden; })()`);
  if (boxShown !== true) fail("the page did not show its name text box on the creation screen");
  // The page focused its box when it opened; the look is chosen on the game
  // screen, so give the keys to the screen first.
  await evaluate(cdp, `document.getElementById("stage").focus()`);
  await pressKey(cdp, "KeyE", "e", 69); // RTRIGGER: focus the look panel
  const base = Math.floor(look / 4);
  const palette = look % 4;
  for (let i = 0; i < base; i++) await pressKey(cdp, "ArrowRight", "ArrowRight", 39);
  for (let i = 0; i < palette; i++) await pressKey(cdp, "ArrowUp", "ArrowUp", 38);
  await waitFor(cdp, (s) => s !== null && s.screen === "creating" && s.look === look, `look ${look} selected with key events`);
  // Now the page's box: Chrome's own text insertion (what an IME commits).
  await evaluate(cdp, `(() => { const i = document.getElementById("auth-name"); i.focus(); i.value = ""; })()`);
  await cdp.send("Input.insertText", { text: name });
  const typed = await evaluate(cdp, `document.getElementById("auth-name").value`);
  if (typed !== name) fail(`the page box holds ${JSON.stringify(typed)}, expected ${JSON.stringify(name)}`);
  await evaluate(cdp, `document.getElementById("auth-name-submit").click()`);
  const left = await waitFor(cdp, (s) => s !== null && (s.screen !== "creating" || s.createError.length > 0), "the create reply");
  if (left.screen === "creating") fail(`creation refused: ${left.createError}`);
  const boxHidden = await evaluate(cdp, `document.getElementById("auth-name-box").hidden`);
  if (boxHidden !== true) fail("the page kept its name box open after creation");
  // Back to the game, as a player clicking it would: the page's keyboard
  // hint overlay only hides while the game screen has focus.
  await evaluate(cdp, `document.getElementById("stage").focus()`);
}

/** The game canvas's place in a capture: device-pixel origin and device
 *  pixels per logical pixel (the page scales the canvas to fit). */
async function canvasPlacement(cdp: Cdp): Promise<CanvasPlacement> {
  const raw = await evaluate(cdp, `(() => {
    const screen = document.getElementById("screen");
    const stage = document.getElementById("stage");
    const r = screen.getBoundingClientRect();
    const logical = String(stage.dataset.logical || "").split("x").map(Number);
    const density = Number(stage.dataset.density) || 1;
    const width = Number.isFinite(logical[0]) && logical[0] > 0 ? logical[0] : screen.width / density;
    const height = Number.isFinite(logical[1]) && logical[1] > 0 ? logical[1] : screen.height / density;
    return JSON.stringify({ x: r.x, y: r.y, w: r.width, dpr: devicePixelRatio, width, height });
  })()`);
  const rect = JSON.parse(String(raw)) as { x: number; y: number; w: number; dpr: number; width: number; height: number };
  return {
    x: rect.x * rect.dpr,
    y: rect.y * rect.dpr,
    scale: (rect.w * rect.dpr) / rect.width,
    width: rect.width,
    height: rect.height,
  };
}

/** The 480x272 screenshot's HUD name line, cell by cell: every code point
 *  of the created name must be drawn as a real glyph (ink inside the cell,
 *  not the hollow replacement box a missing glyph leaves and not blank).
 *  The screenshot is 3x; the plate geometry comes from hud.ts. */
async function checkNameLine(path: string, name: string, state: PublishedState, canvas: CanvasPlacement): Promise<void> {
  const image = decodePng(new Uint8Array(await Bun.file(path).arrayBuffer()));
  const plate = statusPlate(canvas.width, canvas.height, false);
  const cells = Array.from(name);
  const verdicts = cells.map((ch, i) => ({
    ch,
    ...glyphCellVerdict(image.rgba, image.width, canvas.x + (12 + i * NAME_FONT_PX) * canvas.scale, canvas.y + (plate.y0 + 15) * canvas.scale, canvas.scale),
  }));
  const bad = verdicts.filter((v) => v.verdict !== "glyph");
  console.log(`WEBCHECK_NAME ${JSON.stringify({ name, myId: state.myId, canvas, cells: verdicts.map((v) => `${v.ch}:${v.verdict}:${v.total}/${v.ring}`) })}`);
  if (bad.length > 0) fail(`HUD name line cells are not glyphs: ${bad.map((v) => `${v.ch}=${v.verdict}`).join(", ")}`);
}

async function screenshot(cdp: Cdp, path: string): Promise<void> {
  const res = (await cdp.send("Page.captureScreenshot", { format: "png" })) as { data?: string };
  if (!res.data) fail("screenshot returned no data");
  await Bun.write(path, Buffer.from(res.data, "base64"));
}

async function closePage(cdp: Cdp): Promise<void> {
  await cdp.send("Page.navigate", { url: "about:blank" });
  // Give Chrome a turn to run page teardown and send the WebSocket FIN.
  await sleep(1_000);
}

async function main(): Promise<void> {
  const cdp = await attach();
  const collectBrowserError = (method: string) => (params: unknown) => {
    const error = browserErrorFromEvent(method, params);
    if (error) browserErrors.push(error);
  };
  cdp.on("Runtime.consoleAPICalled", collectBrowserError("Runtime.consoleAPICalled"));
  cdp.on("Runtime.exceptionThrown", collectBrowserError("Runtime.exceptionThrown"));
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  // Install auth before the player page evaluates any script. Local demos
  // use the explicit guest credential; hosted demo-cf can supply a ticket.
  // JSON.stringify keeps ticket contents syntactically inert, and the
  // credential is intentionally absent from the WEBCHECK result below.
  const auth = flags.ticket
    ? { kind: "ticket", ticket: flags.ticket }
    : { kind: "guest", name: "web-demo", color: 1 };
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `globalThis.__onlineAuth=${JSON.stringify(auth)};${flags.autoWalk ? "globalThis.__onlineAutoWalk=true;" : ""}`,
  });
  // 480x272 at 3x density, matching the desktop demo captures.
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 480,
    height: 272,
    deviceScaleFactor: 3,
    mobile: false,
  });
  await cdp.send("Page.navigate", { url: pageUrl(flags.page, flags.invite) });

  if (flags.expectReject) {
    const rejected = await waitFor(
      cdp,
      (s) => s !== null && (s.status === "retrying" || s.status === "rejected") && s.rejectText === flags.expectReject,
      `explicit ${flags.expectReject} refusal`,
    );
    const rejectCanvas = await captureAt(cdp, flags.out, 480, 272);
    const rejectInk = [await checkRejectPixels(flags.out, rejectCanvas)];
    if (flags.wideOut) {
      const wideCanvas = await captureAt(cdp, flags.wideOut, 960, 544);
      rejectInk.push(await checkRejectPixels(flags.wideOut, wideCanvas));
    }
    if (browserErrors.length > 0) fail(`browser emitted ${browserErrors.join(" | ")}`);
    console.log(`WEBCHECK_REJECT ${JSON.stringify({ status: rejected.status, rejectText: rejected.rejectText, realmPin: rejected.realmPin, invited: flags.invite !== null, images: [flags.out.split("/").at(-1), flags.wideOut?.split("/").at(-1) ?? null], rejectInk, consoleErrors: browserErrors.length })}`);
    if (flags.closePage) await closePage(cdp);
    process.exit(0);
  }

  if (flags.createName) await createCharacter(cdp, flags.createName, flags.createLook);

  // 1. join + 2. see the other clients + 3. movement. The meeting exercise
  // supplies its own real d-pad movement and must begin while the invited
  // peer is still beside its host, so do not wait for unrelated movement
  // before that interaction.
  const joined = await waitFor(
    cdp,
    joinedExpected,
    `join with online === ${flags.expect}, allOnline === ${flags.expectAll}, and ${flags.expect - 1} remotes`,
  );
  if (!flags.meetPrefix) await waitForMovement(cdp, joined);
  console.log(`WEBCHECK_PHASE ${JSON.stringify({
    phase: "joined",
    epoch: joined.epoch,
    x: joined.x,
    y: joined.y,
    landmarkFirstName: joined.landmarkFirstName,
    progressCount: joined.progressCount,
    improvementLevel: joined.improvementLevel,
  })}`);

  let minted: { token: string; link: string } | null = null;
  if (flags.mintInvite) minted = await mintInvite(cdp);
  let meeting: Record<string, unknown> | null = null;
  if (flags.meetPrefix) meeting = await exerciseMeeting(cdp, flags.meetPrefix);

  let restart: { dropped: string; rejoined: PublishedState } | null = null;
  if (flags.watch) {
    // The demo kills the server: the client must drop, then rejoin after
    // the restart and satisfy the same assertions.
    const dropped = await waitFor(cdp, (s) => s !== null && s.status !== "joined", "connection drop (server restart)");
    const rejoined = await waitFor(
      cdp,
      (s) => joinedExpected(s) && (!flags.expectRealm || s!.epoch !== joined.epoch),
      `rejoin on a new epoch with online === ${flags.expect}, allOnline === ${flags.expectAll}, and ${flags.expect - 1} remotes`,
    );
    await waitForMovement(cdp, rejoined);
    restart = { dropped: dropped.status, rejoined };
  }

  const canvas = await captureAt(cdp, flags.out, 480, 272);
  if (flags.wideOut) await captureAt(cdp, flags.wideOut, 960, 544);
  const final = (await readState(cdp))!;
  if (browserErrors.length > 0) fail(`browser emitted ${browserErrors.join(" | ")}`);
  if (flags.expectName) await checkNameLine(flags.out, flags.expectName, final, canvas);
  console.log(
    `WEBCHECK ${JSON.stringify({
      myId: final.myId,
      online: final.online,
      allOnline: final.allOnline,
      remotes: final.remote.length,
      rtt: final.rtt,
      corrections: final.corrections,
      realmId: final.realmId,
      generatorVersion: final.generatorVersion,
      landmarkFirstName: final.landmarkFirstName,
      progressCount: final.progressCount,
      improvementLevel: final.improvementLevel,
      epoch: final.epoch,
      x: final.x,
      y: final.y,
      name: final.roster[String(final.myId)]?.name ?? "",
      look: final.roster[String(final.myId)]?.look ?? -1,
      created: flags.createName !== null,
      invited: flags.invite !== null,
      minted,
      meeting,
      consoleErrors: browserErrors.length,
      restarted: restart
        ? { droppedStatus: restart.dropped, myId: restart.rejoined.myId, oldEpoch: joined.epoch, newEpoch: restart.rejoined.epoch }
        : null,
    })}`,
  );
  if (flags.closePage) await closePage(cdp);
  process.exit(0);
}

if (import.meta.main) main().catch((err) => fail(String(err)));
