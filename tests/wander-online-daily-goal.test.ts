import { describe, expect, test } from "bun:test";
import { regionName } from "../examples/wander/region.ts";
import { townErrand } from "../examples/wander/towns.ts";
import { regionHub } from "../examples/wander/world.ts";
import {
  DAILY_GOAL_CONTRIBUTION_DAYS_MAX,
  UTC_DAY_MS,
  formatDailyGoal,
  generateDailyGoal,
  matchesDailyContribution,
  parseDailyGoalSnapshot,
  utcDateForDay,
  utcDayFromMs,
  type DailyGoal,
  type DailyGoalSnapshot,
} from "../examples/wander-online/shared/daily-goal.ts";

const SEED = 1593842689;
const REALM = "plaza-1";
const START_DAY = 20_000;

function snapshot(goal: DailyGoal, overrides: Partial<DailyGoalSnapshot> = {}): DailyGoalSnapshot {
  return {
    ...goal,
    progress: 1,
    completed: false,
    contributed: true,
    contributionDays: [goal.day - 2, goal.day],
    revision: 7,
    ...overrides,
  };
}

function goalOfKind(kind: DailyGoal["kind"]): DailyGoal {
  for (let day = START_DAY; day < START_DAY + 16; day++) {
    const goal = generateDailyGoal(SEED, REALM, day);
    if (goal.kind === kind) return goal;
  }
  throw new Error(`fixture did not find a ${kind} goal`);
}

