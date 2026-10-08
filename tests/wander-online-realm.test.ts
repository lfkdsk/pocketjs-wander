import { describe, expect, test } from "bun:test";
import { BTN } from "../examples/wander-online/net/protocol.ts";
import { RealmPredictor } from "../examples/wander-online/net/realm-predict.ts";
import {
  GENERATOR_VERSION,
  type RealmCollisionSource,
  type RealmState,
} from "../examples/wander-online/net/realm-world.ts";
import {
  REALM_FRAME_BUDGET,
  REALM_REF_TICK_BUDGET,
  RealmArena,
  type RealmPlayer,
} from "../examples/wander-online/server/realm-area.ts";
import { entityFor, snapshotForRealm } from "../examples/wander-online/shared/snapshot.ts";
import { decodeState4, type Welcome4 } from "../examples/wander-online/net/protocol.ts";
import { CHUNK } from "../examples/wander/world.ts";

const SEED = 0x5eed_0001;
const EPOCH = 0x1020_3040;

function welcome(arena: RealmArena, player: RealmPlayer): Welcome4 {
  const { id: _id, color: _color, ...mover } = entityFor(player);
  return {
    you: player.id,
    seed: arena.seed,
    generatorVersion: GENERATOR_VERSION,
    epoch: arena.epoch,
    realmId: arena.realmId,
    realmRevision: 0,
    serverTimeMs: 0,
    mover,
  };
}

