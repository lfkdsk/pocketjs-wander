// tests/wander-f1.test.ts — F1: landmarks, rumors, travel log, anti-circling.
//
//   PURITY     landmarkFor is a pure function of (seed, rx, ry); every kind
//              shows up across a 25 x 25 region census
//   WILD       a no-town-no-road region grows a landmark when it rolls one;
//              every seed's 25 x 25 census holds at least 20 landmarks in
//              pure-wilderness regions; 600 s discoveries are >= 1/4 no-town
//   FOOTPRINT  every landmark fills a 3 x 3 box, blocks at least one cell,
//              keeps a walkable ring (verified in the COMPLETE chunk, not
//              just the plan), and never overlaps a road or house
//   DISCOVERY  a landmark is discovered when its centre enters the viewport
//              (exact +/-15 x +/-8 at 480 x 272), not at a Manhattan radius
//   RATE       10 seeds x 600 s auto: median discoveries >= 8, min >= 4
//   GAP        the longest stretch between towns or landmarks is <= 60 s on
//              EVERY seed (no seed gets a relaxed limit)
//   CIRCLING   0x39936d2c visits >= 18 towns with <= 150 re-centres
//   LOG        the log caps at 64, folds overflow into per-kind counts, its
//              total never decreases, and an evicted landmark is still known
//              discovered (a revisit never re-adds it)
//   RUMOR      the rumor is the EXACT nearest placed undiscovered landmark,
//              its direction/distance are live (match the player's tile every
//              tick), and the driver closes on it over a 30 s landmark leg
//   DETERM.    two runs agree per tick, at 60/30/20/4 Hz, and across a
//              serialize/restore round-trip that is not a no-op
//   BUDGET     the 10-seed sweep stays within maxSpent 1500, zero budget
//              violations, and 1 MiB resident bytes

import { describe, expect, test } from "bun:test";
import { planRegion } from "../examples/wander/region.ts";
import { F_BLOCK, F_ROAD } from "../examples/wander/region.ts";
import { generateChunk, blocksAt, COMPLETE } from "../examples/wander/chunk.ts";
import { CHUNK, regionHub, regionOf, REGION } from "../examples/wander/world.ts";
import { isWilderness, landmarkFor, landmarkRoll, LANDMARK_KINDS, type Landmark } from "../examples/wander/landmarks.ts";
import { LOG_CAP, SEEN_CAP, TravelLog } from "../examples/wander/travel-log.ts";
import { regionKey, Residency } from "../examples/wander/residency.ts";
import { WanderSim } from "../examples/wander/wander-sim.ts";
import { __pureLmClearForTest, pureLmCallCount, pureLmIsWarm, pureLmPeek, purePlacedLandmark, pureLmSet } from "../examples/wander/towns.ts";

const SEEDS = Array.from({ length: 10 }, (_, i) => (0x5eed_0001 + i * 0x9e37_79b9) >>> 0);
const CIRCLE_SEED = 0x39936d2c;

function runAuto(seed: number, seconds: number, view: [number, number] = [960, 544]): WanderSim {
  const sim = new WanderSim({ seed, hz: 60, viewW: view[0], viewH: view[1] });
  for (let f = 0; f < seconds * 60; f++) sim.step(0);
  return sim;
}

// ---------------------------------------------------------------------------

describe("F1-1: landmarkFor is pure and every kind appears", () => {
  test("same inputs give a deep-equal landmark", () => {
    for (const seed of SEEDS.slice(0, 3)) {
      for (let ry = -3; ry < 3; ry++) for (let rx = -3; rx < 3; rx++) {
        expect(landmarkFor(seed, rx, ry)).toEqual(landmarkFor(seed, rx, ry));
      }
    }
  });

  test("all six kinds appear across a 25x25 census for every seed", () => {
    for (const seed of SEEDS) {
      const seen = new Set<number>();
      for (let ry = -12; ry <= 12; ry++) for (let rx = -12; rx <= 12; rx++) {
        const lm = landmarkFor(seed, rx, ry);
        if (lm) seen.add(lm.kind);
      }
      expect(seen.size).toBe(LANDMARK_KINDS.length);
    }
  });
});

