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
//     [--expect-name 演示网页] [--timeout-ms 60000]
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
import { statusPlate } from "./hud.ts";
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
  look: number;
  roster: Record<string, { name: string; look: number }>;
  remote: RemotePos[];
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
  };
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
async function canvasPlacement(cdp: Cdp, logicalWidth: number): Promise<{ x: number; y: number; scale: number }> {
  const raw = await evaluate(cdp, `(() => { const r = document.getElementById("screen").getBoundingClientRect(); return JSON.stringify({ x: r.x, y: r.y, w: r.width, dpr: devicePixelRatio }); })()`);
  const rect = JSON.parse(String(raw)) as { x: number; y: number; w: number; dpr: number };
  return { x: rect.x * rect.dpr, y: rect.y * rect.dpr, scale: (rect.w * rect.dpr) / logicalWidth };
}

/** The 480x272 screenshot's HUD name line, cell by cell: every code point
 *  of the created name must be drawn as a real glyph (ink inside the cell,
 *  not the hollow replacement box a missing glyph leaves and not blank).
 *  The screenshot is 3x; the plate geometry comes from hud.ts. */
async function checkNameLine(path: string, name: string, state: PublishedState, canvas: { x: number; y: number; scale: number }): Promise<void> {
  const image = decodePng(new Uint8Array(await Bun.file(path).arrayBuffer()));
  const plate = statusPlate(480, 272, false);
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
  await cdp.send("Page.navigate", { url: flags.page });

  if (flags.createName) await createCharacter(cdp, flags.createName, flags.createLook);

  // 1. join + 2. see the other clients + 3. movement.
  const joined = await waitFor(
    cdp,
    joinedExpected,
    `join with online === ${flags.expect}, allOnline === ${flags.expectAll}, and ${flags.expect - 1} remotes`,
  );
  await waitForMovement(cdp, joined);
  console.log(`WEBCHECK_PHASE ${JSON.stringify({
    phase: "joined",
    epoch: joined.epoch,
    x: joined.x,
    y: joined.y,
    landmarkFirstName: joined.landmarkFirstName,
    progressCount: joined.progressCount,
    improvementLevel: joined.improvementLevel,
  })}`);

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

  const canvas = await canvasPlacement(cdp, 480);
  await screenshot(cdp, flags.out);
  if (flags.wideOut) {
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 960,
      height: 544,
      deviceScaleFactor: 3,
      mobile: false,
    });
    await sleep(500);
    await screenshot(cdp, flags.wideOut);
  }
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
      consoleErrors: browserErrors.length,
      restarted: restart
        ? { droppedStatus: restart.dropped, myId: restart.rejoined.myId, oldEpoch: joined.epoch, newEpoch: restart.rejoined.epoch }
        : null,
    })}`,
  );
  process.exit(0);
}

if (import.meta.main) main().catch((err) => fail(String(err)));
