// examples/wander-online/net/journey.ts — a player's private errand journey
// in the shared realm: the active errand, the towns they helped and talked
// to. The server owns every mutation; the client only presents it. The text
// a journey produces (offers, dialog, notices) is pure in (seed, region) and
// comes from the single-player content modules, so online and offline read
// the same strings.
//
// The model mirrors the single-player sim's bounded session state: an exact
// helped FIFO of HELP_CAP towns backed by a Bloom filter that never forgets,
// a talked FIFO of TALK_CAP towns, and one active errand identified by its
// offering region (the offer itself is a pure function of that region).

import { HelpedBloom, HELPED_BLOOM_WORDS } from "../../wander/helped-bloom.ts";
import { regionName } from "../../wander/region.ts";
import { townErrand, type Errand } from "../../wander/towns.ts";

// The single-player sim's bounds, restated here so the hosted server does
// not bundle the whole WanderSim graph; tests pin them to the sim's exports.
/** Exact helped towns remembered. */
export const HELP_CAP = 32;
/** Manhattan radius around a town hub where the plaza action works. */
export const PLAZA_RADIUS = 12;
/** Manhattan radius around a visit errand's approach tile that completes it. */
export const VISIT_ARRIVE = 6;
/** Towns a player remembers talking to (the single-player TALK_CAP). */
export const TALK_CAP = 24;
/** Saturation point of the distinct-helped counter (stored as u16). */
export const HELPED_COUNT_MAX = 0xffff;
/** Hard bound on a serialized journey. The v2 JSON row's worst case is
 *  fully determined by the caps above and the int32 coordinate range
 *  (`JOURNEY_SAVE_WORST_CASE`, 1874 bytes), so every state the model can
 *  reach serializes below this bound; `fitJourney` is the proven-unreachable
 *  degradation for a row that still would not fit. */
export const JOURNEY_SAVE_MAX = 2048;
/** Longest int32 as decimal text ("-2147483648"). */
const COORD_TEXT_MAX = 11;
/** `[rx,ry]` at the longest coordinates. */
const PAIR_TEXT_MAX = 2 + 2 * COORD_TEXT_MAX + 1;
/** `[a,b,...]` of n items each at most `item` bytes, plus a trailing comma. */
const listTextMax = (n: number, item: number): number => (n === 0 ? 2 : 2 + n * item + (n - 1)) + 1;
/** Worst-case byte length of a v2 row: `{"v":2,` + `"e":` pair + `"h":` list
 *  + `"b":` list of 32 u32 (10 digits) + `"t":` list + `"hc":65535}`. */
export const JOURNEY_SAVE_WORST_CASE =
  7
  + 4 + PAIR_TEXT_MAX + 1
  + 4 + listTextMax(HELP_CAP, PAIR_TEXT_MAX)
  + 4 + listTextMax(HELPED_BLOOM_WORDS, 10)
  + 4 + listTextMax(TALK_CAP, PAIR_TEXT_MAX)
  + 5 + String(HELPED_COUNT_MAX).length + 1;

export interface JourneyPair {
  rx: number;
  ry: number;
}

export interface PlayerJourney {
  /** Offering region of the active errand; null when none is active. */
  errand: JourneyPair | null;
  /** Exact helped towns, oldest first, at most HELP_CAP. */
  helped: readonly JourneyPair[];
  /** HELPED_BLOOM_WORDS u32 words: towns helped at any time. */
  bloom: readonly number[];
  /** Towns talked to, oldest first, at most TALK_CAP. */
  talked: readonly JourneyPair[];
  /** Distinct towns ever helped. */
  helpedCount: number;
}

/** Private journey events the server confirms; the client turns each into
 *  the single-player notice text. */
export const JOURNEY_EVENT = {
  none: 0,
  accepted: 1,
  delivered: 2,
  visited: 3,
  talked: 4,
} as const;
export type JourneyEventKind = (typeof JOURNEY_EVENT)[keyof typeof JOURNEY_EVENT];

export interface JourneyEvent {
  seq: number;
  kind: JourneyEventKind;
  rx: number;
  ry: number;
}

export function emptyJourney(): PlayerJourney {
  return { errand: null, helped: [], bloom: new Array<number>(HELPED_BLOOM_WORDS).fill(0), talked: [], helpedCount: 0 };
}

function samePair(a: JourneyPair, b: JourneyPair): boolean {
  return a.rx === b.rx && a.ry === b.ry;
}

