// examples/wander-online/shared/limits.ts — the hosted server's admission
// and abuse limits, as pure logic shared by the Cloudflare Worker (server
// repo) and its Bun tests. No node:*, no clock reads: every class takes
// `now` so tests run under a fake clock and the Worker passes Date.now.
//
// Close-reason tokens used on rejection (WebSocket close 1008):
//   "origin"  Origin header not on the whitelist
//   "rest"    monthly budget circuit breaker is open
//   "ip"      this IP already holds IP_CONCURRENCY connections
//   "full"    every room is at ROOM_CAP
//   "rate"    inbound message rate/size limit exceeded
//   "idle"    joined player sent nothing for IDLE_TIMEOUT_SEC

export const CLOSE_REASON = {
  origin: "origin",
  rest: "rest",
  ip: "ip",
  full: "full",
  rate: "rate",
  idle: "idle",
} as const;

export type CloseReason = (typeof CLOSE_REASON)[keyof typeof CLOSE_REASON];

// --- Origin whitelist -------------------------------------------------------

export interface OriginPolicy {
  /** The deployed Pages origin, e.g. "https://lfkdsk.github.io". Matched
   *  exactly (an optional trailing slash is tolerated). */
  pagesOrigin: string;
  /** Loopback origins (http://127.0.0.1:*, http://localhost:*, http://[::1]:*)
   *  are allowed for local development. */
  allowLoopback: boolean;
}

/** Whether a WebSocket upgrade's Origin header may proceed. A MISSING
 *  Origin (native desktop clients send none) is allowed; browser pages
 *  always send one. */
export function checkOrigin(origin: string | null | undefined, policy: OriginPolicy): boolean {
  if (!origin) return true;
  const o = origin.endsWith("/") ? origin.slice(0, -1) : origin;
  if (o === policy.pagesOrigin) return true;
  if (policy.allowLoopback && isLoopbackOrigin(o)) return true;
  return false;
}

function isLoopbackOrigin(origin: string): boolean {
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  if (u.protocol !== "http:") return false;
  const host = u.hostname;
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
}

// --- Sliding-window rate limit ----------------------------------------------

/** Per-connection inbound message limiter: at most `limit` hits in any
 *  rolling `windowMs`. O(limit) memory, O(1) amortised per hit (old
 *  timestamps are pruned on every hit). */
export class SlidingWindow {
  private readonly times: number[] = [];
  constructor(
    readonly limit: number,
    readonly windowMs: number,
    private readonly now: () => number,
  ) {}

  /** Record one message; false when the window is already full. */
  hit(): boolean {
    const t = this.now();
    const cutoff = t - this.windowMs;
    while (this.times.length > 0 && this.times[0]! <= cutoff) this.times.shift();
    if (this.times.length >= this.limit) return false;
    this.times.push(t);
    return true;
  }

  /** Hits currently inside the window (tests/stats). */
  get size(): number {
    const cutoff = this.now() - this.windowMs;
    while (this.times.length > 0 && this.times[0]! <= cutoff) this.times.shift();
    return this.times.length;
  }
}

// --- Room selection ----------------------------------------------------------

/** Least-loaded admission: index of the room with the most free slots
 *  (ties: lowest index), or -1 when every room is at its cap. */
export function pickLeastLoaded(counts: readonly number[], cap: number): number {
  let best = -1;
  for (let i = 0; i < counts.length; i++) {
    if (counts[i]! >= cap) continue;
    if (best < 0 || counts[i]! < counts[best]!) best = i;
  }
  return best;
}

// --- Per-IP connection accounting --------------------------------------------

/** Best-effort concurrent-connection count per IP. The Worker keeps this
 *  in the Meter Durable Object (durable storage), so an eviction cannot
 *  raise the cap; it can only reset counts, which under-counts. */
export class IpCounter {
  private readonly counts = new Map<string, number>();

  /** Try to acquire one connection slot for `ip`. False when the IP is
   *  already at `max` (the slot is NOT acquired). */
  acquire(ip: string, max: number): boolean {
    const n = this.counts.get(ip) ?? 0;
    if (n >= max) return false;
    this.counts.set(ip, n + 1);
    return true;
  }

  /** Release one slot (a socket closed). No-op below zero. */
  release(ip: string): void {
    const n = this.counts.get(ip) ?? 0;
    if (n <= 1) this.counts.delete(ip);
    else this.counts.set(ip, n - 1);
  }

  count(ip: string): number {
    return this.counts.get(ip) ?? 0;
  }

  /** Distinct IPs currently holding slots (Meter persistence). */
  get size(): number {
    return this.counts.size;
  }

  /** Snapshot for durable storage / restoration. */
  toJSON(): Record<string, number> {
    return Object.fromEntries(this.counts);
  }

  static fromJSON(json: unknown): IpCounter {
    const c = new IpCounter();
    if (json && typeof json === "object") {
      for (const [ip, n] of Object.entries(json as Record<string, unknown>)) {
        if (typeof n === "number" && n > 0) c.counts.set(ip, Math.floor(n));
      }
    }
    return c;
  }
}

// --- Idle tracking -------------------------------------------------------------

/** Last-activity timestamps per joined player; the Room DO's tick calls
 *  takeExpired() to find players to kick. */
export class IdleTracker {
  private readonly last = new Map<number, number>();
  constructor(private readonly now: () => number) {}

  touch(id: number): void {
    this.last.set(id, this.now());
  }

  forget(id: number): void {
    this.last.delete(id);
  }

  /** Ids idle for at least `timeoutMs`, removed from the tracker. */
  takeExpired(timeoutMs: number): number[] {
    const cutoff = this.now() - timeoutMs;
    const out: number[] = [];
    for (const [id, t] of this.last) {
      if (t <= cutoff) {
        out.push(id);
        this.last.delete(id);
      }
    }
    return out;
  }

  get size(): number {
    return this.last.size;
  }
}