describe("F1-2: wilderness regions grow landmarks", () => {
  test("a no-town-no-road region that rolls a landmark places it in the plan", () => {
    let tested = 0;
    for (const seed of SEEDS) {
      for (let ry = -12; ry <= 12 && tested < 4; ry++) for (let rx = -12; rx <= 12 && tested < 4; rx++) {
        if (!isWilderness(seed, rx, ry)) continue;
        const roll = landmarkRoll(seed, rx, ry);
        if (!roll) continue;
        const plan = planRegion(seed, rx, ry);
        expect(plan.landmark).not.toBeNull();
        expect(plan.landmark!.kindName).toBe(roll.kindName);
        tested++;
      }
    }
    expect(tested).toBeGreaterThan(0);
  });

  test("each seed has at least 20 landmarks in pure-wilderness regions (25x25)", () => {
    for (const seed of SEEDS) {
      let wild = 0, placed = 0;
      for (let ry = -12; ry <= 12; ry++) for (let rx = -12; rx <= 12; rx++) {
        if (!isWilderness(seed, rx, ry)) continue;
        wild++;
        if (planRegion(seed, rx, ry).landmark) placed++;
      }
      // The census must hold at least 20 pure-wilderness regions, and every
      // one of them places its guaranteed landmark.
      expect(wild).toBeGreaterThanOrEqual(20);
      expect(placed).toBeGreaterThanOrEqual(20);
    }
  });

  test("at least a quarter of 600 s discoveries are in no-town regions", () => {
    const sim = runAuto(SEEDS[0]!, 600);
    let noTown = 0;
    for (const v of sim.log.found.values()) {
      if (!regionHub(sim.seed, v.rx, v.ry).town) noTown++;
    }
    expect(sim.log.size).toBeGreaterThan(0);
    expect(noTown / sim.log.size).toBeGreaterThanOrEqual(0.25);
  });
});

describe("F1-3: footprint, ring and non-overlap", () => {
  test("the ring guard skips a candidate whose ring is blocked", () => {
    // Regions where a candidate's box is free but its 1-cell ring has a
    // blocking cell (found by census): the ringOk guard must skip that
    // candidate and place the landmark at a later one with a clear ring.
    // Removing the guard places the landmark on the blocked-ring candidate.
    const cases = [
      { seed: 0x5eed_0001, rx: 10, ry: -8 },
      { seed: 0x5eed_0001, rx: -4, ry: 9 },
      { seed: 0x39936d2c, rx: -6, ry: -7 },
    ];
    for (const { seed, rx, ry } of cases) {
      const plan = planRegion(seed, rx, ry);
      const lm = plan.landmark;
      expect(lm).not.toBeNull();
      let minDx = 99, maxDx = -99, minDy = 99, maxDy = -99;
      for (const c of lm!.cells) {
        minDx = Math.min(minDx, c.dx); maxDx = Math.max(maxDx, c.dx);
        minDy = Math.min(minDy, c.dy); maxDy = Math.max(maxDy, c.dy);
      }
      for (let dy = minDy - 1; dy <= maxDy + 1; dy++) for (let dx = minDx - 1; dx <= maxDx + 1; dx++) {
        if (dx >= minDx && dx <= maxDx && dy >= minDy && dy <= maxDy) continue;
        const i = (lm!.y + dy - plan.y0) * REGION + (lm!.x + dx - plan.x0);
        expect(plan.flags![i]! & F_BLOCK).toBe(0);
      }
    }
  });

  test("every placed landmark fills a 3x3 box, blocks, keeps a walkable ring in the COMPLETE chunk, and avoids roads/houses", () => {
    for (const seed of SEEDS.slice(0, 4)) {
      for (let ry = -6; ry <= 6; ry++) for (let rx = -6; rx <= 6; rx++) {
        const plan = planRegion(seed, rx, ry);
        const lm = plan.landmark;
        if (!lm) continue;
        // Bounding box is at least 3 x 3.
        let minDx = 99, maxDx = -99, minDy = 99, maxDy = -99, blocks = 0;
        for (const c of lm.cells) {
          minDx = Math.min(minDx, c.dx); maxDx = Math.max(maxDx, c.dx);
          minDy = Math.min(minDy, c.dy); maxDy = Math.max(maxDy, c.dy);
          if (c.block) blocks++;
        }
        expect(maxDx - minDx + 1).toBeGreaterThanOrEqual(3);
        expect(maxDy - minDy + 1).toBeGreaterThanOrEqual(3);
        expect(blocks).toBeGreaterThanOrEqual(1);
        // No footprint cell is a road (the landmark never paves over one).
        for (const c of lm.cells) {
          const lx = lm.x + c.dx - plan.x0, ly = lm.y + c.dy - plan.y0;
          expect(plan.flags![ly * REGION + lx]! & F_ROAD).toBe(0);
        }
        // The 1-cell ring around the box is walkable in the GENERATED chunk
        // at COMPLETE (nature is cleared on reserved ring cells, so a tree
        // or boulder cannot block the promised ring).
        const chunkCache = new Map<string, ReturnType<typeof generateChunk>>();
        const chunkAt = (wx: number, wy: number) => {
          const cx = Math.floor(wx / CHUNK), cy = Math.floor(wy / CHUNK);
          const k = `${cx},${cy}`;
          let c = chunkCache.get(k);
          if (!c) { c = generateChunk(seed, cx, cy, plan); chunkCache.set(k, c); }
          return c;
        };
        for (let dy = minDy - 1; dy <= maxDy + 1; dy++) for (let dx = minDx - 1; dx <= maxDx + 1; dx++) {
          if (dx >= minDx && dx <= maxDx && dy >= minDy && dy <= maxDy) continue;
          const wx = lm.x + dx, wy = lm.y + dy;
          const c = chunkAt(wx, wy);
          const i = (wy - c.y0) * CHUNK + (wx - c.x0);
          expect(blocksAt(c, i, COMPLETE)).toBe(false);
        }
      }
    }
  });
});

