// tests/wander-online-journey.test.ts — single-player gameplay under realm
// authority: the private journey model and its persistence bound, the
// COMMAND / PLAYER_JOURNEY codecs, residents as a pure function of the realm
// clock, and the authoritative arena rules (plaza radius, delivery target,
// talk adjacency, visit arrival, once-only shared improvement under
// competition, the lockstep fast bit, and the fixed landmark sighting box).
import { describe, expect, test } from "bun:test";
import { planRegion, regionName } from "../examples/wander/region.ts";
import { regionHub, regionOf } from "../examples/wander/world.ts";
import { purePlacedLandmark, pureLmPeek, townErrand, townFacts, townPlaque, townTalk, warmLandmark, type Errand, type TownLookups } from "../examples/wander/towns.ts";
import { HELP_CAP as SIM_HELP_CAP, PLAZA_RADIUS as SIM_PLAZA_RADIUS, VISIT_ARRIVE as SIM_VISIT_ARRIVE } from "../examples/wander/wander-sim.ts";
import {
  emptyJourney,
  errandHudText,
  fitJourney,
  HELP_CAP,
  HELPED_COUNT_MAX,
  journeyAccept,
  journeyComplete,
  journeyEventText,
  journeyIsHelped,
  journeyTalk,
  JOURNEY_EVENT,
  JOURNEY_SAVE_MAX,
  JOURNEY_SAVE_WORST_CASE,
  mergeJourney,
  parseJourney,
  PLAZA_RADIUS,
  resolveErrand,
  sameJourney,
  serializeJourney,
  TALK_CAP,
  VISIT_ARRIVE,
  type PlayerJourney,
} from "../examples/wander-online/net/journey.ts";
import { HELPED_BLOOM_WORDS } from "../examples/wander/helped-bloom.ts";
import { frontTile, plaqueOf, talkTarget, ticksSinceDiscovery, townResidentsAt, villagerPoseAt, NPC_STEP_TICKS } from "../examples/wander-online/net/npc.ts";
import {
  BTN,
  COMMAND,
  COMMAND_BYTES,
  FAST_SPEED,
  INPUT_BUTTON_MASK,
  MSG,
  PLAYER_JOURNEY_FIXED_BYTES,
  REGION_STATE_FLAG_INITIAL,
  WALK_SPEED,
  decodeCommand,
  decodePlayerJourney,
  decodeState4,
  encodeCommand,
  encodePlayerJourney,
  speedFor,
  type PlayerJourneyMessage,
} from "../examples/wander-online/net/protocol.ts";
import { RealmPredictor } from "../examples/wander-online/net/realm-predict.ts";
import { REALM_LANDMARK_HALF_H, REALM_LANDMARK_HALF_W } from "../examples/wander-online/net/realm-state.ts";
import { RealmArena, TALK_TOLERANCE, type RealmPlayer } from "../examples/wander-online/server/realm-area.ts";
import { entityFor, snapshotForRealm } from "../examples/wander-online/shared/snapshot.ts";
import { GROWTH_TICK_FRAMES } from "../examples/wander/region.ts";

/** The hosted demo's realm: region (0,0) "Lower Nettlevale" offers a
 *  delivery to (0,-1); region (4,0) is a snow town beside OLD CAMP. */
const SEED = 1593842689;
const VISIT_SEED = 0x5eed_0001;

function teleport(p: RealmPlayer, tx: number, ty: number, facing = 0): void {
  p.state = {
    ...p.state,
    move: { ...p.state.move, tx, ty, px: tx * 16, py: ty * 16, facing: facing as 0 | 1 | 2 | 3, phase: 0, moving: false, walking: false },
  };
  p.scanX = null;
  p.scanY = null;
}

function arenaAt(seed: number, clock: { now: number }): RealmArena {
  return new RealmArena({ seed, hz: 60, now: () => clock.now, epoch: 9 });
}

const onlineLookups = (seed: number): TownLookups => ({
  hubOf: (rx, ry) => regionHub(seed, rx, ry),
  landmarkOf: (rx, ry) => purePlacedLandmark(seed, rx, ry),
});

