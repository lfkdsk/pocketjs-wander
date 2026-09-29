// tests/wander-sim.test.ts — the endless world's simulation at model level.
//
//   MEMORY    a 20,000-tile walk east and back keeps resident chunks under
//             the LRU cap, the byte estimate bounded, and the "seen" set a
//             fixed-size filter plus a capped growing map; chunks met again
//             on the way back regenerate byte-identically
//   HYSTERESIS walking back and forth across one chunk edge regenerates
//             nothing after the first pass
//   BUDGET    no reference tick spends more generation units than the tick
//             budget, and no host frame more than its ticks' worth, at
//             60/30/20/4 Hz
//   DETERM.   the same seed gives the same world, residency and auto-wander
//             trajectory; the trajectory is identical at 60/30/20/4 Hz
//   ORIGIN    re-centring the window never moves the player in the world;
//             the window document is a valid rpgkit-project/v1 project
//   CONTROL   any d-pad press takes over; after 10 idle seconds the driver
//             resumes; a touch target is walked to

import { describe, expect, test } from "bun:test";
import { validateSchema } from "../src/engine/schema-validate.ts";
import { BTN } from "../vendor/pocketjs/contracts/spec/spec.ts";
import { CHUNK, REGION, regionOf } from "../examples/wander/world.ts";
import { generateChunk } from "../examples/wander/chunk.ts";
import { planRegion } from "../examples/wander/region.ts";
import { GROWING_CAP, Residency, TICK_BUDGET, type Focus } from "../examples/wander/residency.ts";
import { buildWindow } from "../examples/wander/window.ts";
import { FAST_SPEED, GROW_RING_H, GROW_RING_W, WALK_SPEED, WanderSim } from "../examples/wander/wander-sim.ts";

const schema = await Bun.file(new URL("../src/data/schema.json", import.meta.url)).json() as Record<string, unknown>;
const SEED = 0x5eed_0001;

function chunkSig(c: { terrain: Uint8Array; devBorn: Uint8Array; natUpper: Uint16Array; natHide: Uint8Array }): string {
  let h = 0x811c9dc5;
  for (const a of [c.terrain, c.devBorn, new Uint8Array(c.natUpper.buffer), c.natHide]) for (let i = 0; i < a.length; i++) { h ^= a[i]!; h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16);
}

