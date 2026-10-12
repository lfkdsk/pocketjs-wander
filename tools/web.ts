// tools/web.ts — build this repo's static web site (dist/web) with the
// Pocket RPG Kit site builder from the submodule. The published site plays
// both wander and wander-online. Pages injects the hosted WebSocket URL;
// local builds keep the committed loopback URL.
//
//   bun tools/web.ts                  # both public pages
//   bun tools/web.ts wander           # one page only
//
// Every URL in the generated site is relative, so it works from any
// subpath (GitHub Pages serves this repository at /pocketjs-wander/).

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { writeOnlineUrl } from "./lib/online-url.ts";

const root = resolve(import.meta.dir, "..");
const names = process.argv.slice(2);
const args = names.length > 0 ? names : ["wander", "wander-online"];
const onlineUrl = process.env.WANDER_ONLINE_URL;
if (onlineUrl && args.includes("wander-online")) {
  writeOnlineUrl(root, onlineUrl);
  console.log(`web: wander-online connects to ${onlineUrl}`);
}
const proc = Bun.spawn({
  cmd: [
    process.execPath,
    join(root, "vendor", "pocket-rpgkit", "tools", "web.ts"),
    "--project-root=.",
    ...args,
  ],
  cwd: root,
  stdio: ["inherit", "inherit", "inherit"],
});
const exitCode = await proc.exited;
if (exitCode !== 0) process.exit(exitCode);

// Wander Online adds one more bottom HUD strip than the generic web host
// knows about. In landscape immersive play, lift this page's two floating
// pad clusters just above that strip; portrait and every other game retain
// the kit defaults. Keep this as a post-build page class/CSS override so the
// shared kit submodule remains unmodified.
if (args.includes("wander-online")) {
  const pagePath = join(root, "dist", "web", "wander-online", "index.html");
  const body = '<body class="player-page">';
  const html = readFileSync(pagePath, "utf8");
  if (!html.includes(body)) throw new Error("wander-online web page body marker changed");
  writeFileSync(pagePath, html.replace(body, '<body class="player-page wander-online-page">'));
  appendFileSync(join(root, "dist", "web", "site.css"), `

/* Wander Online's daily-goal strip occupies the band above LOG. */
@media (orientation: landscape) {
  body.wander-online-page.immersive .pad .dpad,
  body.wander-online-page.immersive .pad .actions {
    transform: translateY(-16px);
  }
}
`);
}
