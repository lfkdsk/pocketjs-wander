// tests/wander-online-net.test.ts — wire format, prediction, interpolation
// and reconnect for the wander-online multiplayer demo. The server suite
// (determinism, loopback binding, end-to-end) lives in
// wander-online-server.test.ts.
import { describe, expect, test } from "bun:test";
import {
  BTN,
  ENTITY4_BYTES,
  ENTITY_BYTES,
  MAX_AOI,
  MAX_STATE_BYTES,
  MAX_STATE4_BYTES,
  MSG,
  STATE4_HEADER_BYTES,
  STATE_HEADER_BYTES,
  STATE_POPULATION_BYTES,
  TILE,
  decodeInput,
  decodeState,
  decodeState4,
  decodeWelcome,
  decodeWelcome4,
  encodeBye,
  encodeInput,
  encodePing,
  encodePong,
  encodeRoster,
  decodeRoster,
  encodeState,
  encodeState4,
  encodeWelcome,
  encodeWelcome4,
  gridFromWindow,
  type WireEntity,
} from "../examples/wander-online/net/protocol.ts";
import { WINDOW } from "../examples/wander/window.ts";
import { Arena } from "../examples/wander-online/server/area.ts";
import { Predictor } from "../examples/wander-online/net/predict.ts";
import { Interpolator } from "../examples/wander-online/net/interpolate.ts";
import { stepSession, type SessionState } from "../vendor/pocket-rpgkit/src/engine/session.ts";

