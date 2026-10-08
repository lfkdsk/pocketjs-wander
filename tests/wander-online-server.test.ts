// tests/wander-online-server.test.ts — the authoritative arena and the Bun
// area server: determinism, the 20 Hz -> 3-reference-tick fold, input queue
// ordering, AOI shape, loopback-only binding, and a real-WebSocket
// end-to-end exchange.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import os from "node:os";
import { Arena } from "../examples/wander-online/server/area.ts";
import {
  BTN,
  MSG,
  WORLD_PROTOCOL_VERSION,
  decodeState,
  decodeState4,
  decodeWelcome,
  decodeWelcome4,
  encodeInput,
  encodePing,
} from "../examples/wander-online/net/protocol.ts";
import { WINDOW } from "../examples/wander/window.ts";
import { startServer, type ServerHandle } from "../examples/wander-online/server/server.ts";
import { connect, type TestSocket } from "./lib/ws-helper.ts";

const SEED = 0x5eed_0001;

describe("wander-online arena", () => {
  test("same input sequence on two arenas gives the same mover digest", () => {
    const a = new Arena({ seed: SEED, hz: 20 });
    const b = new Arena({ seed: SEED, hz: 20 });
    const pa = a.add("a", 1);
    const pb = b.add("a", 1);
    let seq = 0;
    const masks = [BTN.right, BTN.right, 0, BTN.down, BTN.down, BTN.down, 0, BTN.left];
    for (let frame = 0; frame < 120; frame++) {
      const mask = masks[frame % masks.length]!;
      for (let t = 0; t < 3; t++) {
        seq++;
        a.pushInput(pa, seq, mask);
        b.pushInput(pb, seq, mask);
      }
      a.step();
      b.step();
      expect(a.digest(pa.id)).toBe(b.digest(pb.id));
    }
  });

  test("20 Hz folds 3 reference ticks per frame: 20 frames = 60 ref ticks", () => {
    const arena = new Arena({ seed: SEED, hz: 20 });
    arena.add("a", 1);
    expect(arena.ticksPerFrame).toBe(3);
    for (let i = 0; i < 20; i++) arena.step();
    expect(arena.refTicks).toBe(60);
    expect(arena.frame).toBe(20);
  });

  test("60 Hz folds 1 reference tick per frame", () => {
    const arena = new Arena({ seed: SEED, hz: 60 });
    expect(arena.ticksPerFrame).toBe(1);
    arena.add("a", 1);
    arena.step();
    expect(arena.refTicks).toBe(1);
  });

  test("input queue applies one input per reference tick in order", () => {
    const arena = new Arena({ seed: SEED, hz: 60 });
    const p = arena.add("a", 1);
    arena.pushInput(p, 1, BTN.right);
    arena.pushInput(p, 2, BTN.right);
    arena.pushInput(p, 3, 0);
    expect(p.lastSeq).toBe(0);
    arena.stepRefTick();
    expect(p.lastSeq).toBe(1);
    expect(p.buttons).toBe(BTN.right);
    arena.stepRefTick();
    expect(p.lastSeq).toBe(2);
    arena.stepRefTick();
    expect(p.lastSeq).toBe(3);
    expect(p.buttons).toBe(0);
    // Underflow: holds the last mask, does not advance lastSeq.
    arena.stepRefTick();
    expect(p.lastSeq).toBe(3);
    expect(p.buttons).toBe(0);
  });

  test("stale and duplicate input seqs are ignored", () => {
    const arena = new Arena({ seed: SEED, hz: 60 });
    const p = arena.add("a", 1);
    arena.pushInput(p, 5, BTN.up);
    arena.pushInput(p, 5, BTN.up); // duplicate
    arena.pushInput(p, 3, BTN.up); // stale (older than the queued 5)
    expect(p.queue.length).toBe(1);
    arena.stepRefTick();
    expect(p.lastSeq).toBe(5);
    arena.pushInput(p, 5, BTN.up); // already applied
    expect(p.queue.length).toBe(0);
  });

  test("AOI: self first, then nearest first, capped", () => {
    const arena = new Arena({ seed: SEED, hz: 20 });
    const me = arena.add("me", 0);
    // Place players at known tiles by writing their mover directly.
    const place = (id: number, tx: number, ty: number) => {
      const p = arena.players.get(id)!;
      p.state = { ...p.state, move: { ...p.state.move, tx, ty, px: tx * 16, py: ty * 16 } };
    };
    const near = arena.add("near", 1);
    const far = arena.add("far", 2);
    const side = arena.add("side", 3);
    place(me.id, 48, 48);
    place(near.id, 49, 48);
    place(far.id, 60, 48);
    place(side.id, 48, 50);
    arena.indexPlayers();
    const view = arena.aoi(me, 16, 3);
    expect(view.map((p) => p.id)).toEqual([me.id, near.id, side.id]);
    // Uncapped, within radius: all four.
    expect(arena.aoi(me, 16).map((p) => p.id).sort()).toEqual([me.id, near.id, far.id, side.id].sort());
    // Out of radius: only self.
    expect(arena.aoi(me, 0).map((p) => p.id)).toEqual([me.id]);
  });
});

