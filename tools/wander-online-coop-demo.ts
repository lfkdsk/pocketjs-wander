// Three real WebSocket clients complete one cooperative delivery against the
// loopback authoritative realm. Two travelers participate; the third client
// observes the single shared town improvement without seeing either private
// journey. The JSON output is suitable for release evidence or CI artifacts.

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { regionHub } from "../examples/wander/world.ts";
import { townErrand } from "../examples/wander/towns.ts";
import { isCooperativeErrand, JOURNEY_EVENT } from "../examples/wander-online/net/journey.ts";
import {
  COMMAND,
  WORLD_PROTOCOL_VERSION,
  WORLD_STATE_VERSION,
  decodePlayerJourney,
  decodeRegionState,
  decodeWelcome4,
  encodeCommand,
  type PlayerJourneyMessage,
  type RegionStateMessage,
} from "../examples/wander-online/net/protocol.ts";
import { startServer } from "../examples/wander-online/server/server.ts";
import type { RealmPlayer } from "../examples/wander-online/server/realm-area.ts";
import { connect, type TestSocket } from "../tests/lib/ws-helper.ts";

const SEED = 1593842689;
const OFFER = { rx: 0, ry: 0 } as const;
const OUTPUT = resolve(process.argv[2] ?? "reports/wander-online-coop-demo.json");

interface JoinedClient {
  name: string;
  socket: TestSocket;
  id: number;
  feature: Record<string, unknown>;
  initialCoop: Record<string, unknown>;
}

async function nextBinary<T>(
  socket: TestSocket,
  decode: (message: ArrayBuffer) => T | null,
  what: string,
  timeoutMs = 3_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const message = await socket.nextMessage(Math.max(1, deadline - Date.now()));
    if (message instanceof ArrayBuffer) {
      const decoded = decode(message);
      if (decoded) return decoded;
    }
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function nextText(
  socket: TestSocket,
  type: string,
  predicate: (message: Record<string, unknown>) => boolean = () => true,
  timeoutMs = 3_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const message = await socket.nextMessage(Math.max(1, deadline - Date.now()));
    if (typeof message !== "string") continue;
    const parsed = JSON.parse(message) as Record<string, unknown>;
    if (parsed.type === type && predicate(parsed)) return parsed;
  }
  throw new Error(`timed out waiting for ${type}`);
}

async function nextJourney(socket: TestSocket, eventKind: number): Promise<PlayerJourneyMessage> {
  return nextBinary(socket, (message) => {
    const journey = decodePlayerJourney(message);
    return journey?.eventKind === eventKind ? journey : null;
  }, `PLAYER_JOURNEY event ${eventKind}`);
}

async function nextImprovement(socket: TestSocket, rx: number, ry: number): Promise<{
  snapshot: RegionStateMessage;
  improvementLevel: number;
  revision: number;
}> {
  return nextBinary(socket, (message) => {
    const snapshot = decodeRegionState(message);
    const row = snapshot?.rows.find((candidate) => candidate.rx === rx && candidate.ry === ry && candidate.improvementLevel > 0);
    return snapshot && row ? { snapshot, improvementLevel: row.improvementLevel, revision: row.revision } : null;
  }, `shared improvement at ${rx},${ry}`);
}

function teleport(player: RealmPlayer, tx: number, ty: number): void {
  player.state = {
    ...player.state,
    move: {
      ...player.state.move,
      tx,
      ty,
      px: tx * 16,
      py: ty * 16,
      phase: 0,
      moving: false,
      walking: false,
    },
  };
  player.buttons = 0;
  player.queue.length = 0;
  player.scanX = null;
  player.scanY = null;
}

const server = startServer({
  port: 0,
  seed: SEED,
  hz: 20,
  broadcastHz: 10,
  aoi: 16,
  simLatency: 0,
  webRoot: "",
  allowGuests: true,
  realmEpoch: 1,
  manualTick: true,
});
const sockets: TestSocket[] = [];