function hasPair(list: readonly JourneyPair[], rx: number, ry: number): boolean {
  return list.some((p) => p.rx === rx && p.ry === ry);
}

function bloomOf(seed: number, words: readonly number[]): HelpedBloom {
  const bloom = new HelpedBloom(seed);
  bloom.copyFrom(words);
  return bloom;
}

/** Whether a town counts as helped: the exact set or the Bloom memory. */
export function journeyIsHelped(seed: number, journey: PlayerJourney, rx: number, ry: number): boolean {
  return hasPair(journey.helped, rx, ry) || bloomOf(seed, journey.bloom).has(rx, ry);
}

export function journeyHasTalked(journey: PlayerJourney, rx: number, ry: number): boolean {
  return hasPair(journey.talked, rx, ry);
}

/** The full errand behind the journey's active offer (pure in seed/region). */
export function resolveErrand(seed: number, journey: PlayerJourney): Errand | null {
  if (!journey.errand) return null;
  return townErrand(seed, journey.errand.rx, journey.errand.ry);
}

/** Accept a town's offer. Returns null when no errand can be accepted
 *  (one is already active, or the town offers nothing). */
export function journeyAccept(seed: number, journey: PlayerJourney, rx: number, ry: number): { journey: PlayerJourney; errand: Errand } | null {
  if (journey.errand) return null;
  const errand = townErrand(seed, rx, ry);
  if (!errand) return null;
  return { journey: { ...journey, errand: { rx, ry } }, errand };
}

/** Finish the active errand. The helped town is the target (deliver) or the
 *  offering town (visit); helping is idempotent, exactly as in single-player. */
export function journeyComplete(seed: number, journey: PlayerJourney, errand: Errand): {
  journey: PlayerJourney;
  newlyHelped: boolean;
  hrx: number;
  hry: number;
} {
  const hrx = errand.kind === "deliver" ? errand.trx : errand.orx;
  const hry = errand.kind === "deliver" ? errand.try : errand.ory;
  if (journeyIsHelped(seed, journey, hrx, hry)) {
    return { journey: { ...journey, errand: null }, newlyHelped: false, hrx, hry };
  }
  const helped = journey.helped.length >= HELP_CAP ? journey.helped.slice(1) : [...journey.helped];
  helped.push({ rx: hrx, ry: hry });
  const bloom = bloomOf(seed, journey.bloom);
  bloom.add(hrx, hry);
  return {
    journey: {
      ...journey,
      errand: null,
      helped,
      bloom: bloom.toJSON(),
      helpedCount: Math.min(HELPED_COUNT_MAX, journey.helpedCount + 1),
    },
    newlyHelped: true,
    hrx,
    hry,
  };
}

/** Remember a conversation in a town (bounded FIFO, deduplicated). */
export function journeyTalk(journey: PlayerJourney, rx: number, ry: number): { journey: PlayerJourney; changed: boolean } {
  if (hasPair(journey.talked, rx, ry)) return { journey, changed: false };
  const talked = journey.talked.length >= TALK_CAP ? journey.talked.slice(1) : [...journey.talked];
  talked.push({ rx, ry });
  return { journey: { ...journey, talked }, changed: true };
}

/** The single-player notice line for a confirmed journey event. */
export function journeyEventText(seed: number, event: JourneyEvent): string {
  switch (event.kind) {
    case JOURNEY_EVENT.accepted: {
      const e = townErrand(seed, event.rx, event.ry);
      if (!e) return "";
      return e.kind === "visit" ? `ERRAND: ${e.what} near ${e.targetName}` : `ERRAND: carry ${e.what} to ${e.targetName}`;
    }
    case JOURNEY_EVENT.delivered:
      return `DELIVERED: ${regionName(seed, event.rx, event.ry)} thanks you — flowers on the plaza`;
    case JOURNEY_EVENT.visited:
      return `DONE: ${regionName(seed, event.rx, event.ry)} thanks you — flowers on their plaza`;
    default:
      return "";
  }
}

/** The single-player errand HUD line. */
export function errandHudText(errand: Errand | null, helpedCount: number): string {
  if (!errand) return `ERRAND: none   HELPED ${helpedCount}`;
  const task = errand.kind === "visit" ? errand.what : `carry ${errand.what}`;
  return `ERRAND: ${task} -> ${errand.targetName}   HELPED ${helpedCount}`;
}

// -- persistence --------------------------------------------------------------

