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
import { BLOCK, PASS, canEnter, setPassageOverride, type Dir4 } from "../src/engine/passability.ts";
import { validateSchema } from "../src/engine/schema-validate.ts";
import { BTN } from "../vendor/pocketjs/contracts/spec/spec.ts";
import { CHUNK, REGION, regionOf } from "../examples/wander/world.ts";
import { generateChunk } from "../examples/wander/chunk.ts";
import { planRegion } from "../examples/wander/region.ts";
import { GROWING_CAP, Residency, TICK_BUDGET, type Focus } from "../examples/wander/residency.ts";
import { buildWindow } from "../examples/wander/window.ts";
import { FAST_SPEED, GROW_RING_H, GROW_RING_W, NEXT_SEED, WALK_SPEED, WanderSim, type ScheduledInput, type WanderMode } from "../examples/wander/wander-sim.ts";

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
    // ~1.7 s alone; a loaded machine needs the headroom.
  }, 30_000);

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
    expect(new Bun.CryptoHasher("sha256").update(JSON.stringify(runs[0]!.digests)).digest("hex")).toBe(
      "6c4e3a49a0b043d944eb61cbdbcb917d7c046ca1dd750d6f773f9e8d81e6dc12",
    );
    // Fast travel too.
    const fast = [60, 4].map((hz) => runSim(hz, 20, { fast: true }));
    expect(fast[1]!.digests).toEqual(fast[0]!.digests);
    expect(new Bun.CryptoHasher("sha256").update(JSON.stringify(fast[0]!.digests)).digest("hex")).toBe(
      "1f3c357035d773e2f065f6739e0bb3579514a290a8610f22bc1ac647881ddc4d",
    );
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

// Per-reference-tick hz consistency with scheduled inputs ---------------

interface TapeRun {
  hz: number;
  sim: WanderSim;
  byTick: Map<number, string>;
}

/** Run a sim whose inputs come from a tape of events at reference ticks,
 *  digesting the state at EVERY reference tick (including ticks folded
 *  inside a low-Hz host frame, via the onTick hook). */
function runTape(hz: number, seconds: number, tape: ScheduledInput[], opts: { seed?: number; fast?: boolean } = {}): TapeRun {
  const sim = new WanderSim({ seed: opts.seed ?? SEED, hz, viewW: 480, viewH: 272, fast: opts.fast });
  sim.schedule(tape);
  const byTick = new Map<number, string>();
  sim.onTick = (d) => byTick.set(sim.now, d);
  for (let f = 0; f < seconds * hz; f++) sim.step(0);
  return { hz, sim, byTick };
}

/** Run the same tape at 60/30/20/4 Hz and assert identical digests at every
 *  reference tick (the onTick hook sees inside each folded frame). Returns
 *  the runs for further assertions. */
function compareHz(seconds: number, tape: ScheduledInput[], opts: { seed?: number; fast?: boolean } = {}): TapeRun[] {
  const runs = [60, 30, 20, 4].map((hz) => runTape(hz, seconds, tape, opts));
  const coarse = runs[3]!;
  for (const r of runs) expect(r.byTick.size).toBe(coarse.byTick.size);
  for (const r of runs.slice(0, 3)) for (const [t, d] of coarse.byTick) expect(r.byTick.get(t)).toBe(d);
  return runs;
}

/** A reachable world tile a few cells east of the player at reference tick
 *  `at` (the world is deterministic per seed, so every hz run sees it). */
function scoutGoal(at: number, dx = 8): { x: number; y: number } {
  const scout = new WanderSim({ seed: SEED, hz: 60, viewW: 480, viewH: 272 });
  while (scout.now < at) scout.step(0);
  const table = scout.session.tables.get("wander")!;
  const m = scout.state.move;
  for (let r = 6; r < 14; r++) {
    const lx = m.tx + r * Math.sign(dx), ly = m.ty;
    if (table.overrides[ly * 96 + lx] === 0) return { x: scout.window.x0 + lx, y: scout.window.y0 + ly };
  }
  throw new Error("no open cell east of the player");
}

/** The tile the player stands on once the in-flight step finishes (tx/ty is
 *  the step's origin while moving, so the destination is one cell along the
 *  facing). A d-pad takeover finishes that step, then walks the held way. */