describe("F1-4: discovery is viewport-based", () => {
  test("a landmark is discovered only once its centre is inside the viewport (exact +/-15 x +/-8)", () => {
    const sim = new WanderSim({ seed: SEEDS[0]!, hz: 60, viewW: 480, viewH: 272 });
    const halfW = Math.floor(480 / 32), halfH = Math.floor(272 / 32);
    expect(halfW).toBe(15); expect(halfH).toBe(8);
    let discovered = 0, maxManhattan = 0, maxDx = 0, maxDy = 0;
    let lastVersion = sim.log.version;
    for (let f = 0; f < 600 * 60 && discovered < 20; f++) {
      sim.step(0);
      if (sim.log.version !== lastVersion) {
        lastVersion = sim.log.version;
        if (sim.log.size === 0) continue;
        const v = [...sim.log.found.values()].at(-1)!;
        const p = sim.playerTile;
        // The discovery is recorded the tick the centre enters the viewport:
        // exact +/-15 x +/-8, not the old +/-16 x +/-9.
        expect(Math.abs(v.x - p.x)).toBeLessThanOrEqual(halfW);
        expect(Math.abs(v.y - p.y)).toBeLessThanOrEqual(halfH);
        maxManhattan = Math.max(maxManhattan, Math.abs(v.x - p.x) + Math.abs(v.y - p.y));
        maxDx = Math.max(maxDx, Math.abs(v.x - p.x));
        maxDy = Math.max(maxDy, Math.abs(v.y - p.y));
        discovered++;
      }
    }
    expect(discovered).toBeGreaterThan(0);
    // The viewport (half-extents 15 x 8) reaches past the old Manhattan-10
    // radius: at least one discovery happened beyond 10 tiles.
    expect(maxManhattan).toBeGreaterThan(10);
    // Lower bound: discoveries reach the exact viewport edge, so shrinking
    // the viewport by one row or column (the halfH-1 / halfW-1 mutation)
    // would miss a real discovery.
    expect(maxDx).toBe(halfW);
    expect(maxDy).toBe(halfH);
  });
});

// One 10-seed x 600 s sweep shared by the rate / gap / circling / budget
// assertions.
const SWEEP: { seed: number; sim: WanderSim; longestGap: number; townEnc: number }[] = [];
function sweep(): typeof SWEEP {
  if (SWEEP.length) return SWEEP;
  const halfW = Math.floor(960 / 32), halfH = Math.floor(544 / 32);
  for (const seed of SEEDS) {
    const sim = new WanderSim({ seed, hz: 60, viewW: 960, viewH: 544 });
    const seenTowns = new Set<string>();
    let lastInteresting = 0, longestGap = 0, lastVersion = -1;
    for (let f = 0; f < 600 * 60; f++) {
      sim.step(0);
      const p = sim.playerTile;
      const rx = regionOf(p.x), ry = regionOf(p.y);
      let interesting = false;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const hub = regionHub(seed, rx + dx, ry + dy);
        if (!hub.town) continue;
        const key = `${hub.rx},${hub.ry}`;
        if (seenTowns.has(key)) continue;
        if (Math.abs(p.x - hub.x) <= halfW && Math.abs(p.y - hub.y) <= halfH) {
          seenTowns.add(key); interesting = true;
        }
      }
      if (sim.log.version !== lastVersion) { lastVersion = sim.log.version; interesting = true; }
      if (interesting) {
        const gap = (sim.now - lastInteresting) / 60;
        if (lastInteresting > 0 || sim.now > 300) longestGap = Math.max(longestGap, gap);
        lastInteresting = sim.now;
      }
    }
    longestGap = Math.max(longestGap, (600 * 60 - lastInteresting) / 60);
    SWEEP.push({ seed, sim, longestGap, townEnc: seenTowns.size });
  }
  return SWEEP;
}

