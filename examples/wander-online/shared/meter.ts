// examples/wander-online/shared/meter.ts — the monthly budget circuit
// breaker, as pure logic shared by the Meter Durable Object (server repo)
// and its Bun tests. No node:*, no clock reads: callers pass `now` and the
// Meter DO persists the plain ledger object.
//
// Billing follows the Cloudflare Workers pricing model
// (https://developers.cloudflare.com/workers/platform/pricing/):
//   - inbound WebSocket messages count as requests 20:1
//     (Cloudflare bills WebSocket messages against the request quota at
//     that ratio); each WebSocket upgrade is itself one request;
//   - wall-clock duration is billed in GB-seconds: the Worker's 128 MB
//     memory times awake seconds, i.e. 128/1024 = 0.125 GB-s per second.
// The plan quotas below are the Workers Paid plan's subscription inclusion
// (as vars on the Worker so they can follow Cloudflare's published numbers
// without a code change).

export interface PlanQuota {
  /** Included requests per UTC month (subscription inclusion). */
  requests: number;
  /** Included GB-seconds per UTC month. */
  gbSeconds: number;
}

export const DEFAULT_PLAN: PlanQuota = { requests: 1_000_000, gbSeconds: 400_000 };

/** Fraction of the plan quota at which new joins are refused. */
export const DEFAULT_BUDGET_FRACTION = 0.8;

/** Cloudflare's WebSocket-message-to-request billing ratio. */
export const MESSAGES_PER_REQUEST = 20;

/** Worker memory billed against duration, in MB (the per-isolate size
 *  Cloudflare bills for WebSocket hibernation). */
export const BILLED_MEMORY_MB = 128;

export interface UsageDelta {
  /** Inbound WebSocket messages since the last report. */
  inboundMessages: number;
  /** WebSocket upgrade requests since the last report. */
  upgrades: number;
  /** Seconds the room was occupied (tick loop running) since the last report. */
  awakeSeconds: number;
}

export interface BilledUsage {
  requests: number;
  gbSeconds: number;
}

/** Convert raw room usage to Cloudflare's billing units. Requests use
 *  ceil() so a partial 20-message block still counts (the billing counter
 *  never rounds down); GB-s accumulate as fractions. */
export function billUsage(delta: UsageDelta): BilledUsage {
  return {
    requests: delta.upgrades + Math.ceil(delta.inboundMessages / MESSAGES_PER_REQUEST),
    gbSeconds: (delta.awakeSeconds * BILLED_MEMORY_MB) / 1024,
  };
}

/** UTC natural-month key, "YYYY-MM". The ledger resets when it changes. */
export function monthKey(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** One month's accumulated billed usage. Plain JSON: the Meter DO stores
 *  this verbatim and restores it after an eviction. */
export interface Ledger {
  month: string;
  requests: number;
  gbSeconds: number;
}

export function emptyLedger(month: string): Ledger {
  return { month, requests: 0, gbSeconds: 0 };
}

export class MonthLedger {
  private state: Ledger;

  constructor(initial?: Ledger) {
    this.state = initial ? { ...initial } : { month: "", requests: 0, gbSeconds: 0 };
  }

  /** Add billed usage, rolling over to a fresh month first when the UTC
   *  month changed since the last record. */
  record(now: Date, billed: BilledUsage): void {
    this.roll(now);
    this.state.requests += billed.requests;
    this.state.gbSeconds += billed.gbSeconds;
  }

  /** Roll to a fresh month when the UTC month changed since the last
   *  write, WITHOUT adding usage. Read-only entry points (/check,
   *  /snapshot) call this so a month boundary is visible even before the
   *  first /report of the new month. Returns true when it rolled. */
  roll(now: Date): boolean {
    const m = monthKey(now);
    if (this.state.month !== m) {
      this.state = emptyLedger(m);
      return true;
    }
    return false;
  }

  /** Which quotas are at or above `fraction` of the plan. The breaker is
   *  open (new joins refused) when ANY metric trips. */
  overBudget(fraction: number, plan: PlanQuota): { requests: boolean; gbSeconds: boolean } {
    return {
      requests: this.state.requests >= plan.requests * fraction,
      gbSeconds: this.state.gbSeconds >= plan.gbSeconds * fraction,
    };
  }

  get month(): string {
    return this.state.month;
  }

  get requests(): number {
    return this.state.requests;
  }

  get gbSeconds(): number {
    return this.state.gbSeconds;
  }

  toJSON(): Ledger {
    return { ...this.state };
  }
}