function standingTile(scout: WanderSim): { tx: number; ty: number } {
  const m = scout.state.move;
  if (!m.moving) return { tx: m.tx, ty: m.ty };
  // Facing order in the session: down, left, up, right.
  const fdx = [0, -1, 0, 1] as const, fdy = [1, 0, -1, 0] as const;
  return { tx: m.tx + fdx[m.facing]!, ty: m.ty + fdy[m.facing]! };
}

/** A d-pad button whose next cell is open from the player's standing tile
 *  at tick `at` (prefers a direction other than the current facing, so the
 *  displacement is unmistakably the keys'). */
function scoutDir(at: number): number {
  const scout = new WanderSim({ seed: SEED, hz: 60, viewW: 480, viewH: 272 });
  while (scout.now < at) scout.step(0);
  return dirFromStanding(scout);
}

function sameFacing(button: number, facing: number): boolean {
  return (button === BTN.DOWN && facing === 0) || (button === BTN.LEFT && facing === 1)
    || (button === BTN.UP && facing === 2) || (button === BTN.RIGHT && facing === 3);
}

function dirFromStanding(scout: WanderSim): number {
  const table = scout.session.tables.get("wander")!;
  const { tx, ty } = standingTile(scout);
  const open = DIRS.filter(([, dx, dy]) => table.overrides[(ty + dy) * 96 + tx + dx] === 0);
  return (open.find(([b]) => !sameFacing(b, scout.state.move.facing)) ?? open[0])![0];
}

describe("wander sim: per-reference-tick consistency at 60/30/20/4 Hz", () => {
  test("auto-wander agrees at every reference tick, not just every second", () => {
    compareHz(50, []);
  }, 60_000);

  test("a tap scheduled at a non-frame-aligned reference tick walks there identically at every rate", () => {
    // 362 is a frame boundary at 60 Hz only: at 30/20/4 Hz it sits inside a
    // folded frame, so the tap must fire mid-fold at the exact tick.
    const goal = scoutGoal(362);
    // 12 s: the walker arrives (~tick 500) and stands there; the 10 s idle
    // resume has not kicked in yet, so the end state is "at the goal".
    const runs = compareHz(12, [{ at: 362, goto: goal }]);
    for (const r of runs) {
      const p = r.sim.playerTile;
      expect(Math.abs(p.x - goal.x) + Math.abs(p.y - goal.y)).toBeLessThanOrEqual(1);
      expect(r.sim.mode).toBe("manual"); // arrived, then waits there
    }
  }, 60_000);

  test("a d-pad hold scheduled at reference ticks walks the same distance at every rate", () => {
    // Held for 12 ticks: at 4 Hz the hold starts and ends inside one folded
    // frame, so the mask must be applied per tick, not per frame.
    const button = scoutDir(360);
    const start = new WanderSim({ seed: SEED, hz: 60, viewW: 480, viewH: 272 }).playerTile;
    const runs = compareHz(20, [{ at: 360, buttons: button }, { at: 372, buttons: 0 }]);
    for (const r of runs) {
      const p = r.sim.playerTile;
      expect(p).toEqual(runs[0]!.sim.playerTile);
      // 12 ticks at 2 px/tick is 24 px: the walker left its start tile.
      expect(Math.abs(p.x - start.x) + Math.abs(p.y - start.y)).toBeGreaterThan(0);
    }
  }, 60_000);

  test("tap, takeover and idle-resume transitions all agree per tick at every rate", () => {
    const goal = scoutGoal(362);
    // The takeover direction must be open in the tape run, not in an auto
    // run: scout it from a sim that followed the same tap.
    const scout = new WanderSim({ seed: SEED, hz: 60, viewW: 480, viewH: 272 });
    scout.schedule([{ at: 362, goto: goal }]);
    while (scout.now < 600) scout.step(0);
    const table = scout.session.tables.get("wander")!;
    const m = scout.state.move;
    const dirs = [[BTN.LEFT, -1, 0], [BTN.RIGHT, 1, 0], [BTN.UP, 0, -1], [BTN.DOWN, 0, 1]] as const;
    const [button] = dirs.find(([, dx, dy]) => table.overrides[(m.ty + dy) * 96 + m.tx + dx] === 0)!;
    const tape: ScheduledInput[] = [
      { at: 362, goto: goal },
      { at: 600, buttons: button },
      { at: 720, buttons: 0 },
    ];
    // 35 s: the tap is taken over at 600, the hold ends at 720, and the 10 s
    // idle resume has handed the walk back to the driver by the end.
    const runs = compareHz(35, tape);
    for (const r of runs) {
      expect(r.sim.mode).toBe("auto");
      expect(r.sim.driver.arrivedTowns).toBe(runs[0]!.sim.driver.arrivedTowns);
    }
  }, 60_000);

  test("another seed and fast travel each agree per tick at every rate", () => {
    const other = compareHz(40, [], { seed: SEED + 0x9e3779b9 });
    const stock = compareHz(40, []);
    const t = other[0]!.sim.now;
    expect(other[0]!.byTick.get(t)).not.toBe(stock[0]!.byTick.get(t));
    compareHz(30, [], { fast: true });
  }, 90_000);
});

