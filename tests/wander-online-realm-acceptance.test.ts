// End-to-end acceptance probes for the v4 endless realm. These deliberately
// use the production generator, authoritative arena and predictor: no toy
// terrain or alternate movement implementation is involved.
import { describe, expect, test } from "bun:test";
import { blocksAt, COMPLETE, generateChunk, type ChunkData } from "../examples/wander/chunk.ts";
import { planRegion } from "../examples/wander/region.ts";
import { CHUNK, REGION_CHUNKS, regionGates, regionHub } from "../examples/wander/world.ts";
import { BTN } from "../examples/wander-online/net/protocol.ts";
import { RealmPredictor } from "../examples/wander-online/net/realm-predict.ts";
import { MultiFocusWorld, type RealmState } from "../examples/wander-online/net/realm-world.ts";
import { RealmArena, type RealmPlayer } from "../examples/wander-online/server/realm-area.ts";
import { entityFor } from "../examples/wander-online/shared/snapshot.ts";

const SEED = 0x5eed_0001;
const EPOCH = 0x3795_a001;
const LEGACY_MIN = 0;
const LEGACY_MAX = 95;

function bytes(view: ArrayBufferView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

const BYTE_FIELDS = [
  "terrain", "blockBiome", "subBiome", "devGround", "devUpper",
  "devBorn", "natUpper", "natHide", "flags", "growCells",
] as const satisfies readonly (keyof ChunkData)[];

function authoritativeMover(state: RealmState) {
  const m = state.move;
  return {
    tx: m.tx,
    ty: m.ty,
    px: m.px,
    py: m.py,
    facing: m.facing,
    phase: m.phase,
    stepDir: m.stepDir,
    moving: m.moving,
    walking: m.walking,
  };
}

function predictorFor(arena: RealmArena, player: RealmPlayer): RealmPredictor {
  const { id: _id, color: _color, ...mover } = entityFor(player);
  return new RealmPredictor({
    you: player.id,
    seed: arena.seed,
    generatorVersion: 1,
    epoch: arena.epoch,
    realmId: arena.realmId,
    realmRevision: 0,
    serverTimeMs: 0,
    mover,
  });
}

interface RegionCoord { x: number; y: number }

/** Find a connected region route whose target has the requested horizontal
 * displacement. Shared gate hashes guarantee that every selected edge has
 * a continuous completed road on both sides. */
function regionRoute(sign: -1 | 1, distance: number): RegionCoord[] {
  const queue: RegionCoord[] = [{ x: 0, y: 0 }];
  const previous = new Map<string, RegionCoord | null>([["0,0", null]]);
  let goal: RegionCoord | null = null;
  for (let head = 0; head < queue.length && head < 10_000; head++) {
    const at = queue[head]!;
    if (sign * at.x >= distance) {
      goal = at;
      break;
    }
    const gates = regionGates(SEED, at.x, at.y);
    const next = [
      { open: gates.w.active, x: at.x - 1, y: at.y },
      { open: gates.e.active, x: at.x + 1, y: at.y },
      { open: gates.n.active, x: at.x, y: at.y - 1 },
      { open: gates.s.active, x: at.x, y: at.y + 1 },
    ];
    for (const candidate of next) {
      const key = `${candidate.x},${candidate.y}`;
      if (!candidate.open || previous.has(key)) continue;
      previous.set(key, at);
      queue.push(candidate);
    }
  }
  if (!goal) throw new Error(`no connected region ${distance} cells toward ${sign}`);
  const reverse: RegionCoord[] = [];
  for (let at: RegionCoord | null = goal; at; at = previous.get(`${at.x},${at.y}`) ?? null) reverse.push(at);
  return reverse.reverse();
}

class CompleteTerrain {
  private readonly plans = new Map<string, ReturnType<typeof planRegion>>();
  private readonly chunks = new Map<string, ChunkData>();

  chunk(cx: number, cy: number): ChunkData {
    const key = `${cx},${cy}`;
    let chunk = this.chunks.get(key);
    if (chunk) return chunk;
    const rx = Math.floor(cx / REGION_CHUNKS), ry = Math.floor(cy / REGION_CHUNKS);
    const planKey = `${rx},${ry}`;
    let plan = this.plans.get(planKey);
    if (!plan) {
      plan = planRegion(SEED, rx, ry);
      this.plans.set(planKey, plan);
    }
    chunk = generateChunk(SEED, cx, cy, plan);
    this.chunks.set(key, chunk);
    return chunk;
  }

  blocked(x: number, y: number): boolean {
    const cx = Math.floor(x / CHUNK), cy = Math.floor(y / CHUNK);
    const chunk = this.chunk(cx, cy);
    return blocksAt(chunk, (y - chunk.y0) * CHUNK + x - chunk.x0, COMPLETE);
  }
}

interface HeapItem { cell: number; score: number }

class MinHeap {
  private readonly values: HeapItem[] = [];
  get size(): number { return this.values.length; }
  push(item: HeapItem): void {
    let at = this.values.length;
    this.values.push(item);
    while (at > 0) {
      const parent = (at - 1) >> 1;
      if (this.values[parent]!.score <= item.score) break;
      this.values[at] = this.values[parent]!;
      at = parent;
    }
    this.values[at] = item;
  }
  pop(): HeapItem {
    const first = this.values[0]!;
    const last = this.values.pop()!;
    if (this.values.length === 0) return first;
    let at = 0;
    while (true) {
      const left = at * 2 + 1;
      if (left >= this.values.length) break;
      const right = left + 1;
      const child = right < this.values.length && this.values[right]!.score < this.values[left]!.score ? right : left;
      if (this.values[child]!.score >= last.score) break;
      this.values[at] = this.values[child]!;
      at = child;
    }
    this.values[at] = last;
    return first;
  }
}

/** Tile A* inside the bounding box of a known connected region route. */
function tileRoute(regions: readonly RegionCoord[]): { masks: number[]; goal: RegionCoord } {
  const start = regionHub(SEED, 0, 0);
  const goal = regionHub(SEED, regions.at(-1)!.x, regions.at(-1)!.y);
  const minRx = Math.min(...regions.map((r) => r.x));
  const maxRx = Math.max(...regions.map((r) => r.x));
  const minRy = Math.min(...regions.map((r) => r.y));
  const maxRy = Math.max(...regions.map((r) => r.y));
  const x0 = minRx * CHUNK * REGION_CHUNKS;
  const y0 = minRy * CHUNK * REGION_CHUNKS;
  const x1 = (maxRx + 1) * CHUNK * REGION_CHUNKS - 1;
  const y1 = (maxRy + 1) * CHUNK * REGION_CHUNKS - 1;
  const width = x1 - x0 + 1, height = y1 - y0 + 1;
  const index = (x: number, y: number) => (y - y0) * width + x - x0;
  const xOf = (cell: number) => x0 + cell % width;
  const yOf = (cell: number) => y0 + Math.floor(cell / width);
  const terrain = new CompleteTerrain();
  if (terrain.blocked(start.x, start.y) || terrain.blocked(goal.x, goal.y)) throw new Error("route endpoint is blocked");

  const total = width * height;
  const came = new Int32Array(total).fill(-2);
  const cameMask = new Uint16Array(total);
  const cost = new Int32Array(total).fill(0x3fff_ffff);
  const startCell = index(start.x, start.y), goalCell = index(goal.x, goal.y);
  const heap = new MinHeap();
  cost[startCell] = 0;
  came[startCell] = -1;
  heap.push({ cell: startCell, score: Math.abs(goal.x - start.x) + Math.abs(goal.y - start.y) });
  const steps = [
    { dx: 1, dy: 0, mask: BTN.right },
    { dx: -1, dy: 0, mask: BTN.left },
    { dx: 0, dy: 1, mask: BTN.down },
    { dx: 0, dy: -1, mask: BTN.up },
  ] as const;
  while (heap.size > 0 && came[goalCell] === -2) {
    const item = heap.pop();
    const x = xOf(item.cell), y = yOf(item.cell), nextCost = cost[item.cell]! + 1;
    const expected = cost[item.cell]! + Math.abs(goal.x - x) + Math.abs(goal.y - y);
    if (item.score !== expected) continue;
    for (const step of steps) {
      const nx = x + step.dx, ny = y + step.dy;
      if (nx < x0 || nx > x1 || ny < y0 || ny > y1 || terrain.blocked(nx, ny)) continue;
      const cell = index(nx, ny);
      if (nextCost >= cost[cell]!) continue;
      cost[cell] = nextCost;
      came[cell] = item.cell;
      cameMask[cell] = step.mask;
      heap.push({ cell, score: nextCost + Math.abs(goal.x - nx) + Math.abs(goal.y - ny) });
    }
  }
  if (came[goalCell] === -2) throw new Error(`no tile route to ${goal.x},${goal.y}`);
  const reverse: number[] = [];
  for (let cell = goalCell; cell !== startCell; cell = came[cell]!) reverse.push(cameMask[cell]!);
  return { masks: reverse.reverse(), goal: { x: goal.x, y: goal.y } };
}

describe("wander-online realm acceptance", () => {
  test("1,000 signed coordinates are byte-identical to the single-player complete generator", () => {
    const streamed = new MultiFocusWorld(SEED);
    const direct = new Map<string, ChunkData>();
    const centers = Array.from({ length: 32 }, (_, i) => ({
      cx: -2_000 + i * 127,
      cy: 1_500 - i * 113,
    }));
    for (const { cx, cy } of centers) {
      streamed.prime([{ x: cx * CHUNK + 16, y: cy * CHUNK + 16 }], 0);
      const actual = streamed.chunk(cx, cy)!;
      const rx = Math.floor(cx / REGION_CHUNKS), ry = Math.floor(cy / REGION_CHUNKS);
      const expected = generateChunk(SEED, cx, cy, planRegion(SEED, rx, ry));
      direct.set(`${cx},${cy}`, expected);
      for (const field of BYTE_FIELDS) {
        expect(bytes(actual[field] as ArrayBufferView)).toEqual(bytes(expected[field] as ArrayBufferView));
      }
    }

    let random = 0x3795_a001;
    for (let sample = 0; sample < 1_000; sample++) {
      random = (Math.imul(random, 1_664_525) + 1_013_904_223) >>> 0;
      const centre = centers[random % centers.length]!;
      random = (Math.imul(random, 1_664_525) + 1_013_904_223) >>> 0;
      const lx = random % CHUNK;
      random = (Math.imul(random, 1_664_525) + 1_013_904_223) >>> 0;
      const ly = random % CHUNK;
      const tx = centre.cx * CHUNK + lx, ty = centre.cy * CHUNK + ly;
      const expected = direct.get(`${centre.cx},${centre.cy}`)!;
      const cell = ly * CHUNK + lx;
      expect(streamed.collisionAt(tx, ty).ready).toBe(true);
      expect(streamed.collisionAt(tx, ty).blocked ? 1 : 0).toBe(blocksAt(expected, cell, COMPLETE) ? 1 : 0);
      expect(streamed.chunk(centre.cx, centre.cy)!.terrain[cell]).toBe(expected.terrain[cell]);
    }
    expect(streamed.chunks.size).toBeLessThanOrEqual(512);
    expect(streamed.plans.size).toBeLessThanOrEqual(160);
  }, 60_000);

  test("two predicted clients walk more than 500 tiles in opposite directions with no boundary correction increase", () => {
    const positive = tileRoute(regionRoute(1, 6));
    const negative = tileRoute(regionRoute(-1, 6));
    const arena = new RealmArena({ seed: SEED, hz: 60, realmId: "acceptance", epoch: EPOCH });
    const a = arena.add("positive", 1);
    const b = arena.add("negative", 2);
    const ax0 = a.state.move.tx, bx0 = b.state.move.tx;
    const predictors = [predictorFor(arena, a), predictorFor(arena, b)];
    const players = [a, b];
    const paths = [positive.masks, negative.masks];
    const counts = [
      { beforeStates: 0, beforeCorrections: 0, afterStates: 0, afterCorrections: 0 },
      { beforeStates: 0, beforeCorrections: 0, afterStates: 0, afterCorrections: 0 },
    ];
    const ticks = Math.max(positive.masks.length, negative.masks.length) * 8;
    for (let tick = 0; tick < ticks; tick++) {
      for (let i = 0; i < 2; i++) {
        const mask = paths[i]![Math.floor(tick / 8)] ?? 0;
        const seq = predictors[i]!.pushInput(mask);
        arena.pushInput(players[i]!, seq, mask);
      }
      arena.stepRefTick();
      for (let i = 0; i < 2; i++) {
        const player = players[i]!, predictor = predictors[i]!, count = counts[i]!;
        const before = predictor.corrections;
        expect(predictor.reconcile(arena.epoch, player.lastSeq, authoritativeMover(player.state))).toBe("matched");
        const corrected = predictor.corrections - before;
        const m = player.state.move;
        if (m.tx >= LEGACY_MIN && m.tx <= LEGACY_MAX && m.ty >= LEGACY_MIN && m.ty <= LEGACY_MAX) {
          count.beforeStates++;
          count.beforeCorrections += corrected;
        } else {
          count.afterStates++;
          count.afterCorrections += corrected;
        }
      }
    }

    expect(a.state.move.tx).toBe(positive.goal.x);
    expect(a.state.move.ty).toBe(positive.goal.y);
    expect(b.state.move.tx).toBe(negative.goal.x);
    expect(b.state.move.ty).toBe(negative.goal.y);
    expect(a.state.move.tx - ax0).toBeGreaterThanOrEqual(500);
    expect(bx0 - b.state.move.tx).toBeGreaterThanOrEqual(500);
    for (const count of counts) {
      expect(count.beforeStates).toBeGreaterThan(0);
      expect(count.afterStates).toBeGreaterThan(0);
      expect(count.beforeCorrections / count.beforeStates).toBe(0);
      expect(count.afterCorrections / count.afterStates).toBe(0);
    }
    expect(arena.world.chunks.size).toBeLessThanOrEqual(512);
    expect(arena.world.plans.size).toBeLessThanOrEqual(160);
  }, 120_000);
});
