// tests/wander-world.test.ts — the endless world is a pure function.
//
//   ORDER     chunks generated in different orders, through the budgeted
//             residency with different focus paths, and after eviction and
//             regeneration are byte-identical, near the origin and at
//             (±100000, ±100000) and beyond
//   POINT     every chunk cell equals the point definitions (biome, seam
//             kind, wilderness stamp) evaluated with no chunk at all
//   SEAMS     roads are continuous across chunk and region borders: each
//             region's grown road network is one connected piece through
//             its hub, gates pair across every shared edge, and no road
//             ends on a region edge anywhere else; biome transitions agree
//             with one large sampler across chunk edges
//   GROWTH    a region's state at growth tick k is "every cell born <= k":
//             roads first, then houses, fields and residents

import { describe, expect, test } from "bun:test";
import {
  BiomeGrid, CHUNK, CHUNK_CELLS, REGION, REGION_CHUNKS, biomeAt, blockOfCell, blockOrigin,
  gateOf, naturalCellAt, pointNature, regionGates, regionHub, seamKindFrom,
} from "../examples/wander/world.ts";
import { F_BLOCK, F_ROAD, GATE_TAIL, planRegion, type RegionPlan } from "../examples/wander/region.ts";
import { COMPLETE, generateChunk, groundAt, NEVER, roadAt, type ChunkData } from "../examples/wander/chunk.ts";
import { Residency } from "../examples/wander/residency.ts";

const SEED = 0x5eed_0001;

function chunkBytes(c: ChunkData): string {
  const parts = [c.terrain, c.blockBiome, c.subBiome, c.devGround, new Uint8Array(c.devUpper.buffer), c.devBorn, new Uint8Array(c.natUpper.buffer), c.natHide, c.flags, new Uint8Array(c.growCells.buffer, c.growCells.byteOffset, c.growCells.byteLength)];
  let h = 0x811c9dc5;
  for (const p of parts) for (let i = 0; i < p.length; i++) { h ^= p[i]!; h = Math.imul(h, 0x01000193); }
  return `${c.cx},${c.cy}:${(h >>> 0).toString(16)}:${parts.map((p) => p.length).join(",")}`;
}

function fresh(seed: number, cx: number, cy: number): ChunkData {
  return generateChunk(seed, cx, cy, planRegion(seed, Math.floor(cx / REGION_CHUNKS), Math.floor(cy / REGION_CHUNKS)));
}