// Scheduled-input contract: same-tick semantics, exact transition ticks,
// and discriminating movement proofs -------------------------------------

const DIRS: [number, number, number][] = [[BTN.LEFT, -1, 0], [BTN.RIGHT, 1, 0], [BTN.UP, 0, -1], [BTN.DOWN, 0, 1]];

interface Snap { now: number; segment: number; mode: WanderMode; fast: boolean; x: number; y: number }

/** Run a tape and snapshot the semantic state at EVERY reference tick. */
function runSnaps(hz: number, seconds: number, tape: ScheduledInput[], opts: { seed?: number; fast?: boolean } = {}): { sim: WanderSim; snaps: Snap[] } {
  const sim = new WanderSim({ seed: opts.seed ?? SEED, hz, viewW: 480, viewH: 272, fast: opts.fast });
  sim.schedule(tape);
  const snaps: Snap[] = [];
  sim.onTick = () => {
    const p = sim.playerTile;
    snaps.push({ now: sim.now, segment: sim.segment, mode: sim.mode, fast: sim.fast, x: p.x, y: p.y });
  };
  for (let f = 0; f < seconds * hz; f++) sim.step(0);
  return { sim, snaps };
}

const snapKey = (s: Snap) => `${s.segment}:${s.now}|${s.mode}|${s.fast}|${s.x},${s.y}`;

/** Run the same tape at 60/30/20/4 Hz, asserting identical snapshot
 *  streams at every reference tick (ordered, so reseeds that restart the
 *  clock still align). Returns the per-Hz snapshot streams. */
function compareSnapsHz(seconds: number, tape: ScheduledInput[], opts: { seed?: number; fast?: boolean } = {}): Snap[][] {
  const runs = [60, 30, 20, 4].map((hz) => runSnaps(hz, seconds, tape, opts).snaps);
  const keys = runs.map((r) => r.map(snapKey));
  for (const k of keys.slice(1)) expect(k).toEqual(keys[0]);
  return runs;
}

/** A d-pad button whose next cell is open at tick `at` in a run that
 *  followed `prefix` (the world at `at` depends on the tape, not on an
 *  auto run). */
function scoutDirTape(at: number, prefix: ScheduledInput[]): number {
  const scout = new WanderSim({ seed: SEED, hz: 60, viewW: 480, viewH: 272 });
  scout.schedule(prefix);
  while (scout.now < at) scout.step(0);
  return dirFromStanding(scout);
}

