// examples/wander-online/social-model.ts — pure controller state for the
// controller-friendly social panel. Network code owns fetching and sending;
// this module only turns bounded snapshots and key edges into rows/actions.

import {
  SOCIAL_MAX_FRIENDS,
  SOCIAL_MAX_PENDING,
  SOCIAL_MAX_REALM_HISTORY,
  SOCIAL_MAX_WORLD_CHOICES,
  type FriendPresence,
  type RealmChoice,
  type SelfDataSummary,
  type SocialSnapshot,
} from "./shared/social.ts";

export const SOCIAL_PAGE_ROWS = 7;
export const SOCIAL_WORLD_LIMIT = SOCIAL_MAX_WORLD_CHOICES;
/** Conservative text-cell budgets for the 480 px layout. */
export const SOCIAL_LABEL_CELLS = 34;
export const SOCIAL_DETAIL_CELLS = 14;

export type SocialScreen = "home" | "friends" | "worlds" | "my-data" | "delete-confirm";
export type SocialInput = "up" | "down" | "confirm" | "back" | "delete" | "privacy";

export interface SocialMenuState {
  screen: SocialScreen;
  /** Absolute row within the current screen, not merely the visible page. */
  cursor: number;
  page: number;
}

export interface SocialMenuData {
  social: SocialSnapshot | null;
  realms: readonly RealmChoice[];
  self: SelfDataSummary | null;
  /** Temporary ids from the current realm roster. They are never durable
   * GitHub ids; the server resolves them inside the joined Room. */
  nearby?: readonly { playerId: number; name: string }[];
  currentRealm?: string | null;
}

export interface SocialRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SocialPanelLayout {
  scale: number;
  panel: SocialRect;
  header: SocialRect;
  body: SocialRect;
  footer: SocialRect;
  rowHeight: number;
  rows: number;
  labelWidth: number;
  detailWidth: number;
}

export type SocialAction =
  | { type: "close" }
  | { type: "request-friend"; playerId: number }
  | { type: "accept-friend"; githubId: number }
  | { type: "decline-friend"; githubId: number }
  | { type: "cancel-friend-request"; githubId: number }
  | { type: "remove-friend"; githubId: number }
  | { type: "join-realm"; realm: string }
  | { type: "set-visibility"; visible: boolean }
  | { type: "delete-profile" };

export type SocialRowKind =
  | "route"
  | "incoming"
  | "outgoing"
  | "friend"
  | "nearby"
  | "realm"
  | "summary"
  | "warning"
  | "empty";

export type SocialRowTone = "normal" | "accent" | "muted" | "danger" | "disabled";

export interface SocialMenuRow {
  key: string;
  kind: SocialRowKind;
  label: string;
  detail: string;
  tone: SocialRowTone;
  githubId?: number;
  playerId?: number;
  presence?: FriendPresence;
  realm?: string;
  joinable?: boolean;
}

export interface SocialTransition {
  state: SocialMenuState;
  /** Null means this input was navigation-only or unavailable for the row. */
  action: SocialAction | null;
}

export interface FriendRealmCandidate extends RealmChoice {
  friends: number;
}

export interface SocialMenuView {
  state: SocialMenuState;
  title: string;
  rows: SocialMenuRow[];
  page: number;
  pages: number;
  footer: string;
}

const HOME_ROWS: readonly SocialMenuRow[] = [
  row("route-friends", "route", "FRIENDS", "REQUESTS + PRESENCE", "accent"),
  row("route-worlds", "route", "WORLDS", "POPULATION", "accent"),
  row("route-my-data", "route", "MY DATA", "PRIVACY + DELETE", "accent"),
];

const SCREEN_TITLES: Record<SocialScreen, string> = {
  home: "SOCIAL",
  friends: "FRIENDS",
  worlds: "WORLDS",
  "my-data": "MY DATA",
  "delete-confirm": "DELETE ALL DATA?",
};

/** One display cell for ASCII, two for non-ASCII. This deliberately
 * overestimates the bundled proportional font so a fitted line stays safe. */
export function measureSocialCells(text: string): number {
  let cells = 0;
  for (const ch of text) cells += (ch.codePointAt(0) ?? 0) <= 0x7f ? 1 : 2;
  return cells;
}

/** Remove line-breaking/control input and add an ellipsis inside maxCells. */
export function fitSocialText(value: string, maxCells: number): string {
  if (maxCells <= 0) return "";
  const text = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (measureSocialCells(text) <= maxCells) return text;
  const ellipsis = "…";
  if (maxCells < measureSocialCells(ellipsis)) return ".";
  const budget = Math.max(0, maxCells - measureSocialCells(ellipsis));
  let out = "";
  let cells = 0;
  for (const ch of text) {
    const width = (ch.codePointAt(0) ?? 0) <= 0x7f ? 1 : 2;
    if (cells + width > budget) break;
    out += ch;
    cells += width;
  }
  return `${out}${ellipsis}`;
}

