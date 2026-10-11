import { describe, expect, test } from "bun:test";
import {
  SOCIAL_MAX_COOP_REQUIRED,
  SOCIAL_MAX_LEADERBOARD_ROWS,
  parseCoopErrandSnapshot,
  parseDiscoveryLeaderboard,
  parseRealmChoices,
  parseRealmFeatures,
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

  test("realm feature flags are strict and discard unrelated fields", () => {
    expect(parseRealmFeatures({
      realm: "plaza-1",
      coopErrands: true,
      discoveryLeaderboard: false,
      privateRoster: [{ id: 7, x: 12, y: 4 }],
    })).toEqual({ realm: "plaza-1", coopErrands: true, discoveryLeaderboard: false });
    expect(parseRealmFeatures({ realm: "../secret", coopErrands: true, discoveryLeaderboard: true })).toBeNull();
    expect(parseRealmFeatures({ realm: "plaza-1", coopErrands: 1, discoveryLeaderboard: true })).toBeNull();
  });

  test("co-op snapshots bound revisions, party counts and timestamps without exposing players", () => {
    const parsed = parseCoopErrandSnapshot({
      realm: "plaza-1",
      revision: 0xffff_ffff,
      status: "waiting",
      cooperative: true,
      ready: true,
      savedReady: 1,
      presentReady: 1,
      required: 2,
      expiresAt: Number.MAX_SAFE_INTEGER,
      playerIds: [4, 8],
      positions: [{ x: 1, y: 2 }],
    });
    expect(parsed).toEqual({
      realm: "plaza-1",
      revision: 0xffff_ffff,
      status: "waiting",
      cooperative: true,
      ready: true,
      savedReady: 1,
      presentReady: 1,
      required: 2,
      expiresAt: Number.MAX_SAFE_INTEGER,
    });
    expect(parsed).not.toHaveProperty("playerIds");
    expect(parsed).not.toHaveProperty("positions");
    expect(parseCoopErrandSnapshot({ ...parsed!, realm: "bad/realm" })).toBeNull();
    expect(parseCoopErrandSnapshot({ ...parsed!, revision: 0x1_0000_0000 })).toBeNull();
    expect(parseCoopErrandSnapshot({ ...parsed!, status: "secret" })).toBeNull();
    expect(parseCoopErrandSnapshot({ ...parsed!, required: 1 })).toBeNull();
    expect(parseCoopErrandSnapshot({ ...parsed!, required: SOCIAL_MAX_COOP_REQUIRED + 1 })).toBeNull();
    expect(parseCoopErrandSnapshot({ ...parsed!, presentReady: 3 })).toBeNull();
    expect(parseCoopErrandSnapshot({ ...parsed!, expiresAt: Number.MAX_SAFE_INTEGER + 1 })).toBeNull();
  });

  test("discovery leaderboard bounds ranks and public rows and strips sensitive fields", () => {
    const source = {
      realm: "plaza-1",
      revision: 9,
      listed: false,
      mine: { rank: 21, firsts: 4, githubId: 99, x: 3, y: 7 },
      leaders: [{ rank: 1, name: "Alice", firsts: 80, githubId: 1, realm: "private" }],
      presence: [{ id: 1, x: 3, y: 7 }],
    };
    expect(parseDiscoveryLeaderboard(source)).toEqual({
      realm: "plaza-1",
      revision: 9,
      listed: false,
      mine: { rank: 21, firsts: 4 },
      leaders: [{ rank: 1, name: "Alice", firsts: 80 }],
    });
    const max = Array.from({ length: SOCIAL_MAX_LEADERBOARD_ROWS }, (_, i) => ({
      rank: i + 1, name: `Finder ${i}`, firsts: 100 - i,
    }));
    expect(parseDiscoveryLeaderboard({ ...source, leaders: max })?.leaders).toHaveLength(SOCIAL_MAX_LEADERBOARD_ROWS);
    expect(parseDiscoveryLeaderboard({ ...source, leaders: [...max, max[0]] })).toBeNull();
    expect(parseDiscoveryLeaderboard({ ...source, realm: "no spaces" })).toBeNull();
    expect(parseDiscoveryLeaderboard({ ...source, mine: { rank: 0, firsts: 4 } })).toBeNull();
    expect(parseDiscoveryLeaderboard({ ...source, mine: { rank: 2, firsts: -1 } })).toBeNull();
    expect(parseDiscoveryLeaderboard({ ...source, mine: { rank: Number.MAX_SAFE_INTEGER + 1, firsts: 4 } })).toBeNull();
    expect(parseDiscoveryLeaderboard({ ...source, leaders: [{ rank: 0, name: "Alice", firsts: 1 }] })).toBeNull();
    expect(parseDiscoveryLeaderboard({ ...source, leaders: [{ rank: 1, name: "", firsts: 1 }] })).toBeNull();
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