describe("wander-online protocol", () => {
  test("INPUT roundtrip carries seq and buttons", () => {
    const buf = encodeInput(123456, BTN.up | BTN.left);
    expect(buf.byteLength).toBe(7);
    const v = new DataView(buf);
    expect(v.getUint8(0)).toBe(MSG.input);
    const d = decodeInput(buf);
    expect(d.seq).toBe(123456);
    expect(d.buttons).toBe(BTN.up | BTN.left);
  });

  test("PING/PONG roundtrip", () => {
    const p = encodePing(7, 0xabcdef01);
    expect(p.byteLength).toBe(9);
    const v = new DataView(p);
    expect(v.getUint8(0)).toBe(MSG.ping);
    expect(v.getUint32(1, true)).toBe(7);
    expect(v.getUint32(5, true)).toBe(0xabcdef01);
    const o = encodePong(7, 0xabcdef01);
    expect(o.byteLength).toBe(9);
    expect(new DataView(o).getUint8(0)).toBe(MSG.pong);
  });

  test("BYE is 5 bytes", () => {
    const b = encodeBye(99);
    expect(b.byteLength).toBe(5);
    const v = new DataView(b);
    expect(v.getUint8(0)).toBe(MSG.bye);
    expect(v.getUint32(1, true)).toBe(99);
  });

  test("WELCOME roundtrip carries seed, origin and grid", () => {
    const grid = new Uint8Array(WINDOW * WINDOW);
    for (let i = 0; i < grid.length; i++) grid[i] = i % 8;
    const buf = encodeWelcome(42, 0x9e3779b9, -123, 456, grid);
    const v = new DataView(buf);
    expect(v.getUint8(0)).toBe(MSG.welcome);
    expect(buf.byteLength).toBe(17 + WINDOW * WINDOW);
    const d = decodeWelcome(buf);
    expect(d.you).toBe(42);
    expect(d.seed).toBe(0x9e3779b9);
    expect(d.x0).toBe(-123);
    expect(d.y0).toBe(456);
    expect(d.grid.length).toBe(WINDOW * WINDOW);
    expect(d.grid[0]).toBe(0);
    expect(d.grid[7]).toBe(7);
    expect(d.grid[8]).toBe(0);
  });

  test("WELCOME4 roundtrip carries a signed absolute mover and realm identity", () => {
    const mover = {
      tx: -50_123, ty: 70_456, px: -14, py: 6,
      dir: 1, phase: 7, stepDir: 1, moving: true, walking: true,
    };
    const buf = encodeWelcome4({
      you: 42,
      seed: 0x9e3779b9,
      generatorVersion: 1,
      epoch: 7,
      realmId: "realm-无界",
      realmRevision: 19,
      serverTimeMs: 123456.25,
      mover,
    });
    expect(new DataView(buf).getUint8(0)).toBe(MSG.welcome4);
    expect(decodeWelcome4(buf)).toEqual({
      you: 42,
      seed: 0x9e3779b9,
      generatorVersion: 1,
      epoch: 7,
      realmId: "realm-无界",
      realmRevision: 19,
      serverTimeMs: 123456.25,
      mover,
    });
    expect(decodeWelcome4(new Uint8Array(buf).subarray(0, buf.byteLength - 1))).toBeNull();
    const trailing = new Uint8Array(buf.byteLength + 1);
    trailing.set(new Uint8Array(buf));
    expect(decodeWelcome4(trailing)).toBeNull();
  });

  test("STATE roundtrip carries frame, ackSeq and every entity field", () => {
    const entities: WireEntity[] = [
      { id: 1, tx: 48, ty: 50, px: 0, py: 0, dir: 0, phase: 0, stepDir: 0, moving: false, walking: false, color: 0 },
      { id: 2, tx: 58, ty: 54, px: -7, py: 9, dir: 3, phase: 4, stepDir: 3, moving: true, walking: true, color: 13 },
    ];
    const buf = encodeState(777, 123456, entities);
    expect(buf.byteLength).toBe(STATE_HEADER_BYTES + 2 * ENTITY_BYTES);
    const v = new DataView(buf);
    expect(v.getUint8(0)).toBe(MSG.state);
    expect(v.getUint8(9)).toBe(2);
    const d = decodeState(buf);
    expect(d.frame).toBe(777);
    expect(d.ackSeq).toBe(123456);
    expect(d.entities.length).toBe(2);
    expect(d.entities[0]).toEqual(entities[0]);
    expect(d.entities[1]).toEqual(entities[1]);
    expect(d.roomOnline).toBeNull();
    expect(d.allOnline).toBeNull();
  });

  test("STATE optional population tail parses one, two and three-player rooms plus cross-room totals", () => {
    for (const [roomOnline, allOnline] of [[1, 1], [2, 7], [3, 12]] as const) {
      const entities = Array.from({ length: roomOnline }, (_, i) => ({
        id: i + 1,
        tx: 48 + i,
        ty: 50,
        px: 0,
        py: 0,
        dir: 0,
        phase: 0,
        stepDir: 0,
        moving: false,
        walking: false,
        color: i,
      } satisfies WireEntity));
      const buf = encodeState(800 + roomOnline, 10, entities, { roomOnline, allOnline });
      expect(buf.byteLength).toBe(STATE_HEADER_BYTES + roomOnline * ENTITY_BYTES + STATE_POPULATION_BYTES);
      const state = decodeState(buf);
      expect(state.entities).toEqual(entities);
      expect(state.roomOnline).toBe(roomOnline);
      expect(state.allOnline).toBe(allOnline);
    }
  });

  test("STATE caps at MAX_AOI entities and stays under the socket message limit", () => {
    const many: WireEntity[] = Array.from({ length: 300 }, (_, i) => ({
      id: i + 1, tx: i % 96, ty: (i / 96) | 0, px: 0, py: 0, dir: 0, phase: 0, stepDir: 0, moving: false, walking: false, color: i & 0x0f,
    }));
    const buf = encodeState(1, 1, many, { roomOnline: 300, allOnline: 500 });
    const d = decodeState(buf);
    expect(d.entities.length).toBe(MAX_AOI);
    expect(buf.byteLength).toBe(MAX_STATE_BYTES);
    // The SOCKET contract caps messages at 64 KiB.
    expect(buf.byteLength).toBeLessThan(64 * 1024);
  });

  test("STATE4 preserves signed world coordinates and rejects non-exact frames", () => {
    const entities: WireEntity[] = [
      { id: 1, tx: -500, ty: 900, px: -12, py: 14, dir: 1, phase: 6, stepDir: 1, moving: true, walking: true, color: 15 },
      { id: 2, tx: 1_000_000, ty: -1_000_000, px: 0, py: 0, dir: 3, phase: 0, stepDir: 3, moving: false, walking: false, color: 2 },
    ];
    const buf = encodeState4(99, 77, 7, entities, { roomOnline: 2, allOnline: 35 });
    expect(buf.byteLength).toBe(STATE4_HEADER_BYTES + 2 * ENTITY4_BYTES + STATE_POPULATION_BYTES);
    expect(buf.byteLength).toBeLessThanOrEqual(MAX_STATE4_BYTES);
    expect(decodeState4(buf)).toEqual({ frame: 99, ackSeq: 77, epoch: 7, entities, roomOnline: 2, allOnline: 35 });
    expect(decodeState4(new Uint8Array(buf).subarray(0, buf.byteLength - 1))).toBeNull();
    const trailing = new Uint8Array(buf.byteLength + 1);
    trailing.set(new Uint8Array(buf));
    expect(decodeState4(trailing)).toBeNull();
  });

  test("gridFromWindow classifies blocks, roads and biome bases", () => {
    // A minimal window-shaped build: block at cell 0, road at cell 1,
    // biome bases (ninja.90..93) and a developed plaza tile.
    const grid = new Uint8Array(WINDOW * WINDOW);
    const ground: string[] = new Array(WINDOW * WINDOW).fill("ninja.0");
    ground[2] = "ninja.90";
    ground[3] = "ninja.91";
    ground[4] = "ninja.92";
    ground[5] = "ninja.93";
    const roads = new Uint8Array(WINDOW * WINDOW);
    roads[1] = 1;
    const w = {
      project: { maps: [{ ground, passage: [[0, "block" as const]] }] },
      roads,
    } as unknown as Parameters<typeof gridFromWindow>[0];
    const g = gridFromWindow(w);
    expect(g[0]).toBe(TILE.block);
    expect(g[1]).toBe(TILE.road);
    expect(g[2]).toBe(TILE.grass);
    expect(g[3]).toBe(TILE.mud);
    expect(g[4]).toBe(TILE.sand);
    expect(g[5]).toBe(TILE.snow);
    expect(g[6]).toBe(TILE.plaza);
  });
});

