// Three real WebSocket clients jointly complete one realm daily goal against
// the loopback authoritative host. At required - 1, two couriers settle one
// cooperative delivery and both retain their private contribution day. The
// clients then observe the festival and remain connected across a controlled
// UTC rollover without publishing a contributor list.
//
//   bun tools/wander-online-daily-goal-demo.ts [output.json]

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { regionHub } from "../examples/wander/world.ts";
import { festivalCells, townErrand } from "../examples/wander/towns.ts";
import {
  COMMAND,
  WORLD_PROTOCOL_VERSION,
  WORLD_STATE_VERSION,
  decodePlayerJourney,
  decodeRegionState,
  decodeWelcome4,
  encodeCommand,
} from "../examples/wander-online/net/protocol.ts";
import { JOURNEY_EVENT, isCooperativeErrand } from "../examples/wander-online/net/journey.ts";
import { startServer } from "../examples/wander-online/server/server.ts";
import type { RealmPlayer } from "../examples/wander-online/server/realm-area.ts";
import {
  UTC_DAY_MS,
  generateDailyGoal,
  parseDailyGoalSnapshot,
  type DailyGoalSnapshot,
} from "../examples/wander-online/shared/daily-goal.ts";
import { SOCIAL_PROTOCOL_VERSION } from "../examples/wander-online/shared/social.ts";
import { connect, type TestSocket } from "../tests/lib/ws-helper.ts";

const SEED = 1593842689;
// This fixture is deliberately a three-credit goal whose real generated
// errand is cooperative: one courier can bring it to required - 1 before the
// other two settle one authoritative pair.
const DAY = 20_025;
const OUTPUT = resolve(process.argv[2] ?? "reports/wander-online-daily-goal-demo.json");
const NAMES = ["Aster", "Birch", "Clover"] as const;

interface DailyWire extends DailyGoalSnapshot {
  type: "dailyGoal";
  v: number;
  completedNow: boolean;
}

interface Client {
  name: string;
  id: number;
  socket: TestSocket;
  features: Record<string, unknown>;
  initial: DailyWire;
}

const DAILY_WIRE_KEYS = [
  "completed", "completedNow", "contributed", "contributionDays", "date",
  "day", "endsAt", "goalId", "kind", "offerRx", "offerRy", "progress",
  "realm", "required", "revision", "targetName", "targetRx", "targetRy",
  "type", "v",
].sort();

function assertDailyWireKeys(daily: DailyWire): void {
  assert.deepEqual(Object.keys(daily).sort(), DAILY_WIRE_KEYS, "daily frame must expose the exact public key set");
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

async function nextJson(
  socket: TestSocket,
  type: string,
  accept: (message: Record<string, unknown>) => boolean = () => true,
  timeoutMs = 3_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const message = await socket.nextMessage(Math.max(1, deadline - Date.now()));
    if (typeof message !== "string") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      continue;
    }
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      if (record.type === type && accept(record)) return record;
    }
  }
  throw new Error(`timed out waiting for ${type}`);
}

async function nextWelcome(socket: TestSocket): Promise<number> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const message = await socket.nextMessage(Math.max(1, deadline - Date.now()));
    if (!(message instanceof ArrayBuffer)) continue;
    const welcome = decodeWelcome4(message);
    if (welcome) return welcome.you;
  }
  throw new Error("timed out waiting for WELCOME4");
}

async function nextJourney(socket: TestSocket, eventKind: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const message = await socket.nextMessage(Math.max(1, deadline - Date.now()));
    if (!(message instanceof ArrayBuffer)) continue;
    if (decodePlayerJourney(message)?.eventKind === eventKind) return;
  }
  throw new Error(`timed out waiting for journey event ${eventKind}`);
}

async function nextDaily(
  socket: TestSocket,
  progress: number,
  festivalTarget?: { rx: number; ry: number },
): Promise<{ daily: DailyWire; festivalLevel: number | null }> {
  const deadline = Date.now() + 3_000;
  let festivalLevel: number | null = null;
  while (Date.now() < deadline) {
    const message = await socket.nextMessage(Math.max(1, deadline - Date.now()));
    if (message instanceof ArrayBuffer) {
      const region = decodeRegionState(message);
      if (festivalTarget && region) {
        const row = region.rows.find((candidate) => candidate.rx === festivalTarget.rx && candidate.ry === festivalTarget.ry);
        if (row) festivalLevel = row.improvementLevel;
      }
      continue;
    }
    if (typeof message !== "string") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const record = parsed as Record<string, unknown>;
    if (record.type !== "dailyGoal" || record.progress !== progress) continue;
    const daily = parseDailyGoalSnapshot(record);
    assert.ok(daily, "daily progress frame must parse");
    return { daily: record as unknown as DailyWire, festivalLevel };
  }
  throw new Error(`timed out waiting for daily progress ${progress}`);
}

