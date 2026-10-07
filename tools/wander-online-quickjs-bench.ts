// tools/wander-online-quickjs-bench.ts — one reproducible 32-player frame
// timing slot for the wander-online desktop app in the real QuickJS host.
// Build the named checkout first, then run four slots in A-B-B-A order.
//
//   bun tools/wander-online-quickjs-bench.ts \
//     --root /path/to/checkout --label candidate --out /path/to/results \
//     [--players 32] [--ticks 480] [--warmup 120] [--port 18181] [--cpu 2]
//
// The local server's explicitly gated --allow-guests mode is used only on
// 127.0.0.1. The generated wrapper injects one guest credential before the
// shipping bundle; no production authentication behavior is bypassed.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const option = (name: string, fallback = ""): string => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? (args[index + 1] ?? fallback) : fallback;
};

const runnerRoot = resolve(import.meta.dir, "..");
const root = resolve(option("root", runnerRoot));
const label = option("label", "candidate");
const out = resolve(option("out", join(runnerRoot, "reports", "wander-online-quickjs")));
const players = Number(option("players", "32"));
const ticks = Number(option("ticks", "480"));
const warmup = Number(option("warmup", "120"));
const port = Number(option("port", "18181"));
const cpu = option("cpu");

function fail(message: string): never {
  throw new Error(`wander-online-quickjs-bench: ${message}`);
}

if (!Number.isInteger(players) || players < 2 || players > 128) fail(`invalid --players ${players}`);
if (!Number.isInteger(ticks) || ticks <= warmup) fail(`--ticks must exceed --warmup (${ticks} <= ${warmup})`);
if (!Number.isInteger(port) || port < 1024 || port > 65535) fail(`invalid --port ${port}`);

const js = join(root, "dist", "linux-app", "wander-online.js");
const pak = join(root, "dist", "linux-app", "wander-online.pak");
const host = join(runnerRoot, "vendor", "pocketjs", "hosts", "desktop", "target", "release", "pocket-desktop-host");
for (const path of [js, pak, host]) if (!existsSync(path)) fail(`missing ${path}; build the desktop app/host first`);

mkdirSync(out, { recursive: true });
const safeLabel = label.replace(/[^a-zA-Z0-9_.-]/g, "-");
const wrapper = join(out, `${safeLabel}.js`);
const rawLog = join(out, `${safeLabel}.log`);
const dataRoot = join(out, `${safeLabel}-data`);
rmSync(dataRoot, { recursive: true, force: true });
mkdirSync(dataRoot, { recursive: true });
const socketUrl = `ws://127.0.0.1:${port}/ws`;
writeFileSync(
  wrapper,
  `globalThis.__onlineUrl=${JSON.stringify(socketUrl)};globalThis.__onlineAuth={kind:"guest",name:"bench",color:0};\n${readFileSync(js, "utf8")}`,
);

const collect = (stream: ReadableStream<Uint8Array> | number | null | undefined): Promise<string> =>
  stream && typeof stream !== "number" ? new Response(stream).text() : Promise.resolve("");
const delay = (ms: number): Promise<void> => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

const server = Bun.spawn({
  cmd: [
    process.execPath,
    join(root, "examples", "wander-online", "server", "server.ts"),
    "--port", String(port),
    "--aoi", "48",
    "--allow-guests",
  ],
  cwd: root,
  stdout: "pipe",
  stderr: "pipe",
});
const serverOut = collect(server.stdout);
const serverErr = collect(server.stderr);
let bots: ReturnType<typeof Bun.spawn> | null = null;
let botsOut: Promise<string> = Promise.resolve("");
let botsErr: Promise<string> = Promise.resolve("");
let desktopLog = "";

