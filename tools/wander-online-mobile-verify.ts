// tools/wander-online-mobile-verify.ts — exercise Wander Online's real web
// player with Chrome phone emulation and real touch input.
//
// Run after `bun run web`:
//
//   bun tools/wander-online-mobile-verify.ts --out dist/wander-online-mobile
//
// The verifier starts loopback web, GitHub-stub and game servers. Each phone
// orientation signs a fresh account in through the real OAuth callback,
// creates its character through the page text box, verifies the realm daily
// goal HUD and notice-board line, exercises the co-op board,
// friend-waiting, READY countdown/cancel surfaces, opens the social home and
// Friends panels and emote picker, mints/copies/closes an invite, and signs
// out. Landscape additionally uses immersive play and proves the floating
// controls clear the game's status, log, errand and help HUD rectangles plus
// the open social panel. PNGs and report.json are retained for inspection.

import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { startServer } from "../examples/wander-online/server/server.ts";
import {
  dailyGoalLayout,
  errandBarRect,
  helpRect,
  logBarRect,
  statusPlate,
  type HudRect,
} from "../examples/wander-online/hud.ts";
import { formatDailyGoal, type DailyGoalSnapshot } from "../examples/wander-online/shared/daily-goal.ts";
import { isCooperativeErrand } from "../examples/wander-online/net/journey.ts";
import { COMMAND } from "../examples/wander-online/net/protocol.ts";
import { plaqueOf } from "../examples/wander-online/net/npc.ts";
import { socialPanelLayout } from "../examples/wander-online/social-model.ts";
import { planRegion } from "../examples/wander/region.ts";
import { regionHub } from "../examples/wander/world.ts";
import { townErrand } from "../examples/wander/towns.ts";
import { Cdp, launchChrome } from "../vendor/pocket-rpgkit/tools/lib/cdp.ts";

const ROOT = resolve(import.meta.dir, "..");
const SITE = resolve(option("site", join(ROOT, "dist", "web")));
const OUT = resolve(option("out", join(ROOT, "dist", "wander-online-mobile")));
const CHROME = option("chrome", Bun.which("google-chrome") ?? Bun.which("chromium") ?? "/usr/bin/google-chrome");
const GAME_PORT = Number(option("server-port", "8080"));
const DPR = 3;
const SEED = 0x5eed_0001;

function option(name: string, fallback: string): string {
  const args = process.argv.slice(2);
  const inline = args.find((arg) => arg.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1]! : fallback;
}

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

interface Failure {
  check: string;
  message: string;
}

interface OnlineState {
  status: string;
  screen: string;
  emoteBar: boolean;
  social: boolean;
  socialScreen: string;
  invite: string;
  myId: number;
  realmId: string;
  notice: string;
  errand: string;
  coopRemaining: number;
  coopWaitingFriends: number;
  dailyGoal: DailyGoalSnapshot | null;
  dailyGoalText: string;
  dailyGoalCountdown: string;
  dailyGoalRemaining: number;
  x: number;
  y: number;
  roster: Record<string, { name: string; look: number }>;
}

interface TargetReport {
  selector: string;
  label: string;
  text: string;
  visible: boolean;
  rect: Rect;
}

interface LayoutReport {
  viewport: { width: number; height: number; dpr: number };
  logical: { width: number; height: number };
  screen: Rect;
  controls: TargetReport[];
  critical: Array<{ name: string; rect: Rect }>;
  overlaps: string[];
  centreOverlaps: string[];
  socialPanel: Rect | null;
  socialOverlaps: string[];
}

const failures: Failure[] = [];
const results: Record<string, unknown> = {};
const consoleErrors: string[] = [];
const sleep = (ms: number) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