interface SerializedJourney {
  v: 2;
  e: [number, number] | null;
  h: [number, number][];
  b: number[];
  t: [number, number][];
  hc: number;
}

function utf8Len(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function pairs(list: readonly JourneyPair[]): [number, number][] {
  return list.map((p) => [p.rx, p.ry]);
}

function journeyJson(journey: PlayerJourney): string {
  const s: SerializedJourney = {
    v: 2,
    e: journey.errand ? [journey.errand.rx, journey.errand.ry] : null,
    h: pairs(journey.helped.slice(-HELP_CAP)),
    b: journey.bloom.map((w) => w >>> 0),
    t: pairs(journey.talked.slice(-TALK_CAP)),
    hc: Math.min(HELPED_COUNT_MAX, Math.max(0, journey.helpedCount | 0)),
  };
  return JSON.stringify(s);
}

/** Shrink a journey until its row fits `max` bytes without losing progress
 *  that cannot be recomputed: the oldest talked towns go first (a talk is a
 *  memory, not progress), then the oldest exact helped towns (the Bloom
 *  memory and `helpedCount` still say they were helped). The errand, the
 *  Bloom words and the count are never dropped. Returns how many entries
 *  were dropped; 0 means the journey was already within the bound. */
export function fitJourney(journey: PlayerJourney, max = JOURNEY_SAVE_MAX): { journey: PlayerJourney; dropped: number } {
  let fitted = journey;
  let dropped = 0;
  while (utf8Len(journeyJson(fitted)) > max) {
    if (fitted.talked.length > 0) fitted = { ...fitted, talked: fitted.talked.slice(1) };
    else if (fitted.helped.length > 0) fitted = { ...fitted, helped: fitted.helped.slice(1) };
    else break;
    dropped++;
  }
  return { journey: fitted, dropped };
}

/** Canonical JSON for the realm's per-player row. Every reachable journey
 *  fits `JOURNEY_SAVE_MAX` (see `JOURNEY_SAVE_WORST_CASE`); a row that still
 *  would not fit is degraded by `fitJourney` rather than lost, and only an
 *  irreducible row (errand + Bloom + count alone over the bound, impossible
 *  with int32 coordinates) throws. */
export function serializeJourney(journey: PlayerJourney, max = JOURNEY_SAVE_MAX): string {
  const text = journeyJson(journey);
  if (utf8Len(text) <= max) return text;
  const fitted = journeyJson(fitJourney(journey, max).journey);
  if (utf8Len(fitted) > max) throw new RangeError(`journey save exceeds ${max} bytes`);
  return fitted;
}

function coordinate(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff) {
    throw new TypeError(`${what} must be an int32`);
  }
  return value;
}

function pairList(value: unknown, what: string, cap: number): JourneyPair[] {
  if (!Array.isArray(value)) throw new TypeError(`${what} must be an array`);
  if (value.length > cap) throw new RangeError(`${what} exceeds the ${cap} entry cap`);
  const out: JourneyPair[] = [];
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2) throw new TypeError(`${what} entries must be [rx, ry]`);
    const rx = coordinate(entry[0], `${what} rx`), ry = coordinate(entry[1], `${what} ry`);
    if (!hasPair(out, rx, ry)) out.push({ rx, ry });
  }
  return out;
}

/** Parse a stored journey. Pre-journey rows (`{"v":1,"active":[]}`) and
 *  empty text restore as an empty journey; malformed rows throw. */
