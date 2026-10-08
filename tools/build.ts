// tools/build.ts — build the wander and wander-online example apps against
// the PocketJS pinned by the Pocket RPG Kit submodule.
//
//   bun tools/build.ts [name...]   # default: both apps
//
// Each app is one entry examples/<name>/<name>.tsx, so the build writes
// dist/<name>.js and dist/<name>.pak (the sim tests boot those). wander's
// gen-assets runs first: it regenerates the asset manifest and the stamp /
// fill composites from grow's committed art in the submodule, byte for byte
// deterministic, so a clean tree stays clean after a build.

import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
mkdirSync(join(root, "dist"), { recursive: true });

async function run(cmd: string[]): Promise<void> {
  const proc = Bun.spawn({ cmd, cwd: root, stdio: ["inherit", "inherit", "inherit"] });
  const exit = await proc.exited;
  if (exit !== 0) process.exit(exit);
}

const APPS = ["wander", "wander-online"] as const;
const wanted = process.argv.slice(2);
for (const name of wanted) {
  if (!(APPS as readonly string[]).includes(name)) {
    console.error(`build: unknown app "${name}" (have: ${APPS.join(", ")})`);
    process.exit(2);
  }
}
const apps = wanted.length ? wanted : [...APPS];

// grow's art is referenced in place from the submodule; regenerate the
// manifest and composites so the build packs current pixels.
await run([process.execPath, join(root, "examples", "wander", "gen-assets.ts")]);

const buildTs = join(root, "vendor", "pocket-rpgkit", "vendor", "pocketjs", "tools", "build.ts");
for (const name of apps) {
  await run([
    process.execPath,
    buildTs,
    join(root, "examples", name, `${name}.tsx`),
    `--project-root=${root}`,
    `--outdir=${join(root, "dist")}`,
    `--inputs-file=${join(root, "dist", `${name}.inputs.json`)}`,
  ]);
}