function check(name: string, ok: boolean, message: string): void {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}: ${message}`);
  if (!ok) failures.push({ check: name, message });
}

function intersects(a: Rect, b: Rect): boolean {
  return !(a.right <= b.left + 0.5 || a.left >= b.right - 0.5 || a.bottom <= b.top + 0.5 || a.top >= b.bottom - 0.5);
}

function pathInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

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

function han(...points: number[]): string {
  return String.fromCodePoint(...points);
}

async function main(): Promise<void> {
  if (!existsSync(join(SITE, "wander-online", "index.html"))) {
    throw new Error(`no built Wander Online page in ${SITE}; run \`bun run web\` first`);
  }
  mkdirSync(OUT, { recursive: true });

  const github = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== "/user") return new Response("not found", { status: 404 });
      const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
      if (token === "mobile-portrait") return Response.json({ id: 71001, login: "touch-portrait" });
      if (token === "mobile-landscape") return Response.json({ id: 71002, login: "touch-landscape" });
      return new Response("unauthorized", { status: 401 });
    },
  });
  const game = startServer({
    port: GAME_PORT,
    seed: SEED,
    hz: 20,
    broadcastHz: 10,
    aoi: 48,
    simLatency: 0,
    webRoot: "",
    allowGuests: true,
    githubApiBase: `http://127.0.0.1:${github.port}`,
    realmEpoch: 0x4d4f_4249,
  });
  const site = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const candidate = resolve(SITE, `.${decodeURIComponent(url.pathname)}`);
      if (!pathInside(SITE, candidate)) return new Response("forbidden", { status: 403 });
      if (existsSync(candidate) && statSync(candidate).isDirectory()) {
        if (!url.pathname.endsWith("/")) return Response.redirect(`${url.pathname}/`, 301);
        return new Response(Bun.file(join(candidate, "index.html")));
      }
      return existsSync(candidate) ? new Response(Bun.file(candidate)) : new Response("not found", { status: 404 });
    },
  });
  const origin = `http://127.0.0.1:${site.port}`;
  const profile = mkdtempSync(join(OUT, "chrome-profile-"));
  const chrome = await launchChrome(CHROME, profile, "844,844");
  const cdp = await Cdp.connect(chrome.ws);
  let phase = "startup";

  cdp.on("Runtime.consoleAPICalled", (params) => {
    if (params.type !== "error" && params.type !== "assert") return;
    const message = params.args?.map((arg: { value?: unknown; description?: string }) => arg.value ?? arg.description).join(" ") ?? "";
    consoleErrors.push(`[${phase}] console.${params.type}: ${message}`);
  });
  cdp.on("Runtime.exceptionThrown", (params) => {
    const detail = params.exceptionDetails;
    consoleErrors.push(`[${phase}] exception: ${detail?.exception?.description ?? detail?.text ?? "unknown"}`);
  });
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Browser.grantPermissions", {
    origin,
    permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
  });
  // Test-only OAuth callback setup. player.js still consumes and validates
  // the matching state through its production callback path. The socket
  // wrapper keeps real network traffic while exposing bounded protocol-frame
  // injection and sent-frame observation to this verification harness.
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => {
      if (location.hostname !== "127.0.0.1") return;
      const NativeWebSocket = globalThis.WebSocket;
      globalThis.__mobileVerifySockets = [];
      globalThis.__mobileVerifyBinaryFrames = [];
      globalThis.__mobileVerifyTextFrames = [];
      class MobileVerifyWebSocket extends NativeWebSocket {
        constructor(url, protocols) {
          if (protocols === undefined) super(url);
          else super(url, protocols);
          globalThis.__mobileVerifySockets.push(this);
        }
        send(data) {
          if (typeof data === "string") {
            try {
              globalThis.__mobileVerifyTextFrames.push(JSON.parse(data));
              if (globalThis.__mobileVerifyTextFrames.length > 256) globalThis.__mobileVerifyTextFrames.shift();
            } catch {}
          } else {
            const bytes = data instanceof ArrayBuffer
              ? new Uint8Array(data)
              : ArrayBuffer.isView(data)
                ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
                : null;
            if (bytes) {
              globalThis.__mobileVerifyBinaryFrames.push(Array.from(bytes));
              if (globalThis.__mobileVerifyBinaryFrames.length > 256) globalThis.__mobileVerifyBinaryFrames.shift();
            }
          }
          super.send(data);
        }
      }
      globalThis.WebSocket = MobileVerifyWebSocket;
      globalThis.__mobileVerifyPushJson = (message) => {
        const socket = globalThis.__mobileVerifySockets.findLast((candidate) => candidate.readyState === NativeWebSocket.OPEN);
        if (!socket) return false;
        socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }));
        return true;
      };
      const params = new URLSearchParams(location.hash.slice(1));
      const state = params.get("state");
      if (state) {
        sessionStorage.setItem("pocket-rpgkit:oauth-state", state);
        globalThis.__mobileVerifyDocument = state;
      }
      localStorage.removeItem("pocket-rpgkit:wander-online:ticket");
      localStorage.removeItem("pocket-rpgkit:wander-online:realm");
    })();`,
  });

  const evaluate = async <T>(expression: string): Promise<T> => {
    const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "browser evaluation failed");
    }
    return result.result.value as T;
  };
  const waitFor = async <T>(label: string, expression: string, accept: (value: T) => boolean, timeoutMs = 30_000): Promise<T> => {
    const deadline = Date.now() + timeoutMs;
    let last: T | undefined;
    while (Date.now() < deadline) {
      try {
        last = await evaluate<T>(expression);
        if (accept(last)) return last;
      } catch {
        // Navigation briefly destroys the old execution context.
      }
      await sleep(100);
    }
    throw new Error(`timed out waiting for ${label}; last=${JSON.stringify(last)}`);
  };
  const rect = (selector: string) => evaluate<Rect>(`(() => {
    const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
  })()`);
  const target = async (selector: string, label: string, minimum = 44): Promise<TargetReport> => {
    const report = await evaluate<TargetReport>(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) return { selector: ${JSON.stringify(selector)}, label: ${JSON.stringify(label)}, text: "", visible: false,
        rect: { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 } };
      const style = getComputedStyle(element);
      const r = element.getBoundingClientRect();
      return { selector: ${JSON.stringify(selector)}, label: ${JSON.stringify(label)}, text: (element.textContent || element.value || "").trim(),
        visible: !element.hidden && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) > 0.01 && r.width > 1 && r.height > 1,
        rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height } };
    })()`);
    check(`${phase}: ${label} is visible`, report.visible, `${report.rect.width.toFixed(1)}x${report.rect.height.toFixed(1)} CSS px`);
    check(
      `${phase}: ${label} is at least ${minimum}px`,
      report.rect.width + 0.01 >= minimum && report.rect.height + 0.01 >= minimum,
      `${report.rect.width.toFixed(1)}x${report.rect.height.toFixed(1)} CSS px`,
    );
    return report;
  };
  const touch = async (selector: string, holdMs = 100): Promise<void> => {
    const r = await rect(selector);
    const viewport = await evaluate<{ width: number; height: number }>("({ width: innerWidth, height: innerHeight })");
    const point = { x: r.left + r.width / 2, y: r.top + r.height / 2, id: 1, radiusX: 1, radiusY: 1, force: 1 };
    check(`${phase}: ${selector} touch point is on screen`, point.x >= 0 && point.x <= viewport.width && point.y >= 0 && point.y <= viewport.height,
      `(${point.x.toFixed(1)}, ${point.y.toFixed(1)}) in ${viewport.width}x${viewport.height}`);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
    await sleep(holdMs);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await sleep(120);
  };
  const screenshot = async (name: string): Promise<string> => {
    const shot = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
    const path = join(OUT, `${name}.png`);
    writeFileSync(path, Buffer.from(shot.data, "base64"));
    return path;
  };
  const pushJson = async (message: Record<string, unknown>): Promise<void> => {
    const delivered = await evaluate<boolean>(
      `globalThis.__mobileVerifyPushJson?.(${JSON.stringify(message)}) === true`,
    );
    if (!delivered) throw new Error(`${phase}: no open game socket for fixture ${String(message.type ?? "message")}`);
    await sleep(120);
  };
  const screenRgbCount = (red: number, green: number, blue: number) => evaluate<number>(`(() => {
    const canvas = document.getElementById("screen");
    const context = canvas?.getContext?.("2d");
    if (!context) return -1;
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i] === ${red} && pixels[i + 1] === ${green} && pixels[i + 2] === ${blue}) count++;
    }
    return count;
  })()`);
  const checkScreenColor = async (label: string, rgb: readonly [number, number, number], minimum: number): Promise<number> => {
    const count = await screenRgbCount(...rgb);
    check(`${phase}: ${label} painted`, count >= minimum, `${count} matching pixels (minimum ${minimum})`);
    return count;
  };
  const setPhone = async (width: number, height: number): Promise<void> => {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: DPR, mobile: true });
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  };
  const stateIs = async (screen: string, status?: string): Promise<OnlineState> => {
    const state = await waitFor<OnlineState | null>(
      `${screen}${status ? `/${status}` : ""}`,
      "globalThis.__onlineState ?? null",
      (candidate) => candidate !== null && candidate.screen === screen && (!status || candidate.status === status),
    );
    return state!;
  };
  const noHorizontalOverflow = async (): Promise<void> => {
    const sizes = await evaluate<{ scroll: number; viewport: number }>("({ scroll: document.documentElement.scrollWidth, viewport: innerWidth })");
    check(`${phase}: no horizontal overflow`, sizes.scroll <= sizes.viewport + 1, `${sizes.scroll}px <= ${sizes.viewport}px`);
  };
  const project = (logical: HudRect, screen: Rect, width: number, height: number): Rect => ({
    left: screen.left + logical.x0 * screen.width / width,
    top: screen.top + logical.y0 * screen.height / height,
    right: screen.left + logical.x1 * screen.width / width,
    bottom: screen.top + logical.y1 * screen.height / height,
    width: (logical.x1 - logical.x0) * screen.width / width,
    height: (logical.y1 - logical.y0) * screen.height / height,
  });
  const layoutReport = async (includeSocialPanel = false): Promise<LayoutReport> => {
    const browser = await evaluate<{
      viewport: { width: number; height: number; dpr: number };
      logical: { width: number; height: number };
      screen: Rect;
      controls: TargetReport[];
    }>(`(() => {
      const screen = document.getElementById("screen").getBoundingClientRect();
      const controls = [...document.querySelectorAll("[data-button], #pad-toggle, #immersive-exit")].map((element) => {
        const style = getComputedStyle(element);
        const r = element.getBoundingClientRect();
        return { selector: element.id ? "#" + element.id : '[data-button="' + element.dataset.button + '"]',
          label: element.id || element.dataset.button || "control", text: (element.textContent || "").trim(),
          visible: !element.hidden && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) > 0.01 && r.width > 1 && r.height > 1,
          rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height } };
      }).filter((entry) => entry.visible);
      return { viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
        logical: { width: __pocketPlayer.width, height: __pocketPlayer.height },
        screen: { left: screen.left, top: screen.top, right: screen.right, bottom: screen.bottom, width: screen.width, height: screen.height }, controls };
    })()`);
    const critical = [
      { name: "status", rect: project(statusPlate(browser.logical.width, browser.logical.height, false), browser.screen, browser.logical.width, browser.logical.height) },
      { name: "daily", rect: project(dailyGoalLayout(browser.logical.width, browser.logical.height).panel, browser.screen, browser.logical.width, browser.logical.height) },
      { name: "log", rect: project(logBarRect(browser.logical.width, browser.logical.height), browser.screen, browser.logical.width, browser.logical.height) },
      { name: "errand", rect: project(errandBarRect(browser.logical.width, browser.logical.height), browser.screen, browser.logical.width, browser.logical.height) },
      { name: "help", rect: project(helpRect(browser.logical.width, browser.logical.height), browser.screen, browser.logical.width, browser.logical.height) },
    ];
    const overlaps: string[] = [];
    for (const control of browser.controls) {
      for (const area of critical) if (intersects(control.rect, area.rect)) overlaps.push(`${control.label}:${area.name}`);
    }
    const centre: Rect = {
      left: browser.screen.left + browser.screen.width * 0.25,
      right: browser.screen.right - browser.screen.width * 0.25,
      top: browser.screen.top + browser.screen.height * 0.20,
      bottom: browser.screen.bottom - browser.screen.height * 0.20,
      width: browser.screen.width * 0.5,
      height: browser.screen.height * 0.6,
    };
    const centreOverlaps = browser.controls.filter((control) => intersects(control.rect, centre)).map((control) => control.label);
    const logicalSocial = includeSocialPanel
      ? socialPanelLayout(browser.logical.width, browser.logical.height).panel
      : null;
    const socialPanel = logicalSocial
      ? project({
          x0: logicalSocial.x,
          y0: logicalSocial.y,
          x1: logicalSocial.x + logicalSocial.w,
          y1: logicalSocial.y + logicalSocial.h,
        }, browser.screen, browser.logical.width, browser.logical.height)
      : null;
    // The regression is the floating game pad (not the separate fullscreen
    // toolbar, which owns its own top-right page region).
    const socialOverlaps = socialPanel
      ? browser.controls
          .filter((control) => control.selector.startsWith('[data-button="') && intersects(control.rect, socialPanel))
          .map((control) => control.label)
      : [];
    check(`${phase}: controls clear critical HUD`, overlaps.length === 0, overlaps.length ? overlaps.join(", ") : "status/daily/log/errand/help clear");
    check(`${phase}: controls leave the central playfield clear`, centreOverlaps.length === 0, centreOverlaps.length ? centreOverlaps.join(", ") : "central 50% clear");
    if (socialPanel) {
      check(`${phase}: controls clear the open social panel`, socialOverlaps.length === 0,
        socialOverlaps.length ? socialOverlaps.join(", ") : "all visible game controls clear");
    }
    for (const control of browser.controls) {
      check(`${phase}: ${control.label} touch size`, control.rect.width + 0.01 >= 44 && control.rect.height + 0.01 >= 44,
        `${control.rect.width.toFixed(1)}x${control.rect.height.toFixed(1)} CSS px`);
    }
    return { ...browser, critical, overlaps, centreOverlaps, socialPanel, socialOverlaps };
  };

  const runPhone = async (
    label: "portrait" | "landscape",
    width: number,
    height: number,
    token: string,
    characterName: string,
    locale: "en" | "zh",
  ): Promise<void> => {
    phase = `${label} ${width}x${height}`;
    console.log(`\n# ${phase} @${DPR}x`);
    await cdp.send("Emulation.setLocaleOverride", { locale: locale === "zh" ? "zh-CN" : "en-US" });
    await setPhone(width, height);
    const oauthState = `${label}-state`;
    await cdp.send("Page.navigate", {
      // The distinct query forces a new document when the second orientation
      // follows the first; changing only the fragment is a same-document
      // navigation and would not reboot the game.
      url: `${origin}/wander-online/?mobile=${label}&lang=${locale}#oauth_token=${encodeURIComponent(token)}&state=${encodeURIComponent(oauthState)}`,
    });
    await waitFor<string>("new player document", "globalThis.__mobileVerifyDocument ?? ''", (value) => value === oauthState);
    await stateIs("creating");
    await waitFor<boolean>("name box", `(() => { const b = document.getElementById("auth-name-box"); return !!b && !b.hidden; })()`, Boolean);
    await noHorizontalOverflow();
    const nameTargets = [
      await target("#auth-name", "character name input"),
      await target("#auth-name-submit", "Create"),
      await target("#auth-signout", "Sign out"),
      await target("#fullscreen-toggle", "Fullscreen"),
    ];
    await touch("#auth-name");
    const focused = await evaluate<boolean>('document.activeElement?.id === "auth-name"');
    check(`${phase}: name input takes touch focus`, focused, `active=${await evaluate<string>('document.activeElement?.id || ""')}`);
    await evaluate('document.getElementById("auth-name").value = ""');
    await cdp.send("Input.insertText", { text: characterName });
    const typed = await evaluate<string>('document.getElementById("auth-name").value');
    check(`${phase}: text entry reaches name input`, typed === characterName, JSON.stringify(typed));
    const nameShot = await screenshot(`${label}-${width}x${height}-name`);
    await touch("#auth-name-submit");
    const joined = await stateIs("world", "joined");
    check(`${phase}: created name reaches roster`, joined.roster[String(joined.myId)]?.name === characterName,
      joined.roster[String(joined.myId)]?.name ?? "missing");
    await waitFor<boolean>("Sign out shown", '!document.getElementById("auth-signout").hidden', Boolean);

    const buttonNames = await evaluate<string[]>(`[...document.querySelectorAll("[data-button]")].map((b) => b.dataset.button)`);
    for (const needed of ["DOWN", "RTRIGGER", "SELECT", "LTRIGGER", "CIRCLE", "CROSS"]) {
      check(`${phase}: ${needed} has a touch button`, buttonNames.includes(needed), `${buttonNames.length} rendered game buttons`);
    }

    if (label === "landscape") {
      await target("#fullscreen-toggle", "Fullscreen");
      await touch("#fullscreen-toggle");
      await waitFor<boolean>("immersive play", 'document.body.classList.contains("immersive")', Boolean);
      await sleep(300);
      await target("#immersive-exit", "Exit fullscreen");
      await target("#pad-toggle", "Hide buttons");
    } else {
      const firstViewport = await evaluate<boolean>(`[...document.querySelectorAll("[data-button]")].every((b) => {
        const r = b.getBoundingClientRect(); return r.width >= 44 && r.height >= 44 && r.top >= 0 && r.bottom <= innerHeight + 1;
      })`);
      check(`${phase}: all game buttons fit the first viewport`, firstViewport, `${buttonNames.length} buttons reachable without scrolling`);
    }
    const controls = await layoutReport();

    const dailyState = await waitFor<OnlineState | null>(
      "authoritative daily goal",
      "globalThis.__onlineState ?? null",
      (candidate) => candidate?.dailyGoal !== null && !!candidate?.dailyGoalText && candidate.dailyGoalRemaining > 0,
    );
    const expectedDailyText = formatDailyGoal(dailyState!.dailyGoal!, locale);
    check(`${phase}: daily goal uses the complete localized copy`, dailyState!.dailyGoalText === expectedDailyText,
      dailyState!.dailyGoalText);
    check(`${phase}: daily goal exposes a UTC countdown`, dailyState!.dailyGoalCountdown.endsWith(" UTC"),
      dailyState!.dailyGoalCountdown);
    const dailyGreenPixels = await checkScreenColor("daily goal text", [0x8f, 0xe3, 0xb0], 8);
    const dailyCountdownPixels = await checkScreenColor("daily goal countdown", [0x9f, 0xd0, 0xff], 8);
    const dailyShot = await screenshot(`${label}-${width}x${height}-daily-${locale}-progress`);

    // Put this verified account at a deterministic co-op notice board. The
    // harness ages that region row so the board is present immediately; the
    // browser still opens it with real touch input and the loopback server
    // still validates and answers the scoped request.
    const offer = cooperativeTown();
    const board = plaqueOf(planRegion(SEED, offer.rx, offer.ry));
    const serverPlayer = game.realmArena.players.get(joined.myId);
    if (!board || !serverPlayer) throw new Error(`${phase}: cooperative board fixture is unavailable`);
    const regionRevision = ++game.realmArena.realmRevision;
    game.realmArena.world.applyRegionState({
      flags: 0,
      realmRevision: regionRevision,
      serverTimeMs: Date.now(),
      rows: [{
        rx: offer.rx,
        ry: offer.ry,
        discoveredAtMs: 0,
        improvementLevel: 0,
        revision: regionRevision,
        landmarkFirstName: "",
      }],
    });
    const boardQueryExpression = `(() => {
      const frames = globalThis.__mobileVerifyTextFrames ?? [];
      for (let i = frames.length - 1; i >= 0; i--) if (frames[i]?.type === "coopBoardGet") return frames[i];
      return null;
    })()`;
    // Residents keep walking while Chrome is under test. Try each adjacent
    // action tile so a resident briefly standing on the player or board tile
    // cannot turn this into a flaky conversation fixture.
    const boardApproaches = [
      { tx: board.x, ty: board.y - 1, facing: 0 },
      { tx: board.x - 1, ty: board.y, facing: 3 },
      { tx: board.x, ty: board.y + 1, facing: 2 },
      { tx: board.x + 1, ty: board.y, facing: 1 },
    ] as const;
    let boardQuery: Record<string, unknown> | null = null;
    for (const approach of boardApproaches) {
      serverPlayer.state = {
        ...serverPlayer.state,
        move: {
          ...serverPlayer.state.move,
          tx: approach.tx,
          ty: approach.ty,
          px: approach.tx * 16,
          py: approach.ty * 16,
          facing: approach.facing,
          phase: 0,
          moving: false,
          walking: false,
        },
      };
      serverPlayer.buttons = 0;
      serverPlayer.queue.length = 0;
      serverPlayer.scanX = null;
      serverPlayer.scanY = null;
      await waitFor<OnlineState | null>(
        "co-op board position",
        "globalThis.__onlineState ?? null",
        (candidate) => candidate?.x === approach.tx && candidate.y === approach.ty,
      );
      await sleep(150);
      await touch('[data-button="CIRCLE"]', 140);
      await waitFor<boolean>("co-op board or resident dialog", "globalThis.__onlineState?.dialog === true", Boolean);
      try {
        boardQuery = await waitFor<Record<string, unknown> | null>(
          "anonymous co-op board query",
          boardQueryExpression,
          (candidate) => candidate?.offerRx === offer.rx && candidate.offerRy === offer.ry,
          1_200,
        );
        break;
      } catch {
        // Close every page of the resident dialog before trying another side.
        for (let page = 0; page < 8 && await evaluate<boolean>("globalThis.__onlineState?.dialog === true"); page++) {
          await touch('[data-button="CIRCLE"]', 100);
        }
      }
    }
    if (!boardQuery) throw new Error(`${phase}: all four notice-board approaches were occupied by residents`);
    const boardQueryExtra = Object.keys(boardQuery!).filter((key) => !["type", "v", "offerRx", "offerRy"].includes(key));
    check(`${phase}: board query contains no partner identity`, boardQueryExtra.length === 0,
      boardQueryExtra.length ? boardQueryExtra.join(", ") : "offer scope only");
    const boardReply = {
      type: "coopBoard",
      v: 1,
      realm: joined.realmId,
      offerRx: offer.rx,
      offerRy: offer.ry,
      waiting: 1,
      required: 2,
    };
    const boardReplyExtra = Object.keys(boardReply).filter((key) => !["type", "v", "realm", "offerRx", "offerRy", "waiting", "required"].includes(key));
    check(`${phase}: board response is anonymous`, boardReplyExtra.length === 0,
      boardReplyExtra.length ? boardReplyExtra.join(", ") : "count only");
    await pushJson(boardReply);
    const boardLayout = await layoutReport();
    const boardDialogPixels = await checkScreenColor("daily board dialog", [0x0b, 0x16, 0x26], 500);
    const boardTextPixels = await checkScreenColor("daily board text", [0xe7, 0xed, 0xf8], 10);
    const dailyBoardShot = await screenshot(`${label}-${width}x${height}-daily-${locale}-board`);
    // The daily line occupies the fourth row. The anonymous co-op count is
    // the following page, so exercise and retain both pages before closing.
    await touch('[data-button="CIRCLE"]', 140);
    await waitFor<boolean>("co-op board second page", "globalThis.__onlineState?.dialog === true", Boolean);
    const boardShot = await screenshot(`${label}-${width}x${height}-coop-${locale}-board-count`);
    await touch('[data-button="CIRCLE"]', 140);
    await waitFor<boolean>("co-op board dialog closed", "globalThis.__onlineState?.dialog === false", Boolean);

    const friend = locale === "zh"
      ? {
          name: han(0x5c71, 0x53cb),
          targetTown: han(0x82d4, 0x5c71),
          item: han(0x5305, 0x88f9),
        }
      : { name: "Mia", targetTown: "Moss", item: "parcel" };
    const expiresAt = Date.now() + 30_000;
    await pushJson({
      type: "realmFeatures",
      v: 1,
      realm: joined.realmId,
      coopErrands: true,
      coopPartnerFinding: true,
      discoveryLeaderboard: false,
      dailyGoals: true,
    });
    await pushJson({
      type: "socialSnapshot",
      v: 1,
      visible: true,
      friends: [{
        githubId: 72,
        name: friend.name,
        presence: "online",
        realm: joined.realmId,
        coopWaiting: { targetTown: friend.targetTown, item: friend.item, expiresAt },
      }],
      incoming: [],
      outgoing: [],
    });
    await pushJson({
      type: "coopFriendWaiting",
      v: 1,
      realm: joined.realmId,
      friend: { githubId: 72, name: friend.name },
      targetTown: friend.targetTown,
      item: friend.item,
      expiresAt,
    });
    const coopLabel = locale === "zh" ? han(0x534f, 0x4f5c) : "COOP";
    const friendNotice = `${coopLabel} · ${friend.name} · ${friend.targetTown} · ${friend.item}`;
    const friendState = await waitFor<OnlineState | null>(
      "friend READY hint",
      "globalThis.__onlineState ?? null",
      (candidate) => candidate?.notice === friendNotice && candidate.coopWaitingFriends === 1,
    );
    check(`${phase}: friend READY is counted once`, friendState!.coopWaitingFriends === 1, friendNotice);
    const friendPromptLayout = await layoutReport();
    const friendPromptPixels = await checkScreenColor("friend READY notice", [0x8a, 0xd0, 0xff], 10);
    const friendPromptShot = await screenshot(`${label}-${width}x${height}-coop-${locale}-friend-waiting`);

    // Open the in-game menu and choose its social row with real touch input.
    // The injected snapshot is the hosted-only privacy-filtered friend view;
    // the bounded panel itself still uses the production menu and touch path.
    await touch('[data-button="SELECT"]', 140);
    await touch('[data-button="DOWN"]', 140);
    await waitFor<boolean>("social panel", "globalThis.__onlineState?.social === true", Boolean);
    const socialScreen = await evaluate<string>('globalThis.__onlineState?.socialScreen || ""');
    check(`${phase}: social panel opens at home`, socialScreen === "home", socialScreen);
    const socialLayout = await layoutReport(true);
    const socialShot = await screenshot(`${label}-${width}x${height}-social`);
    await touch('[data-button="CIRCLE"]', 140);
    await waitFor<boolean>(
      "Friends social panel",
      'globalThis.__onlineState?.socialScreen === "friends"',
      Boolean,
    );
    const socialFriendsLayout = await layoutReport(true);
    const socialFriendsShot = await screenshot(`${label}-${width}x${height}-social-friends`);
    const waitingFriendState = await stateIs("world", "joined");
    check(`${phase}: waiting friend remains visible in Friends`, waitingFriendState.coopWaitingFriends === 1,
      `${waitingFriendState.coopWaitingFriends} waiting friend`);
    const friendRowPixels = await checkScreenColor("selected waiting-friend row", [0x35, 0x49, 0x68], 100);
    const friendListShot = await screenshot(`${label}-${width}x${height}-coop-${locale}-friend-list`);
    await touch('[data-button="CROSS"]', 140);
    await waitFor<boolean>(
      "social home panel",
      'globalThis.__onlineState?.socialScreen === "home"',
      Boolean,
    );
    await touch('[data-button="CROSS"]', 140);
    await waitFor<boolean>("social panel closed", "globalThis.__onlineState?.social === false", Boolean);

    await pushJson({
      type: "coopErrand",
      v: 1,
      realm: joined.realmId,
      revision: 1,
      status: "waiting",
      cooperative: true,
      ready: true,
      savedReady: 1,
      presentReady: 1,
      required: 2,
      expiresAt: Date.now() + 30_000,
    });
    const cancelText = locale === "zh" ? `X ${han(0x53d6, 0x6d88)}` : "X CANCEL";
    const readyNotice = locale === "zh"
      ? `${coopLabel} 1/2 · ${han(0x5c31, 0x7eea)}`
      : "COOP 1/2 · READY";
    const readyState = await waitFor<OnlineState | null>(
      "READY countdown",
      "globalThis.__onlineState ?? null",
      (candidate) => !!candidate && candidate.notice === readyNotice
        && candidate.coopRemaining >= 25 && candidate.coopRemaining <= 30
        && candidate.errand.includes(cancelText),
    );
    check(`${phase}: READY countdown is bounded`, readyState!.coopRemaining >= 25 && readyState!.coopRemaining <= 30,
      `${readyState!.coopRemaining}s remaining`);
    const readyLayout = await layoutReport();
    const readyOrangePixels = await checkScreenColor("READY countdown", [0xff, 0xb3, 0x7a], 20);
    const readyBluePixels = await checkScreenColor("READY notice", [0x8a, 0xd0, 0xff], 10);
    const readyShot = await screenshot(`${label}-${width}x${height}-coop-${locale}-ready-countdown`);
    await touch('[data-button="CROSS"]', 140);
    const sentCancel = await waitFor<boolean>(
      "cancelCoopErrand command",
      `globalThis.__mobileVerifyBinaryFrames.some((frame) => frame.length === 11 && frame[1] === ${COMMAND.cancelCoopErrand})`,
      Boolean,
    );
    check(`${phase}: X sends cancelCoopErrand`, sentCancel, `command kind ${COMMAND.cancelCoopErrand}`);
    await pushJson({
      type: "coopErrand",
      v: 1,
      realm: joined.realmId,
      revision: 2,
      status: "cancelled",
      cooperative: true,
      ready: false,
      savedReady: 0,
      presentReady: 0,
      required: 2,
      expiresAt: 0,
    });
    const cancelledNotice = locale === "zh"
      ? `${coopLabel} · ${han(0x5df2, 0x53d6, 0x6d88)}`
      : "COOP · CANCELLED";
    const cancelledState = await waitFor<OnlineState | null>(
      "cancel acknowledgement",
      "globalThis.__onlineState ?? null",
      (candidate) => candidate?.notice === cancelledNotice && candidate.coopRemaining === 0,
    );
    check(`${phase}: cancelled READY clears countdown`, cancelledState!.coopRemaining === 0, cancelledNotice);
    const cancelledBluePixels = await checkScreenColor("cancel acknowledgement", [0x8a, 0xd0, 0xff], 10);
    const cancelledShot = await screenshot(`${label}-${width}x${height}-coop-${locale}-cancelled`);

    await touch('[data-button="RTRIGGER"]', 140);
    await waitFor<boolean>("emote picker", "globalThis.__onlineState?.emoteBar === true", Boolean);
    const emoteShot = await screenshot(`${label}-${width}x${height}-emote`);
    await touch('[data-button="RTRIGGER"]', 140);
    await waitFor<boolean>("emote picker closed", "globalThis.__onlineState?.emoteBar === false", Boolean);

    await touch('[data-button="SELECT"]', 140);
    await touch('[data-button="LTRIGGER"]', 140);
    const invite = await waitFor<string>(
      "invite link",
      '(() => { const b = document.getElementById("auth-invite-box"); return b && !b.hidden ? document.getElementById("auth-invite").value : ""; })()',
      (value) => typeof value === "string" && value.includes("#invite=local."),
    );
    const immersiveAfterInvite = await evaluate<boolean>('document.body.classList.contains("immersive")');
    check(`${phase}: invite reveals page controls`, !immersiveAfterInvite, "immersive mode exited before showing the page panel");
    await noHorizontalOverflow();
    const inviteTargets = [
      await target("#auth-invite", "invite link input"),
      await target("#auth-invite-copy", "Copy"),
      await target("#auth-invite-close", "Close"),
      await target("#auth-signout", "Sign out"),
    ];
    const inviteShot = await screenshot(`${label}-${width}x${height}-invite`);
    await touch("#auth-invite-copy");
    const copiedLabel = locale === "zh" ? han(0x5df2, 0x590d, 0x5236) : "Copied";
    await waitFor<boolean>(
      "Copied acknowledgement",
      `document.getElementById("auth-invite-copy").textContent.trim() === ${JSON.stringify(copiedLabel)}`,
      Boolean,
    );
    const clipboard = await evaluate<string>("navigator.clipboard.readText()");
    check(`${phase}: Copy writes the real invite`, clipboard === invite, clipboard);
    await touch("#auth-invite-close");
    await waitFor<boolean>("invite panel closed", 'document.getElementById("auth-invite-box").hidden', Boolean);

    await target("#auth-signout", "Sign out");
    await touch("#auth-signout");
    await stateIs("gate");
    const signedOut = await evaluate<{ signOutHidden: boolean; signInEnabled: boolean }>(`({
      signOutHidden: document.getElementById("auth-signout").hidden,
      signInEnabled: !document.getElementById("auth-signin").disabled,
    })`);
    check(`${phase}: Sign out returns to the signed-out gate`, signedOut.signOutHidden && signedOut.signInEnabled,
      `signOutHidden=${signedOut.signOutHidden}, signInEnabled=${signedOut.signInEnabled}`);
    const signedOutShot = await screenshot(`${label}-${width}x${height}-signed-out`);
    results[label] = {
      viewport: `${width}x${height}@${DPR}`,
      locale,
      name: characterName,
      nameTargets,
      inviteTargets,
      invite,
      controls,
      dailyGoal: {
        snapshot: dailyState!.dailyGoal,
        text: dailyState!.dailyGoalText,
        countdown: dailyState!.dailyGoalCountdown,
        remaining: dailyState!.dailyGoalRemaining,
        textPixels: dailyGreenPixels,
        countdownPixels: dailyCountdownPixels,
      },
      coopPartnerFinding: {
        board: {
          offer,
          query: boardQuery,
          dialogPixels: boardDialogPixels,
          textPixels: boardTextPixels,
          layout: boardLayout,
        },
        friend: {
          notice: friendNotice,
          waiting: friendState!.coopWaitingFriends,
          noticePixels: friendPromptPixels,
          selectedRowPixels: friendRowPixels,
          worldLayout: friendPromptLayout,
        },
        ready: {
          remaining: readyState!.coopRemaining,
          countdownPixels: readyOrangePixels,
          noticePixels: readyBluePixels,
          layout: readyLayout,
        },
        cancelled: {
          notice: cancelledNotice,
          noticePixels: cancelledBluePixels,
        },
      },
      socialPanel: socialLayout.socialPanel,
      socialOverlaps: socialLayout.socialOverlaps,
      socialFriendsPanel: socialFriendsLayout.socialPanel,
      socialFriendsOverlaps: socialFriendsLayout.socialOverlaps,
      screenshots: [
        nameShot,
        dailyShot,
        dailyBoardShot,
        boardShot,
        friendPromptShot,
        socialShot,
        socialFriendsShot,
        friendListShot,
        readyShot,
        cancelledShot,
        emoteShot,
        inviteShot,
        signedOutShot,
      ]
        .map((path) => path.split("/").at(-1)),
    };
  };

  try {
    await runPhone("portrait", 390, 844, "mobile-portrait", "Touch Port", "en");
    await runPhone("landscape", 844, 390, "mobile-landscape", "Touch Land", "zh");
    check("browser console stays clean", consoleErrors.length === 0, consoleErrors.length ? consoleErrors.join(" | ") : "no console errors or exceptions");
  } catch (error) {
    failures.push({ check: phase, message: error instanceof Error ? error.message : String(error) });
    console.error(`  FAIL ${phase}: ${error instanceof Error ? error.stack ?? error.message : error}`);
    await screenshot(`error-${phase.replace(/[^a-z0-9]+/gi, "-")}`).catch(() => {});
  } finally {
    const report = {
      verdict: failures.length === 0 ? "PASS" : "FAIL",
      generatedAt: new Date().toISOString(),
      chrome: CHROME,
      gameServer: game.url,
      siteOrigin: origin,
      failures,
      consoleErrors,
      results,
    };
    writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    cdp.close();
    chrome.proc.kill();
    await chrome.proc.exited;
    game.close();
    github.stop(true);
    site.stop(true);
    rmSync(profile, { recursive: true, force: true });
  }

  console.log(`\nwander-online-mobile-verify: ${failures.length === 0 ? "PASS" : `FAIL (${failures.length})`}; artifacts in ${OUT}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

await main();
