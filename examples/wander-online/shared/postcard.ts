// examples/wander-online/shared/postcard.ts — bounded postcard contract.
//
// Postcards are rare JSON controls rather than per-frame world state.  The
// client submits only a preset sentence id and, optionally, coordinates of
// one landmark from its private discovery log.  The authoritative Room
// validates that coordinate and reduces it to a display-only landmark kind
// before Auth stores the card.  Recipient payloads therefore contain no
// sender realm or position and never carry free text.

export const POSTCARD_MAILBOX_CAP = 32;
export const POSTCARD_DAILY_SEND_LIMIT = 5;
export const POSTCARD_TTL_DAYS = 30;
export const POSTCARD_TTL_MS = POSTCARD_TTL_DAYS * 86_400_000;
export const POSTCARD_PROTOCOL_VERSION = 1;

export const POSTCARD_SENTENCE_IDS = [
  "hello",
  "recommend",
  "thanks",
  "memory",
  "cheer",
  "meet-again",
] as const;

export type PostcardSentenceId = typeof POSTCARD_SENTENCE_IDS[number];
export type PostcardLocale = "en" | "zh";

export interface PostcardDraft {
  targetGithubId: number;
  sentenceId: PostcardSentenceId;
  /** Coordinates are request-only proof. They never enter a recipient
   * mailbox response or the persisted postcard body. */
  postmark: { rx: number; ry: number } | null;
}

export interface PostcardMessage {
  id: string;
  senderName: string;
  sentenceId: PostcardSentenceId;
  /** Server-derived landmark kind, never a coordinate or realm id. */
  postmark: string | null;
  sentAt: number;
  expiresAt: number;
  read: boolean;
}

export interface PostcardStatus {
  /** Monotonic per-account mailbox revision. */
  revision: number;
  unread: number;
  total: number;
  dailyRemaining: number;
}

export interface PostcardMailbox extends PostcardStatus {
  postcards: PostcardMessage[];
}

const SENTENCES: Record<PostcardSentenceId, Record<PostcardLocale, string>> = {
  hello: {
    en: "Hello from the road — happy travels!",
    // The bundled 12 px CJK face covers common Han, while punctuation comes
    // from the ASCII face. Keep preset punctuation inside that shared set so
    // every supported host draws the same sentence without replacement boxes.
    zh: "向你问好,祝旅途顺利!",
  },
  recommend: {
    en: "I found a place worth seeing.",
    zh: "我发现了一处值得去看的风景.",
  },
  thanks: {
    en: "Thank you for helping me on our journey!",
    zh: "谢谢你一路上的合作与帮助!",
  },
  memory: {
    en: "I was remembering the roads we shared.",
    zh: "我想起了我们一起走过的路.",
  },
  cheer: {
    en: "May today bring you a new discovery!",
    zh: "愿你今天也有新的发现!",
  },
  "meet-again": {
    en: "I hope our paths cross again soon!",
    zh: "期待不久后在路上再次相见!",
  },
};

const POSTCARD_ID_RE = /^[A-Za-z0-9_-]{8,80}$/;

export function postcardSentenceId(value: unknown): value is PostcardSentenceId {
  return typeof value === "string" && (POSTCARD_SENTENCE_IDS as readonly string[]).includes(value);
}

export function formatPostcardSentence(id: PostcardSentenceId, locale: PostcardLocale): string {
  return SENTENCES[id][locale];
}

/** Strict request parser used on both the client boundary tests and hosted
 * Room. Unknown fields are harmless, but no string supplied by a client can
 * become stored content. */
export function parsePostcardDraft(value: unknown): PostcardDraft | null {
  if (!record(value)
    || !safeInteger(value.targetGithubId, 1, Number.MAX_SAFE_INTEGER)
    || !postcardSentenceId(value.sentenceId)) return null;
  let postmark: PostcardDraft["postmark"];
  if (value.postmark === null) {
    postmark = null;
  } else if (record(value.postmark)
    && int32(value.postmark.rx)
    && int32(value.postmark.ry)) {
    postmark = { rx: value.postmark.rx, ry: value.postmark.ry };
  } else {
    return null;
  }
  return {
    targetGithubId: value.targetGithubId,
    sentenceId: value.sentenceId,
    postmark,
  };
}

export function parsePostcardStatus(value: unknown): PostcardStatus | null {
  if (!record(value)
    || !safeInteger(value.revision, 0, Number.MAX_SAFE_INTEGER)
    || !safeInteger(value.unread, 0, POSTCARD_MAILBOX_CAP)
    || !safeInteger(value.total, 0, POSTCARD_MAILBOX_CAP)
    || value.unread > value.total
    || !safeInteger(value.dailyRemaining, 0, POSTCARD_DAILY_SEND_LIMIT)) return null;
  return {
    revision: value.revision,
    unread: value.unread,
    total: value.total,
    dailyRemaining: value.dailyRemaining,
  };
}

export function parsePostcardMailbox(value: unknown): PostcardMailbox | null {
  const status = parsePostcardStatus(value);
  if (!status || !record(value) || !Array.isArray(value.postcards)
    || value.postcards.length > POSTCARD_MAILBOX_CAP) return null;
  const postcards: PostcardMessage[] = [];
  const ids = new Set<string>();
  let unread = 0;
  for (const candidate of value.postcards) {
    const postcard = parsePostcardMessage(candidate);
    if (!postcard || ids.has(postcard.id)) return null;
    ids.add(postcard.id);
    if (!postcard.read) unread++;
    postcards.push(postcard);
  }
  if (postcards.length !== status.total || unread !== status.unread) return null;
  return { ...status, postcards };
}

export function parsePostcardMessage(value: unknown): PostcardMessage | null {
  if (!record(value)
    || typeof value.id !== "string" || !POSTCARD_ID_RE.test(value.id)
    || !displayText(value.senderName, 48)
    || !postcardSentenceId(value.sentenceId)
    || !(value.postmark === null || displayText(value.postmark, 48))
    || !safeInteger(value.sentAt, 0, Number.MAX_SAFE_INTEGER)
    || !safeInteger(value.expiresAt, value.sentAt + 1, Number.MAX_SAFE_INTEGER)
    || typeof value.read !== "boolean") return null;
  return {
    id: value.id,
    senderName: value.senderName,
    sentenceId: value.sentenceId,
    postmark: value.postmark,
    sentAt: value.sentAt,
    expiresAt: value.expiresAt,
    read: value.read,
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

function int32(value: unknown): value is number {
  return safeInteger(value, -0x8000_0000, 0x7fff_ffff);
}

function displayText(value: unknown, maxCodeUnits: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxCodeUnits
    && !/[\u0000-\u001f\u007f]/.test(value);
}
