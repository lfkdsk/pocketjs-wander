import { describe, expect, test } from "bun:test";
import {
  SOCIAL_DETAIL_CELLS,
  SOCIAL_LABEL_CELLS,
  SOCIAL_PAGE_ROWS,
  createSocialMenuState,
  friendRealmCandidates,
  measureSocialCells,
  reduceSocialMenu,
  socialPanelLayout,
  socialPanelRowRect,
  socialMenuRows,
  socialMenuView,
  type SocialMenuData,
  type SocialMenuState,
  type SocialRect,
} from "../examples/wander-online/social-model.ts";

function fixture(): SocialMenuData {
  return {
    currentRealm: "plaza-2",
    nearby: [{ playerId: 77, name: "Nearby" }],
    social: {
      visible: false,
      incoming: [{ githubId: 10, name: "Incoming" }],
      outgoing: [{ githubId: 11, name: "Outgoing" }],
      friends: [
        { githubId: 3, name: "Offline", presence: "offline", realm: null },
        { githubId: 1, name: "Online", presence: "online", realm: "plaza-2" },
        { githubId: 2, name: "Hidden", presence: "hidden", realm: null },
      ],
    },
    realms: [
      { realm: "plaza-1", band: "quiet", joinable: true },
      { realm: "plaza-2", band: "lively", joinable: true },
      { realm: "plaza-3", band: "full", joinable: false },
    ],
    self: {
      profile: { login: "alice", name: "Alice", look: 7 },
      friends: 3,
      incoming: 1,
      outgoing: 1,
      visible: false,
      realms: [{ realm: "plaza-2", discoveries: 12, helped: 3, updatedAt: 1234 }],
    },
  };
}

function screen(screen: SocialMenuState["screen"], cursor = 0): SocialMenuState {
  return { screen, cursor, page: Math.floor(cursor / SOCIAL_PAGE_ROWS) };
}

function inside(inner: SocialRect, outer: SocialRect): boolean {
  return inner.x >= outer.x
    && inner.y >= outer.y
    && inner.x + inner.w <= outer.x + outer.w
    && inner.y + inner.h <= outer.y + outer.h;
}