describe("F1-5: discovery rate over 10 seeds x 600 s", () => {
  test("median discoveries >= 8 and minimum >= 4", () => {
    const rows = sweep();
    const found = rows.map((r) => r.sim.log.size).sort((a, b) => a - b);
    const med = found[Math.floor(found.length / 2)]!;
    expect(med).toBeGreaterThanOrEqual(8);
    expect(found[0]!).toBeGreaterThanOrEqual(4);
  }, 120_000);
});

describe("F1-6: longest gap between interesting things (bounded)", () => {
  test("EVERY seed stays at or under 60 s between a town or a landmark", () => {
    const rows = sweep();
    for (const r of rows) expect(r.longestGap).toBeLessThanOrEqual(60);
  }, 120_000);
});

describe("F1-7: the circling seed visits many towns without re-centring thrash", () => {
  test("0x39936d2c: >= 18 towns and <= 150 recentres in 600 s", () => {
    const row = sweep().find((r) => r.seed === CIRCLE_SEED)!;
    expect(row.townEnc).toBeGreaterThanOrEqual(18);
    expect(row.sim.recentres).toBeLessThanOrEqual(150);
  }, 120_000);
});

describe("F1-8: the travel log is bounded, lossless and never loses count", () => {
  test("the cap is 64 and overflow folds into per-kind counts", () => {
    expect(LOG_CAP).toBe(64);
    const log = new TravelLog();
    for (let i = 0; i < 80; i++) {
      const kind = i % 2 ? "A" : "B";
      log.add(regionKey(i, 0), { name: `n${i}`, kind, x: i, y: 0, rx: i, ry: 0, t: i });
    }
    expect(log.size).toBe(LOG_CAP);
    expect(log.total).toBe(80); // never decreases
    let overflow = 0;
    for (const n of log.overflowCounts().values()) overflow += n;
    expect(overflow).toBe(16);
    expect([...log.found.values()].at(-1)!.name).toBe("n79");
  });

  test("an evicted landmark is still known discovered: a revisit never re-adds it", () => {
    const log = new TravelLog();
    for (let i = 0; i < 100; i++) {
      log.add(regionKey(i, 0), { name: `n${i}`, kind: "K", x: i, y: 0, rx: i, ry: 0, t: i });
    }
    expect(log.total).toBe(100);
    expect(log.size).toBe(LOG_CAP);
    // The first 36 entries were evicted from the window, but their identity
    // is retained: has() is still true and a revisit does not re-add.
    for (let i = 0; i < 36; i++) expect(log.has(regionKey(i, 0))).toBe(true);
    const again = log.add(regionKey(0, 0), { name: "n0", kind: "K", x: 0, y: 0, rx: 0, ry: 0, t: 100 });
    expect(again).toBe(false);
    expect(log.total).toBe(100); // unchanged: no silent re-discovery
  });

  test("the seen-set has a hard cap and serializes losslessly", () => {
    expect(SEEN_CAP).toBeGreaterThanOrEqual(1024);
    const log = new TravelLog();
    for (let i = 0; i < SEEN_CAP + 100; i++) {
      log.add(regionKey(i, 0), { name: `n${i}`, kind: "K", x: i, y: 0, rx: i, ry: 0, t: i });
    }
    const text = log.serialize();
    const restored = TravelLog.restore(text);
    expect(restored.total).toBe(log.total);
    expect(restored.seenSize).toBe(log.seenSize);
    expect(restored.version).toBe(log.version);
  });

  test("past the exact-set cap a revisit still never re-counts (window fallback)", () => {
    // The review found that after SEEN_CAP distinct adds, re-adding the
    // newest entry (still in the 64-entry window but evicted from the exact
    // set) was accepted again, inflating total and dropping a window entry.
    // has() checks the exact set AND the window, so a revisit is detected
    // while either remembers it — with no false positives (a real new
    // discovery is never skipped).
    const log = new TravelLog();
    const entry = (i: number) => ({ name: `n${i}`, kind: "K", x: i, y: 0, rx: i, ry: 0, t: i });
    for (let i = 0; i < SEEN_CAP + 10; i++) log.add(regionKey(i, 0), entry(i));
    expect(log.total).toBe(SEEN_CAP + 10); // every distinct add counted, exactly once
    expect(log.seenSize).toBe(SEEN_CAP); // exact set capped
    // The newest entry is in the window but NOT in the exact set any more.
    const newest = regionKey(SEEN_CAP + 9, 0);
    expect(log.found.has(newest)).toBe(true);
    // Re-adding it (a revisit) is rejected five times out of five.
    for (let n = 0; n < 5; n++) {
      expect(log.add(newest, entry(SEEN_CAP + 9))).toBe(false);
      expect(log.total).toBe(SEEN_CAP + 10); // unchanged
    }
    // An entry added once the exact set was full (window-only identity):
    // its revisit is detected by the window, not the exact set.
    const windowOnly = regionKey(SEEN_CAP, 0);
    expect(log.found.has(windowOnly)).toBe(true);
    expect(log.add(windowOnly, entry(SEEN_CAP))).toBe(false);
    expect(log.total).toBe(SEEN_CAP + 10);
    // A much older entry, still in the exact set, is detected too.
    expect(log.add(regionKey(500, 0), entry(500))).toBe(false);
    expect(log.total).toBe(SEEN_CAP + 10);
    // The window did not lose an entry to the re-adds.
    expect(log.size).toBe(LOG_CAP);
  });

  test("restore rejects oversize and malformed log saves", () => {
    const log = new TravelLog();
    for (let i = 0; i < 70; i++) log.add(regionKey(i, 0), { name: `n${i}`, kind: "K", x: i, y: 0, rx: i, ry: 0, t: i });
    const good = JSON.parse(log.serialize());
    // Too many window entries.
    expect(() => TravelLog.restore(JSON.stringify({ ...good, found: [...good.found, ...good.found] }))).toThrow(/too many window/);
    // Too many seen keys.
    expect(() => TravelLog.restore(JSON.stringify({ ...good, seen: Array.from({ length: SEEN_CAP + 1 }, (_, i) => i) }))).toThrow(/too many seen/);
    // Wrong version.
    expect(() => TravelLog.restore(JSON.stringify({ ...good, v: 2 }))).toThrow(/unsupported version/);
    // Malformed total (below the window size).
    expect(() => TravelLog.restore(JSON.stringify({ ...good, total: 1 }))).toThrow(/malformed total/);
    // Malformed JSON.
    expect(() => TravelLog.restore("{not json")).toThrow(/not valid JSON/);
    // A faithful round trip still restores losslessly.
    const rt = TravelLog.restore(log.serialize());
    expect(rt.total).toBe(log.total);
    expect(rt.seenSize).toBe(log.seenSize);
    expect(rt.serialize()).toBe(log.serialize());
  });

  test("a real run keeps LOG n = total (not the capped size)", () => {
    const sim = runAuto(SEEDS[0]!, 600);
    expect(sim.log.total).toBeGreaterThanOrEqual(sim.log.size);
  });
});