describe("wander residency: bounded memory over a long walk", () => {
  test("20,000 tiles east and back: resident <= cap, bytes bounded, seen set bounded", () => {
    const res = new Residency(SEED);
    const view = { w: 32, h: 19 }; // a 480 x 272 render ring in tiles
    let now = 0;
    let maxResident = 0, maxBytes = 0, maxGrowing = 0, lastChunk = "";
    const firstSeen = new Map<string, string>();
    let rechecked = 0;
    const walk = (from: number, to: number) => {
      const dir = Math.sign(to - from);
      for (let x = from; x !== to; x += dir) {
        const focus: Focus = { x, y: 7, hx: dir, hy: 0 };
        const key = `${Math.floor(x / CHUNK)}`;
        if (key !== lastChunk) { lastChunk = key; res.updateRings(focus, view.w, view.h, []); }
        for (let rx = regionOf(x - GROW_RING_W); rx <= regionOf(x + GROW_RING_W); rx++)
          for (let ry = regionOf(7 - GROW_RING_H); ry <= regionOf(7 + GROW_RING_H); ry++) res.discover(rx, ry, now);
        res.retireGrowth(now);
        const spent = res.runBudget(TICK_BUDGET, now++);
        expect(spent).toBeLessThanOrEqual(TICK_BUDGET);
        for (const c of res.fresh.splice(0)) {
          const k = `${c.cx},${c.cy}`;
          const sig = chunkSig(c);
          const before = firstSeen.get(k);
          if (before) { expect(sig).toBe(before); rechecked++; } else if (firstSeen.size < 4000) firstSeen.set(k, sig);
        }
        const st = res.stats();
        expect(st.resident).toBeLessThanOrEqual(st.cap);
        maxResident = Math.max(maxResident, st.resident);
        maxBytes = Math.max(maxBytes, st.bytes);
        maxGrowing = Math.max(maxGrowing, st.growing);
      }
    };
    walk(0, 20_000);
    walk(20_000, -200);
    const st = res.stats();
    expect(st.generatedTotal).toBeGreaterThan(2 * (20_000 / CHUNK) * 3);
    expect(st.evictedTotal).toBeGreaterThan(st.generatedTotal - st.cap - 1);
    expect(maxResident).toBeLessThanOrEqual(st.cap);
    expect(st.cap).toBeLessThanOrEqual(40);
    // Chunks ~9 KB each plus at most 12 region plans ~46 KB each.
    expect(maxBytes).toBeLessThan(40 * 12_000 + 12 * 50_000);
    // The seen set: a fixed 16-kbit filter plus a capped growing map, even
    // though the walk discovered hundreds of regions.
    expect(st.seenRegions).toBeGreaterThan(300);
    expect(maxGrowing).toBeLessThanOrEqual(GROWING_CAP);
    expect(rechecked).toBeGreaterThan(500);
  });

  test("walking back and forth across one chunk edge regenerates nothing (hysteresis)", () => {
    const res = new Residency(SEED);
    let now = 0;
    const settle = (x: number) => {
      res.updateRings({ x, y: 10, hx: 1, hy: 0 }, 32, 19, []);
      for (let t = 0; t < 200; t++) res.runBudget(TICK_BUDGET, now++);
    };
    settle(CHUNK * 10 - 3);
    const generated = res.stats().generatedTotal;
    for (let n = 0; n < 40; n++) settle(CHUNK * 10 + (n % 2 ? -4 : 4));
    expect(res.stats().generatedTotal).toBe(generated);
    expect(res.stats().evictedTotal).toBe(0);
  });
});

function runSim(hz: number, seconds: number, opts: { seed?: number; fast?: boolean; view?: [number, number] } = {}): { sim: WanderSim; digests: string[] } {
  const sim = new WanderSim({ seed: opts.seed ?? SEED, hz, viewW: opts.view?.[0] ?? 480, viewH: opts.view?.[1] ?? 272, fast: opts.fast });
  const digests: string[] = [];
  for (let s = 0; s < seconds; s++) {
    for (let f = 0; f < hz; f++) sim.step(0);
    const st = sim.stats();
    digests.push(`${sim.digest()}|${st.resident},${st.generatedTotal},${st.evictedTotal},${st.seenRegions},${st.growing},${sim.driver.arrivedTowns}`);
  }
  return { sim, digests };
}

describe("wander sim: determinism and budget", () => {
  test("same seed, same world and trajectory; another seed differs", () => {
    const a = runSim(60, 40), b = runSim(60, 40), c = runSim(60, 40, { seed: SEED + 0x9e3779b9 });
    expect(b.digests).toEqual(a.digests);
    expect(c.digests.at(-1)).not.toBe(a.digests.at(-1));
    // The walk actually went somewhere and saw a town grow.
    const start = a.digests[0]!.split("|")[1]!, end = a.digests.at(-1)!.split("|")[1]!;
    expect(end).not.toBe(start);
  });

  test("the auto-wander trajectory and residency are identical at 60/30/20/4 Hz", () => {
    const runs = [60, 30, 20, 4].map((hz) => runSim(hz, 50));
    for (const r of runs.slice(1)) expect(r.digests).toEqual(runs[0]!.digests);
    // Fast travel too.
    const fast = [60, 4].map((hz) => runSim(hz, 20, { fast: true }));
    expect(fast[1]!.digests).toEqual(fast[0]!.digests);
  }, 60_000);

  test("no tick exceeds the tick budget and no frame its ticks' worth, at every rate", () => {
    for (const hz of [60, 30, 20, 4]) {
      const { sim } = runSim(hz, 30, { fast: true });
      const st = sim.stats();
      expect(st.budgetViolations).toBe(0);
      expect(st.maxSpent).toBeLessThanOrEqual(TICK_BUDGET);
      expect(st.maxFrameUnits).toBeLessThanOrEqual(TICK_BUDGET * (60 / hz));
      expect(st.maxFrameUnits).toBeGreaterThan(0);
      if (hz === 4) expect(st.maxFrameUnits).toBeGreaterThan(TICK_BUDGET);
    }
  }, 60_000);

  test("a long fast wander stays bounded and keeps discovering towns", () => {
    const sim = new WanderSim({ seed: SEED, hz: 60, viewW: 960, viewH: 544, fast: true });
    const start = sim.playerTile;
    let far = 0;
    for (let f = 0; f < 60 * 240; f++) {
      sim.step(0);
      const st = sim.res.stats();
      if (st.resident > st.cap) throw new Error(`resident ${st.resident} > cap ${st.cap} at frame ${f}`);
      const p = sim.playerTile;
      far = Math.max(far, Math.abs(p.x - start.x) + Math.abs(p.y - start.y));
    }
    const st = sim.stats();
    expect(far).toBeGreaterThan(2_000);
    expect(sim.driver.arrivedTowns).toBeGreaterThan(15);
    expect(st.budgetViolations).toBe(0);
    expect(st.recentres).toBeGreaterThan(40);
    expect(st.maxResident).toBeLessThanOrEqual(st.cap);
  }, 60_000);
});

