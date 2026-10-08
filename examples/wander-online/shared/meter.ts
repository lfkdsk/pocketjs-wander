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
//     memory times awake seconds, i.e. 128/1000 = 0.128 GB-s per second;
//   - SQLite-backed Durable Object storage is tracked as rows read/written,
//     but those dimensions do not participate in the request/duration breaker.
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
  /** SQLite-backed Durable Object rows read since the last report. */
  storageRowReads?: number;
  /** SQLite-backed Durable Object rows written since the last report. */
  storageRowWrites?: number;
}

export interface BilledUsage {
  requests: number;
  gbSeconds: number;
  /** Optional for compatibility with callers that do not yet meter storage. */
  storageRowReads?: number;
  /** Optional for compatibility with callers that do not yet meter storage. */
  storageRowWrites?: number;
}

/** Convert raw room usage to Cloudflare's billing units. Message request
 *  units stay fractional so separate reports can accumulate to Cloudflare's
 *  account-level 20:1 ratio; GB-s use Cloudflare's decimal GB convention. */
export function billUsage(delta: UsageDelta): BilledUsage {
  return {
    requests: delta.upgrades + delta.inboundMessages / MESSAGES_PER_REQUEST,
    gbSeconds: (delta.awakeSeconds * BILLED_MEMORY_MB) / 1000,
    storageRowReads: delta.storageRowReads ?? 0,
    storageRowWrites: delta.storageRowWrites ?? 0,
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
  storageRowReads: number;
  storageRowWrites: number;
}

export function emptyLedger(month: string): Ledger {
  return { month, requests: 0, gbSeconds: 0, storageRowReads: 0, storageRowWrites: 0 };
}

/** Persisted ledgers from before SQLite row accounting have only the original
 *  three fields. Accept that shape at the storage boundary and canonicalize it
 *  immediately so every new write carries all dimensions. */
type LedgerInput = Pick<Ledger, "month" | "requests" | "gbSeconds"> &
  Partial<Pick<Ledger, "storageRowReads" | "storageRowWrites">>;

export class MonthLedger {
  private state: Ledger;

  constructor(initial?: LedgerInput) {
    this.state = initial
      ? {
        month: initial.month,
        requests: initial.requests,
        gbSeconds: initial.gbSeconds,
        storageRowReads: initial.storageRowReads ?? 0,
        storageRowWrites: initial.storageRowWrites ?? 0,
      }
      : emptyLedger("");
  }

  /** Add billed usage, rolling over to a fresh month first when the UTC
   *  month changed since the last record. */
  record(now: Date, billed: BilledUsage): void {
    this.roll(now);
    this.state.requests += billed.requests;
    this.state.gbSeconds += billed.gbSeconds;
    this.state.storageRowReads += billed.storageRowReads ?? 0;
    this.state.storageRowWrites += billed.storageRowWrites ?? 0;
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

  get storageRowReads(): number {
    return this.state.storageRowReads;
  }

  get storageRowWrites(): number {
    return this.state.storageRowWrites;
  }

  toJSON(): Ledger {
    return { ...this.state };
  }
}
