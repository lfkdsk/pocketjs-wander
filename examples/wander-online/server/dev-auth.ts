// examples/wander-online/server/dev-auth.ts — the local Bun server's auth,
// mirroring the Worker's AuthDO contract with in-memory storage. The hosted
// Worker (pocket-online-server) is the real implementation; this exists so
// the loopback server and the sim tests can exercise the full auth flow
// (GitHub exchange, tickets, profiles, link codes) without Cloudflare.
//
// The GitHub API base is configurable (--github-api) so tests point it at a
// fake endpoint; the default is the real api.github.com.

import {
  AUTH_RATE_PER_MIN,
  LINK_CODE_TTL_SEC,
  MAX_SESSIONS_PER_ACCOUNT,
  linkCodeFresh,
  newLinkCode,
  validateLook,
  validateName,
} from "../shared/auth.ts";
import { TicketSigner } from "../shared/ticket-signer.ts";
import { SlidingWindow } from "../shared/limits.ts";

export interface DevProfile {
  name: string;
  look: number;
}

interface DevAccount {
  login: string;
  version: number;
  profile: (DevProfile & { createdAt: number; lastSeenAt: number }) | null;
}

interface DevSession {
  room: string;
  sid: string;
  at: number;
}

export interface DevJoinResult {
  ok: boolean;
  needCreate?: boolean;
  login?: string;
  ticket?: string;
  profile?: DevProfile;
  githubId?: number;
  reason?: string;
  kick?: { room: string; sid: string } | null;
}

/** The local-dev auth: one in-memory account store, one ephemeral signer.
 *  The signer is random per process, so tickets don't survive a restart —
 *  fine for local dev (the Worker persists its key in DO storage). */
export class DevAuth {
  private readonly accounts = new Map<number, DevAccount>();
  private readonly sessions = new Map<number, DevSession[]>();
  private readonly links = new Map<string, { githubId: number; issuedAt: number }>();
  private readonly limiters = new Map<string, SlidingWindow>();
  private readonly signer: TicketSigner;
  private nextId = 1000;

  private constructor(
    signer: TicketSigner,
    private readonly githubApiBase: string,
    private readonly now: () => number,
  ) {
    this.signer = signer;
  }

  static async create(githubApiBase = "https://api.github.com", now: () => number = () => Date.now()): Promise<DevAuth> {
    return new DevAuth(await TicketSigner.generate(), githubApiBase, now);
  }

  private nowSec(): number {
    return Math.floor(this.now() / 1000);
  }

  private limiter(ip: string): SlidingWindow {
    let w = this.limiters.get(ip);
    if (!w) {
      w = new SlidingWindow(AUTH_RATE_PER_MIN, 60_000, this.now);
      this.limiters.set(ip, w);
    }
    return w;
  }

