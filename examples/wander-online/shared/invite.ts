// examples/wander-online/shared/invite.ts — realm invites, the pure part,
// shared by the client, the local Bun server and the hosted Room DO. No
// node:*, no clock reads.
//
// An invite is a short random code the realm's server mints for a joined
// player and remembers for INVITE_TTL_SEC. The shareable token is
// `<realmId>.<CODE>`: the realm name routes the invitee's upgrade to the
// right room, the code proves the invite. It contains no account, name or
// position; the server stores only the code and its expiry. A client joins
// with `?realm=<realmId>&invite=<CODE>` on the v4 endpoint and the server
// answers one of three ways: admission into that realm, 1008 "full" (the
// realm is at its cap: say so, never split friends silently) or 1008
// "invite" (unknown or expired code).
//
// A realm pin without an invite (`?realm=` alone) is how a reconnecting
// player returns to the realm it was in: the server honours it the same
// way, minus the code check.

/** How long an invite can be redeemed. */
export const INVITE_TTL_SEC = 60 * 60;
/** Codes alive per realm; issuing beyond this evicts the oldest. */
export const INVITE_MAX_LIVE = 64;
/** Invites one player may mint per minute. */
export const INVITE_ISSUE_PER_MIN = 3;
export const INVITE_CODE_LEN = 8;
/** Crockford-like alphabet without the confusable I, L, O, U, 0 and 1. */
export const INVITE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";

/** Close-reason tokens (WebSocket 1008) for pinned-realm admission. */
export const REALM_CLOSE_REASON = {
  /** The invite code is unknown, expired or malformed. */
  invite: "invite",
  /** The pinned realm is not a realm this service runs. */
  realm: "realm",
} as const;

export type InviteError = "invite-rate" | "invite-unavailable";

export function newInviteCode(rand: () => number): string {
  let s = "";
  for (let i = 0; i < INVITE_CODE_LEN; i++) {
    s += INVITE_ALPHABET[Math.min(INVITE_ALPHABET.length - 1, Math.floor(rand() * INVITE_ALPHABET.length))]!;
  }
  return s;
}

export function inviteCodeWellFormed(code: string): boolean {
  if (typeof code !== "string" || code.length !== INVITE_CODE_LEN) return false;
  for (let i = 0; i < code.length; i++) if (INVITE_ALPHABET.indexOf(code[i]!) < 0) return false;
  return true;
}

/** Realm ids are the configured room names: short ASCII words with dashes. */
export function realmIdWellFormed(realm: string): boolean {
  return typeof realm === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(realm);
}

export function formatInviteToken(realm: string, code: string): string {
  return `${realm}.${code}`;
}

/** Split a shareable token into its realm and code, or null when malformed. */
export function parseInviteToken(token: string): { realm: string; code: string } | null {
  if (typeof token !== "string") return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const realm = token.slice(0, dot);
  const code = token.slice(dot + 1).toUpperCase();
  if (!realmIdWellFormed(realm) || !inviteCodeWellFormed(code)) return null;
  return { realm, code };
}

/** Whether an invite issued to expire at `expiresAtMs` is still live. */
export function inviteLive(expiresAtMs: number, nowMs: number): boolean {
  return nowMs < expiresAtMs;
}

/** The v4 endpoint with the realm pin and invite as query parameters. No
 *  URL global: the desktop guest runs on QuickJS. */
export function realmJoinUrl(url: string, realm: string | null, invite: string | null): string {
  if (!realm) return url;
  const sep = url.indexOf("?") >= 0 ? "&" : "?";
  const query = `realm=${encodeURIComponent(realm)}${invite ? `&invite=${encodeURIComponent(invite)}` : ""}`;
  return `${url}${sep}${query}`;
}

/** Bounded in-memory invite table: one per realm server. Pure apart from
 *  the clock and random source the host injects. */
export class InviteTable {
  private readonly codes = new Map<string, number>();

  constructor(
    private readonly now: () => number,
    private readonly rand: () => number,
    private readonly ttlMs = INVITE_TTL_SEC * 1000,
    private readonly maxLive = INVITE_MAX_LIVE,
  ) {}

  /** Mint a code; expired codes are dropped and the oldest evicted at cap. */
  issue(): { code: string; expiresAtMs: number } {
    const nowMs = this.now();
    for (const [code, exp] of this.codes) if (!inviteLive(exp, nowMs)) this.codes.delete(code);
    while (this.codes.size >= this.maxLive) this.codes.delete(this.codes.keys().next().value!);
    let code = newInviteCode(this.rand);
    let guard = 0;
    while (this.codes.has(code) && ++guard < 16) code = newInviteCode(this.rand);
    const expiresAtMs = nowMs + this.ttlMs;
    this.codes.set(code, expiresAtMs);
    return { code, expiresAtMs };
  }

  /** Whether a code is live now. Redeeming never consumes it: one link may
   *  bring several friends until it expires. */
  valid(code: string): boolean {
    if (!inviteCodeWellFormed(code)) return false;
    const exp = this.codes.get(code);
    return exp !== undefined && inviteLive(exp, this.now());
  }

  get size(): number {
    return this.codes.size;
  }
}