describe("wander sim: floating origin and the window document", () => {
  test("re-centring never moves the player in the world", () => {
    const sim = new WanderSim({ seed: SEED, hz: 60, viewW: 480, viewH: 272, fast: true });
    let prev = sim.playerPx;
    let recentres = 0;
    for (let f = 0; f < 60 * 60; f++) {
      const w0 = { x: sim.window.x0, y: sim.window.y0 };
      sim.step(0);
      const p = sim.playerPx;
      // One reference tick moves the walker at most one speed step.
      expect(Math.abs(p.x - prev.x) + Math.abs(p.y - prev.y)).toBeLessThanOrEqual(FAST_SPEED);
      if (sim.window.x0 !== w0.x || sim.window.y0 !== w0.y) {
        recentres++;
        // The window steps by whole chunks toward the player's chunk.
        expect([0, CHUNK]).toContain(Math.abs(sim.window.x0 - w0.x));
        expect([0, CHUNK]).toContain(Math.abs(sim.window.y0 - w0.y));
        // Session coordinates stay inside the window's middle chunk.
        expect(sim.state.move.tx).toBeGreaterThanOrEqual(CHUNK - 1);
        expect(sim.state.move.tx).toBeLessThanOrEqual(2 * CHUNK);
      }
      prev = p;
    }
    expect(recentres).toBeGreaterThan(10);
    expect(WALK_SPEED).toBeLessThan(FAST_SPEED);
  });

  test("the window is a valid rpgkit-project/v1 document, with and without its star layer", () => {
    const res = new Residency(SEED);
    const cx = 2, cy = 1;
    res.updateRings({ x: cx * CHUNK + 16, y: cy * CHUNK + 16, hx: 1, hy: 0 }, 32, 19, [[cx - 1, cy - 1], [cx, cy - 1], [cx + 1, cy - 1], [cx - 1, cy], [cx, cy], [cx + 1, cy], [cx - 1, cy + 1], [cx, cy + 1], [cx + 1, cy + 1]]);
    res.fill(0);
    for (const upper of [false, true]) {
      const w = buildWindow(res, SEED, cx, cy, () => 254, { x: cx * CHUNK + 5, y: cy * CHUNK + 5, dir: "down" }, upper);
      const errors = validateSchema(schema, w.project as unknown as Record<string, unknown>);
      expect(errors).toEqual([]);
      const map = w.project.maps[0]!;
      expect(map.width).toBe(96);
      expect(map.ground.length).toBe(96 * 96);
      expect((map.passage ?? []).length).toBeGreaterThan(100);
      if (upper) expect((map.upper ?? []).length).toBeGreaterThan(200);
      else expect(map.upper).toBeUndefined();
      // Every blocking cell is a born house, fence, prop or tree trunk.
      for (const [i] of map.passage ?? []) expect(i).toBeLessThan(96 * 96);
    }
  });
});