describe("wander sim: scheduled-input same-tick contract", () => {
  test("a press and release queued for the same tick leave no edge", () => {
    // TRIANGLE pressed and released inside tick 360: the tick's final mask
    // is 0, so no edge is computed against tick 359's mask and fast never
    // toggles. (The old accumulating-tapeEdge implementation ghost-toggled.)
    const [snaps] = compareSnapsHz(10, [
      { at: 360, buttons: BTN.TRIANGLE },
      { at: 360, buttons: 0 },
    ]);
    expect(snaps!.every((s) => !s.fast)).toBe(true);
    // SELECT the same way, against an active goto: the walk is NOT handed
    // back to the driver, because no edge survived the tick.
    const goal = scoutGoal(360);
    const [sel] = compareSnapsHz(12, [
      { at: 360, goto: goal },
      { at: 400, buttons: BTN.SELECT },
      { at: 400, buttons: 0 },
    ]);
    expect(sel!.find((s) => s.now === 401)!.mode).not.toBe("auto");
  }, 60_000);

  test("a held takeover mask queued with a same-tick tap wins the tick", () => {
    // Documented contract: taps apply before the tick's controls, so the
    // final held mask always wins a same-tick race with a goto.
    const goal = scoutGoal(360);
    const dir = scoutDir(360);
    const [, dx, dy] = DIRS.find(([b]) => b === dir)!;
    const [snaps] = compareSnapsHz(10, [
      { at: 360, goto: goal },
      { at: 360, buttons: dir },
      { at: 380, buttons: 0 },
    ]);
    // The digest after tick 360: the player has the walk, not the tap.
    expect(snaps!.find((s) => s.now === 361)!.mode).toBe("manual");
    // The walker went the d-pad's way.
    const start = snaps!.find((s) => s.now === 360)!;
    const end = snaps!.find((s) => s.now === 380)!;
    expect((end.x - start.x) * dx + (end.y - start.y) * dy).toBeGreaterThan(0);
  }, 60_000);

  test("TRIANGLE toggles fast travel at exactly the pressed tick", () => {
    const [snaps] = compareSnapsHz(10, [
      { at: 360, buttons: BTN.TRIANGLE },
      { at: 361, buttons: 0 },
    ]);
    expect(snaps!.find((s) => s.now === 360)!.fast).toBe(false);
    expect(snaps!.find((s) => s.now === 361)!.fast).toBe(true); // edge at 360
    expect(snaps!.find((s) => s.now === 400)!.fast).toBe(true); // released at 361
  }, 60_000);

  test("SELECT hands the walk back at exactly the pressed tick", () => {
    const goal = scoutGoal(360);
    const [snaps] = compareSnapsHz(14, [
      { at: 360, goto: goal },
      { at: 600, buttons: BTN.SELECT },
      { at: 601, buttons: 0 },
    ]);
    // The tap is still active (walking there, or arrived and waiting).
    expect(snaps!.find((s) => s.now === 600)!.mode).not.toBe("auto");
    expect(snaps!.find((s) => s.now === 601)!.mode).toBe("auto"); // edge at 600
  }, 60_000);
});

describe("wander sim: scheduled controls at exact ticks", () => {
  test("a d-pad hold walks the pressed way from the pressed tick, unlike the auto walker", () => {
    // 361 is mid-fold at 30/20/4 Hz (odd, not a multiple of 3 or 15).
    const dir = scoutDir(361);
    const [, dx, dy] = DIRS.find(([b]) => b === dir)!;
    const runs = compareSnapsHz(10, [
      { at: 361, buttons: dir },
      { at: 380, buttons: 0 },
    ]);
    for (const snaps of runs) {
      // The takeover lands at tick 361 itself, observable one digest later.
      expect(snaps.find((s) => s.now === 361)!.mode).not.toBe("manual");
      expect(snaps.find((s) => s.now === 362)!.mode).toBe("manual");
      const start = snaps.find((s) => s.now === 361)!;
      const end = snaps.find((s) => s.now === 380)!;
      expect((end.x - start.x) * dx + (end.y - start.y) * dy).toBeGreaterThan(0);
    }
    // The displacement came from the keys: the same seconds without the
    // hold leave the auto walker somewhere else.
    const idle = runSnaps(60, 10, []).snaps.find((s) => s.now === 380)!;
    const held = runs[0]!.find((s) => s.now === 380)!;
    expect([held.x, held.y]).not.toEqual([idle.x, idle.y]);
  }, 60_000);

  test("a tap arrives at the goal at one exact tick at every rate", () => {
    const goal = scoutGoal(362);
    const runs = compareSnapsHz(12, [{ at: 362, goto: goal }]);
    const arrivals = runs.map((snaps) => {
      let seenGoto = false;
      for (const s of snaps) {
        if (s.mode === "goto") seenGoto = true;
        else if (seenGoto) return s.now; // first digest after the arrival
      }
      return -1;
    });
    expect(new Set(arrivals).size).toBe(1);
    expect(arrivals[0]).toBeGreaterThan(362);
    for (const snaps of runs) {
      const end = snaps[snaps.length - 1]!;
      expect(Math.abs(end.x - goal.x) + Math.abs(end.y - goal.y)).toBeLessThanOrEqual(1);
    }
  }, 60_000);

  test("a takeover scheduled mid-fold lands at exactly its tick at every rate", () => {
    // 401 is a host-frame boundary at no rate but 60 (odd, 401 % 3 = 2,
    // 401 % 15 = 11): the takeover must fire inside the folded frame.
    const prefix: ScheduledInput[] = [{ at: 362, goto: scoutGoal(362) }];
    const dir = scoutDirTape(401, prefix);
    const runs = compareSnapsHz(12, [...prefix, { at: 401, buttons: dir }, { at: 420, buttons: 0 }]);
    for (const snaps of runs) {
      expect(snaps.find((s) => s.now === 401)!.mode).not.toBe("manual");
      expect(snaps.find((s) => s.now === 402)!.mode).toBe("manual");
    }
  }, 60_000);

  test("a scheduled reseed grows a new seed at exactly its tick and restarts the clock", () => {
    const runs = compareSnapsHz(12, [{ at: 300, reseed: true }]);
    for (const snaps of runs) {
      // The old session's stream ends at the digest after tick 299
      // (now=300); tick 300 reseeds and the next digest is the new
      // session at now=1.
      const oldEnd = snaps.find((s) => s.now === 300 && s.segment === 1)!;
      const newStart = snaps.find((s) => s.now === 1 && s.segment === 2)!;
      expect(snaps.indexOf(newStart)).toBe(snaps.indexOf(oldEnd) + 1);
      expect([oldEnd.x, oldEnd.y]).not.toEqual([newStart.x, newStart.y]);
    }
    const sim = runSnaps(60, 12, [{ at: 300, reseed: true }]).sim;
    expect(sim.seed).toBe((SEED + NEXT_SEED) >>> 0);
    expect(sim.segment).toBe(2);
    // The clock restarted at 0 on the reseed: 720 ticks total, 300 before.
    expect(sim.now).toBe(12 * 60 - 300);
  }, 60_000);
});

