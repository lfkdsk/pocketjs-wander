// examples/wander-online/shared/profile.ts — the bounded, server-derived
// player-card contract shared by the client, loopback tests and hosted Room.
//
// Achievement ids and thresholds are public presentation data. The client may
// render them, but only the hosted server derives earned ids from durable
// journey/realm facts and persists the one-shot unlock set.

export const PROFILE_MAX_ACHIEVEMENTS = 15;
export const PROFILE_MAX_POSTMARKS = 16;

export type ProfileLocale = "en" | "zh";
export type AchievementStat =
  | "completedErrands"
  | "landmarksSeen"
  | "landmarkFirsts"
  | "dailyContributionDays"
  | "realmsVisited";

export interface ProfileFacts {
  completedErrands: number;
  landmarksSeen: number;
  landmarkFirsts: number;
  dailyContributionDays: number;
  realmsVisited: number;
}

export interface AchievementDefinition {
  id: string;
  stat: AchievementStat;
  threshold: number;
  tier: 1 | 2 | 3;
  name: Record<ProfileLocale, string>;
  description: Record<ProfileLocale, string>;
}

/** Copy follows Wander's town-generator voice: roads remember footsteps,
 * errands end in flowers, and discoveries prove old stories true. */
export const ACHIEVEMENTS = [
  achievement("errands-1", "completedErrands", 1, 1,
    "First Bloom", "初绽善意", "One errand ended in bloom.", "一次差事在花开中完成。"),
  achievement("errands-5", "completedErrands", 5, 2,
    "Roadside Kindness", "路边善举", "Five towns keep your kindness in flower.", "五座城镇让你的善意化作花朵。"),
  achievement("errands-25", "completedErrands", 25, 3,
    "A Road Remembered", "道路铭记", "Twenty-five plazas remember your footsteps.", "二十五座广场记得你的脚步。"),
  achievement("sightings-1", "landmarksSeen", 1, 1,
    "Eyes on the Horizon", "眺望远方", "One hidden place entered your travel log.", "一处秘境进入了旅行日志。"),
  achievement("sightings-10", "landmarksSeen", 10, 2,
    "Rumor Walker", "传闻行者", "Ten landmarks proved the old stories true.", "十处地标印证了古老传说。"),
  achievement("sightings-50", "landmarksSeen", 50, 3,
    "No Map Needed", "无需地图", "Fifty wild places now have names in your memory.", "五十处荒野风景已留在记忆中。"),
  achievement("firsts-1", "landmarkFirsts", 1, 1,
    "First Footprints", "最初足迹", "You reached one landmark before any traveler.", "你比所有旅人更早到达一处地标。"),
  achievement("firsts-5", "landmarkFirsts", 5, 2,
    "Pathfinder", "开路者", "Five landmarks remember your name first.", "五处地标首先记住了你的名字。"),
  achievement("firsts-20", "landmarkFirsts", 20, 3,
    "Before the Map", "地图之前", "Twenty landmarks began with your footsteps.", "二十处地标从你的脚步开始。"),
  achievement("shared-days-1", "dailyContributionDays", 1, 1,
    "Shared Morning", "共同清晨", "You lent one day to a realm-wide promise.", "你为整个世界的约定贡献了一天。"),
  achievement("shared-days-7", "dailyContributionDays", 7, 2,
    "Week of Hands", "携手一周", "Seven days carried the road together.", "七天里，大家一同让道路延伸。"),
  achievement("shared-days-30", "dailyContributionDays", 30, 3,
    "Common Season", "共筑一季", "Thirty recorded days of shared work changed the world.", "三十个有记录的共同目标日改变了世界。"),
  achievement("realms-2", "realmsVisited", 2, 1,
    "Across the Gate", "越过门扉", "Your road crossed into two realms.", "你的道路跨进了两个世界。"),
  achievement("realms-3", "realmsVisited", 3, 2,
    "Many Horizons", "多重天际", "Three realms have kept a place for you.", "三个世界为你留下了位置。"),
  achievement("realms-4", "realmsVisited", 4, 3,
    "World Walker", "世界行者", "Four realms remember your arrival.", "四个世界记得你的到来。"),
] as const satisfies readonly AchievementDefinition[];

export type AchievementId = (typeof ACHIEVEMENTS)[number]["id"];

const ACHIEVEMENT_BY_ID = new Map<string, AchievementDefinition>(
  ACHIEVEMENTS.map((item) => [item.id, item]),
);

