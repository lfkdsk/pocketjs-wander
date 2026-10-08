// tools/lib/online-url.ts — write wander-online's server URL into its pak
// config (examples/wander-online/online-config.json) before a build. The
// app reads this file from its pak at boot, so desktop and web builds both
// pick it up; the committed default points at the local Bun server.
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function writeOnlineUrl(root: string, url: string): string {
  if (!/^wss?:\/\/[^\s]+$/.test(url)) {
    throw new Error(`online-url: not a ws:// or wss:// URL: ${url}`);
  }
  const dir = join(root, "examples", "wander-online");
  if (!existsSync(dir)) throw new Error(`online-url: ${dir} not found`);
  const path = join(dir, "online-config.json");
  writeFileSync(path, JSON.stringify({ url }, null, 2) + "\n");
  return path;
}
