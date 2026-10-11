// Three real WebSocket clients complete one cooperative delivery against the
// loopback authoritative realm. A's READY state is projected only to friend B;
// nonfriend C sees the anonymous notice-board count and the shared town
// improvement, but neither private journey. The JSON output is suitable for
// release evidence or CI artifacts.

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { planRegion } from "../examples/wander/region.ts";
import { regionHub } from "../examples/wander/world.ts";
import { townErrand } from "../examples/wander/towns.ts";
import { isCooperativeErrand, JOURNEY_EVENT } from "../examples/wander-online/net/journey.ts";
import { plaqueOf } from "../examples/wander-online/net/npc.ts";
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
import type { CoopStatus, RealmPlayer } from "../examples/wander-online/server/realm-area.ts";
import {
  SOCIAL_PROTOCOL_VERSION,
  parseCoopBoardSnapshot,
  parseCoopFriendWaiting,
  type CoopFriendWaiting,
} from "../examples/wander-online/shared/social.ts";
import { connect, type TestSocket } from "../tests/lib/ws-helper.ts";

const SEED = 1593842689;
const OFFER = { rx: 0, ry: 0 } as const;
const OUTPUT = resolve(process.argv[2] ?? "reports/wander-online-coop-demo.json");

interface DemoAccount {
  role: "A" | "B" | "C";
  githubId: number;
  login: string;
  token: string;
  name: string;
  look: number;
  visible: boolean;
  friendIds: readonly number[];
}

interface DemoFriendNotification extends CoopFriendWaiting {
  type: "coopFriendWaiting";
  v: typeof SOCIAL_PROTOCOL_VERSION;
}

const ACCOUNTS: readonly DemoAccount[] = [
  { role: "A", githubId: 71_001, login: "coop-alice", token: "coop-demo-alice", name: "Alice", look: 1, visible: true, friendIds: [71_002] },
  { role: "B", githubId: 71_002, login: "coop-bob", token: "coop-demo-bob", name: "Bob", look: 2, visible: true, friendIds: [71_001] },
  { role: "C", githubId: 71_003, login: "coop-observer", token: "coop-demo-observer", name: "Observer", look: 3, visible: true, friendIds: [] },
];

interface JoinedClient {
  account: DemoAccount;
  name: string;
  socket: TestSocket;
  id: number;
  feature: Record<string, unknown>;
  initialCoop: Record<string, unknown>;
  socialInbox: DemoFriendNotification[];
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

function teleport(player: RealmPlayer, tx: number, ty: number, facing = player.state.move.facing): void {
  player.state = {
    ...player.state,
    move: {
      ...player.state.move,
      tx,
      ty,
      px: tx * 16,
      py: ty * 16,
      facing,
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

/** The loopback host intentionally has no durable social store. This mirrors
 * the hosted room's mutual-visible-friend projection, but derives the wait
 * itself from the loopback realm's authoritative player/status state. */
function notifyDemoFriends(
  waiter: JoinedClient,
  recipients: readonly JoinedClient[],
  status: CoopStatus,
  targetTown: string,
  item: string,
): DemoFriendNotification {
  if (!waiter.account.visible || !status.cooperative || !status.ready || status.expiresAt === null) {
    throw new Error("cannot project an inactive or private co-op wait");
  }
  const message: DemoFriendNotification = {
    type: "coopFriendWaiting",
    v: SOCIAL_PROTOCOL_VERSION,
    realm: "local",
    friend: { githubId: waiter.account.githubId, name: waiter.name },
    targetTown,
    item,
    expiresAt: status.expiresAt,
  };
  const parsed = parseCoopFriendWaiting(message);
  assert.ok(parsed);
  assert.deepEqual(parsed, {
    realm: message.realm,
    friend: message.friend,
    targetTown: message.targetTown,
    item: message.item,
    expiresAt: message.expiresAt,
  });
  for (const recipient of recipients) {
    const mutual = waiter.account.friendIds.includes(recipient.account.githubId)
      && recipient.account.friendIds.includes(waiter.account.githubId);
    if (mutual) recipient.socialInbox.push(message);
  }
  return message;
}

const accountByToken = new Map(ACCOUNTS.map((account) => [account.token, account]));
const github = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== "/user") return new Response("not found", { status: 404 });
    const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    const account = accountByToken.get(token);
    return account
      ? Response.json({ id: account.githubId, login: account.login })
      : new Response("unauthorized", { status: 401 });
  },
});
let server: ReturnType<typeof startServer> | undefined;
const sockets: TestSocket[] = [];

