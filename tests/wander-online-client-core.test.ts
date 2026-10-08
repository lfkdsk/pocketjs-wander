// tests/wander-online-client-core.test.ts — deterministic unit coverage for
// client-only protocol behavior that does not need the loopback Bun server.
import { describe, expect, test } from "bun:test";
import type { PocketSocket, SocketCloseEvent, SocketReadyState } from "@pocketjs/framework/socket";
import { OnlineClient, realmEndpoint, type SocketFactory } from "../examples/wander-online/net/client.ts";
import {
  WORLD_PROTOCOL_VERSION,
  encodeState4,
  encodeState,
  encodeWelcome,
  encodeWelcome4,
  type WireEntity,
} from "../examples/wander-online/net/protocol.ts";
import { WINDOW } from "../examples/wander/window.ts";

interface SocketHarness {
  factory: SocketFactory;
  sent: (string | Uint8Array | ArrayBuffer)[];
  open: () => void;
  message: (data: string | ArrayBuffer) => void;
}

function socketHarness(): SocketHarness {
  let state: SocketReadyState = "connecting";
  const sent: (string | Uint8Array | ArrayBuffer)[] = [];
  const socket: PocketSocket = {
    url: "ws://unit.test/ws",
    protocol: "",
    get readyState() {
      return state;
    },
    send(data): boolean {
      sent.push(data);
      return true;
    },
    close(code = 1000, reason = ""): void {
      if (state === "closed") return;
      state = "closed";
      const event: SocketCloseEvent = { code, reason, clean: code === 1000 };
      socket.onClose?.(event);
    },
  };
  return {
    factory: () => socket,
    sent,
    open: () => {
      state = "open";
      socket.onOpen?.();
    },
    message: (data) => socket.onMessage?.(typeof data === "string" ? data : new Uint8Array(data)),
  };
}

function entity(id: number): WireEntity {
  return {
    id,
    tx: 48 + id,
    ty: 48,
    px: 0,
    py: 0,
    dir: id & 3,
    phase: 0,
    stepDir: id & 3,
    moving: false,
    walking: false,
    color: id & 0x0f,
  };
}

