// tools/wander-online-mobile-verify.ts — exercise Wander Online's real web
// player with Chrome phone emulation and real touch input.
//
// Run after `bun run web`:
//
//   bun tools/wander-online-mobile-verify.ts --out dist/wander-online-mobile
//
// The verifier starts loopback web, GitHub-stub and game servers. Each phone
// orientation signs a fresh account in through the real OAuth callback,
// creates its character through the page text box, opens the social panel and
// emote picker, mints/copies/closes an invite, and signs out. Landscape additionally uses
// immersive play and proves the floating controls clear the game's status,
// log, errand and help HUD rectangles. PNGs and report.json are retained for
// human inspection.

import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { startServer } from "../examples/wander-online/server/server.ts";
import {
  errandBarRect,
  helpRect,
  logBarRect,
  statusPlate,
  type HudRect,
} from "../examples/wander-online/hud.ts";
import { Cdp, launchChrome } from "../vendor/pocket-rpgkit/tools/lib/cdp.ts";

const ROOT = resolve(import.meta.dir, "..");
const SITE = resolve(option("site", join(ROOT, "dist", "web")));
const OUT = resolve(option("out", join(ROOT, "dist", "wander-online-mobile")));
const CHROME = option("chrome", Bun.which("google-chrome") ?? Bun.which("chromium") ?? "/usr/bin/google-chrome");
const GAME_PORT = Number(option("server-port", "8080"));
const DPR = 3;

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
    seed: 0x5eed_0001,
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
  // the matching state through its production callback path.
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => {
      if (location.hostname !== "127.0.0.1") return;
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
  const layoutReport = async (): Promise<LayoutReport> => {
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
    check(`${phase}: controls clear critical HUD`, overlaps.length === 0, overlaps.length ? overlaps.join(", ") : "status/log/errand/help clear");
    check(`${phase}: controls leave the central playfield clear`, centreOverlaps.length === 0, centreOverlaps.length ? centreOverlaps.join(", ") : "central 50% clear");
    for (const control of browser.controls) {
      check(`${phase}: ${control.label} touch size`, control.rect.width + 0.01 >= 44 && control.rect.height + 0.01 >= 44,
        `${control.rect.width.toFixed(1)}x${control.rect.height.toFixed(1)} CSS px`);
    }
    return { ...browser, critical, overlaps, centreOverlaps };
  };

  const runPhone = async (
    label: "portrait" | "landscape",
    width: number,
    height: number,
    token: string,
    characterName: string,
  ): Promise<void> => {
    phase = `${label} ${width}x${height}`;
    console.log(`\n# ${phase} @${DPR}x`);
    await setPhone(width, height);
    const oauthState = `${label}-state`;
    await cdp.send("Page.navigate", {
      // The distinct query forces a new document when the second orientation
      // follows the first; changing only the fragment is a same-document
      // navigation and would not reboot the game.
      url: `${origin}/wander-online/?mobile=${label}#oauth_token=${encodeURIComponent(token)}&state=${encodeURIComponent(oauthState)}`,
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

    // Open the in-game menu and choose its social row with real touch input.
    // The loopback server intentionally ignores the hosted-only JSON queries;
    // the bounded home panel must still be usable in both orientations.
    await touch('[data-button="SELECT"]', 140);
    await touch('[data-button="DOWN"]', 140);
    await waitFor<boolean>("social panel", "globalThis.__onlineState?.social === true", Boolean);
    const socialScreen = await evaluate<string>('globalThis.__onlineState?.socialScreen || ""');
    check(`${phase}: social panel opens at home`, socialScreen === "home", socialScreen);
    const socialShot = await screenshot(`${label}-${width}x${height}-social`);
    await touch('[data-button="CROSS"]', 140);
    await waitFor<boolean>("social panel closed", "globalThis.__onlineState?.social === false", Boolean);

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
    await waitFor<boolean>("Copied acknowledgement", 'document.getElementById("auth-invite-copy").textContent.trim() === "Copied"', Boolean);
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
      name: characterName,
      nameTargets,
      inviteTargets,
      invite,
      controls,
      screenshots: [nameShot, socialShot, emoteShot, inviteShot, signedOutShot].map((path) => path.split("/").at(-1)),
    };
  };

  try {
    await runPhone("portrait", 390, 844, "mobile-portrait", "Touch Port");
    await runPhone("landscape", 844, 390, "mobile-landscape", "Touch Land");
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
