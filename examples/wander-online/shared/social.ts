// examples/wander-online/shared/social.ts — the small, JSON social contract
// shared by the PocketJS client, the loopback demo and the hosted Worker.
//
// Social messages intentionally stay off the per-frame binary protocol: they
// are user-driven, rare and easier to evolve as versioned JSON.  The server
// never returns a location for an arbitrary account.  Presence is embedded
// only in the authenticated caller's mutual-friend snapshot.

export const SOCIAL_PROTOCOL_VERSION = 1;
export const SOCIAL_MAX_FRIENDS = 64;
export const SOCIAL_MAX_PENDING = 64;
/** Configured choices are a small page; deletion/self-service history must
 * retain every realm the Auth DO can track. */
export const SOCIAL_MAX_WORLD_CHOICES = 16;
export const SOCIAL_MAX_REALM_HISTORY = 256;
export const SOCIAL_MAX_LEADERBOARD_ROWS = 20;
/** Co-op parties are deliberately small enough to fit in one compact HUD
 * counter and to keep every snapshot bounded independently of room size. */
export const SOCIAL_MAX_COOP_REQUIRED = 8;

export interface RealmFeatures {
  realm: string;
  coopErrands: boolean;
  /** Additive board/friend/cancel surface. Absent on older co-op servers. */
  coopPartnerFinding?: boolean;
  discoveryLeaderboard: boolean;
  /** Additive realm-wide UTC goal surface. Absent on older servers. */
  dailyGoals?: boolean;
  /** Additive server-authoritative offline postcard surface. */
  postcards?: boolean;
}

export type CoopErrandStatus = "none" | "travel" | "waiting" | "completed" | "cancelled" | "expired";

/** Private co-op state for the authenticated caller. It contains only
 * aggregate readiness: never another player's identity or location. */
export interface CoopErrandSnapshot {
  realm: string;
  revision: number;
  status: CoopErrandStatus;
  cooperative: boolean;
  ready: boolean;
  savedReady: number;
  presentReady: number;
  required: number;
  expiresAt: number;
}

/** Anonymous, offer-scoped queue depth returned only for the notice board the
 * caller is currently reading. It intentionally carries neither identities
 * nor the target coordinates where READY players are standing. */
export interface CoopBoardSnapshot {
  realm: string;
  offerRx: number;
  offerRy: number;
  waiting: number;
  required: number;
}

/** A mutual visible friend's active wait. The deterministic task copy is
 * useful to the recipient without publishing either player's coordinates. */
export interface FriendCoopWaiting {
  targetTown: string;
  item: string;
  expiresAt: number;
}

/** One ephemeral friend-only prompt. Repeated status/count changes for the
 * same READY deadline do not create another prompt. */
export interface CoopFriendWaiting extends FriendCoopWaiting {
  realm: string;
  friend: FriendIdentity;
}

export interface DiscoveryLeaderboardRow {
  rank: number;
  name: string;
  firsts: number;
}

export interface DiscoveryLeaderboard {
  realm: string;
  revision: number;
  listed: boolean;
  /** The caller always receives their private rank, listed or not. */
  mine: { rank: number; firsts: number };
  /** Public opt-in rows only. The client never infers missing identities. */
  leaders: DiscoveryLeaderboardRow[];
}

export type FriendPresence = "online" | "offline" | "hidden";

/** The only durable identity fields friendship records need. */
export interface FriendIdentity {
  githubId: number;
  name: string;
}

/** A mutual friend as seen by the authenticated owner. */
export interface FriendView extends FriendIdentity {
  presence: FriendPresence;
  /** Present only when the friend is online, visible and in a v4 realm. */
  realm: string | null;
  /** Present only for a visible mutual friend waiting in the caller's realm. */
  coopWaiting?: FriendCoopWaiting | null;
}

export interface SocialSnapshot {
  visible: boolean;
  friends: FriendView[];
  incoming: FriendIdentity[];
  outgoing: FriendIdentity[];
}

export type RealmPopulationBand = "empty" | "quiet" | "lively" | "busy" | "full";

export interface RealmChoice {
  realm: string;
  band: RealmPopulationBand;
  joinable: boolean;
}

/** One realm's private row, summarized without exposing exact coordinates. */
export interface RealmJourneySummary {
  realm: string;
  discoveries: number;
  helped: number;
  updatedAt: number;
}

export interface SelfDataSummary {
  /** Stable account login remains visible when an old account has no
   * character profile, so the empty self-service view is still attributable. */
  login: string;
  profile: { login: string; name: string; look: number } | null;
  friends: number;
  incoming: number;
  outgoing: number;
  visible: boolean;
  realms: RealmJourneySummary[];
}