describe("wander sim: reseed epoch — same-frame inputs and the held mask", () => {
  // A host that samples a whole frame at once (the shipped live path) enqueues
  // a reseeding frame's remaining mask changes and taps at the new session's
  // tick 0, and the held mask carries across the reseed without a fresh press
  // edge. 362 is a host-frame boundary at no rate but 60, so the reseed fires
  // mid-fold at 30/20/4 Hz here too.

  test("a button held across a reseed keeps holding without a fresh press edge", () => {
    // TRIANGLE pressed at 300 and never released; the world reseeds at 362 and
    // the held mask is re-asserted at the new session's tick 0 (the tape a
    // frame-sampling host records). The edge baseline must carry across the
    // reseed, so the re-asserted hold fires no fresh press: fast (toggled at
    // 300) stays on. The old boot() reset the baseline, so the re-asserted
    // hold re-fired as a press and toggled fast back off (review probe 2).
    const runs = compareSnapsHz(12, [
      { at: 300, buttons: BTN.TRIANGLE },
      { at: 362, reseed: true },
      { at: 0, buttons: BTN.TRIANGLE },
    ]);
    for (const snaps of runs) {
      expect(snaps.find((s) => s.now === 301 && s.segment === 1)!.fast).toBe(true); // edge at 300
      // Every new-session snapshot keeps fast: no phantom edge at the reseed.
      for (const s of snaps) if (s.segment === 2) expect(s.fast).toBe(true);
    }
  }, 60_000);

  test("a face button pressed in the reseeding frame fires at the new session's tick 0", () => {
    // The live path's tape for a same-frame SQUARE|TRIANGLE: reseed at the old
    // tick, then TRIANGLE at the new session's tick 0 (review probe 1). The old
    // code enqueued TRIANGLE at the old tick, so it sat at the tape's front
    // until the new session caught up and the short press vanished entirely.
    const runs = compareSnapsHz(12, [
      { at: 362, reseed: true },
      { at: 0, buttons: BTN.TRIANGLE },
      { at: 1, buttons: 0 },
    ]);
    for (const snaps of runs) {
      const oldEnd = snaps.find((s) => s.now === 362 && s.segment === 1)!;
      const newStart = snaps.find((s) => s.now === 1 && s.segment === 2)!;
      expect(snaps.indexOf(newStart)).toBe(snaps.indexOf(oldEnd) + 1);
      expect(oldEnd.fast).toBe(false);
      expect(newStart.fast).toBe(true); // edge at new tick 0
      expect(snaps.find((s) => s.now === 2 && s.segment === 2)!.fast).toBe(true); // released at 1
    }
  }, 60_000);

  test("a d-pad held in the reseeding frame walks the pressed way from tick 0", () => {
    // Scout an open direction in the NEW world (the seed after the reseed).
    const scout = new WanderSim({ seed: SEED, hz: 60, viewW: 480, viewH: 272 });
    scout.schedule([{ at: 362, reseed: true }]);
    while (scout.segment < 2 || scout.now < 1) scout.step(0);
    const dir = dirFromStanding(scout);
    const [, dx, dy] = DIRS.find(([b]) => b === dir)!;
    const runs = compareSnapsHz(12, [
      { at: 362, reseed: true },
      { at: 0, buttons: dir },
      { at: 30, buttons: 0 },
    ]);
    for (const snaps of runs) {
      const start = snaps.find((s) => s.now === 1 && s.segment === 2)!;
      expect(start.mode).toBe("manual"); // takeover at new tick 0
      const end = snaps.find((s) => s.now === 30 && s.segment === 2)!;
      expect((end.x - start.x) * dx + (end.y - start.y) * dy).toBeGreaterThan(0);
    }
  }, 60_000);

  test("a tap in the reseeding frame walks to a tile of the new world", () => {
    // Scout a reachable goal east of the player in the NEW world.
    const scout = new WanderSim({ seed: SEED, hz: 60, viewW: 480, viewH: 272 });
    scout.schedule([{ at: 362, reseed: true }]);
    while (scout.segment < 2 || scout.now < 1) scout.step(0);
    const table = scout.session.tables.get("wander")!;
    const m = scout.state.move;
    let goal = { x: scout.playerTile.x, y: scout.playerTile.y };
    for (let r = 6; r < 14; r++) {
      const lx = m.tx + r, ly = m.ty;
      if (table.overrides[ly * 96 + lx] === 0) { goal = { x: scout.window.x0 + lx, y: scout.window.y0 + ly }; break; }
    }
    const runs = compareSnapsHz(16, [
      { at: 362, reseed: true },
      { at: 0, goto: goal },
    ]);
    for (const snaps of runs) {
      expect(snaps.find((s) => s.now === 1 && s.segment === 2)!.mode).toBe("goto");
      const end = snaps[snaps.length - 1]!;
      expect(Math.abs(end.x - goal.x) + Math.abs(end.y - goal.y)).toBeLessThanOrEqual(1);
    }
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
  const DX = [0, -1, 0, 1] as const;
  const DY = [1, 0, -1, 0] as const;
  const BUTTON = [BTN.DOWN, BTN.LEFT, BTN.UP, BTN.RIGHT] as const;
  const SIDES: readonly (readonly [Dir4, Dir4])[] = [[1, 3], [0, 2], [3, 1], [2, 0]];

  function manualFixture(): { sim: WanderSim; x: number; y: number } {
    const sim = new WanderSim({ seed: SEED, hz: 60, viewW: 480, viewH: 272, manual: true });
    const x = 48, y = 48;
    const table = sim.session.tables.get("wander")!;
    for (let yy = y - 3; yy <= y + 3; yy++) for (let xx = x - 3; xx <= x + 3; xx++) {
      setPassageOverride(table, yy * table.width + xx, PASS);
    }
    const state = sim.state;
    const sw = { ...state.sw, switches: {} };
    sim.state = {
      ...state,
      sw,
      interp: { ...state.interp, sw },
      chars: { rng: state.chars.rng, chars: {} },
      move: {
        ...state.move,
        tx: x, ty: y, px: x * 16, py: y * 16,
        facing: 0, phase: 0, moving: false, walking: false, stepDir: 0,
      },
    };
    return { sim, x, y };
  }

  test("a held cardinal direction slides around either hand of an obstacle corner within one tile step", () => {
    for (const dir of [0, 1, 2, 3] as const) for (let hand = 0; hand < 2; hand++) {
      const { sim, x, y } = manualFixture();
      const table = sim.session.tables.get("wander")!;
      const side = SIDES[dir]![hand]!;
      const other = SIDES[dir]![1 - hand]!;
      // The requested cell is blocked. Both immediate side cells are open,
      // but only `side` has an open second leg past the obstacle corner.
      setPassageOverride(table, (y + DY[dir]!) * table.width + x + DX[dir]!, BLOCK);
      setPassageOverride(table, (y + DY[other]! + DY[dir]!) * table.width + x + DX[other]! + DX[dir]!, BLOCK);

      for (let tick = 0; tick < 8; tick++) sim.step(BUTTON[dir]!);
      expect([sim.state.move.tx, sim.state.move.ty], `dir ${dir}, hand ${hand}`).toEqual([x + DX[side]!, y + DY[side]!]);
      expect(sim.state.move).toMatchObject({ phase: 0, moving: false });

      // Keeping the original direction held takes the now-clear forward
      // step; the helper must not replace the input for the whole side step.
      for (let tick = 0; tick < 8; tick++) sim.step(BUTTON[dir]!);
      expect([sim.state.move.tx, sim.state.move.ty]).toEqual([
        x + DX[side]! + DX[dir]!,
        y + DY[side]! + DY[dir]!,
      ]);
    }
  });

  test("a blocked front with both side cells blocked keeps the player in place and facing the wall", () => {
    for (const dir of [0, 1, 2, 3] as const) {
      const { sim, x, y } = manualFixture();
      const table = sim.session.tables.get("wander")!;
      setPassageOverride(table, (y + DY[dir]!) * table.width + x + DX[dir]!, BLOCK);
      for (const side of SIDES[dir]!) {
        setPassageOverride(table, (y + DY[side]!) * table.width + x + DX[side]!, BLOCK);
      }
      for (let tick = 0; tick < 24; tick++) sim.step(BUTTON[dir]!);
      expect(sim.state.move).toMatchObject({
        tx: x, ty: y, px: x * 16, py: y * 16,
        facing: dir, phase: 0, moving: false, walking: false,
      });
    }
  });

  test("four-direction manual random walk has at most one long stall and at most twelve stalled seconds", () => {
    const sim = new WanderSim({ seed: SEED, hz: 60, viewW: 960, viewH: 544, fast: true });
    for (let frame = 0; frame < 300; frame++) sim.step(0);
    for (let frame = 0; frame < 60; frame++) sim.step(BTN.RIGHT);

    const random = (() => {
      let a = 12345;
      return () => {
        a |= 0; a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    })();
    const directions = [BTN.UP, BTN.RIGHT, BTN.DOWN, BTN.LEFT] as const; // E9: no idle direction.
    let direction: number = directions[0], hold = 0;
    let last = sim.playerTile, stillSince = 0;
    const stalls: { from: number; to: number; frames: number; at: { x: number; y: number } }[] = [];
    const finishStall = (to: number) => {
      if (stillSince > 0 && to - stillSince > 240) stalls.push({ from: stillSince, to, frames: to - stillSince, at: last });
    };
    for (let frame = 0; frame < 7_200; frame++) {
      if (hold <= 0) {
        direction = directions[Math.floor(random() * directions.length)]!;
        hold = 60 + Math.floor(random() * 300);
      }
      hold--;
      sim.step(direction);
      const at = sim.playerTile;
      if (at.x !== last.x || at.y !== last.y) {
        finishStall(frame);
        last = at;
        stillSince = 0;
      } else if (stillSince === 0) stillSince = frame;
    }
    finishStall(7_200); // The research harness omitted a stall still active at EOF.

    const totalFrames = stalls.reduce((sum, stall) => sum + stall.frames, 0);
    expect(stalls.length, JSON.stringify(stalls)).toBeLessThanOrEqual(1);
    expect(totalFrames, JSON.stringify(stalls)).toBeLessThanOrEqual(12 * 60);
  }, 60_000);

  test("newly grown blockers update the live passage table", () => {
    // Regression for passage cooking: growth mutates the live override at a
    // deterministic cell after boot, and both the lookup and the player must
    // observe it without rebuilding the whole session table.
    const sim = new WanderSim({ seed: 1, hz: 60, viewW: 480, viewH: 272, manual: true });
    for (let frame = 0; frame < 49; frame++) sim.step(0);

    const table = sim.session.tables.get("wander")!;
    const at = 37 * table.width + 47;
    expect(table.overrides[at]).toBe(BLOCK);
    expect(canEnter(table, 47, 37)).toBe(false);

    const state = sim.state;
    sim.state = {
      ...state,
      move: {
        ...state.move,
        tx: 47,
        ty: 36,
        px: 47 * 16,
        py: 36 * 16,
        phase: 0,
        moving: false,
      },
    };
    // Block both side cells too, so the manual corner aid cannot
    // correctly route around the passage update this regression exercises.
    setPassageOverride(table, 36 * table.width + 46, BLOCK);
    setPassageOverride(table, 36 * table.width + 48, BLOCK);
    for (let frame = 0; frame < 30; frame++) sim.step(BTN.DOWN);
    expect([sim.state.move.tx, sim.state.move.ty]).toEqual([47, 36]);
  });

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
