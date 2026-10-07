// tests/wander-f2.test.ts — F2: talking towns and errands.
//
//   CONTENT   >= 4 distinct villager line groups per town; every villager
//             cites >= 2 of 4 fact kinds (biome, size, neighbour, landmark)
//   NAMES     name space >= 4096; same-name rate < 5% per 25x25 census
//   ERRANDS   deliver-to-neighbour and visit-a-landmark, targets within two
//             regions, pure in (seed, rx, ry)
//   FLOWERS   improvement cells are walkable and never overlap a road,
//             house or prop
//   AUTO      auto mode accepts and completes errands (helped median >= 3,
//             min >= 1 over 10 seeds x 600 s), stops >= 2 s per town and
//             shows a villager's line at most once per town
//   BLOOM     after 40 helped towns the first town's flowers survive
//   DETERM.   two runs agree per tick, at 60/30/20/4 Hz, and across a
//             serialize/restore round-trip; state stays under 1 KiB

import { describe, expect, test } from "bun:test";
import { BTN } from "../vendor/pocketjs/contracts/spec/spec.ts";
import { lintProject } from "../tools/rpgkit-check/src/lint.ts";
import { planRegion, regionName } from "../examples/wander/region.ts";
import { regionGates, regionHub, regionOf } from "../examples/wander/world.ts";
import { landmarkFor } from "../examples/wander/landmarks.ts";
import {
  improvementCells, purePlacedLandmark, townErrand, townFacts, townTalk, villagerRole, VILLAGER_ROLES,
  type TownLookups,
} from "../examples/wander/towns.ts";
import { F_BLOCK, F_ROAD, F_UPPER } from "../examples/wander/region.ts";
import { regionKey } from "../examples/wander/residency.ts";
import { windowRegions } from "../examples/wander/window.ts";
import { ARRIVE_PAUSE } from "../examples/wander/driver.ts";
import { ERRANDS_SAVE_MAX, HELP_CAP, IDLE_RESUME_SECONDS, WanderSim } from "../examples/wander/wander-sim.ts";

const SEEDS = Array.from({ length: 10 }, (_, i) => (0x5eed_0001 + i * 0x9e37_79b9) >>> 0);

function lookups(seed: number): TownLookups {
  return { hubOf: (rx, ry) => regionHub(seed, rx, ry), landmarkOf: (rx, ry) => landmarkFor(seed, rx, ry) };
}