/** Coarse population is stable enough to choose a world without publishing
 * an exact live count.  A room at cap is always called full. */
export function populationBand(count: number, cap: number): RealmPopulationBand {
  if (!Number.isFinite(count) || count <= 0) return "empty";
  if (!Number.isFinite(cap) || cap < 1) return "full";
  const n = Math.floor(count);
  const limit = Math.floor(cap);
  if (n >= limit) return "full";
  const ratio = n / limit;
  if (ratio <= 0.25) return "quiet";
  if (ratio <= 0.6) return "lively";
  return "busy";
}

export function parseSocialSnapshot(value: unknown): SocialSnapshot | null {
  if (!record(value) || typeof value.visible !== "boolean") return null;
  const friends = boundedArray(value.friends, SOCIAL_MAX_FRIENDS, parseFriendView);
  const incoming = boundedArray(value.incoming, SOCIAL_MAX_PENDING, parseIdentity);
  const outgoing = boundedArray(value.outgoing, SOCIAL_MAX_PENDING, parseIdentity);
  if (!friends || !incoming || !outgoing) return null;
  return { visible: value.visible, friends, incoming, outgoing };
}

export function parseRealmChoices(value: unknown): RealmChoice[] | null {
  return boundedArray(value, SOCIAL_MAX_WORLD_CHOICES, (row) => {
    if (!record(row) || !realmId(row.realm) || !population(row.band) || typeof row.joinable !== "boolean") return null;
    return { realm: row.realm, band: row.band, joinable: row.joinable };
  });
}

export function parseRealmFeatures(value: unknown): RealmFeatures | null {
  if (!record(value) || !realmId(value.realm)
    || typeof value.coopErrands !== "boolean"
    || (value.coopPartnerFinding !== undefined && typeof value.coopPartnerFinding !== "boolean")
    || typeof value.discoveryLeaderboard !== "boolean"
    || (value.dailyGoals !== undefined && typeof value.dailyGoals !== "boolean")
    || (value.postcards !== undefined && typeof value.postcards !== "boolean")) return null;
  const parsed: RealmFeatures = {
    realm: value.realm,
    coopErrands: value.coopErrands,
    discoveryLeaderboard: value.discoveryLeaderboard,
  };
  if (value.coopPartnerFinding !== undefined) parsed.coopPartnerFinding = value.coopPartnerFinding;
  if (value.dailyGoals !== undefined) parsed.dailyGoals = value.dailyGoals;
  if (value.postcards !== undefined) parsed.postcards = value.postcards;
  return parsed;
}

export function parseCoopErrandSnapshot(value: unknown): CoopErrandSnapshot | null {
  if (!record(value) || !realmId(value.realm)
    || !integer(value.revision, 0, 0xffff_ffff)
    || !coopStatus(value.status)
    || typeof value.cooperative !== "boolean"
    || typeof value.ready !== "boolean"
    || !integer(value.required, 2, SOCIAL_MAX_COOP_REQUIRED)
    || !integer(value.savedReady, 0, value.required)
    || !integer(value.presentReady, 0, value.required)
    || !integer(value.expiresAt, 0, Number.MAX_SAFE_INTEGER)) return null;
  return {
    realm: value.realm,
    revision: value.revision,
    status: value.status,
    cooperative: value.cooperative,
    ready: value.ready,
    savedReady: value.savedReady,
    presentReady: value.presentReady,
    required: value.required,
    expiresAt: value.expiresAt,
  };
}

export function parseCoopBoardSnapshot(value: unknown): CoopBoardSnapshot | null {
  if (!record(value) || !realmId(value.realm)
    || !integer(value.offerRx, -0x8000_0000, 0x7fff_ffff)
    || !integer(value.offerRy, -0x8000_0000, 0x7fff_ffff)
    || !integer(value.required, 2, SOCIAL_MAX_COOP_REQUIRED)
    || !integer(value.waiting, 0, value.required)) return null;
  return {
    realm: value.realm,
    offerRx: value.offerRx,
    offerRy: value.offerRy,
    waiting: value.waiting,
    required: value.required,
  };
}

export function parseCoopFriendWaiting(value: unknown): CoopFriendWaiting | null {
  if (!record(value) || !realmId(value.realm)) return null;
  const friend = parseIdentity(value.friend);
  const waiting = parseFriendCoopWaiting(value);
  return friend && waiting ? { realm: value.realm, friend, ...waiting } : null;
}

