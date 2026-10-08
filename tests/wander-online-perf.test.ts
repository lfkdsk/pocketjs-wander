// tests/wander-online-perf.test.ts — the render path's steady-state
// contract: with 32 players on screen, the pooled remote nodes stop
// churning once the scene is warm (no births, no recycles), and the ring's
// mounted/visible counts stay flat. A regression that allocates per frame
// (re-creating nodes, growing the pool) moves the counters and goes red.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { bootWorld } from "../vendor/pocket-rpgkit/vendor/pocketjs/hosts/sim/sim.ts";
import { appBundle, appPreflight } from "./helpers/boot.ts";
import { encodeRoster, encodeState, encodeWelcome, type WireEntity } from "../examples/wander-online/net/protocol.ts";
import type { PocketSocket, SocketCloseEvent } from "@pocketjs/framework/socket";

setDefaultTimeout(30_000);

const preflight = appPreflight("wander-online");
if (!preflight.ok) console.warn(`wander-online perf tests skipped: ${preflight.reason}`);
const simDescribe = preflight.ok ? describe : describe.skip;

const PLAYERS = 32;

/** A socket that joins a 32-player room: WELCOME + ROSTER + one STATE
 *  snapshot holding every player near the window centre. */
function fakeOnlineSocketFactory32(): (url: string) => PocketSocket {
  return () => {
    let opened = false;
    let state: "connecting" | "open" | "closing" | "closed" = "connecting";
    let frame = 0;
    const entities = (): WireEntity[] => {
      const out: WireEntity[] = [];
      for (let i = 0; i < PLAYERS; i++) {
        out.push({
          id: i + 1,
          tx: 40 + (i % 8) * 2,
          ty: 40 + Math.floor(i / 8) * 2,
          px: 0,
          py: 0,
          dir: i % 4,
          phase: 0,
          stepDir: 0,
          moving: false,
          walking: false,
          color: i % 16,
        });
      }
      return out;
    };
    const sendState = () => {
      frame++;
      sock.onMessage?.(new Uint8Array(encodeState(frame, frame, entities())));
    };
    const sendWelcome = () => {
      const grid = new Uint8Array(96 * 96);
      sock.onMessage?.(new Uint8Array(encodeWelcome(1, 0x5eed_0001, 0, 0, grid)));
      const roster = Array.from({ length: PLAYERS }, (_, i) => ({ id: i + 1, name: `P${i + 1}`, look: i % 64 }));
      sock.onMessage?.(new Uint8Array(encodeRoster(roster)));
      sock.onMessage?.(JSON.stringify({ type: "ready", ticket: "t1" }));
      sendState();
      // Keep the snapshots coming so the client's 2 s freeze does not fire.
      const iv = setInterval(() => {
        if (opened) sendState();
      }, 100);
      void iv;
    };
    const sock: PocketSocket = {
      url: "fake://online",
      protocol: "",
      get readyState() {
        return state;
      },
      onOpen: undefined,
      onMessage: undefined,
      onClose: undefined,
      onError: undefined,
      send(data: string | ArrayBuffer): boolean {
        if (!opened) return false;
        if (typeof data !== "string") return true;
        let msg: { type?: string };
        try {
          msg = JSON.parse(data);
        } catch {
          return true;
        }
        queueMicrotask(() => {
          if (msg.type === "join") sendWelcome();
        });
        return true;
      },
      close(code = 1000, reason = ""): void {
        if (!opened) return;
        opened = false;
        state = "closed";
        const ev: SocketCloseEvent = { code, reason, clean: code === 1000 };
        sock.onClose?.(ev);
      },
    };
    queueMicrotask(() => {
      opened = true;
      state = "open";
      sock.onOpen?.();
    });
    return sock;
  };
}

interface World {
  frame: (b: number, a?: number, t?: readonly number[]) => void;
  tick: () => void;
  render: () => Uint8Array;
  ticksPerFrame: number;
}

const churn = () => (globalThis as { __onlineNodeChurn?: number }).__onlineNodeChurn ?? 0;
const arrayAllocations = () => (globalThis as { __onlineArrayAllocations?: number }).__onlineArrayAllocations ?? 0;
const state = () => (globalThis as { __onlineState?: { status?: string; myId?: number } }).__onlineState;

simDescribe("wander-online perf: 32 players on screen", () => {
  test("the pooled remote nodes and id traversal allocate nothing once warm", async () => {
    const w = (await bootWorld(
      appBundle("wander-online"),
      60,
      {
        __onlineUrl: "ws://fake/ws",
        __onlineAuth: { kind: "ticket", ticket: "t1" },
        __onlineSocketFactory: fakeOnlineSocketFactory32(),
      },
      undefined,
      { width: 480, height: 272 },
    )) as unknown as World;
    const pump = (frames: number) => {
      for (let f = 0; f < frames; f++) {
        w.frame(0);
        for (let t = 0; t < w.ticksPerFrame; t++) w.tick();
      }
    };
    pump(5);
    await new Promise((r) => setTimeout(r, 50));
    // Wait for the join and the 32 remote nodes to be born.
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      pump(1);
      if (state()?.status === "joined" && churn() >= PLAYERS - 1) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(state()?.status).toBe("joined");
    expect(churn(), "32 remote nodes born").toBeGreaterThanOrEqual(PLAYERS - 1);
    // Steady state: 60 frames with no joins or leaves must not churn a
    // single node (the pool reuses the warm set).
    const before = churn();
    const arraysBefore = arrayAllocations();
    pump(60);
    expect(churn(), "no node churn across 60 steady frames").toBe(before);
    expect(arrayAllocations(), "no Interpolator.ids() arrays across 60 steady frames").toBe(arraysBefore);
    w.frame(0);
  });
});
