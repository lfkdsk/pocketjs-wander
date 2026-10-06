// tests/wander-online-client.test.ts — the OnlineClient lifecycle against a
// real loopback server: join, transport-drop reconnect, server-restart
// rejoin, and the epoch reset (a fresh join must not reuse the previous
// session's predictor ring or interpolator entities).
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { OnlineClient } from "../examples/wander-online/net/client.ts";
import { startServer, type ServerHandle } from "../examples/wander-online/server/server.ts";
import { bunSocketFactory, type BunPocketSocket } from "./lib/bun-pocket-socket.ts";
import { BTN } from "../examples/wander-online/net/protocol.ts";

const SEED = 0x5eed_0001;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ClientHandle {
  client: OnlineClient;
  /** Simulate a transport drop on this client's live socket. */
  drop: () => void;
}

describe("wander-online client reconnect", () => {
  let server: ServerHandle;
  let port: number;
  let driver: ReturnType<typeof setInterval> | undefined;
  const live: OnlineClient[] = [];

  beforeAll(async () => {
    server = startServer({ port: 0, seed: SEED, hz: 20, broadcastHz: 10, aoi: 48, simLatency: 0, webRoot: "" });
    port = server.port;
    await sleep(150);
  });

  afterAll(() => {
    stopDriver();
    for (const c of live.splice(0)) c.stop();
    server.close();
  });

  afterEach(() => {
    stopDriver();
    for (const c of live.splice(0)) c.stop();
  });

  const stopDriver = () => {
    if (driver) {
      clearInterval(driver);
      driver = undefined;
    }
  };

  const startDriver = () => {
    stopDriver();
    driver = setInterval(() => {
      for (const c of live) c.onFrame(0, 60, BTN.right);
    }, 16);
  };

  const mk = (name: string, color: number): ClientHandle => {
    let current: BunPocketSocket | null = null;
    const client = new OnlineClient(`ws://127.0.0.1:${port}/ws`, name, color, {
      socketFactory: (u) => {
        current = bunSocketFactory(u);
        return current;
      },
    });
    live.push(client);
    return { client, drop: () => current!.drop() };
  };

  const waitFor = async (pred: () => boolean, what: string, timeoutMs = 15000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (pred()) return;
      await sleep(50);
    }
    throw new Error(`timeout waiting for ${what}`);
  };

  test("two clients join and see each other", async () => {
    startDriver();
    const a = mk("alice", 1);
    const b = mk("bob", 2);
    await waitFor(() => a.client.status === "joined" && a.client.online === 2, "a joined with online 2");
    await waitFor(() => b.client.status === "joined" && b.client.online === 2, "b joined with online 2");
    expect(a.client.interp.ids().length).toBe(1);
    expect(b.client.interp.ids().length).toBe(1);
  });

  test("client reconnects after a transport drop and rejoins", async () => {
    startDriver();
    const a = mk("alice", 1);
    const b = mk("bob", 2);
    await waitFor(() => a.client.status === "joined" && a.client.online === 2, "a joined");
    await waitFor(() => b.client.status === "joined" && b.client.online === 2, "b joined");
    // a's transport vanishes; the client must detect it, back off, reconnect
    // and rejoin, seeing b again.
    a.drop();
    await waitFor(() => a.client.status === "reconnecting", "a reconnecting");
    await waitFor(() => a.client.status === "joined" && a.client.online === 2, "a rejoined with online 2");
    expect(a.client.interp.ids().length).toBe(1);
  });

  test("rejoin rebuilds the predictor ring (fresh epoch, no reused inputs)", async () => {
    startDriver();
    const a = mk("alice", 1);
    const b = mk("bob", 2);
    await waitFor(() => a.client.status === "joined" && a.client.interp.ids().length === 1, "a sees b");
    const oldPred = a.client.predictor;
    expect(oldPred).not.toBeNull();
    // Drop a; it rejoins (b is still connected). The predictor must be a new
    // object — the old input ring and history are not reused across epochs.
    a.drop();
    await waitFor(
      () =>
        a.client.status === "joined" &&
        a.client.predictor !== null &&
        a.client.predictor !== oldPred &&
        a.client.interp.ids().length === 1,
      "a rejoined with a fresh predictor and sees b",
    );
  });

  test("rejoin clears the interpolator: a remote that stays gone does not linger", async () => {
    startDriver();
    const a = mk("alice", 1);
    const b = mk("bob", 2);
    await waitFor(() => a.client.status === "joined" && a.client.interp.ids().length === 1, "a sees b");
    // Drop both; only a rejoins. b's entity must not survive in a's
    // interpolator (without the epoch reset it would linger for the 2 s TTL).
    a.drop();
    b.drop();
    b.client.stop(); // b stays gone
    await waitFor(() => a.client.status === "joined", "a rejoined");
    await waitFor(() => a.client.online === 1 && a.client.interp.ids().length === 0, "a sees only itself, no stale b");
  });

  test("server restart: clients drop and rejoin, seeing each other again", async () => {
    startDriver();
    const a = mk("alice", 1);
    const b = mk("bob", 2);
    await waitFor(() => a.client.status === "joined" && a.client.online === 2, "a joined");
    await waitFor(() => b.client.status === "joined" && b.client.online === 2, "b joined");
    // Kill the server and restart it on the same port (a crash, not a
    // graceful shutdown). Both clients must reconnect and rejoin.
    server.close();
    await sleep(500);
    server = startServer({ port, seed: SEED, hz: 20, broadcastHz: 10, aoi: 48, simLatency: 0, webRoot: "" });
    await sleep(150);
    await waitFor(() => a.client.status === "joined" && a.client.online === 2, "a rejoined after restart");
    await waitFor(() => b.client.status === "joined" && b.client.online === 2, "b rejoined after restart");
    expect(a.client.interp.ids().length).toBe(1);
    expect(b.client.interp.ids().length).toBe(1);
  });
});