export function parseDiscoveryLeaderboard(value: unknown): DiscoveryLeaderboard | null {
  if (!record(value) || !realmId(value.realm)
    || !integer(value.revision, 0, 0xffff_ffff)
    || typeof value.listed !== "boolean"
    || !record(value.mine)
    || !integer(value.mine.rank, 1, Number.MAX_SAFE_INTEGER)
    || !integer(value.mine.firsts, 0, Number.MAX_SAFE_INTEGER)) return null;
  const leaders = boundedArray(value.leaders, SOCIAL_MAX_LEADERBOARD_ROWS, (item) => {
    if (!record(item)
      || !integer(item.rank, 1, Number.MAX_SAFE_INTEGER)
      || !displayName(item.name)
      || !integer(item.firsts, 0, Number.MAX_SAFE_INTEGER)) return null;
    return { rank: item.rank, name: item.name, firsts: item.firsts };
  });
  if (!leaders) return null;
  return {
    realm: value.realm,
    revision: value.revision,
    listed: value.listed,
    mine: { rank: value.mine.rank, firsts: value.mine.firsts },
    leaders,
  };
}

export function parseSelfData(value: unknown): SelfDataSummary | null {
  if (!record(value)) return null;
  let profile: SelfDataSummary["profile"];
  let login: string;
  if (value.profile === null) {
    if (!displayName(value.login)) return null;
    profile = null;
    login = value.login;
  } else {
    if (!record(value.profile)) return null;
    const source = value.profile;
    if (!displayName(source.login) || !displayName(source.name) || !integer(source.look, 0, 63)) return null;
    if (value.login !== undefined && value.login !== source.login) return null;
    login = source.login;
    profile = { login, name: source.name, look: source.look };
  }
  if (!integer(value.friends, 0, SOCIAL_MAX_FRIENDS)
    || !integer(value.incoming, 0, SOCIAL_MAX_PENDING)
    || !integer(value.outgoing, 0, SOCIAL_MAX_PENDING)
    || typeof value.visible !== "boolean") return null;
  const realms = boundedArray(value.realms, SOCIAL_MAX_REALM_HISTORY, (row) => {
    if (!record(row) || !realmId(row.realm)
      || !integer(row.discoveries, 0, 1_000_000)
      || !integer(row.helped, 0, 1_000_000)
      || !integer(row.updatedAt, 0, Number.MAX_SAFE_INTEGER)) return null;
    return {
      realm: row.realm,
      discoveries: row.discoveries,
      helped: row.helped,
      updatedAt: row.updatedAt,
    };
  });
  if (!realms) return null;
  return {
    login,
    profile,
    friends: value.friends,
    incoming: value.incoming,
    outgoing: value.outgoing,
    visible: value.visible,
    realms,
  };
}

function parseIdentity(value: unknown): FriendIdentity | null {
  if (!record(value) || !integer(value.githubId, 1, Number.MAX_SAFE_INTEGER) || !displayName(value.name)) return null;
  return { githubId: value.githubId, name: value.name };
}

function parseFriendView(value: unknown): FriendView | null {
  const identity = parseIdentity(value);
  if (!identity || !record(value) || !presence(value.presence)) return null;
  const realm = value.realm === null ? null : realmId(value.realm) ? value.realm : undefined;
  if (realm === undefined || (value.presence !== "online" && realm !== null)) return null;
  const coopWaiting = value.coopWaiting === undefined || value.coopWaiting === null
    ? null
    : parseFriendCoopWaiting(value.coopWaiting);
  if (value.coopWaiting !== undefined && value.coopWaiting !== null && !coopWaiting) return null;
  if (coopWaiting && (value.presence !== "online" || realm === null)) return null;
  return value.coopWaiting === undefined
    ? { ...identity, presence: value.presence, realm }
    : { ...identity, presence: value.presence, realm, coopWaiting };
}

function parseFriendCoopWaiting(value: unknown): FriendCoopWaiting | null {
  if (!record(value) || !displayText(value.targetTown) || !displayText(value.item)
    || !integer(value.expiresAt, 1, Number.MAX_SAFE_INTEGER)) return null;
  return { targetTown: value.targetTown, item: value.item, expiresAt: value.expiresAt };
}

function boundedArray<T>(value: unknown, cap: number, parse: (item: unknown) => T | null): T[] | null {
  if (!Array.isArray(value) || value.length > cap) return null;
  const out: T[] = [];
  for (const item of value) {
    const parsed = parse(item);
    if (!parsed) return null;
    out.push(parsed);
  }
  return out;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

function displayName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 48;
}

function displayText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 80
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function realmId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(value);
}

function presence(value: unknown): value is FriendPresence {
  return value === "online" || value === "offline" || value === "hidden";
}

function population(value: unknown): value is RealmPopulationBand {
  return value === "empty" || value === "quiet" || value === "lively" || value === "busy" || value === "full";
}

function coopStatus(value: unknown): value is CoopErrandStatus {
  return value === "none" || value === "travel" || value === "waiting" || value === "completed"
    || value === "cancelled" || value === "expired";
}
