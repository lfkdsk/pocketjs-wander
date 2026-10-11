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
  profile: { login: string; name: string; look: number };
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
  return boundedArray(value, 16, (row) => {
    if (!record(row) || !realmId(row.realm) || !population(row.band) || typeof row.joinable !== "boolean") return null;
    return { realm: row.realm, band: row.band, joinable: row.joinable };
  });
}

export function parseSelfData(value: unknown): SelfDataSummary | null {
  if (!record(value) || !record(value.profile)) return null;
  const profile = value.profile;
  if (typeof profile.login !== "string" || !displayName(profile.name) || !integer(profile.look, 0, 63)) return null;
  if (!integer(value.friends, 0, SOCIAL_MAX_FRIENDS)
    || !integer(value.incoming, 0, SOCIAL_MAX_PENDING)
    || !integer(value.outgoing, 0, SOCIAL_MAX_PENDING)
    || typeof value.visible !== "boolean") return null;
  const realms = boundedArray(value.realms, 16, (row) => {
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
    profile: { login: profile.login, name: profile.name, look: profile.look },
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
  return { ...identity, presence: value.presence, realm };
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

function realmId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(value);
}

function presence(value: unknown): value is FriendPresence {
  return value === "online" || value === "offline" || value === "hidden";
}

function population(value: unknown): value is RealmPopulationBand {
  return value === "empty" || value === "quiet" || value === "lively" || value === "busy" || value === "full";
}
