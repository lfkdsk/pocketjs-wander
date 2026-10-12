import { describe, expect, test } from "bun:test";
import {
  ACHIEVEMENTS,
  achievementCopy,
  deriveAchievementIds,
  joinedDate,
  parseProfileSnapshot,
  type ProfileFacts,
} from "../examples/wander-online/shared/profile.ts";

const facts = (overrides: Partial<ProfileFacts> = {}): ProfileFacts => ({
  completedErrands: 0,
  landmarksSeen: 0,
  landmarkFirsts: 0,
  dailyContributionDays: 0,
  realmsVisited: 0,
  ...overrides,
});

describe("server-derived player profile contract", () => {
  test("five existing authoritative facts unlock three ordered tiers each", () => {
    expect(ACHIEVEMENTS).toHaveLength(15);
    expect(deriveAchievementIds(facts({
      completedErrands: 25,
      landmarksSeen: 50,
      landmarkFirsts: 20,
      dailyContributionDays: 30,
      realmsVisited: 4,
    }))).toEqual(ACHIEVEMENTS.map((item) => item.id));
    expect(deriveAchievementIds(facts({ completedErrands: 4, landmarkFirsts: 1 })))
      .toEqual(["errands-1", "firsts-1"]);
    expect(deriveAchievementIds({ ...facts(), completedErrands: -1 })).toEqual([]);
  });

  test("every tier has bounded English and Chinese name and generator-style description", () => {
    for (const item of ACHIEVEMENTS) {
      for (const locale of ["en", "zh"] as const) {
        const copy = achievementCopy(item.id, locale);
        expect(copy.name.length).toBeGreaterThan(1);
        expect(copy.name.length).toBeLessThanOrEqual(32);
        expect(copy.description.length).toBeGreaterThan(8);
        expect(copy.description.length).toBeLessThanOrEqual(80);
      }
    }
  });

  test("profile parsing strips no fields and rejects forged ids, duplicate ids and friend-only leaks", () => {
    const value = {
      self: true,
      card: {
        name: "Alice",
        look: 17,
        joinedAt: 1_796_000_000,
        achievements: ["errands-1", "firsts-1"],
        showcasePostmark: "old stones",
        postmarkOptions: ["old stones", "lone tower"],
      },
      newAchievements: ["errands-1"],
    };
    expect(parseProfileSnapshot(value)).toEqual(value);
    expect(parseProfileSnapshot({ ...value, card: { ...value.card, achievements: ["client-god-mode"] } })).toBeNull();
    expect(parseProfileSnapshot({ ...value, card: { ...value.card, achievements: ["errands-1", "errands-1"] } })).toBeNull();
    expect(parseProfileSnapshot({ ...value, self: false, newAchievements: [] })).toBeNull();
    expect(parseProfileSnapshot({
      ...value,
      self: false,
      card: { ...value.card, postmarkOptions: [] },
      newAchievements: [],
    })?.self).toBe(false);
  });

  test("joined date is host-independent UTC", () => {
    expect(joinedDate(0)).toBe("1970-01-01");
    expect(joinedDate(Date.UTC(2026, 9, 12) / 1000)).toBe("2026-10-12");
  });
});