/** Responsive geometry uses the same integer 1x/2x scale as the game HUD.
 * Every returned rectangle is clipped to the supplied viewport. */
export function socialPanelLayout(width: number, height: number): SocialPanelLayout {
  const viewportW = Math.max(0, Math.floor(width));
  const viewportH = Math.max(0, Math.floor(height));
  const scale = Math.max(1, Math.min(Math.floor(viewportW / 480), Math.floor(viewportH / 272)));
  const margin = 8 * scale;
  const panelW = Math.max(0, Math.min(464 * scale, viewportW - Math.min(viewportW, margin * 2)));
  const panelH = Math.max(0, Math.min(256 * scale, viewportH - Math.min(viewportH, margin * 2)));
  const panel: SocialRect = {
    x: Math.max(0, Math.floor((viewportW - panelW) / 2)),
    y: Math.max(0, Math.floor((viewportH - panelH) / 2)),
    w: panelW,
    h: panelH,
  };
  const inset = Math.min(12 * scale, Math.floor(panel.w / 2));
  const contentW = Math.max(0, panel.w - inset * 2);
  const rowHeight = 24 * scale;
  const header: SocialRect = { x: panel.x + inset, y: panel.y + 8 * scale, w: contentW, h: 20 * scale };
  const bodyY = panel.y + 38 * scale;
  const bodyAvailable = Math.max(0, panel.y + panel.h - 42 * scale - bodyY);
  const rows = Math.min(SOCIAL_PAGE_ROWS, Math.floor(bodyAvailable / rowHeight));
  const body: SocialRect = { x: panel.x + inset, y: bodyY, w: contentW, h: rows * rowHeight };
  const footerH = Math.min(16 * scale, panel.h);
  const footer: SocialRect = {
    x: panel.x + inset,
    y: Math.max(panel.y, panel.y + panel.h - 22 * scale),
    w: contentW,
    h: footerH,
  };
  const gap = 8 * scale;
  const detailWidth = Math.min(112 * scale, Math.max(0, body.w));
  const labelWidth = Math.max(0, body.w - detailWidth - gap);
  return { scale, panel, header, body, footer, rowHeight, rows, labelWidth, detailWidth };
}

export function socialPanelRowRect(layout: SocialPanelLayout, index: number): SocialRect {
  const rowIndex = Math.max(0, Math.min(layout.rows - 1, Math.floor(index)));
  return {
    x: layout.body.x,
    y: layout.body.y + rowIndex * layout.rowHeight,
    w: layout.body.w,
    h: layout.rowHeight,
  };
}

function row(
  key: string,
  kind: SocialRowKind,
  label: string,
  detail: string,
  tone: SocialRowTone = "normal",
  extra: Partial<SocialMenuRow> = {},
): SocialMenuRow {
  return {
    key,
    kind,
    label: fitSocialText(label, SOCIAL_LABEL_CELLS),
    detail: fitSocialText(detail, SOCIAL_DETAIL_CELLS),
    tone,
    ...extra,
  };
}

function friendRows(snapshot: SocialSnapshot | null, nearby: SocialMenuData["nearby"]): SocialMenuRow[] {
  if (!snapshot) return [row("friends-loading", "empty", "SOCIAL DATA UNAVAILABLE", "", "muted")];
  const rows: SocialMenuRow[] = [];
  for (const friend of snapshot.incoming.slice(0, SOCIAL_MAX_PENDING)) {
    rows.push(row(
      `incoming-${friend.githubId}`,
      "incoming",
      friend.name,
      "INCOMING",
      "accent",
      { githubId: friend.githubId },
    ));
  }
  const friends = snapshot.friends.slice(0, SOCIAL_MAX_FRIENDS);
  for (const presence of ["online", "hidden", "offline"] as const) {
    for (const friend of friends) {
      if (friend.presence !== presence) continue;
      const detail = presence === "online" && friend.realm ? `ON ${friend.realm}` : presence.toUpperCase();
      rows.push(row(
        `friend-${friend.githubId}`,
        "friend",
        friend.name,
        detail,
        presence === "online" ? "accent" : "muted",
        {
          githubId: friend.githubId,
          presence,
          ...(friend.realm ? { realm: friend.realm } : {}),
        },
      ));
    }
  }
  for (const friend of snapshot.outgoing.slice(0, SOCIAL_MAX_PENDING)) {
    rows.push(row(
      `outgoing-${friend.githubId}`,
      "outgoing",
      friend.name,
      "OUTGOING",
      "muted",
      { githubId: friend.githubId },
    ));
  }
  for (const player of nearby?.slice(0, 32) ?? []) {
    if (!Number.isSafeInteger(player.playerId) || player.playerId <= 0) continue;
    rows.push(row(
      `nearby-${player.playerId}`,
      "nearby",
      player.name,
      "ADD NEARBY",
      "normal",
      { playerId: player.playerId },
    ));
  }
  return rows.length > 0 ? rows : [row("friends-empty", "empty", "NO FRIENDS YET", "", "muted")];
}