export function parseJourney(text: string): PlayerJourney {
  if (typeof text !== "string") throw new TypeError("journey must be JSON text");
  if (text === "") return emptyJourney();
  if (utf8Len(text) > JOURNEY_SAVE_MAX) throw new RangeError(`journey save exceeds ${JOURNEY_SAVE_MAX} bytes`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new TypeError("journey must be valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null) throw new TypeError("journey must be an object");
  const r = parsed as Record<string, unknown>;
  if (r.v === 1) return emptyJourney();
  if (r.v !== 2) throw new RangeError("journey has an unsupported version");
  let errand: JourneyPair | null = null;
  if (r.e !== null && r.e !== undefined) {
    if (!Array.isArray(r.e) || r.e.length !== 2) throw new TypeError("journey errand must be [rx, ry]");
    errand = { rx: coordinate(r.e[0], "errand rx"), ry: coordinate(r.e[1], "errand ry") };
  }
  const helped = pairList(r.h ?? [], "helped", HELP_CAP);
  const talked = pairList(r.t ?? [], "talked", TALK_CAP);
  const bloomSource = r.b ?? [];
  if (!Array.isArray(bloomSource) || bloomSource.length > HELPED_BLOOM_WORDS) throw new TypeError("journey bloom is malformed");
  const bloom = new Array<number>(HELPED_BLOOM_WORDS).fill(0);
  for (let i = 0; i < bloomSource.length; i++) {
    const w = bloomSource[i];
    if (typeof w !== "number" || !Number.isInteger(w) || w < 0 || w > 0xffffffff) throw new TypeError("journey bloom word is malformed");
    bloom[i] = w;
  }
  const hc = typeof r.hc === "number" && Number.isInteger(r.hc) && r.hc >= 0 ? Math.min(r.hc, HELPED_COUNT_MAX) : helped.length;
  return { errand, helped, bloom, talked, helpedCount: hc };
}

export function sameJourney(a: PlayerJourney, b: PlayerJourney): boolean {
  if ((a.errand === null) !== (b.errand === null)) return false;
  if (a.errand && b.errand && !samePair(a.errand, b.errand)) return false;
  if (a.helpedCount !== b.helpedCount || a.helped.length !== b.helped.length || a.talked.length !== b.talked.length) return false;
  for (let i = 0; i < a.helped.length; i++) if (!samePair(a.helped[i]!, b.helped[i]!)) return false;
  for (let i = 0; i < a.talked.length; i++) if (!samePair(a.talked[i]!, b.talked[i]!)) return false;
  for (let i = 0; i < HELPED_BLOOM_WORDS; i++) if ((a.bloom[i] ?? 0) !== (b.bloom[i] ?? 0)) return false;
  return true;
}

// -- concurrent sessions ----------------------------------------------------------

function pairsNotIn(list: readonly JourneyPair[], base: readonly JourneyPair[]): JourneyPair[] {
  return list.filter((p) => !hasPair(base, p.rx, p.ry));
}

/** Union of two FIFO lists that both grew from `base`: `theirs` in order,
 *  then every entry `mine` added since the base, newest last, capped from
 *  the oldest end. */
function mergePairs(base: readonly JourneyPair[], theirs: readonly JourneyPair[], mine: readonly JourneyPair[], cap: number): JourneyPair[] {
  const out = [...theirs];
  for (const p of pairsNotIn(mine, base)) if (!hasPair(out, p.rx, p.ry)) out.push(p);
  return out.length > cap ? out.slice(out.length - cap) : out;
}

/** Three-way merge of one account's journey written by two sessions.
 *  `base` is the row both started from, `theirs` the row stored since, and
 *  `mine` this session's state. Helped and talked towns, the Bloom memory
 *  and the count only ever grow, so they merge as unions; the single active
 *  errand follows whichever side changed it, the stored side when both did.
 *  With either side unchanged the result is exactly the other side. */
export function mergeJourney(base: PlayerJourney, theirs: PlayerJourney, mine: PlayerJourney): PlayerJourney {
  if (sameJourney(theirs, base)) return mine;
  if (sameJourney(mine, base)) return theirs;
  const bloom = new Array<number>(HELPED_BLOOM_WORDS);
  for (let i = 0; i < HELPED_BLOOM_WORDS; i++) bloom[i] = ((theirs.bloom[i] ?? 0) | (mine.bloom[i] ?? 0)) >>> 0;
  const helped = mergePairs(base.helped, theirs.helped, mine.helped, HELP_CAP);
  const talked = mergePairs(base.talked, theirs.talked, mine.talked, TALK_CAP);
  const fresh = pairsNotIn(theirs.helped, base.helped);
  for (const p of pairsNotIn(mine.helped, base.helped)) if (!hasPair(fresh, p.rx, p.ry)) fresh.push(p);
  const helpedCount = Math.min(HELPED_COUNT_MAX, Math.max(theirs.helpedCount, mine.helpedCount, base.helpedCount + fresh.length));
  const mineChanged = (mine.errand === null) !== (base.errand === null) || (mine.errand && base.errand && !samePair(mine.errand, base.errand));
  const theirsChanged = (theirs.errand === null) !== (base.errand === null) || (theirs.errand && base.errand && !samePair(theirs.errand, base.errand));
  const errand = theirsChanged ? theirs.errand : mineChanged ? mine.errand : base.errand;
  return { errand: errand ? { ...errand } : null, helped, bloom, talked, helpedCount };
}