const SEED = 0x5eed_0001;
const MASKS = [BTN.right, BTN.right, BTN.right, 0, BTN.down, BTN.down, BTN.down, 0, BTN.left, BTN.left, 0, BTN.up, BTN.up, 0];

/** The comparable fields of a mover, for tick-by-tick parity assertions. */
function moverFields(m: SessionState["move"]) {
  return { tx: m.tx, ty: m.ty, px: m.px, py: m.py, facing: m.facing, phase: m.phase, stepDir: m.stepDir, moving: m.moving, walking: m.walking };
}

/** Drive a server Arena and a client Predictor in lockstep for `ticks`
 *  reference ticks, reconciling every 10 ticks. Returns the final movers. */
function lockstep(ticks: number) {
  const arena = new Arena({ seed: SEED, hz: 60 });
  const sp = arena.add("server", 1);
  const pred = new Predictor(SEED);
  let seq = 0;
  for (let tick = 0; tick < ticks; tick++) {
    const mask = MASKS[tick % MASKS.length]!;
    seq++;
    pred.pushInput(mask);
    arena.pushInput(sp, seq, mask);
    arena.stepRefTick();
    if (tick % 10 === 9) {
      const m = sp.state.move;
      pred.reconcile(sp.lastSeq, { tx: m.tx, ty: m.ty, px: m.px, py: m.py, facing: m.facing, phase: m.phase, stepDir: m.stepDir, moving: m.moving, walking: m.walking });
    }
  }
  return { arena, sp, pred };
}