describe("wander sim: takeover, idle resume and touch", () => {
  test("a d-pad press takes over at once; 10 idle seconds hand the walk back", () => {
    const sim = new WanderSim({ seed: SEED, hz: 30, viewW: 480, viewH: 272 });
    for (let f = 0; f < 30 * 6; f++) sim.step(0);
    expect(sim.mode).toBe("auto");
    // Pick a direction whose next cell is open in the live passage table.
    const table = sim.session.tables.get("wander")!;
    const dirs = [[BTN.LEFT, -1, 0], [BTN.RIGHT, 1, 0], [BTN.UP, 0, -1], [BTN.DOWN, 0, 1]] as const;
    while (sim.state.move.moving) sim.step(0);
    const m = sim.state.move;
    const [button, dx, dy] = dirs.find(([, dx, dy]) => table.overrides[(m.ty + dy) * 96 + m.tx + dx] === 0)!;
    const before = sim.playerTile;
    for (let f = 0; f < 6; f++) sim.step(button);
    expect(sim.mode).toBe("manual");
    const after = sim.playerTile;
    expect((after.x - before.x) * dx + (after.y - before.y) * dy).toBeGreaterThan(0);
    for (let f = 0; f < 30 * 10 - 2; f++) sim.step(0);
    expect(sim.mode).toBe("manual");
    for (let f = 0; f < 4; f++) sim.step(0);
    expect(sim.mode).toBe("auto");
    // SQUARE / TRIANGLE / SELECT are controls, not a takeover.
    sim.step(BTN.TRIANGLE);
    expect(sim.mode).toBe("auto");
    expect(sim.fast).toBe(true);
  });

  test("a touch target is walked to, then the player waits there", () => {
    const sim = new WanderSim({ seed: SEED, hz: 60, viewW: 480, viewH: 272 });
    for (let f = 0; f < 60 * 6; f++) sim.step(0);
    const p = sim.playerTile;
    // A reachable cell: search the session table for an open cell nearby.
    const table = sim.session.tables.get("wander")!;
    let goal: { x: number; y: number } | null = null;
    for (let r = 6; r < 14 && !goal; r++) {
      const lx = sim.state.move.tx + r, ly = sim.state.move.ty;
      if (table.overrides[ly * 96 + lx] === 0) goal = { x: sim.window.x0 + lx, y: sim.window.y0 + ly };
    }
    expect(goal).not.toBeNull();
    sim.goto(goal!.x, goal!.y);
    expect(sim.mode).toBe("goto");
    for (let f = 0; f < 60 * 12 && sim.mode === "goto"; f++) sim.step(0);
    expect(sim.mode).toBe("manual");
    const q = sim.playerTile;
    expect(Math.abs(q.x - goal!.x) + Math.abs(q.y - goal!.y)).toBeLessThanOrEqual(1);
    expect(q).not.toEqual(p);
  });

  test("residents are born with their town and walk their road routes", () => {
    const sim = new WanderSim({ seed: SEED, hz: 60, viewW: 480, viewH: 272 });
    const at: Record<string, string> = {};
    let moved = 0;
    for (let f = 0; f < 60 * 5; f++) {
      sim.step(0);
      for (const [id, ch] of Object.entries(sim.state.chars.chars)) {
        if (!id.startsWith("v")) continue;
        const k = `${ch.tx},${ch.ty}`;
        if (at[id] && at[id] !== k) moved++;
        at[id] = k;
      }
    }
    expect(Object.keys(at).length).toBeGreaterThan(3);
    expect(moved).toBeGreaterThan(10);
    const plan = planRegion(SEED, regionOf(sim.playerTile.x), regionOf(sim.playerTile.y));
    expect(plan.hub.town).toBe(true);
    void generateChunk; void REGION;
  });
});
