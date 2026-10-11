import { describe, expect, test } from "bun:test";
import {
  parseRealmChoices,
  parseSelfData,
  parseSocialSnapshot,
  populationBand,
} from "../examples/wander-online/shared/social.ts";

describe("social wire contract", () => {
  test("population is coarse and cap-aware", () => {
    expect([0, 1, 8, 9, 19, 20, 31, 32].map((n) => populationBand(n, 32))).toEqual([
      "empty", "quiet", "quiet", "lively", "lively", "busy", "busy", "full",
    ]);
  });

  test("friend locations parse only inside a bounded authenticated snapshot", () => {
    expect(parseSocialSnapshot({
      visible: false,
      friends: [
        { githubId: 2, name: "Bob", presence: "online", realm: "plaza-2" },
        { githubId: 3, name: "Cara", presence: "hidden", realm: null },
      ],
      incoming: [{ githubId: 4, name: "Dan" }],
      outgoing: [],
    })).toEqual({
      visible: false,
      friends: [
        { githubId: 2, name: "Bob", presence: "online", realm: "plaza-2" },
        { githubId: 3, name: "Cara", presence: "hidden", realm: null },
      ],
      incoming: [{ githubId: 4, name: "Dan" }],
      outgoing: [],
    });
    expect(parseSocialSnapshot({
      visible: true,
      friends: [{ githubId: 9, name: "Eve", presence: "offline", realm: "plaza-1" }],
      incoming: [],
      outgoing: [],
    })).toBeNull();
    expect(parseSocialSnapshot({ visible: true, friends: [], incoming: new Array(65).fill({ githubId: 1, name: "x" }), outgoing: [] })).toBeNull();
  });

  test("world choices reject exact counts and malformed identifiers", () => {
    expect(parseRealmChoices([
      { realm: "plaza-1", band: "quiet", joinable: true },
      { realm: "plaza-2", band: "full", joinable: false },
    ])).toHaveLength(2);
    expect(parseRealmChoices([{ realm: "../private", band: "quiet", joinable: true }])).toBeNull();
    expect(parseRealmChoices([{ realm: "plaza-1", band: "quiet", joinable: true, count: 7 }])?.[0]).not.toHaveProperty("count");
  });

  test("self-data summary is bounded and contains no position", () => {
    const parsed = parseSelfData({
      profile: { login: "alice", name: "Alice", look: 7 },
      friends: 2,
      incoming: 1,
      outgoing: 0,
      visible: true,
      realms: [{ realm: "plaza-1", discoveries: 12, helped: 3, updatedAt: 1234, x: 99, y: 88 }],
    });
    expect(parsed?.realms[0]).toEqual({ realm: "plaza-1", discoveries: 12, helped: 3, updatedAt: 1234 });
    expect(parsed?.realms[0]).not.toHaveProperty("x");
    expect(parseSelfData({
      login: "legacy-user",
      profile: null,
      friends: 0,
      incoming: 0,
      outgoing: 0,
      visible: true,
      realms: [],
    })).toEqual({
      login: "legacy-user",
      profile: null,
      friends: 0,
      incoming: 0,
      outgoing: 0,
      visible: true,
      realms: [],
    });
    expect(parseSelfData({
      profile: null,
      friends: 0,
      incoming: 0,
      outgoing: 0,
      visible: true,
      realms: [],
    })).toBeNull();
    expect(parseSelfData({
      profile: { login: "alice", name: "Alice", look: 64 },
      friends: 0,
      incoming: 0,
      outgoing: 0,
      visible: true,
      realms: [],
    })).toBeNull();
    const history = Array.from({ length: 256 }, (_, i) => ({
      realm: `history-${i}`,
      discoveries: i,
      helped: 0,
      updatedAt: i,
    }));
    expect(parseSelfData({
      profile: { login: "alice", name: "Alice", look: 7 },
      friends: 0,
      incoming: 0,
      outgoing: 0,
      visible: true,
      realms: history,
    })?.realms).toHaveLength(256);
    expect(parseSelfData({
      profile: { login: "alice", name: "Alice", look: 7 },
      friends: 0,
      incoming: 0,
      outgoing: 0,
      visible: true,
      realms: [...history, { realm: "overflow", discoveries: 0, helped: 0, updatedAt: 0 }],
    })).toBeNull();
  });
});