describe("wander-online prediction", () => {
  test("same input sequence predicts the authoritative mover with zero corrections", () => {
    const { sp, pred } = lockstep(300);
    expect(pred.corrections).toBe(0);
    const a = sp.state.move;
    const b = pred.current.move;
    expect(b.tx).toBe(a.tx);
    expect(b.ty).toBe(a.ty);
    expect(b.px).toBe(a.px);
    expect(b.py).toBe(a.py);
    expect(b.facing).toBe(a.facing);
    expect(b.moving).toBe(a.moving);
  });

  test("a server-client disagreement causes one correction, then reconverges", () => {
    // At the first resting tick with a non-zero mask, feed the server 0
    // instead of the real mask (the server held a stale mask under input
    // loss): the client starts a step, the server stays idle. The first
    // reconcile after the disagreement corrects; the full movement state
    // (phase/walking/stepDir) is on the wire, so the correction is complete
    // and later reconciles find matching movers.
    const arena = new Arena({ seed: SEED, hz: 60 });
    const sp = arena.add("server", 1);
    const pred = new Predictor(SEED);
    let seq = 0;
    let disagreed = false;
    for (let tick = 0; tick < 240; tick++) {
      const mask = MASKS[tick % MASKS.length]!;
      seq++;
      pred.pushInput(mask);
      if (!disagreed && !sp.state.move.moving && mask === BTN.down) {
        disagreed = true;
        arena.pushInput(sp, seq, 0);
      } else {
        arena.pushInput(sp, seq, mask);
      }
      arena.stepRefTick();
      if (tick % 10 === 9) {
        const m = sp.state.move;
        pred.reconcile(sp.lastSeq, { tx: m.tx, ty: m.ty, px: m.px, py: m.py, facing: m.facing, phase: m.phase, stepDir: m.stepDir, moving: m.moving, walking: m.walking });
      }
    }
    expect(disagreed).toBe(true);
    expect(pred.corrections).toBe(1);
    const a = sp.state.move;
    const b = pred.current.move;
    expect(b.tx).toBe(a.tx);
    expect(b.ty).toBe(a.ty);
    expect(b.px).toBe(a.px);
    expect(b.py).toBe(a.py);
  });

  test("reconcile trims confirmed inputs and history", () => {
    const pred = new Predictor(SEED);
    for (let i = 0; i < 30; i++) pred.pushInput(MASKS[i % MASKS.length]!);
    expect(pred.unacked).toBe(30);
    const m = pred.current.move;
    pred.reconcile(20, { tx: m.tx, ty: m.ty, px: m.px, py: m.py, facing: m.facing, phase: m.phase, stepDir: m.stepDir, moving: m.moving, walking: m.walking });
    expect(pred.unacked).toBe(10);
    expect(pred.lastSeq).toBe(30);
  });

  test("reconcile with an unknown ackSeq is a no-op", () => {
    const pred = new Predictor(SEED);
    for (let i = 0; i < 5; i++) pred.pushInput(BTN.right);
    const before = pred.corrections;
    expect(pred.reconcile(999, { tx: 0, ty: 0, px: 0, py: 0, facing: 0, phase: 0, stepDir: 0, moving: false, walking: false })).toBe(false);
    expect(pred.corrections).toBe(before);
  });

  test("reconcile with ackSeq 0 (nothing applied yet) is a no-op", () => {
    const pred = new Predictor(SEED);
    pred.pushInput(BTN.right);
    expect(pred.reconcile(0, { tx: 0, ty: 0, px: 0, py: 0, facing: 0, phase: 0, stepDir: 0, moving: false, walking: false })).toBe(false);
  });

  test("rollback replays unacked inputs and reconverges tick by tick", () => {
    // The case the rollback-and-replay exists for: the snapshot acks a seq
    // the client has already raced past — the client is AHEAD of the
    // server's watermark — and the predicted mover at that seq disagrees
    // with the authoritative one (the server held a stale mask under input
    // loss). Reconcile must snap to the authoritative mover and replay
    // every unacked input through the reducer, so the predicted state
    // matches the authoritative fold tick by tick from then on.
    const arena = new Arena({ seed: SEED, hz: 60 });
    const sp = arena.add("server", 1);
    const pred = new Predictor(SEED);
    const maskAt = (s: number) => MASKS[s % MASKS.length]!;
    let seq = 0;
    let disagreed = false;
    // Phase 1: 40 ticks in lockstep; at the first resting tick with a live
    // mask the server receives a stale 0: client and server diverge.
    for (let tick = 0; tick < 40; tick++) {
      const mask = MASKS[tick % MASKS.length]!;
      seq++;
      pred.pushInput(mask);
      if (!disagreed && !sp.state.move.moving && mask === BTN.down) {
        disagreed = true;
        arena.pushInput(sp, seq, 0);
      } else {
        arena.pushInput(sp, seq, mask);
      }
      arena.stepRefTick();
    }
    expect(disagreed).toBe(true);
    const ack = sp.lastSeq; // the server has applied seqs 1..ack
    // Phase 2: the client races ahead — 8 inputs the server has not seen.
    const AHEAD = 8;
    for (let k = 0; k < AHEAD; k++) {
      seq++;
      pred.pushInput(maskAt(seq));
    }
    expect(pred.lastSeq).toBe(ack + AHEAD);
    // Independent expectation: the authoritative mover at `ack`, then the
    // unacked inputs folded through the same reducer.
    let expected: SessionState = { ...sp.state, move: { ...sp.state.move } };
    for (let k = 1; k <= AHEAD; k++) {
      expected = stepSession(arena.session, expected, { buttons: maskAt(ack + k) });
    }
    const auth = sp.state.move;
    expect(pred.reconcile(ack, { tx: auth.tx, ty: auth.ty, px: auth.px, py: auth.py, facing: auth.facing, phase: auth.phase, stepDir: auth.stepDir, moving: auth.moving, walking: auth.walking })).toBe(true);
    expect(pred.corrections).toBe(1);
    expect(pred.lastSeq).toBe(ack + AHEAD);
    expect(pred.unacked).toBe(AHEAD);
    // The replay rebuilt the predicted state at the server's watermark plus
    // every unacked tick.
    expect(moverFields(pred.current.move)).toEqual(moverFields(expected.move));
    // The server catches up one input per tick: the predictor's saved state
    // at each seq must equal the authoritative state tick by tick.
    for (let k = 1; k <= AHEAD; k++) {
      const s = ack + k;
      arena.pushInput(sp, s, maskAt(s));
      arena.stepRefTick();
      const saved = pred.savedAt(s);
      expect(saved).not.toBeNull();
      expect(moverFields(saved!.move)).toEqual(moverFields(sp.state.move));
    }
    // Then both sides advance together: every tick matches exactly, with no
    // further corrections.
    for (let tick = 0; tick < 60; tick++) {
      seq++;
      const mask = maskAt(seq);
      pred.pushInput(mask);
      arena.pushInput(sp, seq, mask);
      arena.stepRefTick();
      expect(moverFields(pred.current.move)).toEqual(moverFields(sp.state.move));
    }
    expect(pred.corrections).toBe(1);
  });

  test("reconcile with unacked inputs and no disagreement keeps the prediction exact", () => {
    // The same raced-ahead shape, but the server applied every input
    // correctly: the predicted mover at the ack watermark matches, so no
    // correction — and the unacked inputs stay predicted, untouched.
    const arena = new Arena({ seed: SEED, hz: 60 });
    const sp = arena.add("server", 1);
    const pred = new Predictor(SEED);
    const maskAt = (s: number) => MASKS[s % MASKS.length]!;
    let seq = 0;
    for (let tick = 0; tick < 30; tick++) {
      seq++;
      pred.pushInput(MASKS[tick % MASKS.length]!);
      arena.pushInput(sp, seq, MASKS[tick % MASKS.length]!);
      arena.stepRefTick();
    }
    const ack = sp.lastSeq;
    for (let k = 0; k < 8; k++) {
      seq++;
      pred.pushInput(maskAt(seq));
    }
    const before = pred.current;
    const auth = sp.state.move;
    expect(pred.reconcile(ack, { tx: auth.tx, ty: auth.ty, px: auth.px, py: auth.py, facing: auth.facing, phase: auth.phase, stepDir: auth.stepDir, moving: auth.moving, walking: auth.walking })).toBe(false);
    expect(pred.corrections).toBe(0);
    expect(pred.current).toBe(before);
    expect(pred.unacked).toBe(8);
    // Server catches up: tick-by-tick parity through the unacked tail.
    for (let k = 1; k <= 8; k++) {
      const s = ack + k;
      arena.pushInput(sp, s, maskAt(s));
      arena.stepRefTick();
      const saved = pred.savedAt(s);
      expect(saved).not.toBeNull();
      expect(moverFields(saved!.move)).toEqual(moverFields(sp.state.move));
    }
    expect(pred.corrections).toBe(0);
  });
});

