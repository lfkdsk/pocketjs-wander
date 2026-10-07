// examples/wander/travel-log.ts — the travel log: bounded session state.
//
// Discovered landmarks, keyed by region. The most recent LOG_CAP entries are
// kept in full; when the log is full the oldest entry is folded into a
// per-kind overflow count, so `total` never decreases and no discovery is
// silently lost.
//
// Discovery identity is bounded and exact: a revisit never re-counts while
// the region is remembered by either the exact set (the most recent
// SEEN_CAP region keys) or the window (the LOG_CAP full entries). Past both
// — a session with more than SEEN_CAP discoveries revisiting a region older
// than the window — the identity is gone and a revisit would re-count; that
// is far past any practical walk (a thousand-plus discoveries), and the
// alternative (a probabilistic filter) would silently skip real discoveries
// once it saturated, which is worse. Serializes to a compact string and
// restores with bounds validation.

export const LOG_CAP = 64;
/** Hard cap on remembered exact discovery identities. */
export const SEEN_CAP = 1024;

export interface LogEntry {
  /** Region name where the landmark stands. */
  name: string;
  kind: string;
  /** World tile of the landmark centre. */
  x: number;
  y: number;
  rx: number;
  ry: number;
  /** Reference tick of the discovery. */
  t: number;
}

interface SerializedLog {
  v: 3;
  found: [number, LogEntry][];
  overflow: [string, number][];
  seen: number[];
  total: number;
  version: number;
}

export class TravelLog {
  /** Region key -> entry, insertion-ordered (most recent last), capped at
   *  LOG_CAP. */
  readonly found = new Map<number, LogEntry>();
  /** Evicted entries folded into per-kind counts. */
  private readonly overflow = new Map<string, number>();
  /** Most recent discovered region keys (exact dedup), insertion-ordered,
   *  capped at SEEN_CAP. */
  private readonly seen = new Set<number>();
  /** Total distinct discoveries ever (never decreases). */
  total = 0;
  /** Bumped on every change (the view watches it). */
  version = 0;

  /** Record a discovery. Returns false if the region was already logged. */
  add(key: number, e: LogEntry): boolean {
    if (this.has(key)) return false;
    this.total++;
    if (this.seen.size < SEEN_CAP) this.seen.add(key);
    if (this.found.size >= LOG_CAP) {
      const oldKey = this.found.keys().next().value!;
      const old = this.found.get(oldKey)!;
      this.found.delete(oldKey);
      this.overflow.set(old.kind, (this.overflow.get(old.kind) ?? 0) + 1);
    }
    this.found.set(key, e);
    this.version++;
    return true;
  }

  /** A region is known discovered while the exact set or the window
   *  remembers it (both bounded, both exact — no false positives). */
  has(key: number): boolean { return this.seen.has(key) || this.found.has(key); }
  get size(): number { return this.found.size; }
  /** Number of exact discovery identities remembered (capped at SEEN_CAP). */
  get seenSize(): number { return this.seen.size; }
  overflowCounts(): ReadonlyMap<string, number> { return this.overflow; }

  /** Overwrite this log's contents from another (used by restore). */
  copyFrom(other: TravelLog): void {
    this.found.clear();
    for (const [k, e] of other.found) this.found.set(k, e);
    this.overflow.clear();
    for (const [k, n] of other.overflow) this.overflow.set(k, n);
    this.seen.clear();
    for (const k of other.seen) this.seen.add(k);
    this.total = other.total;
    this.version = other.version;
  }

  serialize(): string {
    const s: SerializedLog = {
      v: 3,
      found: [...this.found.entries()],
      overflow: [...this.overflow.entries()],
      seen: [...this.seen],
      total: this.total,
      version: this.version,
    };
    return JSON.stringify(s);
  }

  static restore(text: string): TravelLog {
    let s: unknown;
    try { s = JSON.parse(text); } catch { throw new Error("wander: travel log save is not valid JSON"); }
    if (typeof s !== "object" || s === null) throw new Error("wander: travel log save is not an object");
    const r = s as Record<string, unknown>;
    if (r.v !== 3) throw new Error("wander: travel log save has an unsupported version");
    if (!Array.isArray(r.found) || r.found.length > LOG_CAP) throw new Error("wander: travel log save has too many window entries");
    if (!Array.isArray(r.seen) || r.seen.length > SEEN_CAP) throw new Error("wander: travel log save has too many seen keys");
    if (!Array.isArray(r.overflow)) throw new Error("wander: travel log save has a malformed overflow");
    const log = new TravelLog();
    for (const [k, e] of r.found as [number, LogEntry][]) {
      if (typeof k !== "number" || typeof e !== "object" || e === null) throw new Error("wander: travel log save has a malformed entry");
      log.found.set(k, e);
    }
    for (const [k, n] of r.overflow as [string, number][]) {
      if (typeof k !== "string" || typeof n !== "number" || n < 0) throw new Error("wander: travel log save has a malformed overflow");
      log.overflow.set(k, n);
    }
    for (const k of r.seen as number[]) {
      if (typeof k !== "number") throw new Error("wander: travel log save has a malformed seen key");
      log.seen.add(k);
    }
    if (typeof r.total !== "number" || r.total < log.found.size) throw new Error("wander: travel log save has a malformed total");
    if (typeof r.version !== "number" || r.version < 0) throw new Error("wander: travel log save has a malformed version");
    log.total = r.total;
    log.version = r.version;
    return log;
  }
}