describe("journey model", () => {
  test("bounds are the single-player sim's", () => {
    expect(HELP_CAP).toBe(SIM_HELP_CAP);
    expect(PLAZA_RADIUS).toBe(SIM_PLAZA_RADIUS);
    expect(VISIT_ARRIVE).toBe(SIM_VISIT_ARRIVE);
    expect(TALK_CAP).toBe(24);
  });

  test("accept, complete (idempotent help), talk, serialize and restore within the save bound", () => {
    const errand = townErrand(SEED, 0, 0)!;
    expect(errand.kind).toBe("deliver");
    let j = emptyJourney();
    expect(journeyAccept(SEED, j, 4, 0)).toBeNull(); // West Roserest offers nothing
    const accepted = journeyAccept(SEED, j, 0, 0)!;
    j = accepted.journey;
    expect(accepted.errand).toEqual(errand);
    expect(journeyAccept(SEED, j, 0, 0)).toBeNull(); // one errand at a time
    expect(resolveErrand(SEED, j)).toEqual(errand);
    const done = journeyComplete(SEED, j, errand);
    expect(done.newlyHelped).toBe(true);
    expect([done.hrx, done.hry]).toEqual([errand.trx, errand.try]);
    j = done.journey;
    expect(j.errand).toBeNull();
    expect(j.helpedCount).toBe(1);
    expect(journeyIsHelped(SEED, j, errand.trx, errand.try)).toBe(true);
    expect(journeyIsHelped(SEED, j, 7, 7)).toBe(false);
    const again = journeyComplete(SEED, journeyAccept(SEED, j, 0, 0)!.journey, errand);
    expect(again.newlyHelped).toBe(false);
    expect(again.journey.helpedCount).toBe(1);
    const talked = journeyTalk(j, 0, 0);
    expect(talked.changed).toBe(true);
    expect(journeyTalk(talked.journey, 0, 0).changed).toBe(false);
    j = talked.journey;
    // Fill every bound and prove the save still fits the single-player budget.
    let full = j;
    for (let i = 0; i < 40; i++) full = journeyTalk(full, 100 + i, -100 - i).journey;
    for (let i = 0; i < 40; i++) {
      full = { ...full, errand: null };
      const e = { ...errand, kind: "deliver" as const, trx: 1000 + i, try: -1000 - i };
      full = journeyComplete(SEED, full, e).journey;
    }
    expect(full.helped).toHaveLength(HELP_CAP);
    expect(full.talked).toHaveLength(TALK_CAP);
    expect(full.helpedCount).toBe(41);
    expect(journeyIsHelped(SEED, full, 1000, -1000), "evicted towns stay helped through the Bloom").toBe(true);
    const text = serializeJourney({ ...full, errand: { rx: -2_000_000_000, ry: 2_000_000_000 } });
    expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(JOURNEY_SAVE_MAX);
    expect(sameJourney(parseJourney(text), { ...full, errand: { rx: -2_000_000_000, ry: 2_000_000_000 } })).toBe(true);
    expect(parseJourney(serializeJourney(j))).toEqual(j);
  });

  /** Every town offer in a square of regions around (crx, cry), nearest first. */
  function farOffers(seed: number, crx: number, cry: number, radius: number): { rx: number; ry: number; errand: Errand }[] {
    const out: { rx: number; ry: number; errand: Errand }[] = [];
    for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
      const rx = crx + dx, ry = cry + dy;
      if (!regionHub(seed, rx, ry).town) continue;
      const errand = townErrand(seed, rx, ry);
      if (errand) out.push({ rx, ry, errand });
    }
    return out;
  }

  /** Accept, finish and talk through real offers until every FIFO is full. */
  function fillJourney(seed: number, offers: { rx: number; ry: number; errand: Errand }[]): PlayerJourney {
    let j = emptyJourney();
    for (const { rx, ry, errand } of offers) {
      if (j.helped.length >= HELP_CAP && j.talked.length >= TALK_CAP) break;
      const accepted = journeyAccept(seed, j, rx, ry);
      if (!accepted) throw new Error(`offer at ${rx},${ry} was refused`);
      expect(accepted.errand).toEqual(errand);
      j = journeyComplete(seed, accepted.journey, errand).journey;
      j = journeyTalk(j, rx, ry).journey;
    }
    return j;
  }

  test("real far offers fill every FIFO and the Bloom; the row exceeds 1 KiB and still fits the bound", () => {
    // Nine-digit region coordinates: the coordinates of an unbounded walk,
    // not the short fixture ones. The old 1 KiB bound broke here.
    const offers = farOffers(SEED, 100_000_000, -100_000_000, 40);
    expect(offers.length).toBeGreaterThanOrEqual(HELP_CAP + 8);
    const full = fillJourney(SEED, offers);
    expect(full.helped).toHaveLength(HELP_CAP);
    expect(full.talked).toHaveLength(TALK_CAP);
    expect(full.helpedCount).toBeGreaterThanOrEqual(HELP_CAP);
    expect(full.bloom.some((w) => w !== 0)).toBe(true);
    const accepted = journeyAccept(SEED, full, offers[offers.length - 1]!.rx, offers[offers.length - 1]!.ry)!;
    const text = serializeJourney(accepted.journey);
    const bytes = new TextEncoder().encode(text).byteLength;
    expect(bytes, "a legal far journey is larger than the old 1 KiB bound").toBeGreaterThan(1024);
    expect(bytes).toBeLessThanOrEqual(JOURNEY_SAVE_WORST_CASE);
    expect(bytes).toBeLessThanOrEqual(JOURNEY_SAVE_MAX);
    expect(sameJourney(parseJourney(text), accepted.journey), "nothing was dropped to fit").toBe(true);
    // Every helped town, exact or evicted, is still remembered.
    for (const { errand } of offers.slice(0, HELP_CAP)) {
      const hrx = errand.kind === "deliver" ? errand.trx : errand.orx;
      const hry = errand.kind === "deliver" ? errand.try : errand.ory;
      expect(journeyIsHelped(SEED, accepted.journey, hrx, hry)).toBe(true);
    }
  });

  test("the worst case (full FIFOs, int32 coordinates, saturated Bloom and count) is exactly the derived bound", () => {
    const M = -0x80000000;
    const worst: PlayerJourney = {
      errand: { rx: M, ry: M },
      helped: Array.from({ length: HELP_CAP }, (_, i) => ({ rx: M + i, ry: M })),
      bloom: new Array<number>(HELPED_BLOOM_WORDS).fill(0xffffffff),
      talked: Array.from({ length: TALK_CAP }, (_, i) => ({ rx: M, ry: M + i })),
      helpedCount: HELPED_COUNT_MAX,
    };
    const text = serializeJourney(worst);
    expect(new TextEncoder().encode(text).byteLength).toBe(JOURNEY_SAVE_WORST_CASE);
    expect(JOURNEY_SAVE_WORST_CASE).toBeLessThanOrEqual(JOURNEY_SAVE_MAX);
    expect(sameJourney(parseJourney(text), worst)).toBe(true);
    // The count saturates instead of growing past the stored u16.
    const errand = townErrand(SEED, 0, 0)!;
    const saturated = journeyComplete(SEED, { ...emptyJourney(), helpedCount: HELPED_COUNT_MAX }, errand).journey;
    expect(saturated.helpedCount).toBe(HELPED_COUNT_MAX);
    // Mutation: widen a cap or shorten the bound and the equality or the
    // ordering above breaks.
    expect(() => parseJourney("x".repeat(JOURNEY_SAVE_MAX + 1))).toThrow();
  });

  test("an over-bound row degrades oldest talked, then oldest helped, and never loses errand, Bloom or count", () => {
    const offers = farOffers(SEED, 100_000_000, -100_000_000, 40);
    const full = journeyAccept(SEED, fillJourney(SEED, offers), offers[offers.length - 1]!.rx, offers[offers.length - 1]!.ry)!.journey;
    const fullBytes = new TextEncoder().encode(serializeJourney(full)).byteLength;
    expect(fitJourney(full).dropped, "a reachable journey is never degraded at the real bound").toBe(0);
    // One byte short: only the oldest talked town(s) go; the helped list
    // is untouched and the newest talk survives at the end.
    const nibble = fitJourney(full, fullBytes - 1);
    expect(nibble.dropped).toBeGreaterThanOrEqual(1);
    expect(nibble.dropped).toBeLessThan(TALK_CAP);
    expect(nibble.journey.talked).toHaveLength(TALK_CAP - nibble.dropped);
    expect(nibble.journey.talked, "kept talked towns are the newest tail").toEqual(full.talked.slice(nibble.dropped));
    expect(nibble.journey.talked[0]).not.toEqual(full.talked[0]);
    expect(nibble.journey.helped).toEqual(full.helped);
    const small = Math.floor(fullBytes * 0.6);
    const { journey: fitted, dropped } = fitJourney(full, small);
    expect(dropped).toBeGreaterThan(0);
    expect(fitted.talked.length).toBeLessThan(full.talked.length);
    expect(fitted.errand).toEqual(full.errand);
    expect(fitted.bloom).toEqual(full.bloom);
    expect(fitted.helpedCount).toBe(full.helpedCount);
    // FIFO direction: the survivors are exactly the newest tail of each
    // list, in order. (Mutation: `slice(0, -1)` in fitJourney keeps the
    // oldest head instead and the tails differ.)
    expect(fitted.talked, "kept talked towns are the newest tail").toEqual(full.talked.slice(full.talked.length - fitted.talked.length));
    expect(fitted.helped, "kept helped towns are the newest tail").toEqual(full.helped.slice(full.helped.length - fitted.helped.length));
    const text = serializeJourney(full, small);
    expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(small);
    expect(sameJourney(parseJourney(text), fitted)).toBe(true);
    // Towns whose exact entry was dropped are still helped through the Bloom.
    for (const p of full.helped) expect(journeyIsHelped(SEED, fitted, p.rx, p.ry)).toBe(true);
    // Only an irreducible row throws.
    expect(() => serializeJourney(full, 40)).toThrow(RangeError);
  });

  test("a bound below the talked list empties it and trims the oldest exact helped towns, newest kept in order", () => {
    const offers = farOffers(SEED, 100_000_000, -100_000_000, 40);
    const full = journeyAccept(SEED, fillJourney(SEED, offers), offers[offers.length - 1]!.rx, offers[offers.length - 1]!.ry)!.journey;
    expect(full.helped).toHaveLength(HELP_CAP);
    expect(full.talked).toHaveLength(TALK_CAP);
    // The irreducible row (errand, Bloom, count, empty lists) plus room for
    // a few helped entries: every talked town must go and most helped too.
    const base = new TextEncoder().encode(serializeJourney({ ...full, talked: [], helped: [] })).byteLength;
    const fullBytes = new TextEncoder().encode(serializeJourney(full)).byteLength;
    const bound = base + Math.floor((fullBytes - base) / 6);
    const { journey: fitted, dropped } = fitJourney(full, bound);
    expect(fitted.talked, "talk memories go before any exact helped town").toHaveLength(0);
    expect(fitted.helped.length).toBeGreaterThan(0);
    expect(fitted.helped.length).toBeLessThan(HELP_CAP);
    expect(dropped).toBe(TALK_CAP + (HELP_CAP - fitted.helped.length));
    // The oldest exact helped towns were dropped: what remains is the
    // newest tail, in its original order, not the oldest head.
    expect(fitted.helped, "kept helped towns are the newest tail").toEqual(full.helped.slice(full.helped.length - fitted.helped.length));
    expect(fitted.helped[fitted.helped.length - 1]).toEqual(full.helped[HELP_CAP - 1]);
    expect(fitted.helped[0]).not.toEqual(full.helped[0]);
    // Progress that cannot be recomputed is untouched.
    expect(fitted.errand).toEqual(full.errand);
    expect(fitted.bloom).toEqual(full.bloom);
    expect(fitted.helpedCount).toBe(full.helpedCount);
    const text = serializeJourney(full, bound);
    expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(bound);
    expect(sameJourney(parseJourney(text), fitted)).toBe(true);
    for (const p of full.helped) expect(journeyIsHelped(SEED, fitted, p.rx, p.ry)).toBe(true);
  });

  test("two sessions of one account merge without a stale write losing progress", () => {
    const base = emptyJourney();
    const errand = townErrand(SEED, 0, 0)!;
    // The review's construction: A accepts an errand, B (still at the base)
    // only moved, then B writes. The merge keeps A's errand.
    const a = journeyAccept(SEED, base, 0, 0)!.journey;
    expect(mergeJourney(base, a, base)).toEqual(a);
    expect(mergeJourney(base, base, a)).toEqual(a);
    // Both progressed: helped, talked, Bloom and count unite; the errand
    // follows the side that changed it, the stored side when both did.
    const aDone = journeyComplete(SEED, a, errand).journey;
    const bTalk = journeyTalk(journeyTalk(base, 7, -7).journey, 8, -8).journey;
    const merged = mergeJourney(base, aDone, bTalk);
    expect(merged.errand).toBeNull();
    expect(merged.helped).toEqual(aDone.helped);
    expect(merged.talked).toEqual(bTalk.talked);
    expect(merged.bloom).toEqual(aDone.bloom);
    expect(merged.helpedCount).toBe(1);
    expect(sameJourney(mergeJourney(base, bTalk, aDone), merged)).toBe(true);
    // Disjoint helps from both sides count twice; the same help once.
    const visit = { ...errand, kind: "visit" as const, orx: 5, ory: 5 };
    const bDone = journeyComplete(SEED, journeyAccept(SEED, base, 0, 0)!.journey, visit).journey;
    const both = mergeJourney(base, aDone, bDone);
    expect(both.helped).toEqual([...aDone.helped, ...bDone.helped]);
    expect(both.helpedCount).toBe(2);
    expect(journeyIsHelped(SEED, both, 5, 5)).toBe(true);
    expect(journeyIsHelped(SEED, both, errand.trx, errand.try)).toBe(true);
    expect(mergeJourney(base, aDone, aDone).helpedCount).toBe(1);
    // Both changed the errand: the stored side wins.
    const theirs = journeyAccept(SEED, base, 0, 0)!.journey;
    const mine = { ...base, errand: { rx: 9, ry: 9 } };
    expect(mergeJourney(base, theirs, mine).errand).toEqual({ rx: 0, ry: 0 });
    // Caps hold after a union.
    const big = fillJourney(SEED, farOffers(SEED, 100_000_000, -100_000_000, 40));
    const other = journeyTalk(base, 1, 1).journey;
    const capped = mergeJourney(base, big, other);
    expect(capped.helped.length).toBeLessThanOrEqual(HELP_CAP);
    expect(capped.talked).toHaveLength(TALK_CAP);
    expect(capped.talked.at(-1)).toEqual({ rx: 1, ry: 1 });
  });

  test("restore accepts the pre-journey placeholder and refuses malformed rows", () => {
    expect(parseJourney("")).toEqual(emptyJourney());
    expect(parseJourney(JSON.stringify({ v: 1, active: [] }))).toEqual(emptyJourney());
    expect(() => parseJourney("{")).toThrow();
    expect(() => parseJourney(JSON.stringify({ v: 3 }))).toThrow();
    expect(() => parseJourney(JSON.stringify({ v: 2, h: [[1]] }))).toThrow();
    expect(() => parseJourney(JSON.stringify({ v: 2, h: Array.from({ length: 33 }, (_, i) => [i, 0]) }))).toThrow();
    expect(() => parseJourney(JSON.stringify({ v: 2, b: [-1] }))).toThrow();
    expect(() => parseJourney(JSON.stringify({ v: 2, e: [1.5, 0] }))).toThrow();
    expect(() => parseJourney("x".repeat(JOURNEY_SAVE_MAX + 1))).toThrow();
  });

  test("notice and HUD text equal the single-player strings", () => {
    const errand = townErrand(SEED, 0, 0)!;
    expect(journeyEventText(SEED, { seq: 1, kind: JOURNEY_EVENT.accepted, rx: 0, ry: 0 })).toBe(`ERRAND: carry ${errand.what} to ${errand.targetName}`);
    expect(journeyEventText(SEED, { seq: 2, kind: JOURNEY_EVENT.delivered, rx: 0, ry: -1 })).toBe(`DELIVERED: ${regionName(SEED, 0, -1)} thanks you — flowers on the plaza`);
    expect(journeyEventText(SEED, { seq: 3, kind: JOURNEY_EVENT.visited, rx: 0, ry: -1 })).toBe(`DONE: ${regionName(SEED, 0, -1)} thanks you — flowers on their plaza`);
    expect(journeyEventText(SEED, { seq: 4, kind: JOURNEY_EVENT.talked, rx: 0, ry: 0 })).toBe("");
    expect(errandHudText(null, 3)).toBe("ERRAND: none   HELPED 3");
    expect(errandHudText(errand, 0)).toBe(`ERRAND: carry ${errand.what} -> ${errand.targetName}   HELPED 0`);
    const visit = townErrand(VISIT_SEED, -1, -1)!;
    expect(visit.kind).toBe("visit");
    expect(errandHudText(visit, 2)).toBe(`ERRAND: ${visit.what} -> ${visit.targetName}   HELPED 2`);
  });
});