async function drainDaily(socket: TestSocket, timeoutMs = 100): Promise<DailyWire[]> {
  const out: DailyWire[] = [];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const message = await socket.nextMessage(Math.max(1, deadline - Date.now()));
    if (message === undefined) break;
    if (typeof message !== "string") continue;
    try {
      const parsed = JSON.parse(message) as Record<string, unknown>;
      if (parsed.type === "dailyGoal" && parseDailyGoalSnapshot(parsed)) out.push(parsed as unknown as DailyWire);
    } catch {
      // Ignore non-JSON text in this bounded drain.
    }
  }
  return out;
}

const goal = generateDailyGoal(SEED, "local", DAY);
assert.equal(goal.kind, "delivery");
assert.equal(goal.required, 3, "demo fixture must require exactly three couriers");
const offer = regionHub(SEED, goal.offerRx!, goal.offerRy!);
const errand = townErrand(SEED, goal.offerRx!, goal.offerRy!);
assert.ok(errand && errand.kind === "deliver");
assert.equal(isCooperativeErrand(SEED, errand), true, "demo fixture must use a real cooperative errand");
assert.deepEqual({ rx: errand.trx, ry: errand.try }, { rx: goal.targetRx, ry: goal.targetRy });

const clock = { now: DAY * UTC_DAY_MS + 12_345 };
const server = startServer({
  port: 0,
  seed: SEED,
  hz: 20,
  broadcastHz: 10,
  aoi: 16,
  simLatency: 0,
  webRoot: "",
  allowGuests: true,
  manualTick: true,
  realmEpoch: 23,
  now: () => clock.now,
});
const sockets: TestSocket[] = [];

