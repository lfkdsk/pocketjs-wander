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
process.exit(await proc.exited);