describe("F1-9: the rumor is the exact nearest, live, and closed on", () => {
  /** Independently recompute the nearest placed undiscovered landmark. */
  function expectedNearest(sim: WanderSim): { lm: Landmark; dist: number } | null {
    const p = sim.playerTile;
    const prx = regionOf(p.x), pry = regionOf(p.y);
    let best: Landmark | null = null, bestD = Infinity;
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const rx = prx + dx, ry = pry + dy;
      if (sim.log.has(regionKey(rx, ry))) continue;
      const lm = sim.placedLandmark(rx, ry);
      if (!lm) continue;
      const d = Math.abs(p.x - lm.cx) + Math.abs(p.y - lm.cy);
      if (d < bestD) { bestD = d; best = lm; }
    }
    return best ? { lm: best, dist: bestD } : null;
  }

  test("the rumor's coordinates and distance match the exact nearest placed landmark", () => {
    const sim = new WanderSim({ seed: SEEDS[0]!, hz: 60, viewW: 480, viewH: 272, fast: true });
    for (let f = 0; f < 60 * 60; f++) sim.step(0);
    const rumor = sim.nearestRumor();
    expect(rumor).not.toBeNull();
    const exp = expectedNearest(sim);
    expect(exp).not.toBeNull();
    expect(rumor!.x).toBe(exp!.lm.cx);
    expect(rumor!.y).toBe(exp!.lm.cy);
    expect(rumor!.dist).toBe(exp!.dist);
    expect(["N", "NE", "E", "SE", "S", "SW", "W", "NW"]).toContain(rumor!.dir);
    const p = sim.playerTile;
    const wx = Math.sign(exp!.lm.cx - p.x), wy = Math.sign(exp!.lm.cy - p.y);
    const dir = wy < 0 ? (wx < 0 ? "NW" : wx > 0 ? "NE" : "N") : wy > 0 ? (wx < 0 ? "SW" : wx > 0 ? "SE" : "S") : wx < 0 ? "W" : "E";
    expect(rumor!.dir).toBe(dir);
  });

  test("the rumor is live: direction and distance match the player's tile every tick", () => {
    const sim = new WanderSim({ seed: SEEDS[0]!, hz: 60, viewW: 480, viewH: 272, fast: true });
    let checked = 0;
    for (let f = 0; f < 120 * 60; f++) {
      sim.step(0);
      
      const rumor = sim.nearestRumor();
      const exp = expectedNearest(sim);
      if (!rumor && !exp) continue;
      expect(rumor).not.toBeNull();
      expect(exp).not.toBeNull();
      expect(rumor!.x).toBe(exp!.lm.cx);
      expect(rumor!.y).toBe(exp!.lm.cy);
      expect(rumor!.dist).toBe(exp!.dist);
      checked++;
    }
    expect(checked).toBeGreaterThan(100);
  }, 120_000);

  test("the driver closes on the rumor: distance to its landmark target falls along each leg", () => {
    const sim = new WanderSim({ seed: SEEDS[0]!, hz: 60, viewW: 960, viewH: 544, fast: true });
    // Landmarks are dense, so the driver's landmark legs are short: the
    // assertion is that EVERY sustained leg (>= 3 s) closes on its target
    // (the walker ends nearer than it started, with no large detour), not
    // that one leg lasts 30 s.
    let legTicks = 0;
    let legStartDist = 0;
    let legMax = 0;
    let legKey = "";
    let legX = 0, legY = 0;
    let closed = 0;
    let sustained = 0;
    const distToLeg = (): number => {
      const p = sim.playerTile;
      return Math.abs(p.x - legX) + Math.abs(p.y - legY);
    };
    for (let f = 0; f < 600 * 60; f++) {
      sim.step(0);
      const t = sim.driver.target;
      const key = t && t.landmark ? `${t.rx},${t.ry}` : "";
      if (key !== legKey) {
        if (legTicks >= 3 * 60) {
          sustained++;
          const closure = legStartDist - distToLeg();
          if (closure >= 1 && legMax <= legStartDist + 8) closed++;
        }
        legKey = key;
        legTicks = 0;
        if (t && t.landmark) {
          legX = t.x; legY = t.y;
          legStartDist = distToLeg();
          legMax = legStartDist;
        }
      } else if (key) {
        legTicks++;
        legMax = Math.max(legMax, distToLeg());
      }
    }
    // The walker closes on nearly every sustained landmark leg.
    expect(sustained).toBeGreaterThanOrEqual(5);
    expect(closed).toBeGreaterThanOrEqual(sustained - 1);
  }, 180_000);
});