describe("wander-online client core", () => {
  test("v4 route, JOIN capability and epoch-aware state are explicit", () => {
    expect(realmEndpoint("wss://example.test/ws")).toBe("wss://example.test/ws/v4");
    expect(realmEndpoint("wss://example.test/ws?ticket=x")).toBe("wss://example.test/ws/v4?ticket=x");
    expect(realmEndpoint("wss://example.test/ws/v4")).toBe("wss://example.test/ws/v4");
    const harness = socketHarness();
    const client = new OnlineClient("ws://unit.test/ws", {
      auth: { kind: "ticket", ticket: "realm-ticket" },
      socketFactory: harness.factory,
    });
    expect(client.url).toBe("ws://unit.test/ws/v4");
    harness.open();
    expect(JSON.parse(harness.sent[0] as string)).toEqual({
      type: "join",
      v: WORLD_PROTOCOL_VERSION,
      clientBuild: "pocketjs-wander",
      supportedGeneratorVersions: [1],
      ticket: "realm-ticket",
    });
    harness.message(encodeWelcome4({
      you: 7,
      seed: 0x5eed_0001,
      generatorVersion: 1,
      epoch: 19,
      realmId: "west",
      realmRevision: 0,
      serverTimeMs: 0,
      mover: {
        tx: -700, ty: 800, px: 0, py: 0,
        dir: 0, phase: 0, stepDir: 0,
        moving: false, walking: false,
      },
    }));
    expect(client.status).toBe("joined");
    expect(client.hud().realmId).toBe("west");
    expect(client.epoch).toBe(19);
    harness.message(encodeState4(1, 0, 19, [{ ...entity(7), tx: -700, ty: 800 }], { roomOnline: 2, allOnline: 5 }));
    expect(client.hud().online).toBe(2);
    expect(client.hud().allOnline).toBe(5);
    client.stop();
  });

  test("HUD population handles legacy one/two/three-player snapshots and a cross-room total", () => {
    const harness = socketHarness();
    let now = 1000;
    const client = new OnlineClient("ws://unit.test/ws", {
      now: () => now,
      socketFactory: harness.factory,
    });
    harness.open();
    harness.message(encodeWelcome(7, 123, 0, 0, new Uint8Array(WINDOW * WINDOW)));

    // Admission itself establishes one online player, before STATE arrives.
    expect(client.hud().online).toBe(1);
    expect(client.hud().allOnline).toBe(1);

    for (const players of [[entity(7)], [entity(7), entity(8)], [entity(9), entity(7), entity(8)]]) {
      now += 100;
      harness.message(encodeState(now, 0, players));
      expect(client.hud().online).toBe(players.length);
      // An old server has no population tail: ALL safely falls back to the
      // room/AOI count rather than advertising a made-up global number.
      expect(client.hud().allOnline).toBe(players.length);
      expect(client.interp.ids().length).toBe(players.length - 1);
    }

    now += 100;
    harness.message(encodeState(now, 0, [entity(7), entity(8)], { roomOnline: 3, allOnline: 12 }));
    expect(client.hud().online).toBe(3);
    expect(client.hud().allOnline).toBe(12);

    // Stale or malformed aggregate values never make the display contradict
    // players already visible in the snapshot, nor show ALL below ONLINE.
    now += 100;
    const staleRoom = encodeState(now, 0, [entity(7), entity(8)], { roomOnline: 1, allOnline: 1 });
    harness.message(staleRoom);
    expect(client.hud().online).toBe(2);
    expect(client.hud().allOnline).toBe(2);
    now += 100;
    const inverted = encodeState(now, 0, [entity(7)], { roomOnline: 6, allOnline: 6 });
    new DataView(inverted).setUint16(inverted.byteLength - 2, 2, true);
    harness.message(inverted);
    expect(client.hud().online).toBe(6);
    expect(client.hud().allOnline).toBe(6);
    client.stop();
  });

  test("needCreate, ready and linked replies expose their ticket and source for durable storage", () => {
    const readyHarness = socketHarness();
    const readyTickets: [string, string][] = [];
    const readyClient = new OnlineClient("ws://unit.test/ws", {
      auth: { kind: "github", token: "one-shot" },
      socketFactory: readyHarness.factory,
      onTicket: (ticket, source) => readyTickets.push([ticket, source]),
    });
    readyHarness.open();
    readyHarness.message(JSON.stringify({ type: "needCreate", login: "octo", ticket: "create-ticket" }));
    readyHarness.message(JSON.stringify({ type: "ready", ticket: "ready-ticket" }));
    expect(readyTickets).toEqual([
      ["create-ticket", "needCreate"],
      ["ready-ticket", "ready"],
    ]);
    expect(readyClient.auth).toEqual({ kind: "ticket", ticket: "ready-ticket" });
    readyClient.stop();

    const linkedHarness = socketHarness();
    const linkedTickets: [string, string][] = [];
    const linkedClient = new OnlineClient("ws://unit.test/ws", {
      auth: { kind: "link", code: "123456" },
      socketFactory: linkedHarness.factory,
      onTicket: (ticket, source) => linkedTickets.push([ticket, source]),
    });
    linkedHarness.open();
    linkedHarness.message(JSON.stringify({ type: "linked", ticket: "linked-ticket" }));

    const textMessages = linkedHarness.sent
      .filter((data): data is string => typeof data === "string")
      .map((data) => JSON.parse(data) as Record<string, unknown>);
    expect(linkedTickets).toEqual([["linked-ticket", "linked"]]);
    expect(linkedClient.auth).toEqual({ kind: "ticket", ticket: "linked-ticket" });
    expect(textMessages).toEqual([
      { type: "linkr", v: 3, code: "123456" },
      {
        type: "join",
        v: WORLD_PROTOCOL_VERSION,
        clientBuild: "pocketjs-wander",
        supportedGeneratorVersions: [1],
        ticket: "linked-ticket",
      },
    ]);
    linkedClient.stop();
  });

  test("late auth replies cannot revive a stopped client", () => {
    const harness = socketHarness();
    const tickets: [string, string][] = [];
    const creates: [string, string][] = [];
    const client = new OnlineClient("ws://unit.test/ws", {
      auth: { kind: "github", token: "one-shot" },
      socketFactory: harness.factory,
      onTicket: (ticket, source) => tickets.push([ticket, source]),
      onNeedCreate: (login, ticket) => creates.push([login, ticket]),
    });
    harness.open();
    const sentBeforeStop = harness.sent.length;
    client.stop();

    harness.message(JSON.stringify({ type: "needCreate", login: "late", ticket: "create-ticket" }));
    harness.message(JSON.stringify({ type: "ready", ticket: "ready-ticket" }));
    harness.message(JSON.stringify({ type: "linked", ticket: "linked-ticket" }));

    expect(client.auth).toEqual({ kind: "github", token: "one-shot" });
    expect(tickets).toEqual([]);
    expect(creates).toEqual([]);
    expect(harness.sent).toHaveLength(sentBeforeStop);
  });
});
