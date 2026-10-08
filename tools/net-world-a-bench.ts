// V8/workerd-family residency benchmark for the production v4 realm.
//
// Reproduce with a fresh process so retained-memory deltas are meaningful:
//   bun build tools/net-world-a-bench.ts --target=node --outfile <scratch>.mjs
//   node --expose-gc <scratch>.mjs
import { performance } from "node:perf_hooks";
import { CHUNK_CACHE_CAP, PLAN_CACHE_CAP } from "../examples/wander-online/net/realm-world.ts";
import { RealmArena } from "../examples/wander-online/server/realm-area.ts";
import { snapshotForRealm } from "../examples/wander-online/shared/snapshot.ts";
import { CHUNK } from "../examples/wander/world.ts";

const SEED = 0x5eed_0001;
const PLAYERS = 32;
const FRAMES = Number(process.env.NET_WORLD_BENCH_FRAMES ?? 500);

function fail(message: string): never {
  throw new Error(`net-world-a-bench: ${message}`);
}

function gc(): void {
  const collect = (globalThis as typeof globalThis & { gc?: () => void }).gc;
  if (!collect) fail("run the bundled script with node --expose-gc");
  collect();
  collect();
}

function memory(): { heapUsed: number; arrayBuffers: number; rss: number } {
  const m = process.memoryUsage();
  return { heapUsed: m.heapUsed, arrayBuffers: m.arrayBuffers, rss: m.rss };
}

function percentile(sorted: readonly number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!;
}

/** Disjoint 3x3 rings. Centre chunks use the same mod-3 alignment, so the
 * measured active set and plan count are stable across runs. */
function locations(shiftChunks = 0): { tx: number; ty: number }[] {
  return Array.from({ length: PLAYERS }, (_, i) => ({
    tx: ((i % 8) * 30 - 105 + shiftChunks) * CHUNK + 16,
    ty: (Math.floor(i / 8) * 30 - 45) * CHUNK + 16,
  }));
}

// Warm code/JIT and release its realm before taking the retained baseline.
{
  const warm = new RealmArena({ seed: SEED ^ 1, hz: 20 });
  const p = warm.add("warm", 0);
  for (let i = 0; i < 20; i++) warm.step();
  warm.remove(p.id);
}
gc();
const before = memory();

const buildStarted = performance.now();
const arena = new RealmArena({ seed: SEED, hz: 20, realmId: "benchmark", epoch: 1 });
for (const [i, at] of locations().entries()) arena.add(`p${i}`, i & 15, i & 63, at);
const coldBuildMs = performance.now() - buildStarted;
if (arena.world.activeCount !== PLAYERS * 9) fail(`active=${arena.world.activeCount}, expected ${PLAYERS * 9}`);
process.stderr.write(`cold-build ${coldBuildMs.toFixed(1)}ms\n`);

// All players advance through ten disjoint chunk columns. This retains much
// more than the 1,800-tick TTL can protect, so the hard LRU must stop at 512
// while preserving every currently-active entry.
const lruStarted = performance.now();
for (let shift = 1; shift <= 10; shift++) {
  const at = locations(shift);
  let i = 0;
  for (const player of arena.players.values()) {
    const next = at[i++]!;
    player.state = {
      ...player.state,
      move: {
        ...player.state.move,
        tx: next.tx,
        ty: next.ty,
        px: next.tx * 16,
        py: next.ty * 16,
        phase: 0,
        moving: false,
        walking: false,
      },
    };
  }
  arena.world.prime(at.map(({ tx, ty }) => ({ x: tx, y: ty, hx: 1 as const, hy: 0 as const })), arena.refTicks);
  process.stderr.write(`lru-shift ${shift}: chunks=${arena.world.chunks.size} plans=${arena.world.plans.size}\n`);
}
const lruExerciseMs = performance.now() - lruStarted;
if (arena.world.activeCount !== PLAYERS * 9) fail(`post-LRU active=${arena.world.activeCount}`);
if (arena.world.chunks.size > CHUNK_CACHE_CAP) fail(`chunks=${arena.world.chunks.size}`);
if (arena.world.plans.size > PLAN_CACHE_CAP) fail(`plans=${arena.world.plans.size}`);
for (const key of arena.world.active) if (!arena.world.chunks.has(key)) fail(`active chunk ${key} was evicted`);
process.stderr.write(`lru-exercise ${lruExerciseMs.toFixed(1)}ms\n`);
const lruResidentChunks = arena.world.chunks.size;
const lruResidentPlans = arena.world.plans.size;

gc();
const after = memory();
const logicalChunkBytes = [...arena.world.chunks.values()].reduce((sum, chunk) => sum + chunk.bytes, 0);
const logicalPlanBytes = [...arena.world.plans.values()].reduce((sum, plan) => sum + plan.bytes, 0);

// A 20 Hz server frame includes three reference ticks. Every other frame
// also builds and serialises each player's 10 Hz sparse AOI snapshot, just
// as RoomDO does in production.
for (let frame = 0; frame < 200; frame++) {
  arena.step();
  if ((frame & 1) === 0) {
    arena.indexPlayers();
    for (const player of arena.players.values()) snapshotForRealm(arena, player, 16, PLAYERS, PLAYERS);
  }
}
process.stderr.write("hot-warmup complete\n");
const frameMs: number[] = [];
let wireBytes = 0;
for (let frame = 0; frame < FRAMES; frame++) {
  const started = performance.now();
  arena.step();
  if ((frame & 1) === 0) {
    arena.indexPlayers();
    for (const player of arena.players.values()) {
      wireBytes += snapshotForRealm(arena, player, 16, PLAYERS, PLAYERS).byteLength;
    }
  }
  frameMs.push(performance.now() - started);
}
frameMs.sort((a, b) => a - b);

console.log(JSON.stringify({
  runtime: process.version,
  players: PLAYERS,
  layout: "dispersed",
  activeChunks: arena.world.activeCount,
  residentChunks: lruResidentChunks,
  residentPlans: lruResidentPlans,
  residentChunksAfterTtl: arena.world.chunks.size,
  chunkCap: CHUNK_CACHE_CAP,
  planCap: PLAN_CACHE_CAP,
  coldBuildMs: Number(coldBuildMs.toFixed(3)),
  lruExerciseMs: Number(lruExerciseMs.toFixed(3)),
  logicalBytes: logicalChunkBytes + logicalPlanBytes,
  v8RetainedBytes: Math.max(0, (after.heapUsed - before.heapUsed) + (after.arrayBuffers - before.arrayBuffers)),
  rssDeltaBytes: Math.max(0, after.rss - before.rss),
  frames: FRAMES,
  medianMsPer20HzFrame: Number(percentile(frameMs, 0.5).toFixed(4)),
  p95MsPer20HzFrame: Number(percentile(frameMs, 0.95).toFixed(4)),
  p99MsPer20HzFrame: Number(percentile(frameMs, 0.99).toFixed(4)),
  maxMsPer20HzFrame: Number(frameMs.at(-1)!.toFixed(4)),
  wireBytes,
}));