try {
  await delay(750);
  if (server.exitCode !== null) fail(`server exited ${server.exitCode}: ${(await serverErr).trim()}`);

  bots = Bun.spawn({
    cmd: [
      process.execPath,
      join(runnerRoot, "examples", "wander-online", "server", "bots.ts"),
      "--url", socketUrl,
      "--count", String(players - 1),
      "--seconds", String(Math.ceil(ticks / 60) + 8),
    ],
    cwd: runnerRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  botsOut = collect(bots.stdout);
  botsErr = collect(bots.stderr);
  await delay(1500);

  const hostCmd = [
    host,
    "--app", "wander-online",
    "--app-id", "dev.lfkdsk.pocket-rpgkit-wander-online",
    "--viewport", "480x272",
    "--fixed",
    "--density", "1",
    "--js", wrapper,
    "--pak", pak,
    "--data-root", dataRoot,
    "--headless",
    "--quit-after", String(ticks),
    "--trace-frames",
  ];
  if (cpu) hostCmd.unshift("taskset", "-c", cpu);
  const desktop = Bun.spawn({
    cmd: hostCmd,
    cwd: root,
    env: { ...process.env, RUST_LOG: "info" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [desktopStdout, desktopStderr, desktopExit] = await Promise.all([
    collect(desktop.stdout),
    collect(desktop.stderr),
    desktop.exited,
  ]);
  desktopLog = desktopStdout + desktopStderr;
  if (desktopExit !== 0) fail(`desktop exited ${desktopExit}; see ${rawLog}`);

  const online = desktopLog
    .split("\n")
    .filter((line) => line.includes("ONLINE "))
    .map((line) => line.slice(line.indexOf("ONLINE ") + 7))
    .flatMap((line) => {
      try { return [JSON.parse(line) as { online?: number }]; } catch { return []; }
    });
  const reached = online.some((state) => state.online === players);
  if (!reached) fail(`desktop never observed online=${players}; see ${rawLog}`);

  const samples = desktopLog
    .split("\n")
    .flatMap((line) => {
      const match = /FRAME_TRACE,tick,\d+,\d+,(\d+)/.exec(line);
      return match ? [Number(match[1])] : [];
    });
  const steady = samples.slice(warmup);
  if (steady.length !== ticks - warmup) {
    fail(`expected ${ticks - warmup} steady samples, got ${steady.length} (${samples.length} total); see ${rawLog}`);
  }
  const sorted = [...steady].sort((a, b) => a - b);
  const percentile = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]!;
  const summary = {
    label,
    commit: Bun.spawnSync({ cmd: ["git", "-C", root, "rev-parse", "HEAD"] }).stdout.toString().trim(),
    pocketjs: Bun.spawnSync({ cmd: ["git", "-C", join(root, "vendor", "pocketjs"), "rev-parse", "HEAD"] }).stdout.toString().trim(),
    bundleSha256: new Bun.CryptoHasher("sha256").update(readFileSync(js)).digest("hex"),
    cpu: cpu || "unbound",
    players,
    ticks,
    warmup,
    samples: steady.length,
    meanUs: Math.round(steady.reduce((sum, value) => sum + value, 0) / steady.length * 10) / 10,
    p50Us: percentile(0.5),
    p95Us: percentile(0.95),
    p99Us: percentile(0.99),
    maxUs: sorted[sorted.length - 1],
  };
  writeFileSync(join(out, `${safeLabel}.json`), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`WANDER_QJS ${JSON.stringify(summary)}`);
} finally {
  if (bots?.exitCode === null) bots.kill();
  if (server.exitCode === null) server.kill();
  const [botStdout, botStderr, serverStdout, serverStderr] = await Promise.all([
    botsOut,
    botsErr,
    serverOut,
    serverErr,
  ]);
  writeFileSync(
    rawLog,
    `${desktopLog}\n--- bots ---\n${botStdout}${botStderr}\n--- server ---\n${serverStdout}${serverStderr}`,
  );
  rmSync(wrapper, { force: true });
  rmSync(dataRoot, { recursive: true, force: true });
}