describe("wander-online interpolation", () => {
  const ent = (id: number, tx: number, ty: number): WireEntity => ({ id, tx, ty, px: 0, py: 0, dir: 0, phase: 0, stepDir: 0, moving: false, walking: false, color: 1 });

  test("renders at the midpoint between two snapshots", () => {
    const interp = new Interpolator(100);
    interp.push([ent(1, 10, 10)], 1000);
    interp.push([ent(1, 12, 10)], 1100);
    // now=1150 -> render time 1050 -> halfway between the two snapshots.
    const p = interp.renderAt(1, 1150);
    expect(p).not.toBeNull();
    expect(p!.x).toBe(11 * 16);
    expect(p!.y).toBe(10 * 16);
  });

  test("keeps phase, step direction and walking as one discrete render pose", () => {
    const interp = new Interpolator(100);
    const early: WireEntity = {
      ...ent(1, 10, 10), dir: 1, phase: 2, stepDir: 1,
      moving: true, walking: true, color: 3,
    };
    const late: WireEntity = {
      ...ent(1, 11, 10), dir: 2, phase: 7, stepDir: 2,
      moving: true, walking: false, color: 4,
    };
    interp.push([early], 1000);
    interp.push([late], 1100);

    expect(interp.renderAt(1, 1149)).toMatchObject({
      dir: 1, phase: 2, stepDir: 1, moving: true, walking: true, color: 3,
    });
    expect(interp.renderAt(1, 1150)).toMatchObject({
      dir: 2, phase: 7, stepDir: 2, moving: true, walking: false, color: 4,
    });
  });

  test("clamps to the oldest snapshot before the render time", () => {
    const interp = new Interpolator(100);
    interp.push([ent(1, 10, 10)], 1000);
    interp.push([ent(1, 12, 10)], 1100);
    // now=1050 -> render time 950, before the first snapshot: hold oldest.
    const p = interp.renderAt(1, 1050);
    expect(p!.x).toBe(10 * 16);
  });

  test("holds the last known position when an entity leaves a snapshot", () => {
    const interp = new Interpolator(100);
    interp.push([ent(1, 10, 10), ent(2, 20, 20)], 1000);
    interp.push([ent(1, 12, 10)], 1100); // entity 2 gone
    const p = interp.renderAt(2, 1150);
    expect(p).not.toBeNull();
    expect(p!.x).toBe(20 * 16);
    expect(p).toMatchObject({ phase: 0, stepDir: 0, walking: false });
  });

  test("expires entities unseen past the TTL", () => {
    const interp = new Interpolator(100);
    interp.push([ent(1, 10, 10)], 1000);
    interp.push([ent(2, 20, 20)], 1100); // entity 1 not refreshed
    // 2 s after entity 1 was last seen: expired.
    expect(interp.renderAt(1, 3100)).toBeNull();
    expect(interp.renderAt(2, 3100)).not.toBeNull();
  });

  test("unknown entity is null", () => {
    const interp = new Interpolator(100);
    interp.push([ent(1, 10, 10)], 1000);
    expect(interp.renderAt(99, 1100)).toBeNull();
  });
});

