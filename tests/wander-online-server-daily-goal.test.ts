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
import { JOURNEY_EVENT } from "../examples/wander-online/net/journey.ts";
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
const DELIVERY_DAY = 20_000;

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
  test("aggregates accepted deliveries, completes once at level 2, and rolls connected recipients at UTC midnight", async () => {
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

      for (let i = 0; i < goal.required; i++) {
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
        expect(progress.completedNow).toBe(i + 1 === goal.required);
      }

      // Everyone sees the same completion pulse exactly once, but their own
      // contribution flag is still projected independently.
      for (let i = 0; i < sockets.length - 1; i++) {
        const completed = await nextJson(
          sockets[i]!,
          "dailyGoal",
          (message) => message.progress === goal.required,
        ) as unknown as DailyWire;
        expect(completed.completed).toBe(true);
        expect(completed.completedNow).toBe(true);
        expect(completed.contributed).toBe(true);
      }
      expect(server.realmArena.world.regionState(goal.targetRx, goal.targetRy)?.improvementLevel).toBe(2);

      const observer = await connect(`ws://127.0.0.1:${server.port}/ws/v4`);
      sockets.push(observer);
      const late = await joinRealm(observer, "late-observer");
      expect(late.daily).toMatchObject({
        progress: goal.required,
        completed: true,
        contributed: false,
        revision: goal.required,
        completedNow: false,
      });

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
    } finally {
      for (const socket of sockets) socket.close();
      server.close();
    }
  });
});