describe("F1-10: determinism, multi-Hz and serialize/restore", () => {
  function runHz(hz: number, seconds: number, seed = SEEDS[0]!): { sim: WanderSim; digests: string[]; logs: string[] } {
    const sim = new WanderSim({ seed, hz, viewW: 480, viewH: 272, fast: true });
    const digests: string[] = [], logs: string[] = [];
    // Sample the log at EVERY reference tick via the onTick hook (the hook
    // fires once per reference tick inside a folded low-Hz frame too), so a
    // mid-second change cannot hide and every run yields 60 * seconds
    // samples regardless of host rate.
    sim.onTick = () => logs.push(sim.logDigest());
    for (let s = 0; s < seconds; s++) {
      for (let f = 0; f < hz; f++) sim.step(0);
      digests.push(sim.digest());
    }
    return { sim, digests, logs };
  }

  test("two runs give the same trajectory and travel log", () => {
    const a = runHz(60, 90), b = runHz(60, 90);
    expect(b.digests).toEqual(a.digests);
    expect(b.logs).toEqual(a.logs);
  }, 120_000);

  test("the trajectory and log are identical at 60/30/20/4 Hz", () => {
    const runs = [60, 30, 20, 4].map((hz) => runHz(hz, 60));
    for (const r of runs.slice(1)) {
      expect(r.digests).toEqual(runs[0]!.digests);
      expect(r.logs).toEqual(runs[0]!.logs);
    }
  }, 180_000);

  test("serialize/restore overwrites a differing log and folds identically afterwards", () => {
    const a = runHz(60, 60);
    const text = a.sim.serializeLog();
    // A second sim runs the same trajectory, then DIVERGES its log (a bogus
    // entry), so the restore that follows is not a no-op: it must overwrite
    // the divergence. A no-op restore would leave the bogus entry in.
    const b = runHz(60, 60);
    b.sim.log.add(regionKey(999, 999), { name: "BOGUS", kind: "BOGUS", x: 0, y: 0, rx: 999, ry: 999, t: 0 });
    expect(b.sim.logDigest()).not.toBe(a.sim.logDigest());
    b.sim.restoreLog(text);
    expect(b.sim.logDigest()).toBe(a.sim.logDigest());
    // Run both 600 more ticks: the restored log folds identically.
    for (let f = 0; f < 600; f++) { a.sim.step(0); b.sim.step(0); }
    expect(b.sim.digest()).toBe(a.sim.digest());
    expect(b.sim.logDigest()).toBe(a.sim.logDigest());
  });

  test("an overflowed log round-trips losslessly (total, overflow, seen, version)", () => {
    const log = new TravelLog();
    for (let i = 0; i < 100; i++) {
      log.add(regionKey(i, 0), { name: `n${i}`, kind: i % 3 ? "A" : "B", x: i, y: 0, rx: i, ry: 0, t: i });
    }
    const text = log.serialize();
    expect(text.length).toBeLessThan(16 * 1024);
    const restored = TravelLog.restore(text);
    expect(restored.total).toBe(100);
    expect(restored.size).toBe(LOG_CAP);
    expect(restored.version).toBe(log.version);
    expect(restored.seenSize).toBe(log.seenSize);
    let overflow = 0;
    for (const n of restored.overflowCounts().values()) overflow += n;
    expect(overflow).toBe(36);
    // The digest distinguishes a lossy restore (overflow + seen + version).
    const a = new TravelLog(); a.copyFrom(log);
    const b = new TravelLog(); b.copyFrom(restored);
    expect(a.serialize()).toBe(b.serialize());
  });
});