/** Realm rows that currently contain at least one visible online friend.
 * The service-provided order is retained so its recommendation stays stable. */
export function friendRealmCandidates(data: SocialMenuData): FriendRealmCandidate[] {
  const counts = new Map<string, number>();
  for (const friend of data.social?.friends.slice(0, SOCIAL_MAX_FRIENDS) ?? []) {
    if (friend.presence === "online" && friend.realm) {
      counts.set(friend.realm, (counts.get(friend.realm) ?? 0) + 1);
    }
  }
  const out: FriendRealmCandidate[] = [];
  for (const choice of data.realms.slice(0, SOCIAL_WORLD_LIMIT)) {
    const friends = counts.get(choice.realm) ?? 0;
    if (friends > 0) out.push({ ...choice, friends });
  }
  return out;
}

function worldRows(data: SocialMenuData): SocialMenuRow[] {
  const candidates = new Map(friendRealmCandidates(data).map((choice) => [choice.realm, choice.friends]));
  const rows: SocialMenuRow[] = [];
  for (const choice of data.realms.slice(0, SOCIAL_WORLD_LIMIT)) {
    const friends = candidates.get(choice.realm) ?? 0;
    const joinable = choice.joinable && choice.band !== "full";
    const detail = friends > 0 ? `${choice.band.toUpperCase()} ${friends}F` : choice.band.toUpperCase();
    rows.push(row(
      `realm-${choice.realm}`,
      "realm",
      choice.realm,
      detail,
      joinable ? (friends > 0 ? "accent" : "normal") : "disabled",
      { realm: choice.realm, joinable },
    ));
  }
  return rows.length > 0 ? rows : [row("worlds-empty", "empty", "NO WORLDS AVAILABLE", "", "muted")];
}

function selfRows(summary: SelfDataSummary | null): SocialMenuRow[] {
  if (!summary) return [row("self-loading", "empty", "SELF DATA UNAVAILABLE", "", "muted")];
  const rows: SocialMenuRow[] = [
    row("self-profile", "summary", summary.profile.name, `@${summary.profile.login}`, "accent"),
    row("self-friends", "summary", "FRIENDS", String(summary.friends)),
    row("self-incoming", "summary", "INCOMING", String(summary.incoming)),
    row("self-outgoing", "summary", "OUTGOING", String(summary.outgoing)),
    row("self-privacy", "summary", "PRESENCE", summary.visible ? "VISIBLE" : "HIDDEN"),
  ];
  for (const realm of summary.realms.slice(0, SOCIAL_MAX_REALM_HISTORY)) {
    rows.push(row(
      `self-realm-${realm.realm}`,
      "summary",
      realm.realm,
      `D${realm.discoveries} H${realm.helped}`,
      "muted",
      { realm: realm.realm },
    ));
  }
  return rows;
}

function deleteRows(): SocialMenuRow[] {
  return [
    row("delete-warning", "warning", "PROFILE + FRIENDS + JOURNEYS", "", "danger"),
    row("delete-again", "warning", "PRESS DELETE AGAIN", "CANNOT UNDO", "danger"),
  ];
}

export function socialMenuRows(state: SocialMenuState, data: SocialMenuData): SocialMenuRow[] {
  switch (state.screen) {
    case "home": return [...HOME_ROWS];
    case "friends": return friendRows(data.social, data.nearby);
    case "worlds": return worldRows(data);
    case "my-data": return selfRows(data.self);
    case "delete-confirm": return deleteRows();
  }
}

export function createSocialMenuState(): SocialMenuState {
  return { screen: "home", cursor: 0, page: 0 };
}

export function normalizeSocialMenuState(state: SocialMenuState, data: SocialMenuData): SocialMenuState {
  const count = socialMenuRows(state, data).length;
  const cursor = Math.max(0, Math.min(Math.max(0, count - 1), Math.floor(state.cursor)));
  return { ...state, cursor, page: Math.floor(cursor / SOCIAL_PAGE_ROWS) };
}