try {
  // Keep the target plan resident so this demonstration verifies the actual
  // level-2 tile application, not only its authoritative state row.
  server.realmArena.world.prime([{ x: errand.tx, y: errand.ty }], 0);
  const targetPlan = server.realmArena.world.plans.get(`${goal.targetRx},${goal.targetRy}`);
  assert.ok(targetPlan, "festival target plan must be resident");
  const festival = festivalCells(targetPlan);
  assert.equal(festival.length, 4);
  const beforeTiles = festival.map((cell) => targetPlan.upper![(cell.y - targetPlan.y0) * 96 + cell.x - targetPlan.x0]);
  assert.ok(beforeTiles.every((tile, index) => tile !== festival[index]!.tile));

  const clients: Client[] = [];
  for (const name of NAMES) {
    const socket = await connect(`ws://127.0.0.1:${server.port}/ws/v4`);
    sockets.push(socket);
    socket.send(JSON.stringify({
      type: "join",
      v: WORLD_PROTOCOL_VERSION,
      supportedGeneratorVersions: [1],
      worldStateVersion: WORLD_STATE_VERSION,
      name,
      color: clients.length + 1,
      look: clients.length + 1,
    }));
    const id = await nextWelcome(socket);
    const features = await nextJson(socket, "realmFeatures");
    const initial = await nextJson(socket, "dailyGoal") as unknown as DailyWire;
    assert.deepEqual(features, {
      type: "realmFeatures",
      v: SOCIAL_PROTOCOL_VERSION,
      realm: "local",
      coopErrands: true,
      coopPartnerFinding: true,
      discoveryLeaderboard: false,
      dailyGoals: true,
    });
    assert.ok(parseDailyGoalSnapshot(initial));
    assertDailyWireKeys(initial);
    assert.equal(initial.goalId, goal.goalId);
    assert.equal(initial.progress, 0);
    assert.equal(initial.contributed, false);
    clients.push({ name, id, socket, features, initial });
  }
  assert.equal(new Set(clients.map((client) => client.id)).size, 3);
  assert.equal(server.realmArena.players.size, 3);

  const progressSteps: Array<Record<string, unknown>> = [];
  const solo = clients[0]!;
  const soloPlayer = server.realmArena.players.get(solo.id);
  assert.ok(soloPlayer, `authoritative player ${solo.name} must exist`);
  // Two distinct accepted errands from Aster establish progress == required - 1.
  // The stable source revision changes between accepts, so these are two real
  // facts rather than a replay of one delivery.
  for (let progress = 1; progress < goal.required; progress++) {
    teleport(soloPlayer, offer.x, offer.y);
    solo.socket.send(encodeCommand({
      kind: COMMAND.acceptErrand,
      rx: goal.offerRx!,
      ry: goal.offerRy!,
      extra: 0,
    }));
    await nextJourney(solo.socket, JOURNEY_EVENT.accepted);

    teleport(soloPlayer, errand.tx, errand.ty);
    solo.socket.send(encodeCommand({
      kind: COMMAND.deliverErrand,
      rx: goal.targetRx,
      ry: goal.targetRy,
      extra: 0,
    }));

    const recipientFrames = await Promise.all(clients.map((client) => nextDaily(client.socket, progress)));
    for (let recipient = 0; recipient < recipientFrames.length; recipient++) {
      const frame = recipientFrames[recipient]!;
      assertDailyWireKeys(frame.daily);
      assert.equal(frame.daily.progress, progress);
      assert.equal(frame.daily.completed, false);
      assert.equal(frame.daily.completedNow, false);
      assert.equal(frame.daily.contributed, recipient === 0);
      assert.deepEqual(frame.daily.contributionDays, recipient === 0 ? [DAY] : []);
    }
    progressSteps.push({
      mode: "solo",
      couriers: [solo.name],
      progress,
      remainingBefore: goal.required - (progress - 1),
      recipients: recipientFrames.map((frame, recipient) => ({
        name: clients[recipient]!.name,
        progress: frame.daily.progress,
        contributed: frame.daily.contributed,
        contributionDays: frame.daily.contributionDays,
        completedNow: frame.daily.completedNow,
        festivalLevel: frame.festivalLevel,
      })),
    });
  }

  assert.equal(progressSteps.at(-1)?.progress, goal.required - 1);

  // Birch and Clover now settle the same cooperative errand as one batch.
  // The first fact fills the aggregate; the second must still be retained in
  // that courier's private contribution history without another completion.
  const pair = clients.slice(1);
  for (const source of pair) {
    const player = server.realmArena.players.get(source.id);
    assert.ok(player, `authoritative player ${source.name} must exist`);
    teleport(player, offer.x, offer.y);
    source.socket.send(encodeCommand({
      kind: COMMAND.acceptCoopErrand,
      rx: goal.offerRx!,
      ry: goal.offerRy!,
      extra: 0,
    }));
    await nextJourney(source.socket, JOURNEY_EVENT.accepted);

    teleport(player, errand.tx, errand.ty);
  }
  pair[0]!.socket.send(encodeCommand({
    kind: COMMAND.readyCoopErrand,
    rx: goal.targetRx,
    ry: goal.targetRy,
    extra: 0,
  }));
  await nextJourney(pair[0]!.socket, JOURNEY_EVENT.coopWaiting);
  pair[1]!.socket.send(encodeCommand({
    kind: COMMAND.readyCoopErrand,
    rx: goal.targetRx,
    ry: goal.targetRy,
    extra: 0,
  }));

  const completionFrames = await Promise.all(clients.map((client) => nextDaily(
    client.socket,
    goal.required,
    { rx: goal.targetRx, ry: goal.targetRy },
  )));
  for (const frame of completionFrames) {
    assertDailyWireKeys(frame.daily);
    assert.equal(frame.daily.progress, goal.required);
    assert.equal(frame.daily.completed, true);
    assert.equal(frame.daily.completedNow, true);
    assert.equal(frame.daily.contributed, true);
    assert.deepEqual(frame.daily.contributionDays, [DAY]);
    assert.equal(frame.festivalLevel, 2);
  }
  // The command path flushes Clover immediately; Birch is flushed on the next
  // authoritative frame. Both must receive the private cooperative journey.
  server.advance(5);
  await Promise.all(pair.map((client) => nextJourney(client.socket, JOURNEY_EVENT.coopDelivered)));
  progressSteps.push({
    mode: "cooperative",
    couriers: pair.map((client) => client.name),
    progressBefore: goal.required - 1,
    progress: goal.required,
    retainedContributors: pair.map((client) => client.name),
    recipients: completionFrames.map((frame, recipient) => ({
      name: clients[recipient]!.name,
      progress: frame.daily.progress,
      contributed: frame.daily.contributed,
      contributionDays: frame.daily.contributionDays,
      completedNow: frame.daily.completedNow,
      festivalLevel: frame.festivalLevel,
    })),
  });

  const row = server.realmArena.world.regionState(goal.targetRx, goal.targetRy);
  assert.equal(row?.improvementLevel, 2);
  const afterTiles = festival.map((cell) => targetPlan.upper![(cell.y - targetPlan.y0) * 96 + cell.x - targetPlan.x0]);
  assert.deepEqual(afterTiles, festival.map((cell) => cell.tile));
  assert.deepEqual(afterTiles, [41, 41, 41, 41]);

  // A further accepted delivery is legitimate gameplay but the completed
  // aggregate remains a hot no-op and cannot emit a second completion edge.
  const repeat = clients[0]!;
  const repeatPlayer = server.realmArena.players.get(repeat.id)!;
  teleport(repeatPlayer, offer.x, offer.y);
  repeat.socket.send(encodeCommand({ kind: COMMAND.acceptErrand, rx: goal.offerRx!, ry: goal.offerRy!, extra: 0 }));
  await nextJourney(repeat.socket, JOURNEY_EVENT.accepted);
  teleport(repeatPlayer, errand.tx, errand.ty);
  repeat.socket.send(encodeCommand({ kind: COMMAND.deliverErrand, rx: goal.targetRx, ry: goal.targetRy, extra: 0 }));
  await nextJourney(repeat.socket, JOURNEY_EVENT.delivered);
  server.advance(5);
  const postCompletionDaily = await Promise.all(clients.map((client) => drainDaily(client.socket)));
  assert.deepEqual(postCompletionDaily.map((frames) => frames.length), [0, 0, 0]);

  const idsBeforeRollover = clients.map((client) => client.id);
  clock.now = goal.endsAt;
  server.advance();
  const rolled = await Promise.all(clients.map(async (client) => {
    const frame = await nextJson(
      client.socket,
      "dailyGoal",
      (message) => message.day === DAY + 1,
    ) as unknown as DailyWire;
    assert.ok(parseDailyGoalSnapshot(frame));
    assert.equal(frame.progress, 0);
    assert.equal(frame.completed, false);
    assert.equal(frame.completedNow, false);
    assert.equal(frame.contributed, false);
    assert.deepEqual(frame.contributionDays, [DAY]);
    return frame;
  }));
  assert.equal(new Set(rolled.map((frame) => frame.goalId)).size, 1);
  assert.deepEqual(clients.map((client) => client.id), idsBeforeRollover);
  assert.equal(server.realmArena.players.size, 3);

  const evidence = {
    verdict: "PASS",
    transport: "three live WebSocket clients",
    seed: SEED,
    realm: "local",
    connectedClients: clients.map((client) => ({ name: client.name, id: client.id })),
    today: {
      goal,
      initialProgress: clients.map((client) => ({ name: client.name, progress: client.initial.progress })),
      progressSteps,
      requiredMinusOneCooperativeDelivery: {
        progressBefore: goal.required - 1,
        couriers: pair.map((client) => client.name),
        progressAfter: completionFrames[0]!.daily.progress,
        privateContributionDays: Object.fromEntries(pair.map((client, index) => [
          client.name,
          completionFrames[index + 1]!.daily.contributionDays,
        ])),
      },
      completionPulsesPerClient: [1, 1, 1],
      extraDailyFramesAfterRepeatDelivery: postCompletionDaily.map((frames) => frames.length),
    },
    festival: {
      region: { rx: goal.targetRx, ry: goal.targetRy, name: goal.targetName },
      improvementLevel: row!.improvementLevel,
      cells: festival,
      beforeTiles,
      afterTiles,
      recipientRegionLevels: progressSteps.at(-1)!.recipients,
      persistence: "level 2 remains as realm history; rollover performs no reset write",
    },
    rollover: {
      clockBefore: goal.endsAt - 1,
      clockAt: clock.now,
      oldDay: DAY,
      newDay: DAY + 1,
      newGoal: rolled[0],
      clientIdsBefore: idsBeforeRollover,
      clientIdsAfter: clients.map((client) => client.id),
      connectedPlayers: server.realmArena.players.size,
    },
    privacy: {
      publicContributorList: false,
      publicLeaderboardExtension: false,
      privateContributionDays: Object.fromEntries(clients.map((client, index) => [client.name, rolled[index]!.contributionDays])),
    },
  };
  await mkdir(dirname(OUTPUT), { recursive: true });
  await writeFile(OUTPUT, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.log(`PASS: required-1 cooperative pair retained both contributions for ${goal.goalId}, installed four festival stalls, and rolled to UTC day ${DAY + 1}`);
  console.log(OUTPUT);
} finally {
  for (const socket of sockets) socket.close();
  server.close();
}