  /** Exchange a GitHub token for the user id/login. The token is used for
   *  this one request and discarded. */
  private async fetchGithubUser(token: string): Promise<{ id: number; login: string } | null> {
    let res: Response;
    try {
      res = await fetch(`${this.githubApiBase}/user`, {
        headers: {
          "Authorization": `Bearer ${token}`,
          "User-Agent": "wander-online-dev",
          "Accept": "application/vnd.github+json",
        },
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      return null;
    }
    if (!res.ok) return null;
    const data = (await res.json().catch(() => null)) as { id?: unknown; login?: unknown } | null;
    if (!data || typeof data.id !== "number" || typeof data.login !== "string") return null;
    return { id: Math.floor(data.id), login: data.login };
  }

  /** The JOIN admission path: exchange a GitHub token or verify a ticket,
   *  then either ask for character creation or register a session. */
  async join(kind: "github" | "ticket", credential: string, room: string, sid: string, ip: string): Promise<DevJoinResult> {
    let githubId: number;
    let login: string;
    let ticket: string;
    let acct: DevAccount | undefined;

    if (kind === "github") {
      if (!ip || !this.limiter(ip).hit()) return { ok: false, reason: "rate" };
      const user = await this.fetchGithubUser(credential);
      if (!user) return { ok: false, reason: "ghauth" };
      githubId = user.id;
      login = user.login;
      acct = this.accounts.get(githubId);
      if (!acct) {
        acct = { login, version: 1, profile: null };
        this.accounts.set(githubId, acct);
      } else {
        acct.login = login;
      }
      ticket = await this.signer.issue(githubId, acct.version, this.nowSec());
    } else {
      const claims = await this.signer.verify(credential, this.nowSec());
      if (!claims) return { ok: false, reason: "ticket" };
      githubId = claims.githubId;
      acct = this.accounts.get(githubId);
      if (!acct || acct.version !== claims.version) return { ok: false, reason: "ticket" };
      login = acct.login;
      ticket = credential;
    }

    if (!acct.profile) {
      return { ok: true, needCreate: true, login, ticket };
    }

    // Session cap: kick the oldest when full.
    const list = this.sessions.get(githubId) ?? [];
    let kick: DevSession | null = null;
    if (list.length >= MAX_SESSIONS_PER_ACCOUNT) {
      kick = list.reduce((a, b) => (a.at <= b.at ? a : b));
    }
    const kept = kick ? list.filter((s) => s !== kick) : list;
    this.sessions.set(githubId, [...kept, { room, sid, at: this.now() }]);
    acct.profile.lastSeenAt = this.nowSec();
    return {
      ok: true,
      ticket,
      login,
      githubId,
      profile: { name: acct.profile.name, look: acct.profile.look },
      kick: kick ? { room: kick.room, sid: kick.sid } : null,
    };
  }

  /** Create the profile for a ticket's account. */
  async create(ticket: string, name: string, look: unknown): Promise<{ ok: boolean; profile?: DevProfile; reason?: string }> {
    const claims = await this.signer.verify(ticket, this.nowSec());
    if (!claims) return { ok: false, reason: "ticket" };
    const acct = this.accounts.get(claims.githubId);
    if (!acct || acct.version !== claims.version) return { ok: false, reason: "ticket" };
    const trimmed = name.trim();
    const nameErr = validateName(trimmed);
    if (nameErr) return { ok: false, reason: nameErr };
    if (!validateLook(look)) return { ok: false, reason: "look" };
    const now = this.nowSec();
    acct.profile = { name: trimmed, look: look as number, createdAt: acct.profile?.createdAt ?? now, lastSeenAt: now };
    return { ok: true, profile: { name: trimmed, look: look as number } };
  }

  /** Delete the profile and bump the version (kills old tickets). */
  async deleteProfile(ticket: string): Promise<boolean> {
    const claims = await this.signer.verify(ticket, this.nowSec());
    if (!claims) return false;
    const acct = this.accounts.get(claims.githubId);
    if (!acct || acct.version !== claims.version) return false;
    acct.profile = null;
    acct.version++;
    this.sessions.delete(claims.githubId);
    return true;
  }

  /** Issue a one-time link code for a signed-in account. */
  async linkIssue(ticket: string): Promise<{ ok: boolean; code?: string; expiresIn?: number; reason?: string }> {
    const claims = await this.signer.verify(ticket, this.nowSec());
    if (!claims) return { ok: false, reason: "ticket" };
    const acct = this.accounts.get(claims.githubId);
    if (!acct || acct.version !== claims.version || !acct.profile) return { ok: false, reason: "ticket" };
    const code = newLinkCode(() => Math.random());
    this.links.set(code, { githubId: claims.githubId, issuedAt: this.nowSec() });
    return { ok: true, code, expiresIn: LINK_CODE_TTL_SEC };
  }

  /** Redeem a link code for a ticket. One-time. */
  async linkRedeem(code: string, ip: string): Promise<{ ok: boolean; ticket?: string; hasProfile?: boolean; login?: string; reason?: string }> {
    if (!ip || !this.limiter(ip).hit()) return { ok: false, reason: "link-rate" };
    if (!/^\d{6}$/.test(code)) return { ok: false, reason: "link-bad-code" };
    const rec = this.links.get(code);
    this.links.delete(code);
    if (!rec) return { ok: false, reason: "link-bad-code" };
    if (!linkCodeFresh(rec.issuedAt, this.nowSec())) return { ok: false, reason: "link-expired" };
    const acct = this.accounts.get(rec.githubId);
    if (!acct) return { ok: false, reason: "link-bad-code" };
    const ticket = await this.signer.issue(rec.githubId, acct.version, this.nowSec());
    return { ok: true, ticket, hasProfile: acct.profile !== null, login: acct.login };
  }

  /** Drop one session (a socket closed). */
  sessionRelease(githubId: number, room: string, sid: string): void {
    const list = this.sessions.get(githubId);
    if (!list) return;
    this.sessions.set(githubId, list.filter((s) => !(s.room === room && s.sid === sid)));
  }
}