describe("realm daily goal", () => {
  test("UTC day and canonical date conversion need no ambient clock", () => {
    expect(utcDayFromMs(0)).toBe(0);
    expect(utcDayFromMs(UTC_DAY_MS - 1)).toBe(0);
    expect(utcDayFromMs(UTC_DAY_MS)).toBe(1);
    expect(utcDateForDay(0)).toBe("1970-01-01");
    expect(utcDateForDay(11_016)).toBe("2000-02-29");
    expect(utcDateForDay(START_DAY)).toBe("2024-10-04");
    expect(() => utcDayFromMs(-1)).toThrow();
    expect(() => utcDateForDay(1.5)).toThrow();
  });

  test("same realm seed and day are stable while dates, realms and seeds vary", () => {
    const first = generateDailyGoal(SEED, REALM, START_DAY);
    expect(generateDailyGoal(SEED, REALM, START_DAY)).toEqual(first);
    expect(generateDailyGoal(SEED, REALM, START_DAY + 1).goalId).not.toBe(first.goalId);
    expect(generateDailyGoal(SEED, "plaza-2", START_DAY).goalId).not.toBe(first.goalId);
    expect(generateDailyGoal(SEED + 1, REALM, START_DAY).goalId).not.toBe(first.goalId);
    expect(first.required).toBeGreaterThanOrEqual(3);
    expect(first.required).toBeLessThanOrEqual(5);
    expect(first.endsAt).toBe((first.day + 1) * UTC_DAY_MS);
    expect(first.date).toBe(utcDateForDay(first.day));
  });

  test("delivery goals point at an offer produced by the real world seed", () => {
    const goal = goalOfKind("delivery");
    expect(goal.offerRx).not.toBeNull();
    expect(goal.offerRy).not.toBeNull();
    const errand = townErrand(SEED, goal.offerRx!, goal.offerRy!);
    expect(errand).toMatchObject({
      kind: "deliver",
      orx: goal.offerRx,
      ory: goal.offerRy,
      trx: goal.targetRx,
      try: goal.targetRy,
      targetName: goal.targetName,
    });
    expect(regionHub(SEED, goal.targetRx, goal.targetRy).town).toBe(true);
  });

  test("landmark goals use a deterministic real town as the festival target", () => {
    const goal = goalOfKind("landmark");
    expect(goal.offerRx).toBeNull();
    expect(goal.offerRy).toBeNull();
    expect(regionHub(SEED, goal.targetRx, goal.targetRy).town).toBe(true);
    expect(goal.targetName).toBe(regionName(SEED, goal.targetRx, goal.targetRy));
  });

  test("the contribution matcher is exact for deliveries and realm-day scoped for discoveries", () => {
    const delivery = goalOfKind("delivery");
    const contribution = {
      realm: delivery.realm,
      day: delivery.day,
      kind: "delivery" as const,
      offerRx: delivery.offerRx!,
      offerRy: delivery.offerRy!,
      targetRx: delivery.targetRx,
      targetRy: delivery.targetRy,
    };
    expect(matchesDailyContribution(delivery, contribution)).toBe(true);
    expect(matchesDailyContribution(delivery, { ...contribution, targetRx: contribution.targetRx + 1 })).toBe(false);
    expect(matchesDailyContribution(delivery, { ...contribution, day: contribution.day + 1 })).toBe(false);

    const landmark = goalOfKind("landmark");
    const found = { realm: landmark.realm, day: landmark.day, kind: "landmark" as const, landmarkRx: -9, landmarkRy: 12 };
    expect(matchesDailyContribution(landmark, found)).toBe(true);
    expect(matchesDailyContribution(landmark, { ...found, realm: "plaza-2" })).toBe(false);
    expect(matchesDailyContribution(landmark, { ...found, landmarkRx: 0x8000_0000 })).toBe(false);
  });

  test("snapshot parsing is bounded and validates derived fields", () => {
    const goal = goalOfKind("delivery");
    const source = snapshot(goal);
    expect(parseDailyGoalSnapshot(JSON.parse(JSON.stringify(source)))).toEqual(source);
    expect(parseDailyGoalSnapshot({ ...source, date: "2099-01-01" })).toBeNull();
    expect(parseDailyGoalSnapshot({ ...source, kind: "future-kind" })).toBeNull();
    expect(parseDailyGoalSnapshot({ ...source, offerRx: null })).toBeNull();
    expect(parseDailyGoalSnapshot({ ...source, required: 6 })).toBeNull();
    expect(parseDailyGoalSnapshot({ ...source, progress: source.required, completed: false })).toBeNull();
    expect(parseDailyGoalSnapshot({ ...source, endsAt: source.endsAt + 1 })).toBeNull();
    expect(parseDailyGoalSnapshot({ ...source, targetName: "bad\nname" })).toBeNull();
    expect(parseDailyGoalSnapshot({ ...source, goalId: "bad/id" })).toBeNull();
    expect(parseDailyGoalSnapshot({ ...source, contributionDays: [source.day, source.day] })).toBeNull();
    expect(parseDailyGoalSnapshot({ ...source, contributionDays: [source.day + 1] })).toBeNull();
    expect(parseDailyGoalSnapshot({ ...source, contributed: false })).toBeNull();
    expect(parseDailyGoalSnapshot({
      ...source,
      contributionDays: Array.from({ length: DAILY_GOAL_CONTRIBUTION_DAYS_MAX + 1 }, (_, i) => source.day - i),
    })).toBeNull();

    const landmark = snapshot(goalOfKind("landmark"));
    expect(parseDailyGoalSnapshot(landmark)).toEqual(landmark);
    expect(parseDailyGoalSnapshot({ ...landmark, offerRx: 0, offerRy: 0 })).toBeNull();
  });

  test("compact English and codepoint-built Chinese copy carries progress", () => {
    const value = snapshot(goalOfKind("landmark"));
    expect(formatDailyGoal(value)).toBe(`DAILY LANDMARK FESTIVAL · ${value.targetName} · 1/${value.required}`);
    expect(formatDailyGoal(value, "zh")).toBe(`${String.fromCodePoint(0x6bcf, 0x65e5)} ${String.fromCodePoint(0x5730, 0x6807, 0x5e86, 0x5178)} · ${value.targetName} · 1/${value.required}`);
  });
});