describe("wander-online server", () => {
  let server: ServerHandle;
  let port: number;

  beforeAll(async () => {
    server = startServer({ port: 0, seed: SEED, hz: 20, broadcastHz: 10, aoi: 16, simLatency: 0, webRoot: "", allowGuests: true });
    port = server.port;
    // Let the tick loop spin up.
    await new Promise((r) => setTimeout(r, 100));
  });

  afterAll(() => {
    server.close();
  });

  test("binds loopback only: LAN interfaces refuse connections", async () => {
    const loop = await connect(`ws://127.0.0.1:${port}/ws`);
    expect(loop).toBeTruthy();
    loop.close();
    // Every non-loopback IPv4 on this machine must refuse the connection:
    // the server is localhost-only by design.
    const ifaces = os.networkInterfaces();
    const lan: string[] = [];
    for (const list of Object.values(ifaces)) {
      for (const ni of list ?? []) {
        if (ni.family === "IPv4" && !ni.internal) lan.push(ni.address);
      }
    }
    for (const addr of lan) {
      await expect(connect(`ws://${addr}:${port}/ws`)).rejects.toThrow();
    }
  });

  test("two clients join and see each other in snapshots", async () => {
    const alice = await connect(`ws://127.0.0.1:${port}/ws`);
    const bob = await connect(`ws://127.0.0.1:${port}/ws`);
    alice.send(JSON.stringify({ type: "join", v: 3, name: "alice", color: 1 }));
    bob.send(JSON.stringify({ type: "join", v: 3, name: "bob", color: 2 }));
    const welcomeA = await alice.nextMessage() as ArrayBuffer;
    const welcomeB = await bob.nextMessage() as ArrayBuffer;
    expect(new DataView(welcomeA).getUint8(0)).toBe(MSG.welcome);
    expect(new DataView(welcomeB).getUint8(0)).toBe(MSG.welcome);
    const wa = decodeWelcome(welcomeA);
    const wb = decodeWelcome(welcomeB);
    expect(wa.seed).toBe(SEED >>> 0);
    expect(wa.you).not.toBe(wb.you);
    expect(wa.grid.length).toBe(WINDOW * WINDOW);

    // Walk Alice to the right for ~1 second so her mover changes.
    const until = Date.now() + 1200;
    let seq = 0;
    const driver = setInterval(() => {
      alice.send(encodeInput(++seq, BTN.right));
    }, 16);
    const seen = new Map<number, number>();
    let snapshots = 0;
    let sawTwoPlayerPopulation = false;
    while (Date.now() < until && snapshots < 5) {
      const msg = (await alice.nextMessage(500)) as ArrayBuffer | undefined;
      if (!msg) break;
      const v = new DataView(msg);
      if (v.getUint8(0) !== MSG.state) continue;
      const st = decodeState(msg);
      snapshots++;
      if (st.roomOnline === 2 && st.allOnline === 2) sawTwoPlayerPopulation = true;
      for (const e of st.entities) seen.set(e.id, (seen.get(e.id) ?? 0) + 1);
    }
    clearInterval(driver);
    expect(snapshots).toBeGreaterThan(0);
    // Alice sees herself and Bob.
    expect(seen.has(wa.you)).toBe(true);
    expect(seen.has(wb.you)).toBe(true);
    expect(sawTwoPlayerPopulation).toBe(true);
    alice.close();
    bob.close();
  });

  test("v4 route emits signed-world WELCOME4 and epoch-matched STATE4", async () => {
    const c = await connect(`ws://127.0.0.1:${port}/ws/v4`);
    c.send(JSON.stringify({
      type: "join",
      v: WORLD_PROTOCOL_VERSION,
      supportedGeneratorVersions: [1],
      name: "realm",
      color: 5,
    }));
    const greeting = decodeWelcome4((await c.nextMessage()) as ArrayBuffer);
    expect(greeting).not.toBeNull();
    expect(greeting?.realmId).toBe("local");
    expect(greeting?.generatorVersion).toBe(1);
    const until = Date.now() + 2000;
    while (Date.now() < until) {
      const msg = (await c.nextMessage(500)) as ArrayBuffer | undefined;
      if (!msg || new DataView(msg).getUint8(0) !== MSG.state4) continue;
      const state = decodeState4(msg);
      expect(state?.epoch).toBe(greeting?.epoch);
      expect(state?.entities[0]?.id).toBe(greeting?.you);
      c.close();
      return;
    }
    c.close();
    throw new Error("no STATE4");
  });

  test("snapshot acks the client's input sequence", async () => {
    const c = await connect(`ws://127.0.0.1:${port}/ws`);
    c.send(JSON.stringify({ type: "join", v: 3, name: "ack", color: 3 }));
    const welcome = (await c.nextMessage()) as ArrayBuffer;
    const you = decodeWelcome(welcome).you;
    let seq = 0;
    for (let i = 0; i < 30; i++) {
      c.send(encodeInput(++seq, BTN.down));
      await new Promise((r) => setTimeout(r, 20));
    }
    // Collect snapshots until one acks a recent seq.
    let acked = 0;
    const until = Date.now() + 2000;
    while (Date.now() < until && acked < seq) {
      const msg = (await c.nextMessage(500)) as ArrayBuffer | undefined;
      if (!msg) break;
      if (new DataView(msg).getUint8(0) !== MSG.state) continue;
      const st = decodeState(msg);
      if (st.entities.some((e) => e.id === you)) acked = Math.max(acked, st.ackSeq);
    }
    expect(acked).toBeGreaterThan(0);
    c.close();
  });

  test("PING gets a PONG with the same payload", async () => {
    const c = await connect(`ws://127.0.0.1:${port}/ws`);
    c.send(JSON.stringify({ type: "join", v: 3, name: "ping", color: 4 }));
    await c.nextMessage();
    c.send(encodePing(9, 12345));
    const until = Date.now() + 2000;
    while (Date.now() < until) {
      const msg = (await c.nextMessage(500)) as ArrayBuffer | undefined;
      if (!msg) break;
      const v = new DataView(msg);
      if (v.getUint8(0) === MSG.pong) {
        expect(v.getUint32(1, true)).toBe(9);
        expect(v.getUint32(5, true)).toBe(12345);
        c.close();
        return;
      }
    }
    c.close();
    throw new Error("no pong");
  });
});
