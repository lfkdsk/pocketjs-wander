import { describe, expect, test } from "bun:test";
import {
  MSG,
  REGION_STATE_FLAG_INITIAL,
  decodePlayerProgress,
  decodeRegionState,
  encodePlayerProgress,
  encodeRegionState,
} from "../examples/wander-online/net/protocol.ts";
import { RealmStateCache } from "../examples/wander-online/net/realm-state.ts";
import { MultiFocusWorld } from "../examples/wander-online/net/realm-world.ts";
import { RealmPredictor } from "../examples/wander-online/net/realm-predict.ts";
import { improvementCells } from "../examples/wander/towns.ts";
import { blocksAt, COMPLETE, UNDISCOVERED } from "../examples/wander/chunk.ts";
import { GROWTH_TICK_FRAMES } from "../examples/wander/region.ts";
import { CHUNK, regionHub } from "../examples/wander/world.ts";

const SEED = 0x5eed_0001;

describe("wander-online realm state protocol", () => {
  test("REGION_STATE round trips signed rows and rejects non-exact or malformed payloads", () => {
    const message = {
      flags: REGION_STATE_FLAG_INITIAL,
      realmRevision: 12,
      serverTimeMs: 12_345.5,
      rows: [{
        rx: -123,
        ry: 456,
        discoveredAtMs: 10_000,
        improvementLevel: 1,
        revision: 11,
        landmarkFirstName: "旅人",
      }],
    };
    const encoded = encodeRegionState(message);
    expect(new DataView(encoded).getUint8(0)).toBe(MSG.regionState);
    expect(decodeRegionState(encoded)).toEqual(message);
    expect(decodeRegionState(new Uint8Array(encoded).subarray(0, encoded.byteLength - 1))).toBeNull();
    const trailing = new Uint8Array(encoded.byteLength + 1);
    trailing.set(new Uint8Array(encoded));
    expect(decodeRegionState(trailing)).toBeNull();

    const badUtf8 = new Uint8Array(encoded.slice(0));
    badUtf8[badUtf8.length - 1] = 0xff;
    expect(decodeRegionState(badUtf8)).toBeNull();
    expect(() => encodeRegionState({ ...message, rows: [...message.rows, message.rows[0]!] })).toThrow(/duplicate/);
  });

  test("PLAYER_PROGRESS is a strict private landmark-region set", () => {
    const message = { revision: 9, landmarks: [{ rx: -7, ry: 8 }, { rx: 9, ry: -10 }] };
    const encoded = encodePlayerProgress(message);
    expect(new DataView(encoded).getUint8(0)).toBe(MSG.playerProgress);
    expect(decodePlayerProgress(encoded)).toEqual(message);
    expect(decodePlayerProgress(new Uint8Array(encoded).subarray(0, encoded.byteLength - 1))).toBeNull();
    const trailing = new Uint8Array(encoded.byteLength + 1);
    trailing.set(new Uint8Array(encoded));
    expect(decodePlayerProgress(trailing)).toBeNull();
    expect(() => encodePlayerProgress({ revision: 1, landmarks: [{ rx: 1, ry: 2 }, { rx: 1, ry: 2 }] })).toThrow(/duplicate/);
  });
});