function moverFields(state: RealmState) {
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

const STEP = [
  { dx: 0, dy: -1, mask: BTN.up },
  { dx: 1, dy: 0, mask: BTN.right },
  { dx: 0, dy: 1, mask: BTN.down },
  { dx: -1, dy: 0, mask: BTN.left },
] as const;

/** Find a short generated path which actually leaves the spawn chunk. */
function pathAcrossChunk(collision: RealmCollisionSource, sx: number, sy: number): number[] {
  const startChunkX = Math.floor(sx / CHUNK);
  const startChunkY = Math.floor(sy / CHUNK);
  const key = (x: number, y: number) => `${x},${y}`;
  const queue: { x: number; y: number }[] = [{ x: sx, y: sy }];
  const from = new Map<string, { x: number; y: number; mask: number }>();
  from.set(key(sx, sy), { x: sx, y: sy, mask: 0 });
  let goal: { x: number; y: number } | null = null;
  for (let head = 0; head < queue.length && head < 9 * CHUNK * CHUNK; head++) {
    const at = queue[head]!;
    if (Math.floor(at.x / CHUNK) !== startChunkX || Math.floor(at.y / CHUNK) !== startChunkY) {
      goal = at;
      break;
    }
    for (const step of STEP) {
      const x = at.x + step.dx, y = at.y + step.dy, k = key(x, y);
      if (from.has(k) || collision.collisionAt(x, y).blocked) continue;
      from.set(k, { x: at.x, y: at.y, mask: step.mask });
      queue.push({ x, y });
    }
  }
  if (!goal) throw new Error("spawn's generated active ring has no path across a chunk boundary");
  const reverse: number[] = [];
  for (let at = goal; at.x !== sx || at.y !== sy;) {
    const prev = from.get(key(at.x, at.y))!;
    reverse.push(prev.mask);
    at = prev;
  }
  return reverse.reverse();
}

describe("wander-online v4 realm arena and prediction", () => {
  test("authoritative server and predictor cross a chunk boundary without corrections", () => {
    const arena = new RealmArena({ seed: SEED, hz: 60, realmId: "realm-test", epoch: EPOCH });
    const player = arena.add("north", 2, 7);
    const predictor = new RealmPredictor(welcome(arena, player));
    const path = pathAcrossChunk(arena.world, player.state.move.tx, player.state.move.ty);
    const originChunk = Math.floor(player.state.move.tx / CHUNK) + "," + Math.floor(player.state.move.ty / CHUNK);
    let seq = 0;
    let correctionsBeforeBoundary = 0;
    let crossed = false;
    for (const mask of path) {
      for (let tick = 0; tick < 8; tick++) {
        seq++;
        predictor.pushInput(mask);
        arena.pushInput(player, seq, mask);
        arena.stepRefTick();
        const result = predictor.reconcile(arena.epoch, player.lastSeq, moverFields(player.state));
        expect(result).toBe("matched");
      }
      const chunk = Math.floor(player.state.move.tx / CHUNK) + "," + Math.floor(player.state.move.ty / CHUNK);
      if (chunk !== originChunk) crossed = true;
      if (!crossed) correctionsBeforeBoundary = predictor.corrections;
    }
    expect(crossed).toBe(true);
    expect(predictor.corrections - correctionsBeforeBoundary).toBe(0);
    expect(moverFields(predictor.current)).toEqual(moverFields(player.state));
  }, 20_000);

  test("20 Hz and 60 Hz hosts fold an identical reference-tick tape", () => {
    expect(REALM_REF_TICK_BUDGET * 3).toBe(REALM_FRAME_BUDGET);
    const slow = new RealmArena({ seed: SEED, hz: 20, epoch: EPOCH });
    const fast = new RealmArena({ seed: SEED, hz: 60, epoch: EPOCH });
    const a = slow.add("slow", 1);
    const b = fast.add("fast", 1);
    const tape = Array.from({ length: 600 }, (_, i) =>
      i % 120 < 40 ? BTN.right : i % 120 < 80 ? BTN.down : BTN.left,
    );
    let seq = 0;
    for (let frame = 0; frame < tape.length / 3; frame++) {
      for (let t = 0; t < 3; t++) {
        const mask = tape[frame * 3 + t]!;
        slow.pushInput(a, ++seq, mask);
      }
      slow.step();
    }
    seq = 0;
    for (const mask of tape) {
      fast.pushInput(b, ++seq, mask);
      fast.step();
    }
    expect(slow.refTicks).toBe(fast.refTicks);
    expect(moverFields(a.state)).toEqual(moverFields(b.state));
  }, 20_000);

  test("snapshot carries signed sparse AOI and epoch, and an empty arena releases caches", () => {
    const arena = new RealmArena({ seed: SEED, hz: 20, realmId: "signed", epoch: EPOCH });
    const me = arena.add("me", 1, 0, { tx: -70_001, ty: 80_003 });
    const near = arena.add("near", 2, 0, { tx: -70_000, ty: 80_004 });
    arena.add("far", 3, 0, { tx: 900_000, ty: -900_000 });
    arena.indexPlayers();
    const decoded = decodeState4(snapshotForRealm(arena, me, 4, 3, 9));
    expect(decoded?.epoch).toBe(EPOCH);
    expect(decoded?.entities.map((e) => e.id)).toEqual([me.id, near.id]);
    expect(decoded?.entities[0]?.tx).toBe(-70_001);
    expect(decoded?.entities[0]?.ty).toBe(80_003);
    expect(decoded?.roomOnline).toBe(3);
    expect(decoded?.allOnline).toBe(9);

    for (const player of [...arena.players.values()]) arena.remove(player.id);
    expect(arena.world.activeCount).toBe(0);
    expect(arena.world.chunks.size).toBe(0);
    expect(arena.world.plans.size).toBe(0);
  }, 20_000);

  test("prediction explicitly corrects a mover mismatch and rejects another epoch", () => {
    const arena = new RealmArena({ seed: SEED, hz: 60, epoch: EPOCH });
    const player = arena.add("p", 1);
    const predictor = new RealmPredictor(welcome(arena, player));
    const seq = predictor.pushInput(0);
    const auth = moverFields(predictor.current);
    expect(predictor.reconcile(EPOCH, seq, { ...auth, px: auth.px + 2 })).toBe("corrected");
    expect(predictor.corrections).toBe(1);
    expect(predictor.reconcile(EPOCH + 1, seq, auth)).toBe("rebase-required");
  });

  test("the player cap refuses atomically before changing world focus", () => {
    const arena = new RealmArena({ seed: SEED, hz: 20, epoch: EPOCH, maxPlayers: 2 });
    const first = arena.add("first", 1, 0, { tx: -100_000, ty: -100_000 });
    arena.add("second", 2, 0, { tx: 100_000, ty: 100_000 });
    const before = {
      players: arena.players.size,
      active: arena.world.activeCount,
      chunks: arena.world.chunks.size,
      plans: arena.world.plans.size,
    };

    expect(arena.tryAdd("refused", 3, 0, { tx: 900_000, ty: -900_000 })).toBeNull();
    expect({
      players: arena.players.size,
      active: arena.world.activeCount,
      chunks: arena.world.chunks.size,
      plans: arena.world.plans.size,
    }).toEqual(before);
    expect(() => arena.add("also-refused", 4)).toThrow("realm is full (2 players)");

    arena.remove(first.id);
    expect(arena.add("replacement", 5).id).toBe(3);
  });

  test("the configured player cap is positive and cannot exceed the safe bound", () => {
    expect(() => new RealmArena({ seed: SEED, hz: 20, maxPlayers: 0 })).toThrow("1..32");
    expect(() => new RealmArena({ seed: SEED, hz: 20, maxPlayers: 33 })).toThrow("1..32");
  });
});