try {
  server = startServer({
    port: 0,
    seed: SEED,
    hz: 20,
    broadcastHz: 10,
    aoi: 16,
    simLatency: 0,
    webRoot: "",
    allowGuests: false,
    githubApiBase: `http://127.0.0.1:${github.port}`,
    realmEpoch: 1,
    manualTick: true,
  });
  const url = `ws://127.0.0.1:${server.port}/ws/v4`;
  const join = async (account: DemoAccount): Promise<JoinedClient> => {
    const socket = await connect(url);
    sockets.push(socket);
    socket.send(JSON.stringify({
      type: "join",
      v: WORLD_PROTOCOL_VERSION,
      supportedGeneratorVersions: [1],
      worldStateVersion: WORLD_STATE_VERSION,
      github: account.token,
    }));
    const needCreate = await nextText(socket, "needCreate");
    assert.equal(needCreate.login, account.login);
    assert.equal(typeof needCreate.ticket, "string");
    socket.send(JSON.stringify({
      type: "create",
      v: WORLD_PROTOCOL_VERSION,
      ticket: needCreate.ticket,
      name: account.name,
      look: account.look,
    }));
    await nextText(socket, "createOk");
    socket.send(JSON.stringify({
      type: "join",
      v: WORLD_PROTOCOL_VERSION,
      supportedGeneratorVersions: [1],
      worldStateVersion: WORLD_STATE_VERSION,
      ticket: needCreate.ticket,
    }));
    const welcome = await nextBinary(socket, decodeWelcome4, `${account.name} WELCOME4`);
    const feature = await nextText(socket, "realmFeatures");
    const initialCoop = await nextText(socket, "coopErrand");
    await nextText(socket, "ready");
    assert.equal(feature.coopErrands, true);
    assert.equal(feature.coopPartnerFinding, true);
    assert.equal(feature.discoveryLeaderboard, false);
    assert.equal(initialCoop.status, "none");
    return { account, name: account.name, socket, id: welcome.you, feature, initialCoop, socialInbox: [] };
  };

  const alice = await join(ACCOUNTS[0]!);
  const bob = await join(ACCOUNTS[1]!);
  const observer = await join(ACCOUNTS[2]!);
  assert.equal(new Set([alice.id, bob.id, observer.id]).size, 3);
  assert.equal(server.realmArena.players.size, 3);
  for (const client of [alice, bob, observer]) {
    assert.equal(server.realmArena.players.get(client.id)?.coopIdentity, String(client.account.githubId));
  }

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

  const aliceAtTarget = server.realmArena.players.get(alice.id);
  assert.ok(aliceAtTarget);
  teleport(aliceAtTarget, targetHub.x, targetHub.y);
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

  const alicePlayer = server.realmArena.players.get(alice.id);
  assert.ok(alicePlayer);
  const authoritativeWaiting = server.realmArena.coopStatusFor(alicePlayer);
  assert.equal(authoritativeWaiting.expiresAt, aliceWaiting.expiresAt);
  const friendWaiting = notifyDemoFriends(alice, [bob, observer], authoritativeWaiting, errand.targetName, errand.what);
  assert.deepEqual(bob.socialInbox, [friendWaiting]);
  assert.deepEqual(observer.socialInbox, []);
  assert.deepEqual(Object.keys(friendWaiting).sort(), ["expiresAt", "friend", "item", "realm", "targetTown", "type", "v"].sort());
  assert.deepEqual(Object.keys(friendWaiting.friend).sort(), ["githubId", "name"]);

  const offerPlan = planRegion(SEED, OFFER.rx, OFFER.ry);
  const board = plaqueOf(offerPlan);
  assert.ok(board);
  const observerPlayer = server.realmArena.players.get(observer.id);
  assert.ok(observerPlayer);
  teleport(observerPlayer, board.x, board.y - 1, 0);
  observer.socket.send(JSON.stringify({
    type: "coopBoardGet",
    v: SOCIAL_PROTOCOL_VERSION,
    offerRx: OFFER.rx,
    offerRy: OFFER.ry,
  }));
  const boardRaw = await nextText(observer.socket, "coopBoard", (message) => message.offerRx === OFFER.rx && message.offerRy === OFFER.ry);
  const boardSnapshot = parseCoopBoardSnapshot(boardRaw);
  assert.ok(boardSnapshot);
  assert.equal(boardSnapshot.waiting, 1);
  assert.equal(boardSnapshot.required, 2);
  assert.deepEqual(Object.keys(boardRaw).sort(), ["offerRx", "offerRy", "realm", "required", "type", "v", "waiting"].sort());

  const bobAtTarget = server.realmArena.players.get(bob.id);
  assert.ok(bobAtTarget);
  teleport(bobAtTarget, targetHub.x, targetHub.y);
  server.advance(1);
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
  assert.equal(observed.revision, after.revision);

  const evidence = {
    schema: "wander-online-coop-demo/v2",
    result: "PASS",
    transport: "three independent WebSocket clients over /ws/v4",
    seed: SEED,
    realm: "local",
    clients: [alice, bob, observer].map(({ account, name, id }) => ({ role: account.role, name, id, githubId: account.githubId })),
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
    partnerFinding: {
      projection: "hosted mutual-visible-friend routing mirrored over authoritative loopback READY state",
      friendship: { mutual: [alice.account.githubId, bob.account.githubId], nonfriend: observer.account.githubId },
      friendNotification: { source: "demo social projection", recipient: bob.account.githubId, message: friendWaiting },
      nonfriendIdentifiedNotifications: observer.socialInbox.length,
      noticeBoard: { source: "loopback WebSocket", message: boardRaw },
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
      "the friend received one privacy-safe waiting projection and the nonfriend received none",
      "the nonfriend read only the offer-scoped anonymous 1/2 notice-board count",
      "the non-participating third client received the shared improved row at the authoritative revision",
    ],
  };
  await mkdir(dirname(OUTPUT), { recursive: true });
  await writeFile(OUTPUT, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    result: evidence.result,
    schema: evidence.schema,
    evidence: OUTPUT,
    friendNotifications: bob.socialInbox.length,
    nonfriendIdentifiedNotifications: observer.socialInbox.length,
    anonymousWaiting: boardSnapshot.waiting,
    observerRevision: observed.revision,
    authoritativeRevision: after.revision,
  }));
} finally {
  for (const socket of sockets) socket.close();
  server?.close();
  github.stop(true);
}