export interface PlayerProfileCard {
  name: string;
  look: number;
  /** Account profile creation time, Unix seconds. */
  joinedAt: number;
  achievements: AchievementId[];
  showcasePostmark: string | null;
  /** Owner-only choices; friend cards deliberately carry an empty array. */
  postmarkOptions: string[];
}

export interface ProfileSnapshot {
  self: boolean;
  card: PlayerProfileCard;
  /** Newly persisted unlocks for this owner request only. */
  newAchievements: AchievementId[];
}

export function deriveAchievementIds(facts: ProfileFacts): AchievementId[] {
  const clean = parseProfileFacts(facts);
  if (!clean) return [];
  return ACHIEVEMENTS
    .filter((item) => clean[item.stat] >= item.threshold)
    .map((item) => item.id);
}

export function achievementDefinition(id: unknown): AchievementDefinition | null {
  return typeof id === "string" ? ACHIEVEMENT_BY_ID.get(id) ?? null : null;
}

export function achievementCopy(
  id: AchievementId,
  locale: ProfileLocale,
): { name: string; description: string } {
  const item = ACHIEVEMENT_BY_ID.get(id)!;
  return { name: item.name[locale], description: item.description[locale] };
}

export function parseProfileFacts(value: unknown): ProfileFacts | null {
  if (!record(value)) return null;
  const completedErrands = count(value.completedErrands);
  const landmarksSeen = count(value.landmarksSeen);
  const landmarkFirsts = count(value.landmarkFirsts);
  const dailyContributionDays = count(value.dailyContributionDays);
  const realmsVisited = count(value.realmsVisited);
  if (completedErrands === null || landmarksSeen === null || landmarkFirsts === null
    || dailyContributionDays === null || realmsVisited === null) return null;
  return { completedErrands, landmarksSeen, landmarkFirsts, dailyContributionDays, realmsVisited };
}

export function parseProfileSnapshot(value: unknown): ProfileSnapshot | null {
  if (!record(value) || typeof value.self !== "boolean" || !record(value.card)) return null;
  const card = value.card;
  if (!displayText(card.name, 48) || !integer(card.look, 0, 63)
    || !integer(card.joinedAt, 0, Number.MAX_SAFE_INTEGER)) return null;
  const achievements = achievementIds(card.achievements);
  const newAchievements = achievementIds(value.newAchievements);
  if (!achievements || !newAchievements || newAchievements.some((id) => !achievements.includes(id))) return null;
  const showcasePostmark = card.showcasePostmark === null
    ? null
    : displayText(card.showcasePostmark, 80) ? card.showcasePostmark : undefined;
  if (showcasePostmark === undefined) return null;
  const postmarkOptions = boundedUniqueText(card.postmarkOptions, PROFILE_MAX_POSTMARKS, 80);
  if (!postmarkOptions || (!value.self && postmarkOptions.length > 0)
    || (showcasePostmark !== null && value.self && !postmarkOptions.includes(showcasePostmark))) return null;
  if (!value.self && newAchievements.length > 0) return null;
  return {
    self: value.self,
    card: {
      name: card.name,
      look: card.look,
      joinedAt: card.joinedAt,
      achievements,
      showcasePostmark,
      postmarkOptions,
    },
    newAchievements,
  };
}

/** Stable UTC date: identical on QuickJS, browsers and Bun. */
export function joinedDate(joinedAt: number): string {
  if (!integer(joinedAt, 0, Number.MAX_SAFE_INTEGER)) return "---- -- --";
  const date = new Date(joinedAt * 1000);
  const year = String(date.getUTCFullYear()).padStart(4, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function achievement(
  id: string,
  stat: AchievementStat,
  threshold: number,
  tier: 1 | 2 | 3,
  enName: string,
  zhName: string,
  enDescription: string,
  zhDescription: string,
): AchievementDefinition {
  return {
    id,
    stat,
    threshold,
    tier,
    name: { en: enName, zh: zhName },
    description: { en: enDescription, zh: zhDescription },
  };
}

function achievementIds(value: unknown): AchievementId[] | null {
  if (!Array.isArray(value) || value.length > PROFILE_MAX_ACHIEVEMENTS) return null;
  const out: AchievementId[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || seen.has(item) || !ACHIEVEMENT_BY_ID.has(item)) return null;
    seen.add(item);
    out.push(item as AchievementId);
  }
  return out;
}

function boundedUniqueText(value: unknown, cap: number, maxLength: number): string[] | null {
  if (!Array.isArray(value) || value.length > cap) return null;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!displayText(item, maxLength) || seen.has(item)) return null;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function count(value: unknown): number | null {
  return integer(value, 0, 1_000_000) ? value : null;
}

function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

function displayText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
