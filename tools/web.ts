// tools/web.ts — build this repo's static web site (dist/web) with the
// Pocket RPG Kit site builder from the submodule. The published site plays
// wander in the browser; wander-online is local-only (it needs the loopback
// server), so it is only built when named explicitly.
//
//   bun tools/web.ts                  # the wander page
//   bun tools/web.ts wander-online    # also the local multiplayer page
//
// Every URL in the generated site is relative, so it works from any
// subpath (GitHub Pages serves this repository at /pocketjs-wander/).

import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const names = process.argv.slice(2);
const args = names.length > 0 ? names : ["wander"];
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