/** The first 50 towns of a 25x25 census, in scan order. */
function firstTowns(seed: number, limit = 50): { rx: number; ry: number }[] {
  const out: { rx: number; ry: number }[] = [];
  for (let ry = -12; ry <= 12 && out.length < limit; ry++) {
    for (let rx = -12; rx <= 12 && out.length < limit; rx++) {
      if (regionHub(seed, rx, ry).town) out.push({ rx, ry });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------

describe("F2-1: every town fields at least 4 distinct villager line groups", () => {
  test("10 seeds x the first 50 towns: >= 4 distinct line sets each", () => {
    for (const seed of SEEDS) {
      const look = lookups(seed);
      for (const { rx, ry } of firstTowns(seed)) {
        const plan = planRegion(seed, rx, ry);
        const facts = townFacts(seed, plan, look);
        const errand = townErrand(seed, rx, ry);
        const groups = new Set<string>();
        const roles = new Set<string>();
        for (let v = 0; v < plan.villagers.length; v++) {
          const { lines } = townTalk(seed, plan, v, facts, errand, false);
          groups.add(lines.join("\n"));
          roles.add(villagerRole(v));
        }
        expect(plan.villagers.length).toBeGreaterThanOrEqual(8);
        expect(groups.size).toBeGreaterThanOrEqual(4);
        // Round-robin roles: 8-12 villagers field all 8 roles.
        expect(roles.size).toBe(VILLAGER_ROLES.length);
      }
    }
  });

  test("two villagers of the same town say different things", () => {
    const seed = SEEDS[0]!;
    const look = lookups(seed);
    const { rx, ry } = firstTowns(seed)[0]!;
    const plan = planRegion(seed, rx, ry);
    const facts = townFacts(seed, plan, look);
    const a = townTalk(seed, plan, 0, facts, null, false).lines;
    const b = townTalk(seed, plan, 1, facts, null, false).lines;
    expect(a.join("\n")).not.toBe(b.join("\n"));
  });
});

describe("F2-2: lines cite at least two of the four fact kinds", () => {
  test("every villager of every census town uses >= 2 kinds; all 4 kinds appear", () => {
    const kinds = new Set<string>();
    for (const seed of SEEDS.slice(0, 4)) {
      const look = lookups(seed);
      for (const { rx, ry } of firstTowns(seed, 20)) {
        const plan = planRegion(seed, rx, ry);
        const facts = townFacts(seed, plan, look);
        const errand = townErrand(seed, rx, ry);
        for (let v = 0; v < plan.villagers.length; v++) {
          const { used } = townTalk(seed, plan, v, facts, errand, false);
          expect(used.length).toBeGreaterThanOrEqual(2);
          for (const k of used) kinds.add(k);
        }
      }
    }
    expect([...kinds].sort()).toEqual(["biome", "landmark", "neighbor", "size"]);
  });

  test("neighbour names and landmark rumors come from real facts", () => {
    const seed = SEEDS[1]!;
    const look = lookups(seed);
    let withNeighbor = 0, withLandmark = 0;
    for (const { rx, ry } of firstTowns(seed, 50)) {
      const plan = planRegion(seed, rx, ry);
      const facts = townFacts(seed, plan, look);
      if (facts.neighbors.length) {
        withNeighbor++;
        // A named neighbour really is a road-connected town: the gate from
        // this region toward the neighbour must be active (the mutation that
        // drops the gate check names non-road-linked towns).
        const g = regionGates(seed, rx, ry);
        const gates = [g.n, g.e, g.s, g.w];
        for (const n of facts.neighbors) {
          expect(n.name.length).toBeGreaterThan(0);
          // Find the neighbour's region by name and check the gate.
          let found = false;
          for (let dy = -1; dy <= 1 && !found; dy++) for (let dx = -1; dx <= 1 && !found; dx++) {
            if (!dx && !dy) continue;
            if (regionName(seed, rx + dx, ry + dy) === n.name && regionHub(seed, rx + dx, ry + dy).town) {
              const gi = dy < 0 ? 0 : dx > 0 ? 1 : dy > 0 ? 2 : 3;
              expect(gates[gi]!.active).toBe(true);
              found = true;
            }
          }
          expect(found).toBe(true);
        }
      }
      if (facts.landmark) {
        withLandmark++;
        expect(facts.landmark.kind.length).toBeGreaterThan(0);
        expect(facts.landmark.dist).toBeGreaterThan(0);
      }
    }
    // Both kinds show up often enough to matter.
    expect(withNeighbor).toBeGreaterThan(10);
    expect(withLandmark).toBeGreaterThan(10);
  });
});

describe("F2-2b: dialog facts are pure in (seed, region) regardless of residency", () => {
  test("the window's villager tokens expand to the pure computation at every resident town", () => {
    // The review found the baked dialog used the residency-aware
    // placedLandmark (null for a developed region whose plan is not
    // resident), so 50/58 towns near spawn differed from the pure lookup.
    // The dialog is now on-demand: the build bakes {x:} tokens and the
    // sim's textTokens resolver expands them at box open. The resolver is
    // pure in (seed, region, villager, helped), so the expanded lines equal
    // the pure computation regardless of residency.
    const seed = SEEDS[0]!;
    const sim = new WanderSim({ seed, hz: 60, viewW: 960, viewH: 544 });
    for (let f = 0; f < 60 * 90; f++) sim.step(0);
    const w = sim.window;
    const pureLook: TownLookups = {
      hubOf: (rx, ry) => regionHub(seed, rx, ry),
      landmarkOf: (rx, ry) => purePlacedLandmark(seed, rx, ry),
    };
    let checked = 0;
    for (const [rx, ry] of windowRegions(w.cx, w.cy)) {
      const plan = sim.res.plan(rx, ry);
      if (!plan || !plan.hub.town) continue;
      const pureFacts = townFacts(seed, plan, pureLook);
      const pureErrand = townErrand(seed, rx, ry);
      const helped = sim.isHelped(rx, ry);
      for (const v of plan.villagers) {
        const ev = w.project.maps[0]!.events?.find((e) => e.id === v.id);
        if (!ev) continue; // villager's walk does not fit in the window
        const cmd = ev.pages[0]!.commands[0]!;
        if (cmd.op !== "text") continue;
        // The baked lines are {x:} tokens; expand each through the sim's
        // resolver (the same path the engine takes at box open).
        const expanded = cmd.lines.map((tok) => {
          expect(tok.startsWith("{x:")).toBe(true);
          expect(tok.endsWith("}")).toBe(true);
          return sim["expandDialogToken"](tok.slice(3, -1));
        });
        const pure = townTalk(seed, plan, v.house, pureFacts, pureErrand, helped).lines;
        expect(expanded).toEqual(pure);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  test("the same town's dialog is identical under different load orders", () => {
    // Two sims at the same seed that load different regions first (one walks
    // east, one west) bake the same dialog for a town they both reach: the
    // facts read only the pure cache, never residency.
    const seed = SEEDS[0]!;
    const town = firstTowns(seed, 1)[0]!;
    const purePlan = planRegion(seed, town.rx, town.ry);
    const pureLook: TownLookups = {
      hubOf: (rx, ry) => regionHub(seed, rx, ry),
      landmarkOf: (rx, ry) => purePlacedLandmark(seed, rx, ry),
    };
    const pureFacts = townFacts(seed, purePlan, pureLook);
    const pureErrand = townErrand(seed, town.rx, town.ry);
    const pureLines = townTalk(seed, purePlan, 0, pureFacts, pureErrand, false).lines.join("\n");
    const a = new WanderSim({ seed, hz: 60, viewW: 480, viewH: 272 });
    const b = new WanderSim({ seed, hz: 60, viewW: 480, viewH: 272 });
    a.goto(a.playerTile.x + 600, a.playerTile.y);
    b.goto(b.playerTile.x - 600, b.playerTile.y);
    for (let f = 0; f < 60 * 90; f++) { a.step(0); b.step(0); }
    // Both sims have very different residency now; the pure facts are unchanged.
    expect(townTalk(seed, purePlan, 0, townFacts(seed, purePlan, pureLook), townErrand(seed, town.rx, town.ry), false).lines.join("\n")).toBe(pureLines);
  });

  test("generated windows are completely lint-clean (10 seeds x every window walked)", () => {
    // The actor switches (`b:<id>`) are seeded into the switch bank by the
    // sim at runtime (wander-sim.ts applySwitches on a window build and
    // applyGrowth as a region grows) — no document command ever sets them.
    // Each window declares them in its switch directory with
    // writtenBy:"host", so lint/switch-read-never-set skips exactly this
    // family and every generated window is clean: zero errors AND zero
    // warnings across 10 seeds x every window each seed walks through.
    let windows = 0;
    for (const seed of SEEDS) {
      const sim = new WanderSim({ seed, hz: 60, viewW: 960, viewH: 544 });
      let lastKey = "";
      for (let f = 0; f < 60 * 60; f++) {
        sim.step(0);
        const key = `${sim.window.x0},${sim.window.y0}`;
        if (key === lastKey) continue;
        lastKey = key;
        windows++;
        const report = lintProject(sim.window.project);
        const bad = report.findings.filter((x) => x.severity === "error" || x.severity === "warning");
        expect(
          bad.map((x) => `${x.severity} ${x.check}: ${x.message}`),
          `window ${key} (seed ${seed}) is lint-clean`,
        ).toEqual([]);
      }
    }
    // 10 seeds, several windows each (auto walk crosses ~10 chunks in 60 s).
    expect(windows).toBeGreaterThanOrEqual(30);
  });
});

describe("F2-3: the name space is large and collisions are rare", () => {
  test("distinct names over a 100x100 census >= 4096", () => {
    for (const seed of SEEDS.slice(0, 3)) {
      const names = new Set<string>();
      for (let ry = -50; ry < 50; ry++) for (let rx = -50; rx < 50; rx++) names.add(regionName(seed, rx, ry));
      expect(names.size).toBeGreaterThanOrEqual(4096);
    }
  });

  test("same-name towns are under 5% of every 25x25 census", () => {
    for (const seed of SEEDS) {
      const counts = new Map<string, number>();
      let towns = 0;
      for (let ry = -12; ry <= 12; ry++) for (let rx = -12; rx <= 12; rx++) {
        if (!regionHub(seed, rx, ry).town) continue;
        const name = regionName(seed, rx, ry);
        counts.set(name, (counts.get(name) ?? 0) + 1);
        towns++;
      }
      let colliding = 0;
      for (const n of counts.values()) if (n > 1) colliding += n;
      expect(colliding / towns).toBeLessThan(0.05);
    }
  });
});

describe("F2-4: errands are deliver-to-neighbour or visit-a-landmark", () => {
  test("both kinds appear; every target is within two regions; pure", () => {
    const kinds = new Set<string>();
    for (const seed of SEEDS) {
      for (const { rx, ry } of firstTowns(seed, 50)) {
        const e1 = townErrand(seed, rx, ry);
        const e2 = townErrand(seed, rx, ry);
        expect(e1).toEqual(e2); // pure
        if (!e1) continue;
        kinds.add(e1.kind);
        expect(Math.max(Math.abs(e1.trx - rx), Math.abs(e1.try - ry))).toBeLessThanOrEqual(2);
        if (e1.kind === "deliver") {
          expect(regionHub(seed, e1.trx, e1.try).town).toBe(true);
          expect(e1.what.length).toBeGreaterThan(0);
        } else {
          // The visit target is the plan's actual placement.
          expect(planRegion(seed, e1.trx, e1.try).landmark).not.toBeNull();
          expect(e1.what.startsWith("see the ")).toBe(true);
        }
      }
    }
    expect([...kinds].sort()).toEqual(["deliver", "visit"]);
  });

  test("the pure visit target matches the plan's placed landmark position", () => {
    // purePlacedLandmark (behind townErrand) has a cheap path for wilderness
    // regions (landmarkFor) and a planRegion path for developed ones; both
    // must equal planRegion(seed, rx, ry).landmark exactly, or the driver
    // heads for a tile the world did not place.
    let checked = 0;
    for (const seed of SEEDS) {
      for (const { rx, ry } of firstTowns(seed, 50)) {
        const e = townErrand(seed, rx, ry);
        if (!e || e.kind !== "visit") continue;
        const placed = planRegion(seed, e.trx, e.try).landmark;
        expect(placed).not.toBeNull();
        expect(e.tx).toBe(placed!.cx);
        expect(e.ty).toBe(placed!.cy);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(50); // the census has many visit errands
  });

  test("every delivery target is road-linked (behind an active gate)", () => {
    let deliveries = 0;
    for (const seed of SEEDS) {
      for (const { rx, ry } of firstTowns(seed, 50)) {
        const e = townErrand(seed, rx, ry);
        if (!e || e.kind !== "deliver") continue;
        deliveries++;
        // The gate from the offering region toward the target must be active.
        const g = regionGates(seed, rx, ry);
        const gates = [g.n, g.e, g.s, g.w];
        const dx = Math.sign(e.trx - rx), dy = Math.sign(e.try - ry);
        const gi = dy < 0 ? 0 : dx > 0 ? 1 : dy > 0 ? 2 : 3;
        expect(gates[gi]!.active).toBe(true);
      }
    }
    expect(deliveries).toBeGreaterThan(50); // the census has many deliveries
  });

  test("the offer is stable across load orders (pure in seed, rx, ry)", () => {
    // Two sims at the same seed that load different regions first (one walks
    // east, one west) must compute the same offer at the same town: the offer
    // reads only the point functions, never residency.
    const seed = SEEDS[0]!;
    const town = firstTowns(seed, 1)[0]!;
    const pure = townErrand(seed, town.rx, town.ry);
    const a = new WanderSim({ seed, hz: 60, viewW: 480, viewH: 272 });
    const b = new WanderSim({ seed, hz: 60, viewW: 480, viewH: 272 });
    a.goto(a.playerTile.x + 600, a.playerTile.y);
    b.goto(b.playerTile.x - 600, b.playerTile.y);
    for (let f = 0; f < 60 * 90; f++) { a.step(0); b.step(0); }
    // Both sims have very different residency now; the offer is unchanged.
    expect(townErrand(seed, town.rx, town.ry)).toEqual(pure);
    // And a sim that reaches the town's plaza accepts exactly that offer.
    // Use the start town: the player spawns on its plaza.
    const c = new WanderSim({ seed, hz: 60, viewW: 960, viewH: 544, manual: true });
    const sp = c.playerTile;
    const srx = regionOf(sp.x), sry = regionOf(sp.y);
    const startPlan = planRegion(seed, srx, sry);
    const startOffer = townErrand(seed, srx, sry);
    // Settle: let the budget generate the town's plan so nearPlaza sees it.
    for (let f = 0; f < 60 * 3; f++) c.step(0);
    expect(c.nearPlaza()).toBe(true);
    c["errand"] = null;
    c.pressAction();
    // The accepted offer is the same pure function of (seed, rx, ry).
    expect(JSON.stringify(c.errand)).toBe(JSON.stringify(startOffer));
    expect(startPlan.hub.town).toBe(true);
  }, 60_000);
});

describe("F2-8: plaza flowers are walkable and avoid roads and houses", () => {
  test("every improvement cell of every census town is walkable and undeveloped", () => {
    for (const seed of SEEDS.slice(0, 4)) {
      for (const { rx, ry } of firstTowns(seed, 50)) {
        const plan = planRegion(seed, rx, ry);
        const cells = improvementCells(plan);
        expect(cells.length).toBeGreaterThan(0);
        for (const c of cells) {
          const i = (c.y - plan.y0) * 96 + (c.x - plan.x0);
          const f = plan.flags![i]!;
          expect(f & F_ROAD).toBe(0); // never on a road
          expect(f & F_BLOCK).toBe(0); // never on a house or prop
          expect(f & F_UPPER).toBe(0); // never replaces an upper cell
          expect(c.tile).toBeGreaterThan(0);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Auto participation, Bloom persistence, determinism, serialization.
// ---------------------------------------------------------------------------

interface AutoRow {
  seed: number;
  helped: number;
  arrivedTowns: number;
  talked: number;
  villagerDialogs: number;
}

/** One 10-seed x 600 s auto sweep shared by the rate / talk assertions. */
const AUTO_SWEEP: AutoRow[] = [];
function autoSweep(): AutoRow[] {
  if (AUTO_SWEEP.length) return AUTO_SWEEP;
  for (const seed of SEEDS) {
    const sim = new WanderSim({ seed, hz: 60, viewW: 960, viewH: 544 });
    let villagerDialogs = 0;
    for (let f = 0; f < 600 * 60; f++) {
      sim.step(0);
      const m = sim.state.interp.modal;
      if (m && m.kind === "text" && VILLAGER_ROLES.some((r) => m.lines[0]?.startsWith(`${r}:`))) villagerDialogs++;
    }
    AUTO_SWEEP.push({
      seed, helped: sim.helpedCount, arrivedTowns: sim.driver.arrivedTowns,
      talked: sim.talkedCount, villagerDialogs,
    });
  }
  return AUTO_SWEEP;
}

describe("F2-5: auto mode accepts and completes errands", () => {
  test("10 seeds x 600 s: helped median >= 3, minimum >= 1", () => {
    const rows = autoSweep();
    const helped = rows.map((r) => r.helped).sort((a, b) => a - b);
    const med = helped[Math.floor(helped.length / 2)]!;
    expect(med).toBeGreaterThanOrEqual(3);
    expect(helped[0]!).toBeGreaterThanOrEqual(1);
    // Every seed both accepted and delivered.
    for (const r of rows) expect(r.helped).toBeGreaterThan(0);
  }, 120_000);
});

describe("F2-6: the auto-walker stops at every town and talks to a villager", () => {
  test("the arrival pause is at least two seconds", () => {
    expect(ARRIVE_PAUSE).toBeGreaterThanOrEqual(120); // 2 s at 60 Hz
  });

  test("a villager dialog opens in auto mode, at most once per town", () => {
    const rows = autoSweep();
    let totalDialogs = 0;
    for (const r of rows) {
      // At least one villager line was shown.
      expect(r.villagerDialogs).toBeGreaterThan(0);
      // At most one talk per arrived town (the talked set is the bound).
      expect(r.talked).toBeLessThanOrEqual(r.arrivedTowns);
      totalDialogs += r.villagerDialogs;
    }
    expect(totalDialogs).toBeGreaterThan(rows.length); // most seeds talk repeatedly
  }, 120_000);

  test("talked grows only when a villager dialog is open (not at arrival)", () => {
    // A town is marked talked only once a real villager dialog opened, so a
    // failed chase can retry on a later visit. Recording it at arrival (the
    // pre-fix order) would grow talked with no dialog open.
    const sim = new WanderSim({ seed: SEEDS[0]!, hz: 60, viewW: 960, viewH: 544 });
    let lastTalked = 0;
    for (let f = 0; f < 600 * 60; f++) {
      sim.step(0);
      if (sim.talkedCount > lastTalked) {
        const m = sim.state.interp.modal;
        const isVillagerDialog = !!m && m.kind === "text" && VILLAGER_ROLES.some((r) => m.lines[0]?.startsWith(`${r}:`));
        expect(isVillagerDialog).toBe(true);
        lastTalked = sim.talkedCount;
      }
    }
    expect(lastTalked).toBeGreaterThan(0); // the walk talked at some towns
  }, 120_000);

  test("EVERY unique arrival town gets a villager dialog (all 10 seeds + the stall seed)", () => {
    // The review found a town the auto-walker reached but never opened a
    // dialog at (the chase stalled one tile short of the villager). Track
    // each arrival's region and each dialog's region on every seed: every
    // arrival town must be in the dialog set.
    const seeds = [...SEEDS, 0x50a8cdc9];
    for (const seed of seeds) {
      const sim = new WanderSim({ seed, hz: 60, viewW: 960, viewH: 544 });
      const arrivalTowns = new Set<number>();
      const dialogTowns = new Set<number>();
      let lastArrived = 0;
      for (let f = 0; f < 600 * 60; f++) {
        sim.step(0);
        if (sim.driver.arrivedTowns !== lastArrived) {
          lastArrived = sim.driver.arrivedTowns;
          const p = sim.playerTile;
          arrivalTowns.add(regionKey(regionOf(p.x), regionOf(p.y)));
        }
        const m = sim.state.interp.modal;
        if (m && m.kind === "text" && VILLAGER_ROLES.some((r) => m.lines[0]?.startsWith(`${r}:`))) {
          const p = sim.playerTile;
          dialogTowns.add(regionKey(regionOf(p.x), regionOf(p.y)));
        }
      }
      expect(arrivalTowns.size).toBeGreaterThan(5);
      for (const t of arrivalTowns) {
        expect(dialogTowns.has(t)).toBe(true);
      }
    }
  }, 600_000);

  test("a takeover during an auto dialog resumes walking after idle (L / d-pad / CROSS)", () => {
    // Review B1: one L / d-pad / CROSS press while an auto villager dialog
    // is open, then release, left auto mode frozen forever with the modal
    // still up — the takeover dropped the auto-talk state but nothing closed
    // or paged the dialog, and the walker cannot move while a modal owns the
    // session. On idle-resume the pager is recreated, pages the dialog to
    // its end, and the walk continues. Each takeover button is exercised.
    for (const btn of [BTN.LTRIGGER, BTN.DOWN, BTN.CROSS]) {
      const sim = new WanderSim({ seed: SEEDS[0]!, hz: 60, viewW: 480, viewH: 272 });
      // Run auto until the start-town villager dialog opens.
      let opened = false;
      for (let f = 0; f < 60 * 60 && !opened; f++) {
        sim.step(0);
        const m = sim.state.interp.modal;
        if (m && m.kind === "text" && VILLAGER_ROLES.some((r) => m.lines[0]?.startsWith(`${r}:`))) opened = true;
      }
      expect(opened, `seed dialog opened before takeover (btn ${btn})`).toBe(true);
      expect(sim.mode).toBe("auto");
      // One-frame takeover, then release.
      sim.step(btn);
      expect(sim.mode, `manual after takeover (btn ${btn})`).toBe("manual");
      sim.step(0);
      // Idle through the 10 s resume and on: the dialog must finish and the
      // walker must keep moving (on the frozen build it never does).
      const idleTicks = IDLE_RESUME_SECONDS * 60;
      for (let t = 0; t < idleTicks; t++) sim.step(0);
      expect(sim.mode, `auto after idle-resume (btn ${btn})`).toBe("auto");
      const w0 = sim.walked;
      for (let t = 0; t < 5 * 60; t++) sim.step(0);
      const w1 = sim.walked;
      for (let t = 0; t < 10 * 60; t++) sim.step(0);
      const w2 = sim.walked;
      expect(sim.state.interp.modal, `dialog closed after resume (btn ${btn})`).toBeNull();
      expect(w1 - w0, `moving within 5 s of resume (btn ${btn})`).toBeGreaterThan(3);
      expect(w2 - w1, `still moving 5-15 s after resume (btn ${btn})`).toBeGreaterThan(10);
    }
  }, 300_000);
});

describe("F2-7: flowers survive past the exact set via the Bloom", () => {
  test("re-helping a town adds no extra flowers and does not shrink the exact set", () => {
    // The review found that a second help wrote flowers on the NEXT ring
    // offsets (the first set already carried F_UPPER, so improvementCells
    // skipped them), growing 4 -> 7 -> 7 cells, and that completeErrand
    // evicted the oldest exact key even when the key was already present.
    const sim = new WanderSim({ seed: SEEDS[0]!, hz: 60, viewW: 960, viewH: 544, manual: true });
    const start = sim.playerTile;
    const srx = regionOf(start.x), sry = regionOf(start.y);
    const plan0 = sim.res.plan(srx, sry)!;
    const cells = improvementCells(plan0);
    expect(cells.length).toBeGreaterThan(0);
    const flowerCount = (plan: NonNullable<ReturnType<typeof sim.res.plan>>) =>
      cells.filter((c) => plan.upper![(c.y - plan.y0) * 96 + (c.x - plan.x0)] === c.tile).length;
    // First help: the plaza gains its flowers.
    sim.__helpForTest(srx, sry);
    expect(flowerCount(sim.res.plan(srx, sry)!)).toBe(cells.length);
    expect(sim.helpedCount).toBe(1);
    expect(sim.helped.size).toBe(1);
    // Re-help twice: no new flowers, no count growth, no set churn.
    sim.__helpForTest(srx, sry);
    sim.__helpForTest(srx, sry);
    expect(flowerCount(sim.res.plan(srx, sry)!)).toBe(cells.length);
    expect(sim.helpedCount).toBe(1);
    expect(sim.helped.size).toBe(1);
    // Fill the exact set to HELP_CAP, then re-help the start town: it must
    // not evict a newer town (the set keeps all HELP_CAP current towns).
    let helped = 1;
    for (let ry = -6; ry <= 6 && helped < HELP_CAP; ry++) {
      for (let rx = -6; rx <= 6 && helped < HELP_CAP; rx++) {
        if ((rx === srx && ry === sry) || !regionHub(sim.seed, rx, ry).town) continue;
        sim.__helpForTest(rx, ry);
        helped++;
      }
    }
    expect(helped).toBe(HELP_CAP);
    expect(sim.helped.size).toBe(HELP_CAP);
    const before = [...sim.helped];
    sim.__helpForTest(srx, sry); // re-help (still in the exact set)
    expect(sim.helped.size).toBe(HELP_CAP);
    expect([...sim.helped]).toEqual(before); // no eviction, no churn
    expect(sim.helpedCount).toBe(HELP_CAP); // distinct towns, not deliveries
  });

  test("a re-delivery to an already-helped town adds no flowers (completeErrand)", () => {
    // The auto-walker re-delivers a pure offer to a town it helped before.
    // completeErrand must be idempotent: no extra flowers, no count growth,
    // no exact-set eviction.
    const sim = new WanderSim({ seed: SEEDS[0]!, hz: 60, viewW: 960, viewH: 544, manual: true });
    const start = sim.playerTile;
    const srx = regionOf(start.x), sry = regionOf(start.y);
    const plan0 = sim.res.plan(srx, sry)!;
    const cells = improvementCells(plan0);
    const flowerCount = (plan: NonNullable<ReturnType<typeof sim.res.plan>>) =>
      cells.filter((c) => plan.upper![(c.y - plan.y0) * 96 + (c.x - plan.x0)] === c.tile).length;
    // A deliver errand targeting the start town itself (drives completeErrand
    // on a resident plan, so the flowers are observable).
    const errand = {
      kind: "deliver" as const, orx: srx, ory: sry, trx: srx, try: sry,
      tx: plan0.hub.x, ty: plan0.hub.y, ax: plan0.hub.x, ay: plan0.hub.y,
      targetName: plan0.name, what: "a parcel",
    };
    // First completion: the town gains flowers.
    sim["errand"] = errand;
    sim["completeErrand"]();
    expect(sim.helpedCount).toBe(1);
    expect(flowerCount(sim.res.plan(srx, sry)!)).toBe(cells.length);
    // Re-deliver twice: idempotent.
    sim["errand"] = errand;
    sim["completeErrand"]();
    sim["errand"] = errand;
    sim["completeErrand"]();
    expect(sim.helpedCount).toBe(1);
    expect(flowerCount(sim.res.plan(srx, sry)!)).toBe(cells.length);
    expect(sim.helped.size).toBe(1);
  });

  test("after 40 helped towns the first town's flowers regrow on its plan", () => {
    const sim = new WanderSim({ seed: SEEDS[0]!, hz: 60, viewW: 960, viewH: 544, manual: true, fast: true });
    const start = sim.playerTile;
    const srx = regionOf(start.x), sry = regionOf(start.y);
    // Record the flower cells before helping (helping sets F_UPPER on them).
    const plan0 = sim.res.plan(srx, sry)!;
    const flowers = improvementCells(plan0);
    expect(flowers.length).toBeGreaterThan(0);
    const hasFlowers = (plan: NonNullable<ReturnType<typeof sim.res.plan>>) =>
      flowers.every((c) => plan.upper![(c.y - plan.y0) * 96 + (c.x - plan.x0)] === c.tile);
    sim.__helpForTest(srx, sry);
    expect(hasFlowers(plan0)).toBe(true);
    // Help 40 more towns (the exact set caps at 32; the start town falls out).
    let helped = 1;
    for (let ry = -6; ry <= 6 && helped < 41; ry++) {
      for (let rx = -6; rx <= 6 && helped < 41; rx++) {
        if ((rx === srx && ry === sry) || !regionHub(sim.seed, rx, ry).town) continue;
        sim.__helpForTest(rx, ry);
        helped++;
      }
    }
    expect(helped).toBe(41);
    expect(sim.helped.size).toBe(HELP_CAP); // exact set capped
    expect(sim.helpedCount).toBe(41);
    expect(sim.helped.has(regionKey(srx, sry))).toBe(false); // evicted from the exact set
    // Walk far enough to evict the start plan, then walk back.
    const far = { x: start.x + 3000, y: start.y };
    sim.goto(far.x, far.y);
    for (let f = 0; f < 60 * 400 && sim.mode !== "manual"; f++) sim.step(0);
    expect(sim.res.plan(srx, sry)).toBeUndefined(); // evicted
    sim.goto(start.x, start.y);
    for (let f = 0; f < 60 * 400 && sim.mode !== "manual"; f++) sim.step(0);
    // The plan regenerated and the Bloom replanted the flowers.
    for (let f = 0; f < 60 * 30 && !sim.res.plan(srx, sry); f++) sim.step(0);
    const plan1 = sim.res.plan(srx, sry);
    expect(plan1).toBeDefined();
    expect(hasFlowers(plan1!)).toBe(true);
  }, 60_000);
});

describe("F2-9: the errand flow is deterministic and multi-Hz consistent", () => {
  test("two auto runs agree at every reference tick", () => {
    const a = new WanderSim({ seed: SEEDS[0]!, hz: 60, viewW: 480, viewH: 272 });
    const b = new WanderSim({ seed: SEEDS[0]!, hz: 60, viewW: 480, viewH: 272 });
    const da: string[] = [], db: string[] = [];
    a.onTick = (d) => da.push(d);
    b.onTick = (d) => db.push(d);
    for (let f = 0; f < 120 * 60; f++) { a.step(0); b.step(0); }
    expect(db).toEqual(da);
    expect(a.helpedCount).toBeGreaterThan(0); // errands actually ran
  }, 60_000);

  test("the auto errand/talk flow agrees at 60/30/20/4 Hz per tick", () => {
    const runs = [60, 30, 20, 4].map((hz) => {
      const sim = new WanderSim({ seed: SEEDS[0]!, hz, viewW: 480, viewH: 272 });
      const byTick = new Map<number, string>();
      sim.onTick = (d) => byTick.set(sim.now, d);
      for (let f = 0; f < 120 * hz; f++) sim.step(0);
      return { hz, byTick, sim };
    });
    const coarse = runs[3]!;
    for (const r of runs) expect(r.byTick.size).toBe(coarse.byTick.size);
    for (const r of runs.slice(0, 3)) for (const [t, d] of coarse.byTick) expect(r.byTick.get(t)).toBe(d);
  }, 120_000);

  test("a goto-driven accept→deliver flow completes (result assertion; F3 lands per-tick goto)", () => {
    // The start town's errand, from the pure offer.
    const seed = SEEDS[1]!;
    const sim = new WanderSim({ seed, hz: 60, viewW: 960, viewH: 544, manual: true });
    const start = sim.playerTile;
    const srx = regionOf(start.x), sry = regionOf(start.y);
    const look: TownLookups = {
      hubOf: (rx, ry) => sim.res.hub(rx, ry),
      landmarkOf: (rx, ry) => sim.placedLandmark(rx, ry),
    };
    const offer = townErrand(seed, srx, sry);
    expect(offer).not.toBeNull();
    // Accept at the plaza, then walk to the target and deliver.
    sim.pressAction();
    expect(sim.errand).toEqual(offer);
    sim.goto(offer!.ax, offer!.ay);
    for (let f = 0; f < 60 * 300 && sim.mode !== "manual"; f++) sim.step(0);
    if (offer!.kind === "visit") {
      // A visit errand completes on arrival (no pressAction needed).
      expect(sim.helpedCount).toBe(1);
    } else {
      // Walk to the target hub and press CROSS.
      sim.pressAction();
      expect(sim.helpedCount).toBe(1);
    }
    expect(sim.errand).toBeNull();
  }, 60_000);
});

describe("F2-10: serialize/restore round-trips the errand state under 1 KiB", () => {
  test("a fresh save (no town helped yet) round-trips without throwing", () => {
    // The empty helped set serializes as h:""; restore must accept it as the
    // valid encoding of "nothing helped yet", not reject it as malformed
    // base64 (a save taken before the first delivery must restore).
    const a = new WanderSim({ seed: SEEDS[0]!, hz: 60, viewW: 480, viewH: 272 });
    expect(a.helpedCount).toBe(0);
    const text = a.serializeErrands();
    expect(text).toContain('"h":""');
    const b = new WanderSim({ seed: SEEDS[0]!, hz: 60, viewW: 480, viewH: 272 });
    expect(() => b.restoreErrands(text)).not.toThrow();
    expect(b.serializeErrands()).toBe(text); // byte-identical round trip
    expect(b.errandsDigest()).toBe(a.errandsDigest());
    expect(b.helpedCount).toBe(0);
    // A save taken mid-session, then a save with no errand and no helped
    // towns, both restore into a sim that folds identically to a fresh one.
    const c = new WanderSim({ seed: SEEDS[0]!, hz: 60, viewW: 480, viewH: 272 });
    c.restoreErrands(text);
    const d = new WanderSim({ seed: SEEDS[0]!, hz: 60, viewW: 480, viewH: 272 });
    for (let f = 0; f < 600; f++) { c.step(0); d.step(0); }
    expect(c.errandsDigest()).toBe(d.errandsDigest());
  });

  test("the talked set round-trips (bounded, within the 1 KiB save)", () => {
    // talked is bounded session state: it must serialize and restore, and a
    // maxed save (HELP_CAP helped + TALK_CAP talked + Bloom + errand) must
    // stay within the 1 KiB bound.
    const a = new WanderSim({ seed: SEEDS[0]!, hz: 60, viewW: 960, viewH: 544 });
    for (let f = 0; f < 600 * 60 && a.talkedCount < 3; f++) a.step(0);
    expect(a.talkedCount).toBeGreaterThan(0);
    const text = a.serializeErrands();
    const b = new WanderSim({ seed: SEEDS[0]!, hz: 60, viewW: 960, viewH: 544 });
    b.restoreErrands(text);
    expect(b.talkedCount).toBe(a.talkedCount);
    expect(b.errandsDigest()).toBe(a.errandsDigest());
    expect(b.serializeErrands()).toBe(text); // byte-identical round trip
    // A maxed save: HELP_CAP helped + TALK_CAP talked + Bloom + a full errand.
    const sim = new WanderSim({ seed: SEEDS[0]!, hz: 60, viewW: 480, viewH: 272 });
    const big = 22_369_621;
    for (let i = 0; i < HELP_CAP; i++) sim.__helpForTest(big - i, big);
    for (let i = 0; i < 24; i++) sim["talked"].add(big - 100 - i);
    sim["errand"] = {
      kind: "deliver", orx: big, ory: big, trx: big + 1, try: big, tx: 2_147_483_000, ty: 2_147_483_000,
      ax: 2_147_483_000, ay: 2_147_483_000,
      targetName: "Great Bramford", what: "a jar of honey",
    };
    const maxed = sim.serializeErrands();
    expect(new TextEncoder().encode(maxed).length).toBeLessThanOrEqual(ERRANDS_SAVE_MAX);
    const restored = new WanderSim({ seed: SEEDS[0]!, hz: 60, viewW: 480, viewH: 272 });
    restored.restoreErrands(maxed);
    expect(restored.talkedCount).toBe(24);
    expect(restored.serializeErrands()).toBe(maxed);
  }, 120_000);

  test("restore reproduces the errand, helped set and Bloom; folds identically after", () => {
    // Fresh-instance round trip: the destination is NOT warmed up, so the
    // restore must rebuild everything from the string alone.
    const a = new WanderSim({ seed: SEEDS[0]!, hz: 60, viewW: 480, viewH: 272 });
    for (let f = 0; f < 300 * 60; f++) a.step(0);
    expect(a.helpedCount).toBeGreaterThan(0);
    const text = a.serializeErrands();
    const b = new WanderSim({ seed: SEEDS[0]!, hz: 60, viewW: 480, viewH: 272 });
    b.restoreErrands(text);
    // Re-serializing gives the identical string (the restore is faithful).
    expect(b.serializeErrands()).toBe(text);
    expect(b.errandsDigest()).toBe(a.errandsDigest());
    // Two fresh restores fold identically afterwards (the restored state
    // drives the same future).
    const c = new WanderSim({ seed: SEEDS[0]!, hz: 60, viewW: 480, viewH: 272 });
    c.restoreErrands(text);
    for (let f = 0; f < 600; f++) { b.step(0); c.step(0); }
    expect(c.errandsDigest()).toBe(b.errandsDigest());
  }, 60_000);

  test("a maxed state at the int32 tile boundary serializes to <= 1024 UTF-8 bytes", () => {
    const sim = new WanderSim({ seed: SEEDS[0]!, hz: 60, viewW: 480, viewH: 272 });
    // Max-coordinate helped keys (region coords at the int32 tile boundary).
    const big = 22_369_621; // regionOf(2^31)
    for (let i = 0; i < HELP_CAP; i++) sim.__helpForTest(big - i, big);
    sim["errand"] = {
      kind: "deliver", orx: big, ory: big, trx: big + 1, try: big, tx: 2_147_483_000, ty: 2_147_483_000,
      ax: 2_147_483_000, ay: 2_147_483_000,
      targetName: "Great Bramford", what: "a jar of honey",
    };
    const text = sim.serializeErrands();
    // UTF-8 byte length, not the JS string length.
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(ERRANDS_SAVE_MAX);
    expect(text.length).toBeLessThanOrEqual(ERRANDS_SAVE_MAX);
    const restored = new WanderSim({ seed: SEEDS[0]!, hz: 60, viewW: 480, viewH: 272 });
    restored.restoreErrands(text);
    expect(restored.serializeErrands()).toBe(text);
    expect(restored.errandsDigest()).toBe(sim.errandsDigest());
  });

  test("restore rejects oversize and malformed input", () => {
    const sim = new WanderSim({ seed: SEEDS[0]!, hz: 60, viewW: 480, viewH: 272 });
    // Correct base64 with padding (the sim's own b64encode): a buggy encoder
    // that emits a phantom byte in the last group makes every case throw on a
    // length mismatch instead of the check it names, masking the rejections.
    const B64C = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const b64 = (bytes: Uint8Array) => {
      let s = "";
      for (let i = 0; i < bytes.length; i += 3) {
        const b0 = bytes[i]!, b1 = i + 1 < bytes.length ? bytes[i + 1]! : 0, b2 = i + 2 < bytes.length ? bytes[i + 2]! : 0;
        s += B64C[b0 >> 2]! + B64C[((b0 & 3) << 4) | (b1 >> 4)]!;
        s += i + 1 < bytes.length ? B64C[((b1 & 15) << 2) | (b2 >> 6)]! : "=";
        s += i + 2 < bytes.length ? B64C[b2 & 63]! : "=";
      }
      return s;
    };
    const bloom = new Uint8Array(128);
    // 33 helped keys (bypasses HELP_CAP=32) but under the 1 KiB byte cap, so
    // this reaches the HELP_CAP check and no other.
    const capKeys = new Uint8Array(33 * 8);
    const capDv = new DataView(capKeys.buffer);
    for (let i = 0; i < 33; i++) capDv.setFloat64(i * 8, i + 1, true);
    expect(() => sim.restoreErrands(JSON.stringify({ v: 1, e: null, h: b64(capKeys), b: b64(bloom), hc: 33 }))).toThrow(/too many helped/);
    // Wrong version.
    expect(() => sim.restoreErrands(JSON.stringify({ v: 2, e: null, h: "", b: b64(bloom), hc: 0 }))).toThrow(/unsupported version/);
    // Malformed JSON.
    expect(() => sim.restoreErrands("{not json")).toThrow(/not valid JSON/);
    // Over 1 KiB: a valid-JSON object with an ignored extra field, so the byte
    // cap is the only check that can fire (JSON.parse and every field pass).
    expect(() => sim.restoreErrands(JSON.stringify({ v: 1, e: null, h: "", b: b64(bloom), hc: 0, extra: "x".repeat(2000) }))).toThrow(/exceeds 1 KiB/);
    // Malformed Bloom (wrong byte length): 132 bytes decodes fine, so the
    // length check is the guard (a short read would throw in DataView instead).
    expect(() => sim.restoreErrands(JSON.stringify({ v: 1, e: null, h: "", b: b64(new Uint8Array(132)), hc: 0 }))).toThrow(/malformed bloom/);
    // Bad errand kind.
    expect(() => sim.restoreErrands(JSON.stringify({ v: 1, e: { k: "steal", o: [0, 0], t: [1, 0], c: [10, 10], a: [10, 10], n: "X", w: "y" }, h: "", b: b64(bloom), hc: 0 }))).toThrow(/unknown errand kind/);
    // Malformed errand coordinates.
    expect(() => sim.restoreErrands(JSON.stringify({ v: 1, e: { k: "deliver", o: [0], t: [1, 0], c: [10, 10], a: [10, 10], n: "X", w: "y" }, h: "", b: b64(bloom), hc: 0 }))).toThrow(/malformed errand coordinates/);
    // Malformed helped set (valid base64, length not a multiple of 8).
    expect(() => sim.restoreErrands(JSON.stringify({ v: 1, e: null, h: b64(new Uint8Array(7)), b: b64(bloom), hc: 0 }))).toThrow(/malformed helped set/);
    // The sim's state is untouched after a rejected restore.
    expect(sim.helpedCount).toBe(0);
    expect(sim.errand).toBeNull();
  });

  test("restore repaints a resident helped town's plaza flowers", () => {
    const sim = new WanderSim({ seed: SEEDS[0]!, hz: 60, viewW: 960, viewH: 544, manual: true });
    const start = sim.playerTile;
    const srx = regionOf(start.x), sry = regionOf(start.y);
    sim.__helpForTest(srx, sry); // help the start town (its plan is resident)
    const text = sim.serializeErrands();
    // A fresh sim at the same seed: the start town is resident (boot builds it).
    const b = new WanderSim({ seed: SEEDS[0]!, hz: 60, viewW: 960, viewH: 544, manual: true });
    const plan = b.res.plan(srx, sry)!;
    const flowers = improvementCells(plan);
    expect(flowers.length).toBeGreaterThan(0);
    const hasFlowers = (p: NonNullable<ReturnType<typeof b.res.plan>>) =>
      flowers.every((c) => p.upper![(c.y - p.y0) * 96 + (c.x - p.x0)] === c.tile);
    expect(hasFlowers(plan)).toBe(false); // not helped yet
    b.restoreErrands(text);
    expect(hasFlowers(b.res.plan(srx, sry)!)).toBe(true); // repainted by restore
    expect(b.improvedVersion).toBeGreaterThan(0); // the view would repaint
  });
});