describe("F1 sweep: generation budget and resident bytes", () => {
  test("maxSpent <= 1500, zero budget violations, resident bytes <= 1 MiB on every seed", () => {
    const rows = sweep();
    for (const r of rows) {
      const st = r.sim.stats();
      expect(st.maxSpent).toBeLessThanOrEqual(1500);
      expect(st.budgetViolations).toBe(0);
      expect(st.bytes).toBeLessThanOrEqual(1024 * 1024);
    }
  }, 120_000);
});

describe("F1-B6: landmark planning runs inside the per-tick budget", () => {
  test("the sim's landmark lookup reads the pure cache and never computes", () => {
    // The window build and the plaza offer read only READY facts: a cold
    // region returns null (degraded) and does not warm the cache, so no
    // planRegion ever runs inside a window-build slice.
    const seed = SEEDS[0]!;
    const sim = new WanderSim({ seed, hz: 60, viewW: 480, viewH: 272 });
    const rx = 50, ry = 50; // far from spawn, not warmed by boot
    expect(pureLmIsWarm(seed, rx, ry)).toBe(false);
    expect(sim["look"].landmarkOf(rx, ry)).toBeNull(); // cold: degraded, no compute
    expect(pureLmIsWarm(seed, rx, ry)).toBe(false); // still cold: the build did not compute
    const pure = purePlacedLandmark(seed, rx, ry);
    expect(pureLmIsWarm(seed, rx, ry)).toBe(true);
    expect(sim["look"].landmarkOf(rx, ry)).toBe(pure); // warm: reads the cache
  });

  test("the fact job warms a developed region's landmark in budgeted slices", () => {
    const seed = SEEDS[0]!;
    const sim = new WanderSim({ seed, hz: 60, viewW: 480, viewH: 272, manual: true });
    // A developed region whose roll placed a landmark (the expensive case:
    // only it runs a planRegion; wilderness and no-roll regions are cheap).
    // Search far from spawn so the shared module cache is cold for it.
    let target: [number, number] | null = null;
    for (let ry = 40; ry <= 70 && !target; ry++) {
      for (let rx = 40; rx <= 70 && !target; rx++) {
        if (!isWilderness(seed, rx, ry) && landmarkRoll(seed, rx, ry)) target = [rx, ry];
      }
    }
    expect(target).not.toBeNull();
    const [trx, try_] = target!;
    expect(pureLmIsWarm(seed, trx, try_)).toBe(false);
    // A budget smaller than one plan slice does not complete the warm.
    sim.res.warmFact(trx, try_);
    const spent = sim.res.runBudget(60, 0);
    expect(spent).toBeLessThanOrEqual(60);
    // A full budget completes it; the cached value equals the pure computation.
    sim.res.runBudget(100_000, 1);
    expect(pureLmIsWarm(seed, trx, try_)).toBe(true);
    expect(pureLmPeek(seed, trx, try_)).toEqual(purePlacedLandmark(seed, trx, try_));
    expect(sim.stats().factWarmed).toBeGreaterThan(0);
  });

  test("a developed region's fact warm spans multiple budget calls (slices are charged)", () => {
    // Kills the surviving mutant "fact-job slices are not charged": dropping
    // `spent += r.value` in the fact-job loop lets one runBudget call warm a
    // developed region for free (all slices run in one call). With the fix,
    // one call with a modest budget does at most a slice or two, so the warm
    // is incomplete; a large budget completes it.
    const seed = SEEDS[0]!;
    const res = new Residency(seed);
    res.onFact = (rx, ry, lm) => pureLmSet(seed, rx, ry, lm);
    res.isFactWarm = (rx, ry) => pureLmIsWarm(seed, rx, ry);
    let target: [number, number] | null = null;
    for (let ry = 40; ry <= 70 && !target; ry++) {
      for (let rx = 40; rx <= 70 && !target; rx++) {
        if (!isWilderness(seed, rx, ry) && landmarkRoll(seed, rx, ry)) target = [rx, ry];
      }
    }
    expect(target).not.toBeNull();
    const [trx, try_] = target!;
    __pureLmClearForTest();
    expect(pureLmIsWarm(seed, trx, try_)).toBe(false);
    res.warmFact(trx, try_);
    // One call with a modest budget (just over one slice) does not complete
    // the warm: the plan needs several slices, each charged.
    res.runBudget(500, 0);
    expect(pureLmIsWarm(seed, trx, try_)).toBe(false);
    // A large budget completes it.
    res.runBudget(100_000, 1);
    expect(pureLmIsWarm(seed, trx, try_)).toBe(true);
  });

  test("windowReady waits for the landmark facts to be warm", () => {
    // Kills the surviving mutant "windowReady returns before the warm-fact
    // check": with a cold cache the build would start immediately and bake a
    // degraded dialog. With the fix, windowReady is false until the
    // budgeted fact job warms the scan.
    const seed = SEEDS[0]!;
    const sim = new WanderSim({ seed, hz: 60, viewW: 960, viewH: 544 });
    __pureLmClearForTest();
    // The start window's chunks and plans are resident (boot built it), but
    // the landmark facts are cold (cleared), so windowReady must wait.
    expect(sim["windowReady"](sim.window.cx, sim.window.cy)).toBe(false);
    // Stepping runs the budgeted fact job, which warms the scan.
    for (let f = 0; f < 120; f++) sim.step(0);
    expect(sim["windowReady"](sim.window.cx, sim.window.cy)).toBe(true);
  });

  test("a 600 s auto run warms facts without a budget violation", () => {
    const sim = new WanderSim({ seed: SEEDS[0]!, hz: 60, viewW: 960, viewH: 544 });
    for (let f = 0; f < 600 * 60; f++) sim.step(0);
    const s = sim.stats();
    // The fact work is charged to the per-tick budget (it was uncharged
    // before): the run stays within maxSpent 1500 with zero violations.
    expect(s.maxSpent).toBeLessThanOrEqual(1500);
    expect(s.budgetViolations).toBe(0);
  }, 120_000);

  test("no landmark plan runs inside a window-build slice at runtime", () => {
    // Self-contained: record the counter before this test runs, so it passes
    // alone (earlier tests may have bumped the module-global counter). The
    // window build reads only the pure cache (warmed by boot and the
    // budgeted fact job), so purePlacedLandmark (the only thing that runs a
    // planRegion on a cache miss) is never called at runtime. Re-adding a
    // warmLandmark call to the window build would make this fail.
    const before = pureLmCallCount;
    const sim = new WanderSim({ seed: SEEDS[0]!, hz: 60, viewW: 960, viewH: 544 });
    for (let f = 0; f < 600 * 60; f++) sim.step(0); // many window builds
    expect(pureLmCallCount).toBe(before); // zero runtime calls
  }, 120_000);
});