describe("static text parity", () => {
  test("board and resident lines match the single-player token resolver for a sample of towns", () => {
    // The sim resolves facts through regionHub and the warm pure landmark
    // cache; the online view resolves through regionHub and the computing
    // lookup. Once the sim's cache is warm both must yield identical lines.
    const simLookups: TownLookups = {
      hubOf: (rx, ry) => regionHub(SEED, rx, ry),
      landmarkOf: (rx, ry) => pureLmPeek(SEED, rx, ry) ?? null,
    };
    let towns = 0, lines = 0;
    for (let ry = -3; ry <= 3 && towns < 12; ry++) for (let rx = -3; rx <= 3 && towns < 12; rx++) {
      if (!regionHub(SEED, rx, ry).town) continue;
      const plan = planRegion(SEED, rx, ry);
      if (plan.empty) continue;
      for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) warmLandmark(SEED, rx + dx, ry + dy);
      towns++;
      for (const helped of [false, true]) {
        const onlineFacts = townFacts(SEED, plan, onlineLookups(SEED));
        const simFacts = townFacts(SEED, plan, simLookups);
        const onlineErrand = townErrand(SEED, rx, ry);
        const simErrand = townErrand(SEED, rx, ry, simLookups.landmarkOf);
        expect(townPlaque(SEED, plan, onlineFacts, onlineErrand, helped)).toEqual(townPlaque(SEED, plan, simFacts, simErrand, helped));
        lines += 3;
        for (const v of plan.villagers) {
          expect(townTalk(SEED, plan, v.house, onlineFacts, onlineErrand, helped).lines)
            .toEqual(townTalk(SEED, plan, v.house, simFacts, simErrand, helped).lines);
          lines += 4;
        }
      }
    }
    expect(towns).toBeGreaterThanOrEqual(6);
    expect(lines).toBeGreaterThan(100);
  });
});