describe("wander-online social menu model", () => {
  test("home navigation enters each route and back yields an explicit close action", () => {
    const data = fixture();
    let transition = reduceSocialMenu(createSocialMenuState(), "down", data);
    expect(transition).toEqual({ state: screen("home", 1), action: null });
    transition = reduceSocialMenu(transition.state, "confirm", data);
    expect(transition).toEqual({ state: screen("worlds"), action: null });
    transition = reduceSocialMenu(transition.state, "back", data);
    expect(transition).toEqual({ state: screen("home"), action: null });
    expect(reduceSocialMenu(transition.state, "back", data).action).toEqual({ type: "close" });

    const myData = reduceSocialMenu(screen("home", 2), "confirm", data);
    expect(myData.state).toEqual(screen("my-data"));
  });

  test("friends are grouped incoming, online, hidden, offline and outgoing with typed actions", () => {
    const data = fixture();
    const rows = socialMenuRows(screen("friends"), data);
    expect(rows.map((row) => [row.kind, row.label, row.detail])).toEqual([
      ["incoming", "Incoming", "INCOMING"],
      ["friend", "Online", "ON plaza-2"],
      ["friend", "Hidden", "HIDDEN"],
      ["friend", "Offline", "OFFLINE"],
      ["outgoing", "Outgoing", "OUTGOING"],
      ["nearby", "Nearby", "ADD NEARBY"],
    ]);
    expect(reduceSocialMenu(screen("friends", 0), "confirm", data).action)
      .toEqual({ type: "accept-friend", githubId: 10 });
    expect(reduceSocialMenu(screen("friends", 0), "delete", data).action)
      .toEqual({ type: "decline-friend", githubId: 10 });
    expect(reduceSocialMenu(screen("friends", 1), "confirm", data).action)
      .toEqual({ type: "join-realm", realm: "plaza-2" });
    expect(reduceSocialMenu(screen("friends", 1), "delete", data).action)
      .toEqual({ type: "remove-friend", githubId: 1 });
    expect(reduceSocialMenu(screen("friends", 4), "delete", data).action)
      .toEqual({ type: "cancel-friend-request", githubId: 11 });
    expect(reduceSocialMenu(screen("friends", 5), "confirm", data).action)
      .toEqual({ type: "request-friend", playerId: 77 });
    expect(reduceSocialMenu(screen("friends", 2), "confirm", data).action).toBeNull();
  });

  test("worlds expose coarse bands, friend candidates and refuse non-joinable rows", () => {
    const data = fixture();
    expect(friendRealmCandidates(data)).toEqual([
      { realm: "plaza-2", band: "lively", joinable: true, friends: 1 },
    ]);
    const rows = socialMenuRows(screen("worlds"), data);
    expect(rows.map((row) => [row.label, row.detail, row.joinable])).toEqual([
      ["plaza-1", "QUIET", true],
      ["plaza-2", "LIVELY 1F", true],
      ["plaza-3", "FULL", false],
    ]);
    expect(reduceSocialMenu(screen("worlds", 1), "confirm", data).action)
      .toEqual({ type: "join-realm", realm: "plaza-2" });
    expect(reduceSocialMenu(screen("worlds", 2), "confirm", data).action).toBeNull();
  });

  test("privacy is explicit and profile deletion needs a second delete edge", () => {
    const data = fixture();
    expect(reduceSocialMenu(screen("my-data"), "privacy", data).action)
      .toEqual({ type: "set-visibility", visible: true });

    const armed = reduceSocialMenu(screen("my-data"), "delete", data);
    expect(armed).toEqual({ state: screen("delete-confirm"), action: null });
    expect(reduceSocialMenu(armed.state, "confirm", data).action).toBeNull();
    expect(reduceSocialMenu(armed.state, "back", data)).toEqual({ state: screen("my-data"), action: null });
    expect(reduceSocialMenu(armed.state, "delete", data)).toEqual({
      state: screen("my-data"),
      action: { type: "delete-profile" },
    });
  });

  test("long lists are capped and paged without losing absolute selection", () => {
    const data = fixture();
    data.social!.incoming = Array.from({ length: 100 }, (_, i) => ({ githubId: i + 100, name: `Request ${i}` }));
    data.social!.friends = [];
    data.social!.outgoing = [];
    data.realms = Array.from({ length: 30 }, (_, i) => ({ realm: `realm-${i}`, band: "quiet", joinable: true }));
    expect(socialMenuRows(screen("friends"), data)).toHaveLength(65);
    expect(socialMenuRows(screen("worlds"), data)).toHaveLength(16);

    data.self!.realms = Array.from({ length: 30 }, (_, i) => ({
      realm: `history-${i}`, discoveries: i, helped: 0, updatedAt: i,
    }));
    expect(socialMenuRows(screen("my-data"), data)).toHaveLength(35);

    let state = screen("friends");
    for (let i = 0; i < 8; i++) state = reduceSocialMenu(state, "down", data).state;
    const view = socialMenuView(state, data);
    expect(view.state).toEqual(screen("friends", 8));
    expect(view.page).toBe(1);
    expect(view.pages).toBe(10);
    expect(view.rows).toHaveLength(SOCIAL_PAGE_ROWS);
    expect(view.rows[0]!.key).toBe("incoming-107");
  });

  test("maximum names, realms and untrusted line breaks are fitted to fixed cells", () => {
    const data = fixture();
    data.social!.incoming = [{ githubId: 99, name: `${"界".repeat(48)}\nBAD` }];
    data.social!.friends = [{
      githubId: 98,
      name: "N".repeat(48),
      presence: "online",
      realm: "r".repeat(32),
    }];
    data.social!.outgoing = [];
    data.realms = [{ realm: "r".repeat(32), band: "busy", joinable: true }];
    const rows = [
      ...socialMenuRows(screen("friends"), data),
      ...socialMenuRows(screen("worlds"), data),
    ];
    for (const row of rows) {
      expect(measureSocialCells(row.label), row.label).toBeLessThanOrEqual(SOCIAL_LABEL_CELLS);
      expect(measureSocialCells(row.detail), row.detail).toBeLessThanOrEqual(SOCIAL_DETAIL_CELLS);
      expect(row.label).not.toContain("\n");
    }
    expect(rows.some((row) => row.label.endsWith("…"))).toBe(true);
    expect(rows.some((row) => row.detail.endsWith("…"))).toBe(true);
  });
});

describe("wander-online social panel layout", () => {
  test("the panel, rows and footer stay inside 480x272 and 960x544", () => {
    for (const [width, height, scale] of [[480, 272, 1], [960, 544, 2]] as const) {
      const viewport = { x: 0, y: 0, w: width, h: height };
      const layout = socialPanelLayout(width, height);
      expect(layout.scale).toBe(scale);
      expect(layout.rows).toBe(SOCIAL_PAGE_ROWS);
      expect(inside(layout.panel, viewport)).toBe(true);
      expect(inside(layout.header, layout.panel)).toBe(true);
      expect(inside(layout.body, layout.panel)).toBe(true);
      expect(inside(layout.footer, layout.panel)).toBe(true);
      for (let row = 0; row < SOCIAL_PAGE_ROWS; row++) {
        expect(inside(socialPanelRowRect(layout, row), layout.body), `${width}x${height} row ${row}`).toBe(true);
      }
      expect(layout.labelWidth + layout.detailWidth).toBeLessThan(layout.body.w);
    }
  });
});