try {
  const url = `ws://127.0.0.1:${server.port}/ws/v4`;
  const join = async (name: string, color: number): Promise<JoinedClient> => {
    const socket = await connect(url);
    sockets.push(socket);
    socket.send(JSON.stringify({
      type: "join",
      v: WORLD_PROTOCOL_VERSION,
      supportedGeneratorVersions: [1],
      worldStateVersion: WORLD_STATE_VERSION,
      name,
      color,
    }));
    const welcome = await nextBinary(socket, decodeWelcome4, `${name} WELCOME4`);
    const feature = await nextText(socket, "realmFeatures");
    const initialCoop = await nextText(socket, "coopErrand");
    assert.equal(feature.coopErrands, true);
    assert.equal(feature.discoveryLeaderboard, false);
    assert.equal(initialCoop.status, "none");
    return { name, socket, id: welcome.you, feature, initialCoop };
  };

  const alice = await join("Alice", 1);
  const bob = await join("Bob", 2);
  const observer = await join("Observer", 3);
  assert.equal(new Set([alice.id, bob.id, observer.id]).size, 3);
  assert.equal(server.realmArena.players.size, 3);

  const errand = townErrand(SEED, OFFER.rx, OFFER.ry);
  assert.ok(errand);
  assert.equal(errand.kind, "deliver");
  assert.equal(isCooperativeErrand(SEED, errand), true);
  const targetHub = regionHub(SEED, errand.trx, errand.try);
  assert.deepEqual({ x: errand.tx, y: errand.ty }, { x: targetHub.x, y: targetHub.y });

  for (const participant of [alice, bob]) {
    participant.socket.send(encodeCommand({ kind: COMMAND.acceptCoopErrand, ...OFFER, extra: 0 }));
    const accepted = await nextJourney(participant.socket, JOURNEY_EVENT.accepted);
    assert.equal(accepted.cooperative, true);
    assert.deepEqual(accepted.errand, OFFER);
  }

  for (const participant of [alice, bob]) {
    const player = server.realmArena.players.get(participant.id);
    assert.ok(player);
    teleport(player, targetHub.x, targetHub.y);
  }
  server.advance(1);
  const before = server.realmArena.world.regionState(errand.trx, errand.try);
  assert.ok(before);
  assert.equal(before.improvementLevel, 0);

  alice.socket.send(encodeCommand({ kind: COMMAND.readyCoopErrand, rx: errand.trx, ry: errand.try, extra: 0 }));
  const aliceWaitingJourney = await nextJourney(alice.socket, JOURNEY_EVENT.coopWaiting);
  const aliceWaiting = await nextText(alice.socket, "coopErrand", (message) => message.status === "waiting" && message.ready === true);
  assert.equal(aliceWaiting.presentReady, 1);
  assert.equal(aliceWaiting.required, 2);
  assert.equal(server.realmArena.world.regionState(errand.trx, errand.try)?.improvementLevel, 0);

  bob.socket.send(encodeCommand({ kind: COMMAND.readyCoopErrand, rx: errand.trx, ry: errand.try, extra: 0 }));
  const bobDelivered = await nextJourney(bob.socket, JOURNEY_EVENT.coopDelivered);
  const aliceFinishedStatus = await nextText(alice.socket, "coopErrand", (message) => message.status === "none");
  const bobFinishedStatus = await nextText(bob.socket, "coopErrand", (message) => message.status === "none");
  const observed = await nextImprovement(observer.socket, errand.trx, errand.try);

  // The command flushes Bob immediately; the periodic private flush carries
  // Alice's settlement on the next snapshot cadence without exposing it to
  // the observer.
  server.advance(2);
  const aliceDelivered = await nextJourney(alice.socket, JOURNEY_EVENT.coopDelivered);
  const after = server.realmArena.world.regionState(errand.trx, errand.try);
  assert.ok(after);
  assert.equal(after.improvementLevel, 1);
  assert.equal(aliceDelivered.helpedCount, 1);
  assert.equal(bobDelivered.helpedCount, 1);
  assert.equal(aliceDelivered.errand, null);
  assert.equal(bobDelivered.errand, null);
  assert.equal(aliceFinishedStatus.presentReady, 0);
  assert.equal(bobFinishedStatus.presentReady, 0);
  assert.equal(observed.improvementLevel, 1);

  const evidence = {
    schema: "wander-online-coop-demo/v1",
    transport: "three independent WebSocket clients over /ws/v4",
    seed: SEED,
    realm: "local",
    clients: [alice, bob, observer].map(({ name, id }) => ({ name, id })),
    offer: OFFER,
    delivery: {
      target: { rx: errand.trx, ry: errand.try, tx: errand.tx, ty: errand.ty, name: errand.targetName },
      item: errand.what,
      requiredPlayers: aliceWaiting.required,
    },
    waiting: {
      journeyEvent: aliceWaitingJourney.eventKind,
      status: aliceWaiting.status,
      savedReady: aliceWaiting.savedReady,
      presentReady: aliceWaiting.presentReady,
      improvementLevel: before.improvementLevel,
    },
    completion: {
      aliceJourneyEvent: aliceDelivered.eventKind,
      bobJourneyEvent: bobDelivered.eventKind,
      aliceHelpedCount: aliceDelivered.helpedCount,
      bobHelpedCount: bobDelivered.helpedCount,
      aliceStatus: aliceFinishedStatus.status,
      bobStatus: bobFinishedStatus.status,
      sharedImprovementLevel: after.improvementLevel,
      sharedRevision: after.revision,
      observerSawImprovementLevel: observed.improvementLevel,
      observerSawRowRevision: observed.revision,
    },
    assertions: [
      "three distinct clients joined the authoritative realm",
      "one ready participant remained waiting at 1/2 with no improvement",
      "the second distinct participant completed both private journeys",
      "the target town improved exactly from level 0 to level 1",
      "the non-participating third client received the shared improved row",
    ],
  };
  await mkdir(dirname(OUTPUT), { recursive: true });
  await writeFile(OUTPUT, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.log(`PASS three-client cooperative demo: ${alice.name}+${bob.name} delivered ${errand.what} to ${errand.targetName}; ${observer.name} saw improvement 0->1`);
  console.log(`evidence ${OUTPUT}`);
} finally {
  for (const socket of sockets) socket.close();
  server.close();
}
