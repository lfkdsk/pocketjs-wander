// tools/desktop.ts — build wander or wander-online for the PocketJS desktop
// host and run it in a window: macos-app on a Mac, linux-app elsewhere.
//
//   bun tools/desktop.ts wander                # build, then launch (Cmd+Q quits)
//   bun tools/desktop.ts wander-online --build-only
//   bun tools/desktop.ts wander -- --quit-after 900   # extra host flags pass through
//   WANDER_ONLINE_URL=wss://host/ws bun tools/desktop.ts wander-online
//                                              # bake a server URL into the
//                                              # wander-online pak config
//   bun tools/desktop.ts wander-online --guest demo
//                                              # local --allow-guests server only
//   bun tools/desktop.ts wander-online --realm plaza-2 --auto-invite
//                                              # pin a realm, mint an invite after joining
//   bun tools/desktop.ts wander-online --invite plaza-2.K7MQ2XJ4
//                                              # join through an invite token
//
// The plan -> bundle -> host pipeline lives in tools/lib/desktop.ts.

import { join, resolve } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { DESKTOP_TARGET, buildForDesktop, runDesktopHost } from "./lib/desktop.ts";
import { writeOnlineUrl } from "./lib/online-url.ts";

const root = resolve(import.meta.dir, "..");
const APPS = ["wander", "wander-online"] as const;

const argv = process.argv.slice(2).filter((a) => a !== "--");
const buildOnly = argv.includes("--build-only");
const rest = argv.filter((a) => a !== "--build-only");
const name = rest[0] && !rest[0].startsWith("--") ? rest.shift()! : "wander";
if (!(APPS as readonly string[]).includes(name)) {
  throw new Error(`desktop: unknown app "${name}" (have: ${APPS.join(", ")})`);
}

// wander-online only: bake the server URL into its pak config before the
// build (--url wins over the WANDER_ONLINE_URL env var). The pak config
// reaches the web build; the desktop host loads the pak natively (no
// globalThis.__pak), so the URL is also prepended to the desktop JS bundle
// as globalThis.__onlineUrl, which the app checks first.
const urlIdx = rest.indexOf("--url");
let bakedUrl = "";
if (urlIdx >= 0 || process.env.WANDER_ONLINE_URL) {
  if (name !== "wander-online") throw new Error("desktop: --url/WANDER_ONLINE_URL only applies to wander-online");
  bakedUrl = urlIdx >= 0 ? (rest.splice(urlIdx, 2)[1] ?? "") : process.env.WANDER_ONLINE_URL!;
  writeOnlineUrl(root, bakedUrl);
}

const guestIdx = rest.indexOf("--guest");
let guestName = "";
if (guestIdx >= 0) {
  if (name !== "wander-online") throw new Error("desktop: --guest only applies to wander-online");
  guestName = rest.splice(guestIdx, 2)[1] ?? "";
  if (!guestName || guestName.length > 16) throw new Error("desktop: --guest requires a 1–16 character name");
}

// wander-online only: a realm pin, an invite token (`<realm>.<CODE>`) and
// an automatic invite request after joining (demos): the same hooks the
// web page and the sim tests use, prepended to the bundle like the URL.
const takeFlag = (flag: string): string => {
  const i = rest.indexOf(flag);
  if (i < 0) return "";
  if (name !== "wander-online") throw new Error(`desktop: ${flag} only applies to wander-online`);
  return rest.splice(i, 2)[1] ?? "";
};
const pinnedRealm = takeFlag("--realm");
const inviteToken = takeFlag("--invite");
const autoInviteIdx = rest.indexOf("--auto-invite");
const autoInvite = autoInviteIdx >= 0;
if (autoInvite) {
  if (name !== "wander-online") throw new Error("desktop: --auto-invite only applies to wander-online");
  rest.splice(autoInviteIdx, 1);
}

const build = await buildForDesktop(join(root, "examples", name, "pocket.json"));
if (bakedUrl || guestName || pinnedRealm || inviteToken || autoInvite) {
  // The desktop host evals the bundle as one script; leading assignments
  // run before the app. Guest auth is accepted only by the loopback
  // development server's explicit --allow-guests mode.
  const jsPath = join(build.outdir, `${build.plan.app.output}.js`);
  const prev = readFileSync(jsPath, "utf8");
  const bootstrap = [
    bakedUrl ? `globalThis.__onlineUrl=${JSON.stringify(bakedUrl)};` : "",
    guestName ? `globalThis.__onlineAuth=${JSON.stringify({ kind: "guest", name: guestName, color: 0 })};` : "",
    pinnedRealm ? `globalThis.__onlineRealm=${JSON.stringify(pinnedRealm)};` : "",
    inviteToken ? `globalThis.__onlineInvite=${JSON.stringify(inviteToken)};` : "",
    autoInvite ? "globalThis.__onlineAutoInvite=true;" : "",
  ].join("");
  writeFileSync(jsPath, `${bootstrap}\n${prev}`);
  if (bakedUrl) console.log(`desktop: baked server URL ${bakedUrl} into ${jsPath}`);
  if (guestName) console.log(`desktop: baked local guest ${JSON.stringify(guestName)} into ${jsPath}`);
  if (pinnedRealm) console.log(`desktop: baked realm pin ${JSON.stringify(pinnedRealm)} into ${jsPath}`);
  if (inviteToken) console.log(`desktop: baked invite token into ${jsPath}`);
  if (autoInvite) console.log(`desktop: baked automatic invite request into ${jsPath}`);
}
if (buildOnly) {
  console.log(`desktop: built ${build.plan.app.output} for ${DESKTOP_TARGET} + release host (${build.bin})`);
  process.exit(0);
}
await runDesktopHost(build, rest);
