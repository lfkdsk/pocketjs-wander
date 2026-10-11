import { describe, expect, test } from "bun:test";
import {
  SOCIAL_DETAIL_CELLS,
  SOCIAL_LABEL_CELLS,
  SOCIAL_PAGE_ROWS,
  SOCIAL_WIDE_PHONE_PANEL_W,
  createSocialMenuState,
  friendRealmCandidates,
  fitSocialText,
  measureSocialCells,
  onlineNoticeTypography,
  reduceSocialMenu,
  resolveOnlineLocale,
  socialPanelLayout,
  socialPanelLabelCells,
  socialPanelRowRect,
  socialMenuRows,
  socialMenuView,
  type SocialMenuData,
  type SocialMenuState,
  type SocialRect,
} from "../examples/wander-online/social-model.ts";
import { fitViewport } from "../vendor/pocket-rpgkit/tools/web/fit.ts";

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
      login: "alice",
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
  test("home route summaries use complete single-line copy", () => {
    const rows = socialMenuRows(screen("home"), fixture());
    expect(rows.map((row) => row.detail)).toEqual([
      "REQUESTS",
      "POPULATION",
      "PRIVACY",
    ]);
    for (const row of rows) {
      expect(row.detail.endsWith("…")).toBe(false);
      expect(measureSocialCells(row.detail)).toBeLessThanOrEqual(SOCIAL_DETAIL_CELLS);
    }
  });

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

  test("Discovery route is capability-gated and toggles public listing without hiding private YOU", () => {
    const legacy = fixture();
    expect(socialMenuRows(screen("home"), legacy).map((row) => row.key)).toEqual([
      "route-friends", "route-worlds", "route-my-data",
    ]);
    legacy.features = { realm: "plaza-2", coopErrands: true, discoveryLeaderboard: false };
    expect(socialMenuRows(screen("home"), legacy).map((row) => row.key)).not.toContain("route-discovery");

    const data = fixture();
    data.features = { realm: "plaza-2", coopErrands: true, discoveryLeaderboard: true };
    data.leaderboard = {
      realm: "plaza-2",
      revision: 4,
      listed: false,
      mine: { rank: 31, firsts: 7 },
      leaders: [
        { rank: 1, name: "Public One", firsts: 80 },
        { rank: 4, name: "Public Four", firsts: 44 },
      ],
    };
    expect(socialMenuRows(screen("home"), data).map((row) => row.key)).toEqual([
      "route-friends", "route-worlds", "route-discovery", "route-my-data",
    ]);
    const opened = reduceSocialMenu(screen("home", 2), "confirm", data);
    expect(opened).toEqual({ state: screen("discovery"), action: null });
    expect(socialMenuRows(opened.state, data).map((row) => [row.label, row.detail])).toEqual([
      ["YOU · #31", "7 FIRSTS"],
      ["#1 Public One", "80 FIRSTS"],
      ["#4 Public Four", "44 FIRSTS"],
    ]);
    expect(reduceSocialMenu(opened.state, "privacy", data).action)
      .toEqual({ type: "set-discovery-listing", listed: true });
    data.leaderboard = { ...data.leaderboard, listed: true };
    expect(reduceSocialMenu(opened.state, "privacy", data).action)
      .toEqual({ type: "set-discovery-listing", listed: false });
  });

  test("Discovery keeps twenty public leaders in normal seven-row paging", () => {
    const data = fixture();
    data.features = { realm: "plaza-2", coopErrands: false, discoveryLeaderboard: true };
    data.leaderboard = {
      realm: "plaza-2",
      revision: 1,
      listed: false,
      mine: { rank: 99, firsts: 0 },
      leaders: Array.from({ length: 20 }, (_, i) => ({ rank: i + 1, name: `Finder ${i}`, firsts: 20 - i })),
    };
    const rows = socialMenuRows(screen("discovery"), data);
    expect(rows).toHaveLength(21);
    expect(rows[0]?.key).toBe("discovery-mine");
    expect(rows.slice(1).every((row) => row.key.startsWith("discovery-leader-"))).toBe(true);
    expect(socialMenuView(screen("discovery"), data).rows).toHaveLength(SOCIAL_PAGE_ROWS);
    expect(socialMenuView(screen("discovery", 14), data)).toMatchObject({ page: 2, pages: 3 });
  });

  test("locale hook selects concise Chinese Discovery copy from codepoints", () => {
    const data = fixture();
    data.features = { realm: "plaza-2", coopErrands: true, discoveryLeaderboard: true };
    data.leaderboard = {
      realm: "plaza-2", revision: 1, listed: false,
      mine: { rank: 3, firsts: 7 }, leaders: [{ rank: 1, name: "Alice", firsts: 9 }],
    };
    data.locale = resolveOnlineLocale(undefined, "zh-CN");
    const discovery = String.fromCodePoint(0x53d1, 0x73b0, 0x699c);
    const firstFinders = String.fromCodePoint(0x9996, 0x6b21, 0x53d1, 0x73b0);
    const you = String.fromCodePoint(0x4f60);
    expect(resolveOnlineLocale("ZH-hans", "en-US")).toBe("zh");
    expect(resolveOnlineLocale("en", "zh-CN")).toBe("en");
    expect(resolveOnlineLocale(undefined, "fr")).toBe("en");
    expect(onlineNoticeTypography("zh")).toEqual({ className: "text-xs", lineHeight: 12 });
    expect(onlineNoticeTypography("en")).toEqual({ className: "text-sm", lineHeight: 18 });
    expect(socialMenuRows(screen("home"), data)[2]).toMatchObject({ label: discovery, detail: firstFinders });
    const view = socialMenuView(screen("discovery"), data);
    expect(view.title).toBe("FIRST FINDERS");
    expect([...`${view.title}${view.footer}`].every((ch) => {
      const cp = ch.codePointAt(0) ?? 0;
      return cp < 0x3400 || cp > 0x9fff;
    })).toBe(true);
    expect(view.rows[0]?.label).toBe(`${you} · #3`);
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

  test("the friends footer keeps complete controller copy inside the narrow panel", () => {
    expect(socialMenuView(screen("friends"), fixture()).footer)
      .toBe("CIRCLE ACT · SQUARE REMOVE · CROSS BACK");
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
    expect(socialMenuView(armed.state, data).title).toBe("DELETE ALL DATA?");
    expect(socialMenuRows(armed.state, data)[0]?.label).toBe("PROFILE + FRIENDS + JOURNEYS");
    expect(reduceSocialMenu(armed.state, "confirm", data).action).toBeNull();
    expect(reduceSocialMenu(armed.state, "back", data)).toEqual({ state: screen("my-data"), action: null });
    expect(reduceSocialMenu(armed.state, "delete", data)).toEqual({
      state: screen("my-data"),
      action: { type: "delete-profile" },
    });
  });

  test("legacy self data without a profile renders an explicit safe summary", () => {
    const data = fixture();
    Object.assign(data.self!, { profile: null });
    const rows = socialMenuRows(screen("my-data"), data);
    expect(rows[0]).toMatchObject({
      key: "self-profile",
      kind: "summary",
      label: "NO PROFILE",
      detail: "@alice",
      tone: "muted",
    });
    expect(rows.slice(1).map((row) => row.label)).toEqual([
      "FRIENDS",
      "INCOMING",
      "OUTGOING",
      "PRESENCE",
      "plaza-2",
    ]);
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

  test("phone portrait and landscape reserve an unclipped detail text cell", () => {
    for (const [width, height] of [[390, 844], [844, 390]] as const) {
      const viewport = { x: 0, y: 0, w: width, h: height };
      const layout = socialPanelLayout(width, height);
      const detailGutter = 8 * layout.scale;
      expect(layout.scale).toBe(1);
      expect(inside(layout.panel, viewport), `${width}x${height} panel`).toBe(true);
      expect(layout.rows).toBe(SOCIAL_PAGE_ROWS);
      expect(layout.detailWidth - detailGutter, `${width}x${height} detail text width`)
        .toBeGreaterThanOrEqual(120);
      expect(layout.labelWidth + layout.detailWidth + detailGutter).toBe(layout.body.w);
    }
  });

  test("the hosted landscape viewport keeps the panel between both floating control clusters", () => {
    const fit = fitViewport({
      policy: "dynamic",
      default: [960, 544],
      min: [480, 272],
      max: [4096, 4096],
    }, 844, 390, 3, 2);
    expect(fit).toEqual({ size: [633, 292], k: 4 });

    const [width, height] = fit.size;
    const layout = socialPanelLayout(width, height);
    const viewport = { x: 0, y: 0, w: width, h: height };
    expect(layout.scale).toBe(1);
    expect(layout.panel.w).toBe(SOCIAL_WIDE_PHONE_PANEL_W);
    expect(inside(layout.panel, viewport)).toBe(true);
    expect(inside(layout.header, layout.panel)).toBe(true);
    expect(inside(layout.body, layout.panel)).toBe(true);
    expect(inside(layout.footer, layout.panel)).toBe(true);
    for (let row = 0; row < SOCIAL_PAGE_ROWS; row++) {
      expect(inside(socialPanelRowRect(layout, row), layout.body), `row ${row}`).toBe(true);
    }
    expect(layout.detailWidth - 8).toBeGreaterThanOrEqual(120);
    expect(socialPanelLabelCells(layout)).toBe(24);

    // The immersive pad has a 152 CSS-px d-pad after 12 px padding, and a
    // 164 CSS-px action cluster before the same right padding. Project the
    // actual logical panel through the live 844 px stage as the browser does.
    const cssPerLogical = 844 / width;
    const panelLeft = layout.panel.x * cssPerLogical;
    const panelRight = (layout.panel.x + layout.panel.w) * cssPerLogical;
    expect(panelLeft).toBeGreaterThan(164);
    expect(panelRight).toBeLessThan(668);
  });

  test("English and Chinese Discovery cells fit at every supported phone viewport", () => {
    for (const locale of ["en", "zh"] as const) {
      const data = fixture();
      data.locale = locale;
      data.features = { realm: "plaza-2", coopErrands: true, discoveryLeaderboard: true };
      data.leaderboard = {
        realm: "plaza-2", revision: 1, listed: true,
        mine: { rank: Number.MAX_SAFE_INTEGER, firsts: Number.MAX_SAFE_INTEGER },
        leaders: [{
          rank: Number.MAX_SAFE_INTEGER,
          name: String.fromCodePoint(0x4e00).repeat(48),
          firsts: Number.MAX_SAFE_INTEGER,
        }],
      };
      for (const [width, height] of [[390, 844], [844, 390], [633, 292]] as const) {
        const layout = socialPanelLayout(width, height);
        const view = socialMenuView(screen("discovery"), data);
        expect(view.rows.length).toBeLessThanOrEqual(SOCIAL_PAGE_ROWS);
        for (const item of view.rows) {
          expect(measureSocialCells(item.label), `${locale} ${width}x${height} label`)
            .toBeLessThanOrEqual(SOCIAL_LABEL_CELLS);
          expect(measureSocialCells(item.detail), `${locale} ${width}x${height} detail`)
            .toBeLessThanOrEqual(SOCIAL_DETAIL_CELLS);
          expect(measureSocialCells(fitSocialText(item.label, socialPanelLabelCells(layout))), `${locale} ${width}x${height} painted label`)
            .toBeLessThanOrEqual(socialPanelLabelCells(layout));
        }
      }
    }
  });
});