/** Deterministic pseudo-random chunk coordinates, some far away. */
function sampleChunks(n: number): [number, number][] {
  const out: [number, number][] = [];
  let r = 0x1234_5678;
  const next = () => { r = (Math.imul(r ^ (r >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0; return r; };
  for (let i = 0; i < n; i++) {
    const far = i % 3 === 0 ? 3125 : i % 3 === 1 ? 40 : 1_000_000;
    out.push([(next() % (2 * far)) - far, (next() % (2 * far)) - far]);
  }
  // (±100000, ±100000) tiles, and chunk corners of the int32 range.
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) out.push([Math.floor((sx * 100000) / CHUNK), Math.floor((sy * 100000) / CHUNK)]);
  out.push([Math.floor(2 ** 30 / CHUNK), Math.floor(-(2 ** 30) / CHUNK)]);
  return out;
}

describe("wander world: order independence", () => {
  const coords = sampleChunks(36);

  test("forward, reverse and shuffled generation give byte-identical chunks", () => {
    const forward = coords.map(([x, y]) => chunkBytes(fresh(SEED, x, y)));
    const reverse = [...coords].reverse().map(([x, y]) => chunkBytes(fresh(SEED, x, y))).reverse();
    const order = coords.map((_, i) => i).sort((a, b) => ((a * 7919) % 37) - ((b * 7919) % 37));
    const shuffled: string[] = new Array(coords.length);
    for (const i of order) shuffled[i] = chunkBytes(fresh(SEED, coords[i]![0], coords[i]![1]));
    expect(reverse).toEqual(forward);
    expect(shuffled).toEqual(forward);
    // Mutation guard: another seed is a different world.
    expect(coords.slice(0, 6).map(([x, y]) => chunkBytes(fresh(SEED + 1, x, y)))).not.toEqual(forward.slice(0, 6));
  });

  test("budgeted residency along different paths, with eviction and regeneration, matches direct generation", () => {
    const target: [number, number][] = [];
    for (let cy = -1; cy <= 1; cy++) for (let cx = 3; cx <= 8; cx++) target.push([cx, cy]);
    const direct = new Map(target.map(([x, y]) => [`${x},${y}`, chunkBytes(fresh(SEED, x, y))]));
    const run = (path: { x: number; y: number }[]): Map<string, string> => {
      const res = new Residency(SEED);
      const seen = new Map<string, string>();
      let now = 0;
      for (const p of path) {
        res.updateRings({ x: p.x, y: p.y, hx: 1, hy: 0 }, 30, 17, []);
        for (let t = 0; t < 40; t++) {
          res.runBudget(1400, now++);
          for (const c of res.fresh.splice(0)) {
            const k = `${c.cx},${c.cy}`;
            if (direct.has(k)) {
              const bytes = chunkBytes(c);
              // A chunk evicted and regenerated later must come back the same.
              if (seen.has(k)) expect(bytes).toBe(seen.get(k)!);
              seen.set(k, bytes);
            }
          }
        }
      }
      expect(res.stats().resident).toBeLessThanOrEqual(res.stats().cap);
      return seen;
    };
    // East then far away (evicting everything) then back; and a west-first path.
    const east: { x: number; y: number }[] = [];
    for (let x = 80; x <= 280; x += 8) east.push({ x, y: 0 });
    for (let x = 280; x <= 1500; x += 64) east.push({ x, y: 0 });
    for (let x = 1500; x >= 80; x -= 64) east.push({ x, y: 0 });
    const west: { x: number; y: number }[] = [];
    for (let x = 400; x >= 60; x -= 8) west.push({ x, y: (x % 3) * 10 - 10 });
    const a = run(east), b = run(west);
    expect(a.size).toBe(direct.size);
    expect(b.size).toBe(direct.size);
    for (const [k, v] of direct) {
      expect(a.get(k)).toBe(v);
      expect(b.get(k)).toBe(v);
    }
  });
});

describe("wander world: chunks equal the point definitions", () => {
  test("terrain (biome and seam kind) of every cell, including far chunks", () => {
    const s = (x: number, y: number) => biomeAt(SEED, x, y);
    for (const [cx, cy] of [[0, 0], [-1, 2], [3125, -3125], [-3125, 3125], [31250, 31250]] as const) {
      const c = fresh(SEED, cx, cy);
      for (let i = 0; i < CHUNK_CELLS; i += 3) {
        const x = c.x0 + (i % CHUNK), y = c.y0 + Math.floor(i / CHUNK);
        expect(c.terrain[i]! & 3).toBe(s(x, y));
        expect(c.terrain[i]! >> 2).toBe(seamKindFrom(s, x, y));
      }
    }
  });

  test("the rectangle biome sampler is bit-identical to the point function", () => {
    const g = new BiomeGrid(SEED, -200, -150, 200, 150);
    for (let n = 0; n < 4000; n++) {
      const x = ((n * 7919) % 401) - 200, y = ((n * 104729) % 301) - 150;
      expect(g.biome(x, y)).toBe(biomeAt(SEED, x, y));
    }
  });

  test("wilderness cells match the per-block point definition outside gate corridors", () => {
    const nature = pointNature(SEED);
    let checked = 0, trees = 0;
    for (const [cx, cy] of [[1, 1], [-4, 7], [100, -100]] as const) {
      const plan = planRegion(SEED, Math.floor(cx / REGION_CHUNKS), Math.floor(cy / REGION_CHUNKS));
      const c = generateChunk(SEED, cx, cy, plan);
      for (let i = 0; i < CHUNK_CELLS; i++) {
        const x = c.x0 + (i % CHUNK), y = c.y0 + Math.floor(i / CHUNK);
        const { bx, by } = blockOfCell(x, y);
        const o = blockOrigin(bx, by);
        const inCorridor = plan.corridors.some((b) => [[0, 0], [1, 0], [0, 1], [1, 1]].some(([dx, dy]) =>
          o.x0 + dx! >= b.x0 && o.x0 + dx! <= b.x1 && o.y0 + dy! >= b.y0 && o.y0 + dy! <= b.y1));
        const expected = inCorridor ? 0 : naturalCellAt(SEED, x, y, nature);
        expect(c.natUpper[i]).toBe(expected);
        checked++;
        if (expected >= 128) trees++;
      }
    }
    expect(checked).toBe(3 * CHUNK_CELLS);
    expect(trees).toBeGreaterThan(100);
  });
});

// ---------------------------------------------------------------------------

/** Region-level road grid at COMPLETE (plan data), world tile -> road. */
function roadCells(plan: RegionPlan): Set<string> {
  const out = new Set<string>();
  if (plan.empty) return out;
  for (let i = 0; i < REGION * REGION; i++) {
    if (plan.flags![i]! & F_ROAD) out.add(`${plan.x0 + (i % REGION)},${plan.y0 + Math.floor(i / REGION)}`);
  }
  return out;
}

describe("wander world: roads and seams across borders", () => {
  const regions: RegionPlan[] = [];
  for (let ry = -3; ry <= 3; ry++) for (let rx = -3; rx <= 3; rx++) regions.push(planRegion(SEED, rx, ry));

  test("each region's roads form one connected network through its hub", () => {
    let withRoads = 0;
    for (const plan of regions) {
      const roads = roadCells(plan);
      if (!roads.size) continue;
      withRoads++;
      const start = `${plan.hub.x},${plan.hub.y}`;
      expect(roads.has(start)).toBe(true);
      const seen = new Set([start]);
      const queue = [start];
      while (queue.length) {
        const [x, y] = queue.pop()!.split(",").map(Number) as [number, number];
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const k = `${x + dx},${y + dy}`;
          if (roads.has(k) && !seen.has(k)) { seen.add(k); queue.push(k); }
        }
      }
      expect(seen.size).toBe(roads.size);
    }
    expect(withRoads).toBeGreaterThan(30);
  });

  test("gates pair across every shared region edge, and roads touch region edges only there", () => {
    let paired = 0;
    for (const plan of regions) {
      const roads = roadCells(plan);
      const g = regionGates(SEED, plan.rx, plan.ry);
      const x0 = plan.x0, y0 = plan.y0, x1 = x0 + REGION - 1, y1 = y0 + REGION - 1;
      const gates = new Set<string>();
      if (g.w.active) gates.add(`${x0},${y0 + g.w.at}`);
      if (g.e.active) gates.add(`${x1},${y0 + g.e.at}`);
      if (g.n.active) gates.add(`${x0 + g.n.at},${y0}`);
      if (g.s.active) gates.add(`${x0 + g.s.at},${y1}`);
      for (const k of roads) {
        const [x, y] = k.split(",").map(Number) as [number, number];
        const onEdge = x === x0 || x === x1 || y === y0 || y === y1;
        if (onEdge) expect(gates.has(k)).toBe(true);
      }
      for (const k of gates) expect(roads.has(k)).toBe(true);
      // Development keeps off the two edge rows except the gate tails, so a
      // 2x2 wilderness block over the edge never meets the other plan.
      if (!plan.empty) for (let i = 0; i < REGION * REGION; i++) {
        if (!plan.flags![i]) continue;
        const lx = i % REGION, ly = Math.floor(i / REGION);
        if (lx >= 2 && ly >= 2 && lx < REGION - 2 && ly < REGION - 2) continue;
        const x = x0 + lx, y = y0 + ly;
        expect(plan.corridors.some((b) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1)).toBe(true);
      }
      // East and south neighbours see the same gates from their side.
      if (plan.rx < 3 && g.e.active) {
        const east = regions.find((p) => p.rx === plan.rx + 1 && p.ry === plan.ry)!;
        expect(gateOf(SEED, true, plan.rx + 1, plan.ry)).toEqual(regionGates(SEED, east.rx, east.ry).w);
        expect(roadCells(east).has(`${x1 + 1},${y0 + g.e.at}`)).toBe(true);
        // The two tails run straight across the edge.
        for (let n = 0; n <= GATE_TAIL; n++) {
          expect(roads.has(`${x1 - n},${y0 + g.e.at}`)).toBe(true);
          expect(roadCells(east).has(`${x1 + 1 + n},${y0 + g.e.at}`)).toBe(true);
        }
        paired++;
      }
      if (plan.ry < 3 && g.s.active) {
        const south = regions.find((p) => p.rx === plan.rx && p.ry === plan.ry + 1)!;
        expect(roadCells(south).has(`${x0 + g.s.at},${y1 + 1}`)).toBe(true);
        paired++;
      }
    }
    expect(paired).toBeGreaterThan(40);
  });

  test("chunk data carries exactly the plan's development, so roads continue across chunk edges", () => {
    // A 9 x 6 chunk mosaic built from independently generated chunks.
    const cells = new Map<string, boolean>();
    let edgeRoads = 0;
    for (let cy = -3; cy < 3; cy++) {
      for (let cx = -4; cx < 5; cx++) {
        const plan = planRegion(SEED, Math.floor(cx / REGION_CHUNKS), Math.floor(cy / REGION_CHUNKS));
        const c = generateChunk(SEED, cx, cy, plan);
        for (let i = 0; i < CHUNK_CELLS; i++) {
          const lx = i % CHUNK, ly = Math.floor(i / CHUNK);
          const x = c.x0 + lx, y = c.y0 + ly;
          const pi = (y - plan.y0) * REGION + (x - plan.x0);
          const planRoad = !plan.empty && (plan.flags![pi]! & F_ROAD) !== 0;
          expect(roadAt(c, i, COMPLETE)).toBe(planRoad);
          if (!plan.empty && plan.flags![pi]) {
            expect(c.devBorn[i]).toBe(plan.born![pi]!);
            expect(c.devUpper[i]).toBe(plan.upper![pi]!);
            expect((c.flags[i]! & F_BLOCK) !== 0).toBe((plan.flags![pi]! & F_BLOCK) !== 0);
          } else {
            expect(c.devBorn[i]).toBe(NEVER);
          }
          cells.set(`${x},${y}`, roadAt(c, i, COMPLETE));
          if (planRoad && (lx === 0 || ly === 0 || lx === CHUNK - 1 || ly === CHUNK - 1)) edgeRoads++;
        }
      }
    }
    // Every road cell has a road neighbour in the mosaic, chunk edges included.
    let checked = 0;
    for (const [k, road] of cells) {
      if (!road) continue;
      const [x, y] = k.split(",").map(Number) as [number, number];
      const inner = [[1, 0], [-1, 0], [0, 1], [0, -1]].every(([dx, dy]) => cells.has(`${x + dx!},${y + dy!}`));
      if (!inner) continue;
      const n = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dx, dy]) => cells.get(`${x + dx!},${y + dy!}`)).length;
      expect(n).toBeGreaterThan(0);
      checked++;
    }
    expect(edgeRoads).toBeGreaterThan(10);
    expect(checked).toBeGreaterThan(500);
  });

  test("biome transitions agree across chunk edges with one large sampler", () => {
    const g = new BiomeGrid(SEED, -200, -200, 200, 200);
    const lookup = (x: number, y: number) => g.biome(x, y);
    let borders = 0;
    for (let cy = -4; cy < 4; cy++) for (let cx = -4; cx < 4; cx++) {
      const c = fresh(SEED, cx, cy);
      for (let i = 0; i < CHUNK_CELLS; i++) {
        const lx = i % CHUNK, ly = Math.floor(i / CHUNK);
        if (lx !== 0 && ly !== 0 && lx !== CHUNK - 1 && ly !== CHUNK - 1) continue;
        const x = c.x0 + lx, y = c.y0 + ly;
        expect(c.terrain[i]!).toBe(lookup(x, y) | (seamKindFrom(lookup, x, y) << 2));
        if (c.terrain[i]! >> 2) borders++;
      }
    }
    expect(borders).toBeGreaterThan(50);
  });

  test("neighbouring biomes are always neighbours in grow's cyclic order", () => {
    const g = new BiomeGrid(SEED, -600, -600, 600, 600);
    const pairs = new Set<string>();
    for (let y = -600; y < 600; y++) for (let x = -600; x < 600; x++) {
      const a = g.biome(x, y), b = g.biome(x + 1, y), c = g.biome(x, y + 1);
      for (const n of [b, c]) {
        if (n === a) continue;
        pairs.add(`${Math.min(a, n)}-${Math.max(a, n)}`);
        // B's seam art blends in (B + 3) % 4: the pair must be adjacent.
        expect((a + 1) % 4 === n || (n + 1) % 4 === a).toBe(true);
      }
    }
    expect(pairs.size).toBeGreaterThanOrEqual(3);
  });
});