describe("wander-online realm state projection", () => {
  test("unknown regions are undiscovered; revisions, improvements and clock are monotonic", () => {
    const state = new RealmStateCache();
    expect(state.regionTick(-1, 2, 10_000)).toBe(UNDISCOVERED);
    state.apply({
      flags: 1,
      realmRevision: 5,
      serverTimeMs: 1_000,
      rows: [{ rx: -1, ry: 2, discoveredAtMs: 1_000, improvementLevel: 1, revision: 5, landmarkFirstName: "A" }],
    });
    expect(state.regionTick(-1, 2, 1_133)).toBe(0);
    expect(state.regionTick(-1, 2, 1_134)).toBe(1);
    state.apply({
      flags: 0,
      realmRevision: 4,
      serverTimeMs: 900,
      rows: [{ rx: -1, ry: 2, discoveredAtMs: 999, improvementLevel: 0, revision: 4, landmarkFirstName: "stale" }],
    });
    expect(state.serverTimeMs).toBe(1_000);
    expect(state.realmRevision).toBe(5);
    expect(state.get(-1, 2)?.landmarkFirstName).toBe("A");
    state.apply({
      flags: 0,
      realmRevision: 6,
      serverTimeMs: 1_200,
      rows: [{ rx: -1, ry: 2, discoveredAtMs: 1_000, improvementLevel: 0, revision: 6, landmarkFirstName: "B" }],
    });
    expect(state.get(-1, 2)?.improvementLevel).toBe(1);
    expect(state.get(-1, 2)?.landmarkFirstName).toBe("B");
  });

  test("one shared phase drives collision before and after a born blocker", () => {
    const world = new MultiFocusWorld(SEED);
    const focus = { x: 60, y: 55 };
    world.prime([focus], 0);
    let target: { x: number; y: number; rx: number; ry: number } | null = null;
    for (const chunk of world.chunks.values()) {
      for (let i = 0; i < CHUNK * CHUNK; i++) {
        if (blocksAt(chunk, i, UNDISCOVERED) === blocksAt(chunk, i, COMPLETE)) continue;
        target = { x: chunk.x0 + (i % CHUNK), y: chunk.y0 + (i >> 5), rx: chunk.rx, ry: chunk.ry };
        break;
      }
      if (target) break;
    }
    expect(target).not.toBeNull();
    expect(world.collisionAt(target!.x, target!.y).blocked).toBe(blocksAt(
      world.chunk(Math.floor(target!.x / CHUNK), Math.floor(target!.y / CHUNK))!,
      (target!.y & 31) * CHUNK + (target!.x & 31),
      UNDISCOVERED,
    ));
    world.applyRegionState({
      flags: 1,
      realmRevision: 1,
      serverTimeMs: 1_000_000,
      rows: [{ ...target!, discoveredAtMs: 0, improvementLevel: 0, revision: 1, landmarkFirstName: "" }],
    });
    expect(world.regionTick(target!.rx, target!.ry, world.worldTimeMs)).toBe(COMPLETE);
    expect(world.collisionAt(target!.x, target!.y).blocked).toBe(blocksAt(
      world.chunk(Math.floor(target!.x / CHUNK), Math.floor(target!.y / CHUNK))!,
      (target!.y & 31) * CHUNK + (target!.x & 31),
      COMPLETE,
    ));
  });

  test("an improvement delta is idempotent and is replayed after cache regeneration", () => {
    let town = { rx: 0, ry: 0 };
    outer: for (let ry = -4; ry <= 4; ry++) for (let rx = -4; rx <= 4; rx++) {
      if (regionHub(SEED, rx, ry).town) { town = { rx, ry }; break outer; }
    }
    const hub = regionHub(SEED, town.rx, town.ry);
    const world = new MultiFocusWorld(SEED);
    world.prime([{ x: hub.x, y: hub.y }], 0);
    const plan = world.plans.get(`${town.rx},${town.ry}`)!;
    const cells = improvementCells(plan);
    const before = plan.upper!.slice();
    const apply = (revision: number) => world.applyRegionState({
      flags: revision === 1 ? 1 : 0,
      realmRevision: revision,
      serverTimeMs: revision,
      rows: [{ ...town, discoveredAtMs: 0, improvementLevel: 1, revision, landmarkFirstName: "First" }],
    });
    apply(1);
    const changed = before.reduce((n, value, i) => n + (value !== plan.upper![i] ? 1 : 0), 0);
    expect(changed).toBe(cells.length);
    const once = plan.upper!.slice();
    apply(2);
    expect(plan.upper).toEqual(once);
    for (const cell of cells) {
      const chunk = world.chunk(Math.floor(cell.x / CHUNK), Math.floor(cell.y / CHUNK))!;
      const i = (cell.y - chunk.y0) * CHUNK + cell.x - chunk.x0;
      expect(chunk.devUpper[i]).toBe(cell.tile);
      expect(blocksAt(chunk, i, COMPLETE)).toBe(false);
    }

    world.setFocuses([], 10_000);
    world.clearCache();
    world.prime([{ x: hub.x, y: hub.y }], 10_001);
    const regenerated = world.plans.get(`${town.rx},${town.ry}`)!;
    for (const cell of cells) {
      const i = (cell.y - regenerated.y0) * 96 + cell.x - regenerated.x0;
      expect(regenerated.upper![i]).toBe(cell.tile);
    }
  }, 20_000);

  test("rollback evaluates each pending input at its saved server time", () => {
    const probe = new MultiFocusWorld(SEED);
    probe.prime([{ x: 60, y: 55 }], 0);
    let target: { x: number; y: number; rx: number; ry: number; born: number; before: boolean; after: boolean } | null = null;
    for (const chunk of probe.chunks.values()) {
      for (let i = 0; i < CHUNK * CHUNK; i++) {
        const born = chunk.devBorn[i]!;
        if (born === 0 || born >= COMPLETE) continue;
        const before = blocksAt(chunk, i, born - 1), after = blocksAt(chunk, i, born);
        if (before === after) continue;
        target = {
          x: chunk.x0 + (i % CHUNK), y: chunk.y0 + (i >> 5),
          rx: chunk.rx, ry: chunk.ry, born, before, after,
        };
        break;
      }
      if (target) break;
    }
    expect(target).not.toBeNull();
    const discoveredAtMs = 10_000;
    const bornAtMs = discoveredAtMs + target!.born * GROWTH_TICK_FRAMES * 1000 / 60;
    const preBirthMs = bornAtMs - 0.01, postBirthMs = bornAtMs + 0.01;
    const predictor = new RealmPredictor({
      you: 1,
      seed: SEED,
      generatorVersion: 1,
      epoch: 7,
      realmId: "time-test",
      realmRevision: 0,
      serverTimeMs: discoveredAtMs,
      mover: {
        tx: target!.x - 1, ty: target!.y, px: 0, py: 0,
        dir: 3, phase: 0, stepDir: 3, moving: false, walking: false,
      },
    });
    predictor.world.applyRegionState({
      flags: 1,
      realmRevision: 1,
      serverTimeMs: discoveredAtMs,
      rows: [{
        rx: target!.rx, ry: target!.ry, discoveredAtMs,
        improvementLevel: 0, revision: 1, landmarkFirstName: "",
      }],
    });
    predictor.pushInput(0, discoveredAtMs);
    predictor.pushInput(0, preBirthMs);
    predictor.pushInput(0, postBirthMs);
    const base = predictor.savedAt(1)!.move;

    // A newer render/server clock must not overwrite the scoped times used
    // while correction replay rebuilds seq 2 and seq 3.
    predictor.world.setWorldTime(postBirthMs + 60_000);
    const observed: boolean[] = [];
    const collisionAt = predictor.world.collisionAt.bind(predictor.world);
    predictor.world.collisionAt = (x, y) => {
      const result = collisionAt(x, y);
      if (x === target!.x && y === target!.y) observed.push(result.blocked);
      return result;
    };
    expect(predictor.reconcile(7, 1, { ...base, px: base.px + 1 })).toBe("corrected");
    expect(observed).toEqual([target!.before, target!.after]);
    expect(predictor.world.worldTimeMs).toBe(postBirthMs + 60_000);
  }, 20_000);
});
