// tests/wander-online-client-core.test.ts — deterministic unit coverage for
// client-only protocol behavior that does not need the loopback Bun server.
import { describe, expect, test } from "bun:test";
import { SocketError, type PocketSocket, type SocketCloseEvent, type SocketReadyState } from "@pocketjs/framework/socket";
import {
  OnlineClient,
  PREDICTION_REBASE_CLOSE_CODE,
  UPGRADE_REQUIRED_CLOSE_CODE,
  realmEndpoint,
  type SocketFactory,
} from "../examples/wander-online/net/client.ts";
import {
  BTN,
  MSG,
  REGION_STATE_FLAG_INITIAL,
  WELCOME4_FLAG_INPUT_BATCH_6,
  WORLD_PROTOCOL_VERSION,
  WORLD_STATE_VERSION,
  decodeInputBatch,
  decodeWelcome4Capabilities,
  encodeBye,
  encodePlayerProgress,
  encodeRegionState,
  encodeRoster,
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
  closeRequests: { code: number; reason: string }[];
  open: () => void;
  refusedOpen: () => void;
  refusedSendOpen: () => void;
  refuseSend: (error?: SocketError) => void;
  close: (code: number, reason: string) => void;
  message: (data: string | ArrayBuffer) => void;
  captureCallbacks: () => {
    open: () => void;
    close: (code: number, reason: string) => void;
    message: (data: string | ArrayBuffer) => void;
  };
}