describe("wander world: growth is a pure function of the growth tick", () => {
  test("roads come first, then houses, fields and residents; complete equals the plan", () => {
    let towns = 0;
    for (let ry = -2; ry <= 2; ry++) for (let rx = -2; rx <= 2; rx++) {
      const plan = planRegion(SEED, rx, ry);
      if (plan.empty || !plan.hub.town) continue;
      towns++;
      let firstRoad = Infinity, firstHouse = Infinity, lastRoadTrunk = 0;
      for (let i = 0; i < REGION * REGION; i++) {
        const f = plan.flags![i]!;
        if (!f) continue;
        if (f & F_ROAD) firstRoad = Math.min(firstRoad, plan.born![i]!);
        if ((f & F_BLOCK) && plan.upper![i]! >= 128) firstHouse = Math.min(firstHouse, plan.born![i]!);
        if (f & F_ROAD) lastRoadTrunk = Math.max(lastRoadTrunk, plan.born![i]!);
        expect(plan.born![i]!).toBeLessThan(plan.totalTicks);
      }
      expect(firstRoad).toBe(0);
      expect(firstHouse).toBeGreaterThan(firstRoad);
      expect(plan.villagers.length).toBeGreaterThan(0);
      for (const v of plan.villagers) expect(v.born).toBeGreaterThan(firstHouse);
      // Same plan twice: identical grids.
      const again = planRegion(SEED, rx, ry);
      expect(Buffer.from(again.born!).equals(Buffer.from(plan.born!))).toBe(true);
      expect(Buffer.from(again.upper!.buffer).equals(Buffer.from(plan.upper!.buffer))).toBe(true);
      // A chunk at growth tick k shows exactly the cells born <= k.
      const cx = Math.floor(plan.hub.x / CHUNK), cy = Math.floor(plan.hub.y / CHUNK);
      const c = generateChunk(SEED, cx, cy, plan);
      for (const k of [-1, 0, 3, 8, plan.totalTicks - 1, COMPLETE]) {
        for (let i = 0; i < CHUNK_CELLS; i++) {
          const born = c.devBorn[i]!;
          expect(groundAt(c, i, k) !== 0).toBe(c.devGround[i] !== 0 && born !== NEVER && k >= born);
        }
      }
    }
    expect(towns).toBeGreaterThan(8);
  });

  test("region hubs and towns are pure and jittered inside their region", () => {
    for (let ry = -5; ry <= 5; ry++) for (let rx = -5; rx <= 5; rx++) {
      const h = regionHub(SEED, rx, ry);
      expect(regionHub(SEED, rx, ry)).toEqual(h);
      expect(h.x - rx * REGION).toBeGreaterThanOrEqual(36);
      expect(h.x - rx * REGION).toBeLessThanOrEqual(60);
      expect(h.y - ry * REGION).toBeGreaterThanOrEqual(38);
      expect(h.y - ry * REGION).toBeLessThanOrEqual(58);
    }
  });
});
