import { describe, expect, test } from "bun:test";
import {
  CHUNK_CACHE_CAP,
  CHUNK_TTL_TICKS,
  GENERATOR_VERSION,
  I32_MAX,
  MultiFocusWorld,
  PLAN_CACHE_CAP,
  REALM_STEP_MAX,
  RealmWorld,
  realmChunkKey,
  realmStart,
  startRealmState,
  stepRealmMover,
  type RealmCollisionSource,
  type RealmState,
} from "../examples/wander-online/net/realm-world.ts";
import { CHUNK } from "../examples/wander/world.ts";
import { initialMovement } from "../vendor/pocket-rpgkit/src/engine/movement.ts";
import { BTN_BITS } from "../vendor/pocket-rpgkit/src/engine/camera.ts";
import type { ChunkData } from "../examples/wander/chunk.ts";

const SEED = 0x5eed_0001;

function chunkHash(c: ChunkData): number {
  const parts = [
    c.terrain, c.blockBiome, c.subBiome, c.devGround,
    new Uint8Array(c.devUpper.buffer, c.devUpper.byteOffset, c.devUpper.byteLength),
    c.devBorn, new Uint8Array(c.natUpper.buffer, c.natUpper.byteOffset, c.natUpper.byteLength),
    c.natHide, c.flags,
  ];
  let h = 0x811c9dc5;
  for (const part of parts) for (const byte of part) {
    h ^= byte;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

describe("wander-online streamed realm world", () => {
  test("version, signed-coordinate active unions, 32 focuses, and corner deltas are exact", () => {
    expect(GENERATOR_VERSION).toBe(1);
    const world = new MultiFocusWorld(SEED);

    expect(world.setFocuses([{ x: -100_001, y: 100_001 }], 0)).toEqual({
      active: 9,
      addedChunks: 9,
      addedRegions: expect.any(Number),
    });
    expect(world.active.has(realmChunkKey(Math.floor(-100_001 / CHUNK), Math.floor(100_001 / CHUNK)))).toBe(true);

    const spread = Array.from({ length: 32 }, (_, i) => ({
      x: -1_000_000 + i * 50_000,
      y: 900_000 - i * 40_000,
    }));
    expect(world.setFocuses(spread, 1).active).toBe(32 * 9);

    const corner = new MultiFocusWorld(SEED);
    corner.setFocuses([{ x: 63, y: 63 }], 0); // chunk centre (1,1)
    const delta = corner.setFocuses([{ x: 64, y: 64 }], 1); // diagonal into (2,2)
    expect(delta.active).toBe(9);
    expect(delta.addedChunks).toBe(5);
    // The active frontier crosses both 3x3-region axes: east, south, corner.
    expect(delta.addedRegions).toBe(3);
  });

  test("budgeting, missing collision, heading priority, and generation determinism", () => {
    const start = realmStart(SEED);
    const world = new MultiFocusWorld(SEED);
    world.setFocuses([{ x: start.tx, y: start.ty, hx: 1, hy: 0 }], 0);

    expect(world.collisionAt(start.tx, start.ty)).toEqual({ ready: false, blocked: true });
    expect(world.runBudget(REALM_STEP_MAX - 1, 0)).toBe(0);
    expect(world.runBudget(REALM_STEP_MAX * 2, 0)).toBeLessThanOrEqual(REALM_STEP_MAX * 2);
    world.prime(undefined, 0);
    expect(world.fresh[0]!.cx).toBe(Math.floor(start.tx / CHUNK));
    expect(world.fresh[0]!.cy).toBe(Math.floor(start.ty / CHUNK));
    expect(world.collisionAt(start.tx, start.ty)).toEqual({ ready: true, blocked: false });

    const focuses = [
      { x: -100_001, y: -200_003 },
      { x: 300_007, y: 400_009 },
    ];
    const a = new MultiFocusWorld(SEED);
    const b = new MultiFocusWorld(SEED);
    a.prime(focuses, 0);
    b.prime([...focuses].reverse(), 0);
    const ah = [...a.chunks].map(([key, c]) => [key, chunkHash(c)]).sort();
    const bh = [...b.chunks].map(([key, c]) => [key, chunkHash(c)]).sort();
    expect(bh).toEqual(ah);
  }, 20_000);

  test("absolute movement reuses streamed collision and blocks missing terrain and int32 edges", () => {
    const missing = new MultiFocusWorld(SEED);
    const initial = startRealmState(SEED);
    expect(Object.keys(initial.chars.chars)).toHaveLength(0);
    const stopped = stepRealmMover(initial, BTN_BITS.RIGHT, missing);
    expect(stopped.move.tx).toBe(initial.move.tx);
    expect(stopped.move.moving).toBe(false);
    expect(stopped.move.facing).toBe(3);

    const client = new RealmWorld(SEED);
    let state = client.start();
    const x0 = state.move.tx;
    for (let i = 0; i < 8; i++) state = client.step(state, BTN_BITS.RIGHT, i);
    expect(state.move.tx).toBe(x0 + 1);
    expect(state.move.px).toBe(state.move.tx * 16);

    // The reducer itself guards signed-int32 boundaries even if a custom
    // collision provider reports every tile open.
    const open: RealmCollisionSource = { collisionAt: () => ({ ready: true, blocked: false }) };
    const edge: RealmState = {
      move: initialMovement(I32_MAX, 0, 3, { tile: 16, speed: 2 }),
      chars: initial.chars,
    };
    const bounded = stepRealmMover(edge, BTN_BITS.RIGHT, open);
    expect(bounded.move.tx).toBe(I32_MAX);
    expect(bounded.move.moving).toBe(false);
  }, 20_000);

  test("hard LRU and plan caps precede TTL, active chunks stay pinned, and empty focus can clear", () => {
    const world = new MultiFocusWorld(SEED);
    // Each point is 30 chunks from the next.  Its 3x3 union is disjoint and,
    // because the centre is a region corner, visits four distinct plans.
    for (let i = 0; i < 57; i++) {
      const tile = i * 30 * CHUNK;
      world.prime([{ x: tile, y: tile }], 0);
    }
    expect(world.chunks.size).toBe(CHUNK_CACHE_CAP);
    expect(world.plans.size).toBe(PLAN_CACHE_CAP);
    expect(world.activeCount).toBe(9);
    for (const key of world.active) expect(world.chunks.has(key)).toBe(true);

    // Elapsed reference ticks, not wall time, drive TTL.
    world.setFocuses([], CHUNK_TTL_TICKS - 1);
    expect(world.chunks.size).toBe(CHUNK_CACHE_CAP);
    world.setFocuses([], CHUNK_TTL_TICKS);
    expect(world.chunks.size).toBe(0);
    world.clearCache();
    expect(world.plans.size).toBe(0);
  }, 40_000);
});
