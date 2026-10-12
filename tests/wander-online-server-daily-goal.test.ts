// Loopback-host integration for realm daily goals: accepted arena facts are
// aggregated once per player, broadcast with recipient-specific credit, and
// rolled at the injected UTC clock boundary.
import { describe, expect, test } from "bun:test";
import {
  COMMAND,
  WORLD_PROTOCOL_VERSION,
  WORLD_STATE_VERSION,
  decodePlayerJourney,
  encodeCommand,
} from "../examples/wander-online/net/protocol.ts";
import { JOURNEY_EVENT, isCooperativeErrand } from "../examples/wander-online/net/journey.ts";
import { type RealmPlayer } from "../examples/wander-online/server/realm-area.ts";
import { startServer } from "../examples/wander-online/server/server.ts";
import {
  UTC_DAY_MS,
  generateDailyGoal,
  parseDailyGoalSnapshot,
  type DailyGoalSnapshot,
} from "../examples/wander-online/shared/daily-goal.ts";
import { SOCIAL_PROTOCOL_VERSION } from "../examples/wander-online/shared/social.ts";
import { regionHub } from "../examples/wander/world.ts";
import { townErrand } from "../examples/wander/towns.ts";
import { connect, type TestSocket } from "./lib/ws-helper.ts";

const SEED = 1593842689;
const DELIVERY_DAY = 20_004;

interface DailyWire extends DailyGoalSnapshot {
  type: "dailyGoal";
  v: number;
  completedNow: boolean;
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
  throw new Error(`no ${type} message matched before timeout`);
}

async function waitForJourney(socket: TestSocket, eventKind: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const message = await socket.nextMessage(Math.max(1, deadline - Date.now()));
    if (!(message instanceof ArrayBuffer)) continue;
    const journey = decodePlayerJourney(message);
    if (journey?.eventKind === eventKind) return;
  }
  throw new Error(`no journey event ${eventKind} before timeout`);
}

/** Daily snapshots precede the command sender's private journey frame. Keep
 * both observations together so a replay test cannot accidentally consume
 * and discard an unexpected daily broadcast while waiting for confirmation. */
async function dailyUntilJourney(socket: TestSocket, eventKind: number): Promise<DailyWire[]> {
  const daily: DailyWire[] = [];
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const message = await socket.nextMessage(Math.max(1, deadline - Date.now()));
    if (typeof message === "string") {
      try {
        const parsed = JSON.parse(message) as Record<string, unknown>;
        if (parsed.type === "dailyGoal") daily.push(parsed as unknown as DailyWire);
      } catch {
        // Other malformed text is irrelevant to this command confirmation.
      }
      continue;
    }
    if (message instanceof ArrayBuffer && decodePlayerJourney(message)?.eventKind === eventKind) return daily;
  }
  throw new Error(`no journey event ${eventKind} before timeout`);
}

async function nextDailyOrNull(socket: TestSocket, timeoutMs = 250): Promise<DailyWire | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const message = await socket.nextMessage(Math.max(1, deadline - Date.now()));
    if (typeof message !== "string") continue;
    try {
      const parsed = JSON.parse(message) as Record<string, unknown>;
      if (parsed.type === "dailyGoal") return parsed as unknown as DailyWire;
    } catch {
      // Ignore unrelated malformed text until the bounded wait expires.
    }
  }
  return null;
}

async function joinRealm(socket: TestSocket, name: string): Promise<{ features: Record<string, unknown>; daily: DailyWire }> {
  socket.send(JSON.stringify({
    type: "join",
    v: WORLD_PROTOCOL_VERSION,
    supportedGeneratorVersions: [1],
    worldStateVersion: WORLD_STATE_VERSION,
    name,
    color: 1,
  }));
  const features = await nextJson(socket, "realmFeatures");
  const message = await nextJson(socket, "dailyGoal");
  const daily = parseDailyGoalSnapshot(message);
  expect(daily).not.toBeNull();
  return { features, daily: message as unknown as DailyWire };
}

