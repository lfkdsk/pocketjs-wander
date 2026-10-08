// tests/helpers/boot.ts — boot the built example bundles (dist/<name>.js)
// on PocketJS's deterministic wasm sim host from the vendored submodule.
//
// The bundle and pak live in THIS repo's dist/, and the wasm core lives in
// vendor/pocket-rpgkit/vendor/pocketjs.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { bootWorld } from "../../vendor/pocket-rpgkit/vendor/pocketjs/hosts/sim/sim.ts";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const DIST = join(ROOT, "dist");
const WASM_PATH = join(
  ROOT,
  "vendor",
  "pocket-rpgkit",
  "vendor",
  "pocketjs",
  "hosts",
  "web",
  "pocketjs.wasm",
);

export interface SimWorld {
  frame: (buttons: number, analog?: number) => void;
  tick: () => void;
  render: () => Uint8Array;
  resizeViewport: (w: number, h: number) => void;
}

/** Whether a sim test for app `name` can run (bundle + wasm core). A fresh
 *  `bun install && bun test` reports the source suites green and skips the
 *  bundle suite with the missing-artifact reason. */
export function appPreflight(name: string): { ok: true } | { ok: false; reason: string } {
  const bundle = join(DIST, `${name}.js`);
  if (!existsSync(bundle)) {
    return { ok: false, reason: `missing ${bundle} — run \`bun run build\`` };
  }
  if (!existsSync(WASM_PATH)) {
    return { ok: false, reason: `missing ${WASM_PATH} — run \`bun run build:wasm\`` };
  }
  return { ok: true };
}

/** Absolute bundle path (no extension) for the vendored sim's bootWorld,
 *  which boots external-project bundles by path:
 *    bootWorld(appBundle("wander"), 60)  */
export function appBundle(name: string): string {
  return join(DIST, name);
}

export { bootWorld };