describe("wander-online ROSTER codec", () => {
  test("round trips names and looks, including CJK", () => {
    const entries = [
      { id: 1, name: "lfkdsk", look: 0 },
      { id: 42, name: "口袋妖怪", look: 63 },
      { id: 7, name: "a b-c_d.E", look: 17 },
    ];
    const buf = encodeRoster(entries);
    expect(buf.byteLength).toBe(2 + (4 + 1 + 6 + 1) + (4 + 1 + 12 + 1) + (4 + 1 + 9 + 1));
    const back = decodeRoster(buf);
    expect(back).toEqual(entries); // mutation: drop the UTF-8 encode -> CJK names mojibake
  });

  test("the kind byte is 0x50 and the count is first", () => {
    const buf = encodeRoster([{ id: 1, name: "x", look: 0 }]);
    const v = new DataView(buf);
    expect(v.getUint8(0)).toBe(MSG.roster);
    expect(v.getUint8(1)).toBe(1); // mutation: count after entries -> decode reads 0
  });

  test("truncated and oversized payloads decode to null, not a crash", () => {
    const good = encodeRoster([{ id: 1, name: "abc", look: 0 }]);
    expect(decodeRoster(good.slice(0, good.byteLength - 1))).toBeNull();
    expect(decodeRoster(new ArrayBuffer(1))).toBeNull();
    const bad = new ArrayBuffer(3);
    new DataView(bad).setUint8(0, MSG.roster);
    new DataView(bad).setUint8(1, 5); // claims 5 entries, has none
    expect(decodeRoster(bad)).toBeNull(); // mutation: trust the count -> reads past the buffer
  });

  test("a full 32-player roster fits one message", () => {
    const entries = Array.from({ length: 32 }, (_, i) => ({ id: i + 1, name: `player${i}`, look: i % 64 }));
    const buf = encodeRoster(entries);
    expect(buf.byteLength).toBeLessThan(64 * 1024);
    expect(decodeRoster(buf)!.length).toBe(32);
  });
});
