// tests/wander-online-client-core.test.ts — deterministic unit coverage for
// client-only protocol behavior that does not need the loopback Bun server.
import { describe, expect, test } from "bun:test";
import type { PocketSocket, SocketCloseEvent, SocketReadyState } from "@pocketjs/framework/socket";
import { OnlineClient, type SocketFactory } from "../examples/wander-online/net/client.ts";
import {
  encodeState,
  encodeWelcome,
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
  test("HUD online count includes the local player for one, two and three players", () => {
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

    for (const players of [[entity(7)], [entity(7), entity(8)], [entity(9), entity(7), entity(8)]]) {
      now += 100;
      harness.message(encodeState(now, 0, players));
      expect(client.hud().online).toBe(players.length);
      expect(client.interp.ids().length).toBe(players.length - 1);
    }
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
      { type: "join", v: 3, ticket: "linked-ticket" },
    ]);
    linkedClient.stop();
  });
});