describe("COMMAND and PLAYER_JOURNEY codecs", () => {
  test("COMMAND is exactly 11 bytes and strict", () => {
    const buf = encodeCommand({ kind: COMMAND.talk, rx: -123456, ry: 654321, extra: 7 });
    expect(buf.byteLength).toBe(COMMAND_BYTES);
    expect(decodeCommand(buf)).toEqual({ kind: COMMAND.talk, rx: -123456, ry: 654321, extra: 7 });
    expect(decodeCommand(new Uint8Array(buf).subarray(0, 10))).toBeNull();
    const longer = new Uint8Array(12);
    longer.set(new Uint8Array(buf));
    expect(decodeCommand(longer)).toBeNull();
    const zeroKind = new Uint8Array(buf.slice(0));
    zeroKind[1] = 0;
    expect(decodeCommand(zeroKind)).toBeNull();
    expect(() => encodeCommand({ kind: 0, rx: 0, ry: 0, extra: 0 })).toThrow();
    expect(() => encodeCommand({ kind: 1, rx: 2 ** 31, ry: 0, extra: 0 })).toThrow();
  });

  test("PLAYER_JOURNEY round-trips and rejects truncation, trailing bytes, bad flags and duplicates", () => {
    const message: PlayerJourneyMessage = {
      revision: 42,
      eventSeq: 7,
      eventKind: JOURNEY_EVENT.delivered,
      eventRx: -5,
      eventRy: 9,
      fast: true,
      errand: { rx: 3, ry: -4 },
      helpedCount: 1000,
      bloom: Array.from({ length: 32 }, (_, i) => (i * 0x9e3779b9) >>> 0),
      helped: [{ rx: 1, ry: 2 }, { rx: -3, ry: 4 }],
      talked: [{ rx: 1, ry: 2 }],
    };
    const buf = encodePlayerJourney(message);
    expect(buf.byteLength).toBe(PLAYER_JOURNEY_FIXED_BYTES + 3 * 8);
    expect(new Uint8Array(buf)[0]).toBe(MSG.playerJourney);
    expect(decodePlayerJourney(buf)).toEqual(message);
    const none = encodePlayerJourney({ ...message, errand: null, fast: false, helped: [], talked: [] });
    expect(none.byteLength).toBe(PLAYER_JOURNEY_FIXED_BYTES);
    expect(decodePlayerJourney(none)?.errand).toBeNull();
    expect(decodePlayerJourney(new Uint8Array(buf).subarray(0, buf.byteLength - 1))).toBeNull();
    const trailing = new Uint8Array(buf.byteLength + 1);
    trailing.set(new Uint8Array(buf));
    expect(decodePlayerJourney(trailing)).toBeNull();
    const badFlags = new Uint8Array(buf.slice(0));
    badFlags[18] |= 0x80;
    expect(decodePlayerJourney(badFlags)).toBeNull();
    expect(() => encodePlayerJourney({ ...message, helped: [{ rx: 1, ry: 2 }, { rx: 1, ry: 2 }] })).toThrow();
    expect(() => encodePlayerJourney({ ...message, bloom: message.bloom.slice(1) })).toThrow();
    expect(() => encodePlayerJourney({ ...message, helped: Array.from({ length: 33 }, (_, i) => ({ rx: i, ry: 0 })) })).toThrow();
  });

  test("the fast bit is part of the honoured input mask and selects the bounded speed", () => {
    expect(INPUT_BUTTON_MASK).toBe(0x01f0);
    expect(speedFor(BTN.right)).toBe(WALK_SPEED);
    expect(speedFor(BTN.right | BTN.fast)).toBe(FAST_SPEED);
    expect(speedFor(0x8e00)).toBe(WALK_SPEED);
  });
});

