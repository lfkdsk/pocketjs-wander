// examples/wander-online/shared/auth.ts — the account/auth wire contract and
// its pure logic, shared by the Cloudflare Worker (server repo), the local
// Bun server, the bots and the client. No node:*, no clock reads: every
// time-dependent function takes `now` so the Bun tests run under a fake
// clock and the Worker passes Date.now.
//
// Accounts are GitHub identities. The client presents a GitHub OAuth token
// exactly once (in the first JOIN); the server exchanges it for the GitHub
// user id, discards the token, and issues its own HMAC session ticket. The
// ticket is what every later JOIN carries; it is stored client-side (browser
// storage on web, the save directory on desktop) and never logged.
//
//   ticket = `${githubId}.${version}.${expiry}.<hmac-b64url>`
//
// `version` is the account's profile version, bumped on profile deletion, so
// deleting a profile invalidates every outstanding ticket at once.
//
// Close-reason tokens added here (WebSocket close 1008):
//   "version"  the JOIN predates the auth protocol (no/old "v")
//   "auth"     the JOIN carried neither a ticket nor a GitHub token
//   "ghauth"   the GitHub exchange failed (401, timeout, ...)
//   "ticket"   the ticket is malformed, expired, tampered or version-stale
//   "taken"    a newer session for this account replaced this one
//   "rate"     (existing) auth attempts per IP exceeded
//
// Text replies on an unjoined socket (the socket stays open so the client
// can correct and retry):
//   {"type":"needCreate","login":string,"ticket":string}
//   {"type":"ready","ticket":string}
//   {"type":"createError","reason":NameError}
//   {"type":"linkCode","code":string,"expiresIn":number}
//   {"type":"linkError","reason":LinkError}
//   {"type":"linked","ticket":string,"hasProfile":boolean}
//   {"type":"deleted"}
//   {"type":"deleteError","reason":string}  (the delete was refused or could
//          not be confirmed; the client stays signed in and shows why)

import { CLOSE_REASON } from "./limits.ts";

export const AUTH_CLOSE_REASON = {
  version: "version",
  auth: "auth",
  ghauth: "ghauth",
  ticket: "ticket",
  taken: "taken",
} as const;

/** All close tokens a hosted server may send (the admission ones plus the
 *  auth ones), for the client's rejection table. */
export const ALL_CLOSE_REASONS = {
  ...CLOSE_REASON,
  ...AUTH_CLOSE_REASON,
} as const;

/** The JOIN wire version this module speaks. A JOIN without a matching "v"
 *  is refused with 1008 "version" — an old client gets a clear reason, not a
 *  garbled close. */
export const AUTH_PROTOCOL_VERSION = 3;

/** Ticket lifetime: 30 days. */
export const TICKET_TTL_SEC = 30 * 24 * 3600;

/** Device-link code lifetime: 5 minutes. */
export const LINK_CODE_TTL_SEC = 5 * 60;

/** Auth attempts (GitHub exchanges, link-code issue/redeem) allowed per IP
 *  per minute. Best-effort: the limiter lives in the Auth DO's memory, so an
 *  eviction resets it (under-counts, never blocks a legitimate user). */
export const AUTH_RATE_PER_MIN = 10;

/** Concurrent sessions per GitHub account. The oldest is kicked (1008
 *  "taken") when a newer one arrives. */
export const MAX_SESSIONS_PER_ACCOUNT = 2;

/** Chosen-name limits. */
export const NAME_MAX = 12;
export const NAME_MIN = 1;

/** The look pool size (examples/wander/looks.ts LOOK_COUNT). Duplicated as a
 *  number so this module stays import-free of the wander example. */
export const LOOK_COUNT = 64;

// --- Profile validation --------------------------------------------------------

export type NameError =
  | "name-empty"
  | "name-too-long"
  | "name-charset"
  | "name-blocked";

/** Letters and numbers (any script, so CJK names pass), plus a small set of
 *  harmless separators. Everything else — control chars, emoji, combining
 *  marks, confusables — is refused. */
const NAME_CHARSET = /^[\p{L}\p{N} _.-]+$/u;

/** A small, deliberately crude blocklist (lowercase substring match). It is
 *  not a moderation system; it keeps the worst slurs and impersonation bait
 *  off other players' screens. Extend freely. */
export const NAME_BLOCKLIST: readonly string[] = [
  "admin",
  "root",
  "system",
  "moderator",
  "nigger",
  "faggot",
  "kys",
  "hitler",
  "stalin",
];

/** Validate a chosen display name. Returns the error code, or null when the
 *  name is acceptable. Length is by code point, so a CJK name counts the
 *  same as a Latin one. */
export function validateName(raw: string): NameError | null {
  if (typeof raw !== "string") return "name-empty";
  const name = Array.from(raw.trim());
  if (name.length < NAME_MIN) return "name-empty";
  if (name.length > NAME_MAX) return "name-too-long";
  const joined = name.join("");
  if (!NAME_CHARSET.test(joined)) return "name-charset";
  const lower = joined.toLowerCase();
  for (const bad of NAME_BLOCKLIST) {
    if (lower.includes(bad)) return "name-blocked";
  }
  return null;
}

/** Validate a look id against the W-CHAR pool. */
export function validateLook(look: unknown): boolean {
  return typeof look === "number" && Number.isInteger(look) && look >= 0 && look < LOOK_COUNT;
}

// --- Device-link codes ----------------------------------------------------------

export type LinkError = "link-bad-code" | "link-expired" | "link-used" | "link-rate";

/** Generate a 6-digit one-time link code from a random source. */
export function newLinkCode(rand: () => number): string {
  let s = "";
  for (let i = 0; i < 6; i++) s += Math.floor(rand() * 10).toString();
  return s;
}

/** Whether a link code issued at `issuedAt` (unix seconds) is still
 *  redeemable at `now`. */
export function linkCodeFresh(issuedAt: number, now: number, ttlSec = LINK_CODE_TTL_SEC): boolean {
  return now - issuedAt < ttlSec;
}

/** Seconds a code issued at `issuedAt` has left at `now` (0 when expired). */
export function linkCodeTtl(issuedAt: number, now: number, ttlSec = LINK_CODE_TTL_SEC): number {
  return Math.max(0, ttlSec - (now - issuedAt));
}