function socketHarness(opts: { deferClientClose?: boolean } = {}): SocketHarness {
  let state: SocketReadyState = "connecting";
  let sendError: SocketError | null = null;
  const sent: (string | Uint8Array | ArrayBuffer)[] = [];
  const closeRequests: { code: number; reason: string }[] = [];
  const deliverClose = (code: number, reason: string): void => {
    if (state === "closed") return;
    state = "closed";
    const event: SocketCloseEvent = { code, reason, clean: code === 1000 };
    socket.onClose?.(event);
  };
  const socket: PocketSocket = {
    url: "ws://unit.test/ws",
    protocol: "",
    get readyState() {
      return state;
    },
    send(data): boolean {
      if (state !== "open") throw new SocketError("closed", "socket: socket is not open");
      if (sendError) throw sendError;
      sent.push(data);
      return true;
    },
    close(code = 1000, reason = ""): void {
      if (code !== 1000 && (!Number.isInteger(code) || code < 3000 || code > 4999)) {
        throw new RangeError(`invalid client WebSocket close code ${code}`);
      }
      if (state === "closed") return;
      closeRequests.push({ code, reason });
      if (opts.deferClientClose) {
        state = "closing";
        return;
      }
      deliverClose(code, reason);
    },
  };
  return {
    factory: () => socket,
    sent,
    closeRequests,
    open: () => {
      state = "open";
      socket.onOpen?.();
    },
    refusedOpen: () => {
      // Web hosts can dequeue open after the peer has already closed with a
      // policy refusal in the same pump turn.
      state = "closed";
      socket.onOpen?.();
    },
    refusedSendOpen: () => {
      // The SDK has dispatched open, but the native transport has already
      // closed and refuses send before its queued close event is dispatched.
      state = "open";
      sendError = new SocketError("closed", "socket: socket is not open");
      socket.onOpen?.();
    },
    refuseSend: (error = new SocketError("closed", "socket: socket is not open")) => {
      sendError = error;
    },
    // Peer-originated close codes are not subject to the browser's narrower
    // rule for close codes initiated by this client.
    close: deliverClose,
    message: (data) => socket.onMessage?.(typeof data === "string" ? data : new Uint8Array(data)),
    captureCallbacks: () => {
      // Model a native host that already queued callbacks before the client
      // detached the old socket during an explicit realm switch.
      const onOpen = socket.onOpen;
      const onClose = socket.onClose;
      const onMessage = socket.onMessage;
      return {
        open: () => onOpen?.(),
        close: (code, reason) => onClose?.({ code, reason, clean: code === 1000 }),
        message: (data) => onMessage?.(typeof data === "string" ? data : new Uint8Array(data)),
      };
    },
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

function realmWelcome(epoch = 19, realmId = "west"): ArrayBuffer {
  return encodeWelcome4({
    you: 7,
    seed: 0x5eed_0001,
    generatorVersion: 1,
    epoch,
    realmId,
    realmRevision: 0,
    serverTimeMs: 1_000,
    mover: {
      tx: -700, ty: 800, px: 0, py: 0,
      dir: 0, phase: 0, stepDir: 0,
      moving: false, walking: false,
    },
  });
}

function readyRealm(harness: SocketHarness, welcome = realmWelcome()): void {
  harness.message(welcome);
  harness.message(encodeRegionState({
    flags: REGION_STATE_FLAG_INITIAL,
    realmRevision: 1,
    serverTimeMs: 1_000,
    rows: [{
      rx: -8, ry: 8, discoveredAtMs: 0,
      improvementLevel: 0, revision: 1, landmarkFirstName: "",
    }],
  }));
}

function inputBatches(sent: readonly (string | Uint8Array | ArrayBuffer)[]) {
  return sent.flatMap((data) => {
    if (typeof data === "string") return [];
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (bytes[0] !== MSG.inputBatch) return [];
    const decoded = decodeInputBatch(bytes);
    return decoded ? [decoded] : [];
  });
}

describe("wander-online client core", () => {
  test("an immediate refusal during the queued open callback cannot hide its close reason", () => {
    const harness = socketHarness();
    const client = new OnlineClient("ws://unit.test/ws", {
      auth: { kind: "ticket", ticket: "realm-ticket" },
      socketFactory: harness.factory,
    });
    expect(() => harness.refusedOpen()).not.toThrow();
    expect(() => harness.refusedSendOpen()).not.toThrow();
    expect(harness.sent).toEqual([]);
    client.stop();
  });

  test("a native close before its callback cannot crash a joined client's frame", () => {
    const first = socketHarness(), second = socketHarness();
    const factories = [first.factory, second.factory];
    let opened = 0;
    let now = 1_000;
    const client = new OnlineClient("ws://unit.test/ws", {
      now: () => now,
      socketFactory: (url, opts) => factories[opened++]!(url, opts),
    });
    first.open();
    readyRealm(first);

    // Leave five of the negotiated six ticks pending. The native transport
    // then closes, while PocketSocket still reports "open" until its queued
    // close callback runs in the next service-pump turn.
    for (let i = 0; i < 5; i++) client.onFrame(BTN.right, 60, 0);
    first.refuseSend();
    expect(() => client.onFrame(BTN.right, 60, 0)).not.toThrow();

    first.close(1008, "rest");
    expect(client.hud()).toMatchObject({
      status: "retrying",
      rejectReason: "rest",
      rejectText: "CLOSED FOR THE MONTH",
      retryIn: 15_000,
    });

    // The slow retry can hit the same native-close window during JOIN. It
    // stays harmless and the authoritative second close doubles backoff.
    now += 15_000;
    client.onFrame(0, 60, 0);
    expect(() => second.refusedSendOpen()).not.toThrow();
    second.close(1008, "rest");
    expect(client.hud()).toMatchObject({
      status: "retrying",
      rejectReason: "rest",
      rejectText: "CLOSED FOR THE MONTH",
      retryIn: 30_000,
    });
    client.stop();
  });

  test("a passive close publishes an empty roster with reconnect state before retrying", () => {
    const first = socketHarness(), second = socketHarness();
    const factories = [first.factory, second.factory];
    let connectionCount = 0;
    let now = 1_000;
    const updates: { ids: number[]; status: string }[] = [];
    let client!: OnlineClient;
    client = new OnlineClient("ws://unit.test/ws", {
      now: () => now,
      socketFactory: (url, opts) => factories[connectionCount++]!(url, opts),
      onRoster: (entries) => updates.push({
        ids: entries.map((entry) => entry.id),
        status: client.status,
      }),
    });
    first.open();
    readyRealm(first);
    first.message(encodeRoster([
      { id: 7, name: "Self", look: 0 },
      { id: 8, name: "Nearby", look: 1 },
    ]));
    expect(updates).toEqual([{ ids: [7, 8], status: "joined" }]);

    first.close(1006, "abnormal drop");
    expect(client.roster.size).toBe(0);
    expect(updates).toEqual([
      { ids: [7, 8], status: "joined" },
      { ids: [], status: "reconnecting" },
    ]);
    expect(client.hud()).toMatchObject({ status: "reconnecting", retryIn: 1_000 });

    now += 999;
    client.onFrame(0, 60, 0);
    expect(connectionCount).toBe(1);
    now += 1;
    client.onFrame(0, 60, 0);
    expect(connectionCount).toBe(2);
    expect(client.status).toBe("connecting");
    second.open();
    readyRealm(second, realmWelcome(20));
    expect(client.status).toBe("joined");
    client.stop();
  });

  test("gameplay sends still surface non-closed socket failures", () => {
    const harness = socketHarness();
    const client = new OnlineClient("ws://unit.test/ws", {
      now: () => 1_000,
      socketFactory: harness.factory,
    });
    harness.open();
    readyRealm(harness);
    for (let i = 0; i < 5; i++) client.onFrame(BTN.left, 60, 0);
    harness.refuseSend(new SocketError("protocol", "socket: malformed test frame"));
    expect(() => client.onFrame(BTN.left, 60, 0)).toThrow("socket: malformed test frame");
    client.stop();
  });

  test("an incompatible WELCOME4 uses a private close without retrying, while server 1008 remains compatible", () => {
    const incompatible = socketHarness();
    let now = 1_000;
    let connectionCount = 0;
    const client = new OnlineClient("ws://unit.test/ws", {
      now: () => now,
      socketFactory: (url, opts) => {
        connectionCount++;
        return incompatible.factory(url, opts);
      },
    });
    incompatible.open();

    // Keep the WELCOME4 discriminator but truncate its fixed payload so the
    // client must reject it before accepting a world epoch.
    const malformedWelcome = realmWelcome().slice(0, 41);
    expect(() => incompatible.message(malformedWelcome)).not.toThrow();
    expect(incompatible.closeRequests).toEqual([{
      code: UPGRADE_REQUIRED_CLOSE_CODE,
      reason: "upgrade-required",
    }]);
    expect(client.hud()).toMatchObject({
      status: "rejected",
      rejectReason: "upgrade-required",
      rejectText: "WORLD UPDATE REQUIRED",
      retryIn: 0,
    });

    now += 120_000;
    client.onFrame(0, 60, 0);
    expect(connectionCount).toBe(1);

    // A hosted server can still originate the standard 1008 policy close;
    // it is delivered as a peer event, not mistaken for a client request.
    const refused = socketHarness();
    const refusedClient = new OnlineClient("ws://unit.test/ws", {
      now: () => now,
      socketFactory: refused.factory,
    });
    refused.open();
    refused.close(1008, "upgrade-required");
    expect(refused.closeRequests).toEqual([]);
    expect(refusedClient.hud()).toMatchObject({
      status: "rejected",
      rejectReason: "upgrade-required",
      rejectText: "WORLD UPDATE REQUIRED",
      retryIn: 0,
    });

    client.stop();
    refusedClient.stop();
  });

  test("a prediction rebase uses a private close and reconnects into the new epoch", () => {
    const first = socketHarness({ deferClientClose: true }), second = socketHarness();
    const factories = [first.factory, second.factory];
    let connectionCount = 0;
    let now = 1_000;
    const client = new OnlineClient("ws://unit.test/ws", {
      now: () => now,
      auth: { kind: "ticket", ticket: "realm-ticket" },
      socketFactory: (url, opts) => factories[connectionCount++]!(url, opts),
    });
    first.open();
    readyRealm(first, realmWelcome(19));
    expect(client.status).toBe("joined");
    const oldPredictor = client.predictor;
    client.roster.set(8, { id: 8, name: "Old", look: 1 });
    client.far.set(8, { dir: 2, band: 1, at: now });
    client.emotes.set(8, { emote: 1, until: now + 5_000 });
    client.interp.push([entity(8)], now);

    // A snapshot from another epoch cannot be reconciled against this
    // predictor. Closing must itself be browser-valid so onClose can clear
    // the frozen client and schedule the normal reconnect.
    expect(() => first.message(encodeState4(
      1_100,
      0,
      20,
      [{ ...entity(7), tx: -700, ty: 800 }],
    ))).not.toThrow();
    expect(first.closeRequests).toEqual([{
      code: PREDICTION_REBASE_CLOSE_CODE,
      reason: "prediction rebase",
    }]);
    expect(client.status).toBe("frozen");
    expect(client.onFrame(BTN.left, 60, 0)).toBe(0);
    expect(client.predictor).toBe(oldPredictor);

    // The transport reports close asynchronously. Its echoed code/reason are
    // not needed: a rebase follows the ordinary reconnect policy.
    first.close(1000, "");
    expect(client.hud()).toMatchObject({ status: "reconnecting", retryIn: 1_000 });
    expect(client.myId).toBe(0);
    expect(client.predictor).toBeNull();
    expect(client.roster.size).toBe(0);
    expect(client.far.size).toBe(0);
    expect(client.emotes.size).toBe(0);
    expect(client.interp.ids()).toEqual([]);

    now += 999;
    client.onFrame(0, 60, 0);
    expect(connectionCount).toBe(1);
    now += 1;
    client.onFrame(0, 60, 0);
    expect(connectionCount).toBe(2);
    expect(client.status).toBe("connecting");
    second.open();
    expect(JSON.parse(second.sent[0] as string)).toMatchObject({
      type: "join",
      ticket: "realm-ticket",
    });
    readyRealm(second, realmWelcome(20));
    expect(client.status).toBe("joined");
    expect(client.epoch).toBe(20);
    expect(client.predictor).not.toBe(oldPredictor);
    expect(client.predictor?.lastSeq).toBe(0);
    expect(client.predictor?.unacked).toBe(0);
    expect(second.closeRequests).toEqual([]);
    client.stop();
  });

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
      worldStateVersion: WORLD_STATE_VERSION,
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
    expect(client.status).toBe("connecting");
    expect(client.hud().realmId).toBe("west");
    expect(client.epoch).toBe(19);
    client.onFrame(0, 60, 0);
    expect(client.predictor?.lastSeq).toBe(0);
    harness.message(encodeRegionState({
      flags: REGION_STATE_FLAG_INITIAL,
      realmRevision: 3,
      serverTimeMs: 1_000,
      rows: [{
        rx: -8, ry: 8, discoveredAtMs: 500,
        improvementLevel: 1, revision: 3, landmarkFirstName: "Pathfinder",
      }],
    }));
    harness.message(encodePlayerProgress({ revision: 4, landmarks: [{ rx: -8, ry: 8 }, { rx: 1, ry: -2 }] }));
    expect(client.status).toBe("joined");
    expect(client.hud().landmarkFirstName).toBe("Pathfinder");
    expect(client.hud().progressCount).toBe(2);
    expect(client.hud().progressKeys).toEqual(["-8,8", "1,-2"]);
    expect(client.hud().improvementLevel).toBe(1);
    harness.message(encodeState4(1, 0, 19, [{ ...entity(7), tx: -700, ty: 800 }], { roomOnline: 2, allOnline: 5 }));
    expect(client.hud().online).toBe(2);
    expect(client.hud().allOnline).toBe(5);
    client.stop();
  });

  test("a capable v4 welcome sends six predicted 60 Hz ticks in one 10 Hz batch", () => {
    expect(decodeWelcome4Capabilities(realmWelcome())?.inputBatchSize).toBe(6);
    const harness = socketHarness();
    const client = new OnlineClient("ws://unit.test/ws", {
      now: () => 1_000,
      socketFactory: harness.factory,
    });
    harness.open();
    readyRealm(harness);

    client.onFrame(BTN.right, 60, 0);
    expect(client.predictor?.lastSeq).toBe(1); // prediction is immediate
    expect(client.predictor?.unacked).toBe(1);
    expect(inputBatches(harness.sent)).toHaveLength(0);
    for (let i = 1; i < 5; i++) client.onFrame(BTN.right, 60, 0);
    expect(client.predictor?.lastSeq).toBe(5);
    expect(inputBatches(harness.sent)).toHaveLength(0);

    client.onFrame(BTN.right, 60, 0);
    expect(inputBatches(harness.sent)).toEqual([{
      firstSeq: 1,
      buttons: [BTN.right, BTN.right, BTN.right, BTN.right, BTN.right, BTN.right],
    }]);
    client.stop();
  });

  test("a capable v4 welcome sends one six-tick batch every two 20 Hz frames", () => {
    const harness = socketHarness();
    const client = new OnlineClient("ws://unit.test/ws", {
      now: () => 1_000,
      socketFactory: harness.factory,
    });
    harness.open();
    readyRealm(harness);

    client.onFrame(BTN.down, 20, 0);
    expect(client.predictor?.lastSeq).toBe(3);
    expect(inputBatches(harness.sent)).toHaveLength(0);
    client.onFrame(BTN.down, 20, 0);
    expect(client.predictor?.lastSeq).toBe(6);
    expect(inputBatches(harness.sent)).toEqual([{
      firstSeq: 1,
      buttons: [BTN.down, BTN.down, BTN.down, BTN.down, BTN.down, BTN.down],
    }]);
    client.stop();
  });

  test("an old v4 welcome without the capability bit falls back to three ticks", () => {
    const oldWelcome = realmWelcome();
    const flags = new DataView(oldWelcome).getUint8(28);
    new DataView(oldWelcome).setUint8(28, flags & ~WELCOME4_FLAG_INPUT_BATCH_6);
    expect(decodeWelcome4Capabilities(oldWelcome)?.inputBatchSize).toBe(3);

    const harness = socketHarness();
    const client = new OnlineClient("ws://unit.test/ws", {
      now: () => 1_000,
      socketFactory: harness.factory,
    });
    harness.open();
    readyRealm(harness, oldWelcome);
    client.onFrame(BTN.left, 60, 0);
    client.onFrame(BTN.left, 60, 0);
    expect(inputBatches(harness.sent)).toHaveLength(0);
    client.onFrame(BTN.left, 60, 0);
    expect(inputBatches(harness.sent)).toEqual([{
      firstSeq: 1,
      buttons: [BTN.left, BTN.left, BTN.left],
    }]);
    client.stop();
  });

  test("a fresh WELCOME4 discards a partial batch from the previous epoch", () => {
    const harness = socketHarness();
    const client = new OnlineClient("ws://unit.test/ws", {
      now: () => 1_000,
      socketFactory: harness.factory,
    });
    harness.open();
    readyRealm(harness, realmWelcome(19));
    client.roster.set(8, { id: 8, name: "Old", look: 1 });
    client.far.set(8, { dir: 2, band: 1, at: 1_000 });
    client.emotes.set(8, { emote: 1, until: 6_000 });
    client.interp.push([entity(8)], 1_000);
    for (let i = 0; i < 5; i++) client.onFrame(BTN.right, 60, 0);
    expect(inputBatches(harness.sent)).toHaveLength(0);

    readyRealm(harness, realmWelcome(20));
    expect(client.roster.size).toBe(0);
    expect(client.far.size).toBe(0);
    expect(client.emotes.size).toBe(0);
    expect(client.interp.ids()).toEqual([]);
    for (let i = 0; i < 5; i++) client.onFrame(BTN.left, 60, 0);
    expect(inputBatches(harness.sent)).toHaveLength(0);
    client.onFrame(BTN.left, 60, 0);
    expect(inputBatches(harness.sent)).toEqual([{
      firstSeq: 1,
      buttons: [BTN.left, BTN.left, BTN.left, BTN.left, BTN.left, BTN.left],
    }]);
    client.stop();
  });

  test("switchRealm validates its target, clears the old epoch and ignores callbacks already queued by the old socket", () => {
    const first = socketHarness(), second = socketHarness();
    const factories = [first.factory, second.factory];
    const urls: string[] = [];
    let opened = 0;
    const client = new OnlineClient("ws://unit.test/ws", {
      now: () => 1_000,
      socketFactory: (url, opts) => {
        urls.push(url);
        return factories[opened++]!(url, opts);
      },
    });
    first.open();
    readyRealm(first, realmWelcome(19, "west"));
    const oldPredictor = client.predictor;
    const queued = first.captureCallbacks();
    client.roster.set(8, { id: 8, name: "Old", look: 1 });
    client.far.set(8, { dir: 2, band: 1, at: 1_000 });
    client.emotes.set(8, { emote: 1, until: 6_000 });
    client.interp.push([entity(8)], 1_000);
    for (let i = 0; i < 5; i++) client.onFrame(BTN.right, 60, 0);

    for (const [realm, invite] of [
      ["", null],
      ["bad realm", null],
      ["x".repeat(33), null],
      [null, "ABCDEFGH"],
      ["east_2", "abcdefgh"],
      ["east_2", "ABC"],
    ] as const) {
      expect(client.switchRealm(realm, invite)).toBe(false);
    }
    expect(client.realmPin).toBe("west");
    expect(client.predictor).toBe(oldPredictor);
    expect(first.closeRequests).toEqual([]);

    expect(client.switchRealm("east_2", "ABCDEFGH")).toBe(true);
    expect(client.realmPin).toBe("east_2");
    expect(client.invite).toBe("ABCDEFGH");
    expect(client.status).toBe("reconnecting");
    expect(client.predictor).toBeNull();
    expect(client.roster.size).toBe(0);
    expect(client.far.size).toBe(0);
    expect(client.emotes.size).toBe(0);
    expect(client.interp.ids()).toEqual([]);
    expect(first.closeRequests).toEqual([{ code: 1000, reason: "switch realm" }]);

    client.onFrame(0, 60, 0);
    expect(urls).toEqual([
      "ws://unit.test/ws/v4",
      "ws://unit.test/ws/v4?realm=east_2&invite=ABCDEFGH",
    ]);

    // These closures were captured before switchRealm detached the handlers.
    // Identity guards must make them inert even though a new socket now owns
    // the client.
    const firstSent = first.sent.length;
    queued.open();
    queued.message(realmWelcome(99, "stale"));
    queued.close(1008, "realm");
    expect(first.sent).toHaveLength(firstSent);
    expect(client.realmPin).toBe("east_2");
    expect(client.status).toBe("reconnecting");

    second.open();
    expect(JSON.parse(second.sent[0] as string)).toMatchObject({ type: "join" });
    readyRealm(second, realmWelcome(20, "east_2"));
    expect(client.status).toBe("joined");
    expect(client.realmPin).toBe("east_2");
    expect(client.invite).toBeNull();
    for (let i = 0; i < 6; i++) client.onFrame(BTN.left, 60, 0);
    expect(inputBatches(second.sent)).toEqual([{
      firstSeq: 1,
      buttons: [BTN.left, BTN.left, BTN.left, BTN.left, BTN.left, BTN.left],
    }]);
    client.stop();
  });

  test("a strict BYE removes only the named roster entry", () => {
    const harness = socketHarness();
    const updates: number[][] = [];
    const client = new OnlineClient("ws://unit.test/ws", {
      socketFactory: harness.factory,
      onRoster: (entries) => updates.push(entries.map((entry) => entry.id)),
    });
    harness.open();
    readyRealm(harness);
    harness.message(encodeRoster([
      { id: 7, name: "Self", look: 0 },
      { id: 8, name: "Gone", look: 1 },
    ]));
    client.far.set(8, { dir: 2, band: 1, at: 1_000 });
    client.emotes.set(8, { emote: 1, until: 6_000 });
    expect([...client.roster.keys()]).toEqual([7, 8]);
    expect(updates).toEqual([[7, 8]]);

    const trailing = new Uint8Array(6);
    trailing.set(new Uint8Array(encodeBye(8)));
    harness.message(trailing.buffer);
    expect(client.roster.has(8)).toBe(true);
    expect(updates).toEqual([[7, 8]]);

    harness.message(encodeBye(8));
    expect([...client.roster.keys()]).toEqual([7]);
    expect(updates).toEqual([[7, 8], [7]]);
    expect(client.far.has(8)).toBe(false);
    expect(client.emotes.has(8)).toBe(false);
    client.stop();
  });

  test("leaveRealm discards a partial batch before the next connection", () => {
    const first = socketHarness(), second = socketHarness();
    const factories = [first.factory, second.factory];
    let opened = 0;
    const factory: SocketFactory = (url, opts) => factories[opened++]!(url, opts);
    const client = new OnlineClient("ws://unit.test/ws", {
      now: () => 1_000,
      socketFactory: factory,
    });
    first.open();
    readyRealm(first, realmWelcome(19));
    for (let i = 0; i < 5; i++) client.onFrame(BTN.right, 60, 0);
    expect(inputBatches(first.sent)).toHaveLength(0);

    client.leaveRealm();
    client.onFrame(0, 60, 0); // opens the replacement socket
    second.open();
    readyRealm(second, realmWelcome(20));
    for (let i = 0; i < 6; i++) client.onFrame(BTN.left, 60, 0);
    expect(inputBatches(second.sent)).toEqual([{
      firstSeq: 1,
      buttons: [BTN.left, BTN.left, BTN.left, BTN.left, BTN.left, BTN.left],
    }]);
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
        worldStateVersion: WORLD_STATE_VERSION,
        ticket: "linked-ticket",
      },
    ]);
    linkedClient.stop();
  });

  test("late auth replies cannot revive a stopped client", () => {
    const harness = socketHarness({ deferClientClose: true });
    const tickets: [string, string][] = [];
    const creates: [string, string][] = [];
    const client = new OnlineClient("ws://unit.test/ws", {
      auth: { kind: "github", token: "one-shot" },
      socketFactory: harness.factory,
      onTicket: (ticket, source) => tickets.push([ticket, source]),
      onNeedCreate: (login, ticket) => creates.push([login, ticket]),
    });
    harness.open();
    client.roster.set(8, { id: 8, name: "Old", look: 1 });
    client.far.set(8, { dir: 2, band: 1, at: 1_000 });
    client.emotes.set(8, { emote: 1, until: 6_000 });
    const sentBeforeStop = harness.sent.length;
    client.stop();

    expect(client.roster.size).toBe(0);
    expect(client.far.size).toBe(0);
    expect(client.emotes.size).toBe(0);

    harness.message(JSON.stringify({ type: "needCreate", login: "late", ticket: "create-ticket" }));
    harness.message(JSON.stringify({ type: "ready", ticket: "ready-ticket" }));
    harness.message(JSON.stringify({ type: "linked", ticket: "linked-ticket" }));

    expect(client.auth).toEqual({ kind: "github", token: "one-shot" });
    expect(tickets).toEqual([]);
    expect(creates).toEqual([]);
    expect(harness.sent).toHaveLength(sentBeforeStop);
  });

  test("private PLAYER_PROGRESS snapshots stay isolated per OnlineClient", () => {
    const aHarness = socketHarness(), bHarness = socketHarness();
    const a = new OnlineClient("ws://unit.test/ws", { socketFactory: aHarness.factory });
    const b = new OnlineClient("ws://unit.test/ws", { socketFactory: bHarness.factory });
    aHarness.open();
    bHarness.open();
    aHarness.message(encodePlayerProgress({ revision: 1, landmarks: [{ rx: 1, ry: 2 }] }));
    bHarness.message(encodePlayerProgress({ revision: 1, landmarks: [{ rx: -3, ry: 4 }] }));
    expect(a.progressKeys).toEqual(["1,2"]);
    expect(b.progressKeys).toEqual(["-3,4"]);
    aHarness.message(encodePlayerProgress({ revision: 0, landmarks: [{ rx: 9, ry: 9 }] }));
    expect(a.progressKeys).toEqual(["1,2"]);
    expect(b.progressKeys).toEqual(["-3,4"]);
    a.stop();
    b.stop();
  });
});