describe("residents as a pure function of the realm clock", () => {
  const plan = planRegion(SEED, 4, 0);

  test("a resident is unborn before its growth tick, then walks its route at 8 ticks per step", () => {
    const v = plan.villagers[0]!;
    expect(v.born).toBeGreaterThan(0);
    expect(villagerPoseAt(v, v.born * GROWTH_TICK_FRAMES - 1)).toBeNull();
    const born = villagerPoseAt(v, v.born * GROWTH_TICK_FRAMES)!;
    expect([born.tx, born.ty, born.phase]).toEqual([v.x, v.y, 0]);
    const period = v.route.length * NPC_STEP_TICKS;
    const t0 = v.born * GROWTH_TICK_FRAMES;
    for (let k = 0; k < period; k++) {
      const a = villagerPoseAt(v, t0 + k)!, b = villagerPoseAt(v, t0 + k + period)!;
      expect([a.tx, a.ty, a.px, a.py, a.facing, a.phase]).toEqual([b.tx, b.ty, b.px, b.py, b.facing, b.phase]);
      expect(Math.abs(a.px - a.tx * 16)).toBeLessThanOrEqual(14);
    }
    // After the first full step the resident stands one tile from its door.
    const stepped = villagerPoseAt(v, t0 + NPC_STEP_TICKS)!;
    expect(Math.abs(stepped.tx - v.x) + Math.abs(stepped.ty - v.y)).toBe(1);
    // Ends of the route (the wait steps) hold the tile still.
    const mid = villagerPoseAt(v, t0 + (v.route.length / 2 - 1) * NPC_STEP_TICKS + 3)!;
    expect(mid.phase).toBe(0);
  });

  test("every born resident appears once; the clock derives from the discovery stamp", () => {
    expect(ticksSinceDiscovery(1000, 1000 + 1000)).toBe(60);
    expect(ticksSinceDiscovery(5000, 1000)).toBe(0);
    const all = townResidentsAt(plan, 10_000_000);
    expect(all).toHaveLength(plan.villagers.length);
    expect(new Set(all.map((r) => r.id)).size).toBe(all.length);
    expect(all.every((r) => r.rx === 4 && r.ry === 0)).toBe(true);
    expect(townResidentsAt(plan, 0)).toHaveLength(plan.villagers.filter((v) => v.born === 0).length);
  });

  test("talk targets the resident in front of (or under) the mover; the board sits at hub+(1,1)", () => {
    const residents = townResidentsAt(plan, 10_000_000);
    const r = residents[3]!;
    expect(talkTarget({ tx: r.tx, ty: r.ty - 1, facing: 0 }, residents)?.id).toBe(r.id);
    expect(talkTarget({ tx: r.tx, ty: r.ty + 1, facing: 2 }, residents)?.id).toBe(r.id);
    expect(talkTarget({ tx: r.tx, ty: r.ty, facing: 1 }, residents)?.id).toBe(r.id);
    const away = talkTarget({ tx: r.tx + 7, ty: r.ty + 7, facing: 3 }, residents);
    expect(away === null || (away.tx === r.tx + 8 && away.ty === r.ty + 7)).toBe(true);
    expect(frontTile({ tx: 1, ty: 1, facing: 3 })).toEqual({ x: 2, y: 1 });
    const board = plaqueOf(plan)!;
    expect([board.x, board.y]).toEqual([plan.hub.x + 1, plan.hub.y + 1]);
    expect(board.born).toBeGreaterThanOrEqual(0);
  });
});