describe("wander-online loopback daily goal", () => {
  test("keeps both completion couriers' private credit and ignores a wall-clock rollback", async () => {
    const goal = generateDailyGoal(SEED, "local", DELIVERY_DAY);
    expect(goal.kind).toBe("delivery");
    const clock = { now: DELIVERY_DAY * UTC_DAY_MS + 12_345 };
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
      realmEpoch: 17,
      now: () => clock.now,
    });
    const sockets: TestSocket[] = [];
    try {
      const offer = regionHub(SEED, goal.offerRx!, goal.offerRy!);
      const errand = townErrand(SEED, goal.offerRx!, goal.offerRy!);
      expect(errand?.kind).toBe("deliver");
      if (!errand || errand.kind !== "deliver") throw new Error("expected generated delivery");
      expect(isCooperativeErrand(SEED, errand)).toBe(true);

      // Bring the aggregate to one short of completion with ordinary facts.
      for (let i = 0; i < goal.required - 1; i++) {
        const socket = await connect(`ws://127.0.0.1:${server.port}/ws/v4`);
        sockets.push(socket);
        const joined = await joinRealm(socket, `courier-${i}`);
        expect(joined.features).toMatchObject({
          v: SOCIAL_PROTOCOL_VERSION,
          realm: "local",
          dailyGoals: true,
        });
        expect(joined.daily).toMatchObject({
          goalId: goal.goalId,
          progress: i,
          required: goal.required,
          contributed: false,
          completedNow: false,
        });

        const player = [...server.realmArena.players.values()].find((candidate) => candidate.name === `courier-${i}`);
        expect(player).toBeDefined();
        if (!player) throw new Error("joined player missing from arena");
        teleport(player, offer.x, offer.y);
        socket.send(encodeCommand({ kind: COMMAND.acceptErrand, rx: goal.offerRx!, ry: goal.offerRy!, extra: 0 }));
        await waitForJourney(socket, JOURNEY_EVENT.accepted);

        teleport(player, errand.tx, errand.ty);
        socket.send(encodeCommand({ kind: COMMAND.deliverErrand, rx: goal.targetRx, ry: goal.targetRy, extra: 0 }));
        const progress = await nextJson(socket, "dailyGoal", (message) => message.progress === i + 1) as unknown as DailyWire;
        expect(parseDailyGoalSnapshot(progress)).not.toBeNull();
        expect(progress.contributed).toBe(true);
        expect(progress.contributionDays).toEqual([DELIVERY_DAY]);
        expect(progress.completedNow).toBe(false);
      }

      // One cooperative settlement emits two accepted delivery facts. The
      // first fills the aggregate; the second must still retain private
      // credit for its courier without bumping progress or revision again.
      const coop: { socket: TestSocket; player: RealmPlayer }[] = [];
      for (const name of ["coop-first", "coop-second"]) {
        const socket = await connect(`ws://127.0.0.1:${server.port}/ws/v4`);
        sockets.push(socket);
        const joined = await joinRealm(socket, name);
        expect(joined.daily).toMatchObject({
          progress: goal.required - 1,
          contributed: false,
          completedNow: false,
        });
        const player = [...server.realmArena.players.values()].find((candidate) => candidate.name === name);
        if (!player) throw new Error("cooperative courier missing from arena");
        teleport(player, offer.x, offer.y);
        socket.send(encodeCommand({ kind: COMMAND.acceptCoopErrand, rx: goal.offerRx!, ry: goal.offerRy!, extra: 0 }));
        await waitForJourney(socket, JOURNEY_EVENT.accepted);
        teleport(player, errand.tx, errand.ty);
        coop.push({ socket, player });
      }
      coop[0]!.socket.send(encodeCommand({ kind: COMMAND.readyCoopErrand, rx: goal.targetRx, ry: goal.targetRy, extra: 0 }));
      await waitForJourney(coop[0]!.socket, JOURNEY_EVENT.coopWaiting);
      coop[1]!.socket.send(encodeCommand({ kind: COMMAND.readyCoopErrand, rx: goal.targetRx, ry: goal.targetRy, extra: 0 }));
      for (const { socket } of coop) {
        const completed = await nextJson(
          socket,
          "dailyGoal",
          (message) => message.progress === goal.required,
        ) as unknown as DailyWire;
        expect(completed.completed).toBe(true);
        expect(completed.completedNow).toBe(true);
        expect(completed.contributed).toBe(true);
        expect(completed.contributionDays).toEqual([DELIVERY_DAY]);
        expect(completed.revision).toBe(goal.required);
      }
      await waitForJourney(coop[1]!.socket, JOURNEY_EVENT.coopDelivered);

      // Recipients that contributed earlier see the same single completion
      // edge while retaining their own private projection.
      for (let i = 0; i < goal.required - 1; i++) {
        const completed = await nextJson(sockets[i]!, "dailyGoal", (message) => message.progress === goal.required) as unknown as DailyWire;
        expect(completed).toMatchObject({ completed: true, completedNow: true, contributed: true });
      }
      expect(server.realmArena.world.regionState(goal.targetRx, goal.targetRy)?.improvementLevel).toBe(2);

      // A new identity can still record private credit after realm completion.
      // Replaying another valid fact from that same identity is wire-quiet.
      const observer = await connect(`ws://127.0.0.1:${server.port}/ws/v4`);
      sockets.push(observer);
      const late = await joinRealm(observer, "late-courier");
      expect(late.daily).toMatchObject({
        progress: goal.required,
        completed: true,
        contributed: false,
        revision: goal.required,
        completedNow: false,
      });
      const latePlayer = [...server.realmArena.players.values()].find((candidate) => candidate.name === "late-courier");
      if (!latePlayer) throw new Error("late courier missing from arena");
      const deliverLate = async (): Promise<void> => {
        teleport(latePlayer, offer.x, offer.y);
        observer.send(encodeCommand({ kind: COMMAND.acceptErrand, rx: goal.offerRx!, ry: goal.offerRy!, extra: 0 }));
        await waitForJourney(observer, JOURNEY_EVENT.accepted);
        teleport(latePlayer, errand.tx, errand.ty);
        observer.send(encodeCommand({ kind: COMMAND.deliverErrand, rx: goal.targetRx, ry: goal.targetRy, extra: 0 }));
      };
      await deliverLate();
      const credited = await nextJson(observer, "dailyGoal", (message) => message.contributed === true) as unknown as DailyWire;
      expect(credited).toMatchObject({
        day: DELIVERY_DAY,
        progress: goal.required,
        revision: goal.required,
        completedNow: false,
      });
      expect(credited.contributionDays).toEqual([DELIVERY_DAY]);
      await waitForJourney(observer, JOURNEY_EVENT.delivered);

      await deliverLate();
      expect(await dailyUntilJourney(observer, JOURNEY_EVENT.delivered)).toEqual([]);

      // The normal forward boundary still rolls, and the newer goal can make
      // progress before the injected wall clock is corrected backwards.
      clock.now = goal.endsAt;
      server.advance();
      const rolled = await nextJson(
        sockets[0]!,
        "dailyGoal",
        (message) => message.day === DELIVERY_DAY + 1,
      ) as unknown as DailyWire;
      expect(parseDailyGoalSnapshot(rolled)).not.toBeNull();
      expect(rolled).toMatchObject({
        day: DELIVERY_DAY + 1,
        progress: 0,
        completed: false,
        contributed: false,
        contributionDays: [DELIVERY_DAY],
        revision: 0,
        completedNow: false,
      });

      const tomorrowGoal = generateDailyGoal(SEED, "local", DELIVERY_DAY + 1);
      expect(tomorrowGoal.kind).toBe("delivery");
      const tomorrowErrand = townErrand(SEED, tomorrowGoal.offerRx!, tomorrowGoal.offerRy!);
      if (!tomorrowErrand || tomorrowErrand.kind !== "deliver") throw new Error("expected tomorrow's delivery");
      const tomorrowSocket = await connect(`ws://127.0.0.1:${server.port}/ws/v4`);
      sockets.push(tomorrowSocket);
      const tomorrowJoined = await joinRealm(tomorrowSocket, "tomorrow-courier");
      expect(tomorrowJoined.daily).toMatchObject({ day: DELIVERY_DAY + 1, progress: 0, contributed: false });
      const tomorrowPlayer = [...server.realmArena.players.values()].find((candidate) => candidate.name === "tomorrow-courier");
      if (!tomorrowPlayer) throw new Error("tomorrow courier missing from arena");
      const tomorrowOffer = regionHub(SEED, tomorrowGoal.offerRx!, tomorrowGoal.offerRy!);
      teleport(tomorrowPlayer, tomorrowOffer.x, tomorrowOffer.y);
      tomorrowSocket.send(encodeCommand({ kind: COMMAND.acceptErrand, rx: tomorrowGoal.offerRx!, ry: tomorrowGoal.offerRy!, extra: 0 }));
      await waitForJourney(tomorrowSocket, JOURNEY_EVENT.accepted);
      teleport(tomorrowPlayer, tomorrowErrand.tx, tomorrowErrand.ty);
      tomorrowSocket.send(encodeCommand({ kind: COMMAND.deliverErrand, rx: tomorrowGoal.targetRx, ry: tomorrowGoal.targetRy, extra: 0 }));
      const tomorrowProgress = await nextJson(tomorrowSocket, "dailyGoal", (message) => message.progress === 1) as unknown as DailyWire;
      expect(tomorrowProgress).toMatchObject({
        day: DELIVERY_DAY + 1,
        progress: 1,
        revision: 1,
        contributed: true,
        completedNow: false,
      });
      await waitForJourney(tomorrowSocket, JOURNEY_EVENT.delivered);

      clock.now = DELIVERY_DAY * UTC_DAY_MS + 12_345;
      server.advance();
      expect(await nextDailyOrNull(tomorrowSocket)).toBeNull();
      const rollbackObserver = await connect(`ws://127.0.0.1:${server.port}/ws/v4`);
      sockets.push(rollbackObserver);
      const afterRollback = await joinRealm(rollbackObserver, "rollback-observer");
      expect(afterRollback.daily).toMatchObject({
        day: DELIVERY_DAY + 1,
        progress: 1,
        revision: 1,
        contributed: false,
        completedNow: false,
      });
    } finally {
      for (const socket of sockets) socket.close();
      server.close();
    }
  });
});