function enter(screen: SocialScreen): SocialMenuState {
  return { screen, cursor: 0, page: 0 };
}

function selectedRow(state: SocialMenuState, data: SocialMenuData): SocialMenuRow | null {
  return socialMenuRows(state, data)[state.cursor] ?? null;
}

/** Controller input reducer. It never mutates data and never sends: every
 * externally meaningful operation is returned as a typed parent action. */
export function reduceSocialMenu(
  state: SocialMenuState,
  input: SocialInput,
  data: SocialMenuData,
): SocialTransition {
  const current = normalizeSocialMenuState(state, data);
  const rows = socialMenuRows(current, data);
  if (input === "up" || input === "down") {
    const delta = input === "up" ? -1 : 1;
    const cursor = Math.max(0, Math.min(rows.length - 1, current.cursor + delta));
    return { state: { ...current, cursor, page: Math.floor(cursor / SOCIAL_PAGE_ROWS) }, action: null };
  }
  if (input === "back") {
    return current.screen === "home"
      ? { state: current, action: { type: "close" } }
      : { state: enter(current.screen === "delete-confirm" ? "my-data" : "home"), action: null };
  }
  if (input === "privacy") {
    if (current.screen !== "my-data") return { state: current, action: null };
    const visible = data.social?.visible ?? data.self?.visible;
    return visible === undefined
      ? { state: current, action: null }
      : { state: current, action: { type: "set-visibility", visible: !visible } };
  }
  if (input === "delete") {
    if (current.screen === "my-data") return { state: enter("delete-confirm"), action: null };
    if (current.screen === "delete-confirm") {
      return { state: enter("my-data"), action: { type: "delete-profile" } };
    }
    if (current.screen === "friends") {
      const selected = selectedRow(current, data);
      if (selected?.kind === "incoming" && selected.githubId !== undefined) {
        return { state: current, action: { type: "decline-friend", githubId: selected.githubId } };
      }
      if (selected?.kind === "outgoing" && selected.githubId !== undefined) {
        return { state: current, action: { type: "cancel-friend-request", githubId: selected.githubId } };
      }
      if (selected?.kind === "friend" && selected.githubId !== undefined) {
        return { state: current, action: { type: "remove-friend", githubId: selected.githubId } };
      }
    }
    return { state: current, action: null };
  }
  if (input !== "confirm") return { state: current, action: null };
  const selected = selectedRow(current, data);
  if (current.screen === "home") {
    const screen = (["friends", "worlds", "my-data"] as const)[current.cursor];
    return screen ? { state: enter(screen), action: null } : { state: current, action: null };
  }
  if (current.screen === "friends") {
    if (selected?.kind === "incoming" && selected.githubId !== undefined) {
      return { state: current, action: { type: "accept-friend", githubId: selected.githubId } };
    }
    if (selected?.kind === "friend" && selected.presence === "online" && selected.realm) {
      return { state: current, action: { type: "join-realm", realm: selected.realm } };
    }
    if (selected?.kind === "nearby" && selected.playerId !== undefined) {
      return { state: current, action: { type: "request-friend", playerId: selected.playerId } };
    }
  }
  if (current.screen === "worlds" && selected?.kind === "realm" && selected.joinable && selected.realm) {
    return { state: current, action: { type: "join-realm", realm: selected.realm } };
  }
  return { state: current, action: null };
}

export function socialMenuView(state: SocialMenuState, data: SocialMenuData): SocialMenuView {
  const normalized = normalizeSocialMenuState(state, data);
  const allRows = socialMenuRows(normalized, data);
  const pages = Math.max(1, Math.ceil(allRows.length / SOCIAL_PAGE_ROWS));
  const start = normalized.page * SOCIAL_PAGE_ROWS;
  const footer = normalized.screen === "home"
    ? "CIRCLE OPEN · CROSS CLOSE"
    : normalized.screen === "friends"
      ? "CIRCLE ACCEPT/JOIN/ADD · SQUARE REMOVE · CROSS BACK"
      : normalized.screen === "worlds"
        ? "CIRCLE JOIN · CROSS BACK"
        : normalized.screen === "my-data"
          ? "TRIANGLE PRIVACY · SQUARE DELETE · CROSS BACK"
          : "SQUARE DELETE FOREVER · CROSS CANCEL";
  return {
    state: normalized,
    title: SCREEN_TITLES[normalized.screen],
    rows: allRows.slice(start, start + SOCIAL_PAGE_ROWS),
    page: normalized.page,
    pages,
    footer: fitSocialText(footer, 58),
  };
}