describe("authoritative arena rules", () => {
  test("accept needs the plaza, deliver needs the target town, and a bystander learns nothing private", () => {
    const clock = { now: 1_000_000 };
    const arena = arenaAt(SEED, clock);
    const hub = regionHub(SEED, 0, 0);
    const errand = townErrand(SEED, 0, 0)!;
    const p = arena.add("Ada", 1, 0, { tx: hub.x + PLAZA_RADIUS + 1, ty: hub.y });
    expect(arena.applyCommand(p, { kind: COMMAND.acceptErrand, rx: 0, ry: 0, extra: 0 }, clock.now)).toBeNull();
    expect(p.journeyDirty).toBe(false);
    teleport(p, hub.x + PLAZA_RADIUS, hub.y);
    expect(arena.applyCommand(p, { kind: COMMAND.acceptErrand, rx: 1, ry: 0, extra: 0 }, clock.now), "region must match").toBeNull();
    expect(arena.applyCommand(p, { kind: COMMAND.acceptErrand, rx: 0, ry: 0, extra: 0 }, clock.now)).toBe(JOURNEY_EVENT.accepted);
    expect(p.journey.errand).toEqual({ rx: 0, ry: 0 });
    expect(p.journeyDirty).toBe(true);
    expect(arena.applyCommand(p, { kind: COMMAND.deliverErrand, rx: 0, ry: 0, extra: 0 }, clock.now), "not the target").toBeNull();
    const message = arena.journeyMessage(p);
    expect(message.errand).toEqual({ rx: 0, ry: 0 });
    expect(message.eventKind).toBe(JOURNEY_EVENT.accepted);
    expect(JSON.stringify(message)).not.toContain("Ada");
    teleport(p, errand.tx, errand.ty);
    arena.stepRefTick();
    expect(arena.applyCommand(p, { kind: COMMAND.deliverErrand, rx: errand.trx, ry: errand.try, extra: 0 }, clock.now)).toBe(JOURNEY_EVENT.delivered);
    expect(p.journey.errand).toBeNull();
    expect(p.journey.helped).toEqual([{ rx: errand.trx, ry: errand.try }]);
    expect(arena.world.regionState(errand.trx, errand.try)?.improvementLevel).toBe(1);
    const rows = arena.drainChangedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.improvementLevel).toBe(1);
    expect(arena.drainChangedRows()).toHaveLength(0);
  });

  test("two players completing the same errand in the same tick raise the shared improvement once", () => {
    const clock = { now: 2_000_000 };
    const arena = arenaAt(SEED, clock);
    const hub = regionHub(SEED, 0, 0);
    const errand = townErrand(SEED, 0, 0)!;
    const a = arena.add("A", 1, 0, { tx: hub.x, ty: hub.y });
    const b = arena.add("B", 2, 0, { tx: hub.x, ty: hub.y });
    const c = arena.add("C", 3, 0, { tx: hub.x, ty: hub.y });
    for (const p of [a, b]) expect(arena.applyCommand(p, { kind: COMMAND.acceptErrand, rx: 0, ry: 0, extra: 0 }, clock.now)).toBe(JOURNEY_EVENT.accepted);
    for (const p of [a, b]) teleport(p, errand.tx, errand.ty);
    arena.stepRefTick();
    const before = arena.realmRevision;
    const target = arena.world.regionState(errand.trx, errand.try)!;
    expect(target.improvementLevel).toBe(0);
    expect(arena.applyCommand(a, { kind: COMMAND.deliverErrand, rx: errand.trx, ry: errand.try, extra: 0 }, clock.now)).toBe(JOURNEY_EVENT.delivered);
    expect(arena.applyCommand(b, { kind: COMMAND.deliverErrand, rx: errand.trx, ry: errand.try, extra: 0 }, clock.now)).toBe(JOURNEY_EVENT.delivered);
    const rows = arena.drainChangedRows();
    expect(rows, "exactly one shared change").toHaveLength(1);
    expect(rows[0]!.improvementLevel).toBe(1);
    expect(arena.realmRevision).toBe(before + 1);
    expect(a.journey.helpedCount).toBe(1);
    expect(b.journey.helpedCount).toBe(1);
    expect(c.journey.helpedCount).toBe(0);
    expect(c.journeyDirty).toBe(false);
    // The shared row is level 1 for everyone who looks; the bystander's
    // own snapshot stays private and untouched.
    expect(arena.world.regionState(errand.trx, errand.try)?.improvementLevel).toBe(1);
    expect(arena.regionSnapshotFor(a, 0).rows.find((r) => r.rx === errand.trx && r.ry === errand.try)?.improvementLevel).toBe(1);
    expect(arena.journeyMessage(c).helped).toEqual([]);
  });

  test("a visit errand completes on arrival within VISIT_ARRIVE and helps the offering town", () => {
    const clock = { now: 3_000_000 };
    // Region (1,-2) is a town whose offer is a visit to Juniperkiln's landmark.
    const arena = arenaAt(SEED, clock);
    const errand = townErrand(SEED, 1, -2)!;
    expect(errand.kind).toBe("visit");
    const hub = regionHub(SEED, 1, -2);
    expect(hub.town).toBe(true);
    const p = arena.add("V", 1, 0, { tx: hub.x, ty: hub.y });
    expect(arena.applyCommand(p, { kind: COMMAND.acceptErrand, rx: 1, ry: -2, extra: 0 }, clock.now)).toBe(JOURNEY_EVENT.accepted);
    p.journeyDirty = false;
    teleport(p, errand.ax + VISIT_ARRIVE + 1, errand.ay);
    arena.stepRefTick();
    expect(p.journey.errand).not.toBeNull();
    teleport(p, errand.ax + VISIT_ARRIVE, errand.ay);
    arena.stepRefTick();
    expect(p.journey.errand).toBeNull();
    expect(p.event.kind).toBe(JOURNEY_EVENT.visited);
    expect([p.event.rx, p.event.ry]).toEqual([1, -2]);
    expect(p.journey.helped).toEqual([{ rx: 1, ry: -2 }]);
    expect(arena.world.regionState(1, -2)?.improvementLevel).toBe(1);
  });

  test("talk is confirmed only next to the resident at the server's clock and records the town once", () => {
    const clock = { now: 4_000_000 };
    const arena = arenaAt(SEED, clock);
    const plan = planRegion(SEED, 4, 0);
    const p = arena.add("T", 1, 0, { tx: plan.hub.x, ty: plan.hub.y });
    const row = arena.world.regionState(4, 0)!;
    clock.now += 10 * 60 * 1000; // every resident is born
    arena.stepRefTick();
    const residents = townResidentsAt(plan, ticksSinceDiscovery(row.discoveredAtMs, clock.now));
    expect(residents).toHaveLength(plan.villagers.length);
    const r = residents[0]!;
    teleport(p, r.tx + TALK_TOLERANCE + 1, r.ty);
    expect(arena.applyCommand(p, { kind: COMMAND.talk, rx: 4, ry: 0, extra: 0 }, clock.now)).toBeNull();
    teleport(p, r.tx + TALK_TOLERANCE, r.ty);
    expect(arena.applyCommand(p, { kind: COMMAND.talk, rx: 4, ry: 0, extra: 0 }, clock.now)).toBe(JOURNEY_EVENT.talked);
    expect(p.journey.talked).toEqual([{ rx: 4, ry: 0 }]);
    const revision = p.journeyRevision;
    expect(arena.applyCommand(p, { kind: COMMAND.talk, rx: 4, ry: 0, extra: 0 }, clock.now)).toBe(JOURNEY_EVENT.talked);
    expect(p.journeyRevision, "a repeated talk changes nothing persistent").toBe(revision);
    expect(arena.applyCommand(p, { kind: COMMAND.talk, rx: 4, ry: 0, extra: 200 }, clock.now), "no such resident").toBeNull();
  });

  test("the fast bit moves 8 px per tick in lockstep; forged bits and a cheating predictor are overruled", () => {
    const clock = { now: 5_000_000 };
    const arena = arenaAt(SEED, clock);
    const hub = regionHub(SEED, 0, 0);
    const p = arena.add("F", 1, 0, { tx: hub.x, ty: hub.y });
    // Pick an open direction from the hub.
    const dirs = [[BTN.right, 1, 0, 3], [BTN.left, -1, 0, 1], [BTN.down, 0, 1, 0], [BTN.up, 0, -1, 2]] as const;
    const open = dirs.find(([, dx, dy]) => {
      const a = arena.world.collisionAt(hub.x + dx, hub.y + dy), b = arena.world.collisionAt(hub.x + 2 * dx, hub.y + 2 * dy);
      return a.ready && !a.blocked && b.ready && !b.blocked;
    })!;
    const [button, dx, dy] = open;
    const { id: _id, color: _color, ...mover } = entityFor(p);
    const initial = arena.regionSnapshotFor(p, REGION_STATE_FLAG_INITIAL);
    const honest = new RealmPredictor({ you: p.id, seed: SEED, generatorVersion: 1, epoch: arena.epoch, realmId: arena.realmId, realmRevision: initial.realmRevision, serverTimeMs: initial.serverTimeMs, mover });
    honest.world.applyRegionState(initial);
    let seq = 0;
    const fastMask = button | BTN.fast | 0x8e00; // unknown bits must be ignored by both sides
    for (let t = 0; t < 2; t++) {
      seq = honest.pushInput(fastMask, clock.now);
      arena.pushInput(p, seq, fastMask);
      arena.stepRefTick();
      expect(honest.reconcile(arena.epoch, p.lastSeq, { ...p.state.move })).toBe("matched");
    }
    expect(p.fast).toBe(true);
    expect(p.state.move.px - hub.x * 16).toBe(dx * 16);
    expect(p.state.move.py - hub.y * 16).toBe(dy * 16);
    arena.indexPlayers();
    const wire = decodeState4(snapshotForRealm(arena, p, 16))!;
    expect(wire.entities[0]!.fast).toBe(true);
    // Walking: the same two ticks cover a quarter of the distance.
    const walkStart = { px: p.state.move.px, py: p.state.move.py };
    for (let t = 0; t < 2; t++) {
      seq = honest.pushInput(button, clock.now);
      arena.pushInput(p, seq, button);
      arena.stepRefTick();
      expect(honest.reconcile(arena.epoch, p.lastSeq, { ...p.state.move })).toBe("matched");
    }
    expect(p.fast).toBe(false);
    expect(Math.abs(p.state.move.px - walkStart.px) + Math.abs(p.state.move.py - walkStart.py)).toBe(4);
    // A client that locally doubles its speed is corrected to the server mover.
    seq = honest.pushInput(fastMask, clock.now);
    honest.current.move.px += dx * 8;
    honest.current.move.py += dy * 8;
    arena.pushInput(p, seq, fastMask);
    arena.stepRefTick();
    expect(honest.reconcile(arena.epoch, p.lastSeq, { ...p.state.move })).toBe("corrected");
    expect(honest.current.move.px).toBe(p.state.move.px);
    expect(honest.current.move.py).toBe(p.state.move.py);
    // Only unknown bits: nothing moves and fast stays off.
    const before = { ...p.state.move };
    arena.pushInput(p, ++seq, 0x8e00);
    arena.stepRefTick();
    expect(p.fast).toBe(false);
    expect([p.state.move.tx, p.state.move.ty, p.state.move.px, p.state.move.py]).toEqual([before.tx, before.ty, before.px, before.py]);
  });

  test("landmark sighting uses the fixed 15x8 box and the region's growth, never a viewport", () => {
    const lm = purePlacedLandmark(SEED, 4, 0)!;
    expect(lm.kindName).toBe("OLD CAMP");
    const clock = { now: 6_000_000 };
    const arena = arenaAt(SEED, clock);
    const far = arena.add("Far", 1, 0, { tx: lm.cx + REALM_LANDMARK_HALF_W + 1, ty: lm.cy });
    expect(far.landmarks).toEqual([]);
    expect(far.progressDirty).toBe(false);
    const edge = arena.add("Edge", 2, 0, { tx: lm.cx + REALM_LANDMARK_HALF_W, ty: lm.cy + REALM_LANDMARK_HALF_H });
    expect(edge.landmarks).toEqual([{ rx: 4, ry: 0 }]);
    expect(edge.progressDirty).toBe(true);
    expect(arena.world.regionState(4, 0)?.landmarkFirstName).toBe("Edge");
    const rows = arena.drainChangedRows();
    expect(rows.map((r) => r.landmarkFirstName)).toEqual(["Edge"]);
    // The hub of the same region is 26 tiles away: entering the region is not a sighting.
    const hubWalker = arena.add("Hub", 3, 0, { tx: regionHub(SEED, 4, 0).x, ty: regionHub(SEED, 4, 0).y });
    expect(hubWalker.landmarks).toEqual([]);
    teleport(hubWalker, lm.cx, lm.cy + REALM_LANDMARK_HALF_H);
    arena.stepRefTick();
    expect(hubWalker.landmarks).toEqual([{ rx: 4, ry: 0 }]);
    expect(arena.world.regionState(4, 0)?.landmarkFirstName, "first stays with the first").toBe("Edge");
    expect(arena.progressMessage(hubWalker)).toEqual({ revision: 1, landmarks: [{ rx: 4, ry: 0 }] });
    // Growth gating: a landmark born later is invisible until its tick.
    const later = { ...lm, bornTick: 40 };
    expect(arena.landmarkVisible(later, lm.cx, lm.cy, clock.now)).toBe(false);
    expect(arena.landmarkVisible(later, lm.cx, lm.cy, clock.now + 40 * GROWTH_TICK_FRAMES * 1000 / 60 + 1)).toBe(true);
    expect(regionOf(lm.cx)).toBe(4);
  });

  test("restored private state survives admission and the snapshots carry it", () => {
    const clock = { now: 7_000_000 };
    const arena = arenaAt(SEED, clock);
    const journey = journeyTalk(journeyAccept(SEED, emptyJourney(), 0, 0)!.journey, 0, 0).journey;
    const p = arena.add("R", 1, 0, { tx: 0, ty: 0 }, { journey, journeyRevision: 5, landmarks: [{ rx: 9, ry: 9 }], progressRevision: 5 });
    expect(p.journey).toEqual(journey);
    expect(arena.journeyMessage(p).revision).toBe(5);
    expect(arena.journeyMessage(p).errand).toEqual({ rx: 0, ry: 0 });
    expect(arena.journeyMessage(p).talked).toEqual([{ rx: 0, ry: 0 }]);
    expect(arena.progressMessage(p)).toEqual({ revision: 5, landmarks: [{ rx: 9, ry: 9 }] });
    expect(p.journeyDirty).toBe(false);
  });
});
