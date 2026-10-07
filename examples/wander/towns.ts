// examples/wander/towns.ts — what townsfolk say, what they ask, how they thank.
//
// Pure content: every line is a function of (seed, region plan, villager
// index) plus a few pure lookups (hubs, names, landmarks). The sim owns
// whether an errand is active and which towns have been helped; the offers
// and the thanks are recomputed by anyone who needs them, so nothing here
// stores state.

import { growHash, regionGates, regionHub, type Biome } from "./world.ts";
import { planRegion, regionName, type RegionPlan } from "./region.ts";
import { isWilderness, landmarkApproach, landmarkFor, landmarkRoll, type Landmark } from "./landmarks.ts";

export type FactKind = "biome" | "size" | "neighbor" | "landmark";

export interface NeighborTown { name: string; dir: string }
export interface LandmarkRumor { kind: string; dir: string; dist: number; name: string }
export interface TownFacts {
  size: "HAMLET" | "VILLAGE" | "TOWN";
  /** Road-connected neighbour towns, nearest gate first, at most 3. */
  neighbors: NeighborTown[];
  /** Nearest landmark within three regions, if any. */
  landmark: LandmarkRumor | null;
}

/** Pure lookups the content needs (the sim wires its residency, tests wire
 *  the point functions). */
export interface TownLookups {
  hubOf(rx: number, ry: number): { town: boolean; x: number; y: number };
  landmarkOf(rx: number, ry: number): Landmark | null;
}

const DIR_WORD = ["south", "west", "north", "east"] as const; // +dy, -dx, -dy, +dx
const GATE_DELTA: readonly (readonly [number, number, number])[] = [
  [0, -1, 2], [1, 0, 3], [0, 1, 0], [-1, 0, 1], // n, e, s, w
] as const;

/** The town's facts: size class, road-connected neighbours, nearest
 *  landmark. Pure in (seed, plan) given the lookups. */
export function townFacts(seed: number, plan: RegionPlan, look: TownLookups): TownFacts {
  const size = plan.houses <= 8 ? "HAMLET" : plan.houses <= 16 ? "VILLAGE" : "TOWN";
  const neighbors: NeighborTown[] = [];
  const g = regionGates(seed, plan.rx, plan.ry);
  const gates = [g.n, g.e, g.s, g.w];
  for (let d = 0; d < 4 && neighbors.length < 3; d++) {
    if (!gates[d]!.active) continue;
    const [dx, dy, dir] = GATE_DELTA[d]!;
    const nrx = plan.rx + dx, nry = plan.ry + dy;
    if (!look.hubOf(nrx, nry).town) continue;
    neighbors.push({ name: regionName(seed, nrx, nry), dir: DIR_WORD[dir]! });
  }
  let landmark: LandmarkRumor | null = null;
  let best = Infinity, bestTie = 0;
  for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
    // The town's own region (0,0) is eligible: its landmark can be the
    // nearest one, and skipping it under-reports the rumor.
    const lm = look.landmarkOf(plan.rx + dx, plan.ry + dy);
    if (!lm) continue;
    const d = Math.abs(lm.cx - plan.hub.x) + Math.abs(lm.cy - plan.hub.y);
    const tie = growHash(seed, lm.rx, lm.ry, 0x1a4d) % 10007;
    if (d < best || (d === best && tie < bestTie)) {
      best = d; bestTie = tie;
      const wx = Math.sign(lm.cx - plan.hub.x), wy = Math.sign(lm.cy - plan.hub.y);
      const dir = wy < 0 ? (wx < 0 ? "NW" : wx > 0 ? "NE" : "N") : wy > 0 ? (wx < 0 ? "SW" : wx > 0 ? "SE" : "S") : wx < 0 ? "W" : "E";
      landmark = { kind: lm.kindName, dir, dist: d, name: regionName(seed, lm.rx, lm.ry) };
    }
  }
  return { size, neighbors, landmark };
}

// ---------------------------------------------------------------------------
// Roles. A villager's role decides which two fact categories it talks about;
// roles are assigned round-robin by house order, so a town of 8-12 villagers
// always fields all 8 roles (>= 4 distinct line groups structurally).
// ---------------------------------------------------------------------------

export const VILLAGER_ROLES = ["FARMER", "BAKER", "ELDER", "TRAVELER", "GUARD", "HERBALIST", "CHILD", "MASON"] as const;
export function villagerRole(villager: number): string {
  return VILLAGER_ROLES[villager % VILLAGER_ROLES.length]!;
}
/** The two fact categories a role draws on (a missing fact falls back to
 *  the next available, so every villager still cites >= 2). */
const ROLE_FACTS: readonly (readonly FactKind[])[] = [
  ["biome", "size"],      // FARMER
  ["size", "neighbor"],   // BAKER
  ["neighbor", "landmark"], // ELDER
  ["landmark", "biome"],  // TRAVELER
  ["neighbor", "biome"],  // GUARD
  ["landmark", "size"],   // HERBALIST
  ["biome", "neighbor"],  // CHILD
  ["size", "landmark"],   // MASON
];

// ---------------------------------------------------------------------------
// Line templates. Every category has at least 8.
// ---------------------------------------------------------------------------

/** What the land gives and asks, by biome. */
const BIOME_LINES: readonly (readonly string[])[] = [
  [ // grass
    "The fields treat us well here.",
    "Rain has been kind to the barley.",
    "Two harvests a year, if the weather holds.",
    "The pasture is sweet all summer.",
    "We trade grain south along the road.",
    "The clover grows thick down by the river.",
    "Frost came late this year; the soil is warm.",
    "Every field around is green to the horizon.",
  ],
  [ // mud
    "The mud never dries this time of year.",
    "We lay planks over the worst of the road.",
    "Rain keeps the wells full and the boots wet.",
    "The clay is good for bricks, at least.",
    "Mist sits in the hollow until noon.",
    "The floods come every spring without fail.",
    "Reeds grow tall where the ground won't drain.",
    "A dry week is news worth repeating.",
  ],
  [ // sand
    "Water is scarce; the well runs low.",
    "The sun is merciless from noon to dusk.",
    "We store every drop the cistern catches.",
    "Date palms are the only green that lasts.",
    "Sand drifts against the walls by morning.",
    "The caravan road is our lifeline.",
    "Nights are cold; the days make up for it.",
    "A sip of water is worth more than coin.",
  ],
  [ // snow
    "The cold keeps us indoors half the year.",
    "Snow buries the road to the gate for months.",
    "We burn peat and tell stories by the fire.",
    "Frost flowers on the glass every dawn.",
    "Spring is short and fiercely green.",
    "The stores must last until the thaw.",
    "Wolves follow the road in the deep winter.",
    "The aurora is the only light some nights.",
  ],
];

const SIZE_LINES = [
  "We are {n} houses now and still growing.",
  "Only {n} houses, but every one of them home.",
  "{n} houses, {n} fires, {n} suppers.",
  "The village counts {n} roofs these days.",
  "We were three houses once; now we are {n}.",
  "{n} houses stand between the road and the fields.",
  "A {size} of {n} houses, give or take.",
  "Every one of our {n} houses has someone in it.",
] as const;

const NEIGHBOR_LINES = [
  "The road to the {ndir} runs to {nname}.",
  "Traders come from {nname}, {ndir} of here.",
  "{nname} lies {ndir}, a day's walk at most.",
  "If you're heading {ndir}, {nname} is the next stop.",
  "Our nearest neighbours are in {nname}, {ndir}.",
  "The {ndir} gate sees most traffic; it leads to {nname}.",
  "Folks in {nname} keep their own counsel, {ndir} of us.",
  "My cousin walked to {nname} {ndir} and back in a day.",
] as const;

const LANDMARK_LINES = [
  "They say there are {lkind} {ldir} of here.",
  "Old tales place {lkind} about {ldist} tiles {ldir}.",
  "Have you seen the {lkind}? They lie {ldir}.",
  "The {lkind} {ldir} have stood longer than any town.",
  "Shepherds avoid the {lkind} {ldir} after dark.",
  "A traveler spoke of {lkind}, {ldir}, half a day off.",
  "The {lkind} {ldir} are marked on no map but ours.",
  "Birds circle the {lkind} {ldir} at sundown.",
] as const;

const ERRAND_LINES = [
  "Take {what} to {target}? Press CROSS on our plaza.",
  "Could you carry {what} as far as {target}?",
  "{target} is waiting for {what}; the plaza board hires you.",
  "A parcel for {target}: {what}, if you're going that way.",
  "Someone in {target} needs {what}. Press CROSS by the well.",
  "We'd pay in thanks: {what} bound for {target}.",
  "The errand board asks for {what} delivered to {target}.",
  "Carry {what} to {target} and the town will remember.",
] as const;

const VISIT_ERRAND_LINES = [
  "Go and see the {kind} near {target}? Press CROSS on our plaza.",
  "We'd hear news of the {kind} near {target}.",
  "Lay eyes on the {kind} by {target} and tell us what you find.",
  "The {kind} near {target} have gone unwitnessed too long.",
  "A coin for whoever visits the {kind} near {target}.",
  "Travel to the {kind} by {target}; the plaza board asks it.",
  "Seek out the {kind} near {target} and come back wiser.",
  "The {kind} near {target} are worth the walk, they say.",
] as const;

const HELPED_LINES = [
  "The flowers you brought bloom on the plaza. Thank you.",
  "Our plaza still blooms from your kindness.",
  "Travelers ask who planted the plaza flowers. We say: a friend.",
  "The flowers you carried took root. Come see them.",
  "We keep the plaza flowers for you, whenever you return.",
  "Bloom season is every season, thanks to you.",
  "The whole town smells of the flowers you brought.",
  "Strangers water the plaza flowers now; they remember too.",
] as const;

const NO_ERRAND_LINES = [
  "Roads end here in every direction.",
  "No one passes through but the wind.",
  "We've nothing to ask of you, traveler.",
  "The next town is too far for errands.",
  "Whatever you need, it isn't here.",
  "Quiet today. Quiet most days.",
  "The road goes on; nothing follows it back.",
  "We trade with no one and owe no one.",
] as const;

const PLAQUE_LINES = [
  "Grown by rule the day you found it.",
  "A town of the road, raised as you came.",
  "Every stone here remembers its first visitor.",
  "Founded by footsteps; yours among them.",
  "The road grew here, and so did we.",
  "Built in the time it takes to walk through.",
  "A stopping place, if you need one.",
  "The gate was open before you arrived.",
] as const;

const PLAQUE_HELPED = [
  "A town that repaid a traveler's kindness.",
  "The plaza flowers were a gift. They outlasted the visit.",
  "Here a traveler's errand ended in bloom.",
  "We were helped once. The flowers keep the record.",
  "Kindness passed through here and left petals.",
  "The plaza remembers every friend who came.",
  "Flowers grow where an errand was completed.",
  "This town keeps a traveler's promise in bloom.",
] as const;

// ---------------------------------------------------------------------------
// Errands.
// ---------------------------------------------------------------------------

export type ErrandKind = "deliver" | "visit";
export interface Errand {
  kind: ErrandKind;
  /** Offering region. */
  orx: number; ory: number;
  /** Target region. */
  trx: number; try: number;
  /** Target tile: the hub (deliver) or the landmark centre (visit). */
  tx: number; ty: number;
  /** Walkable tile the walker actually heads for: the hub (deliver) or a
   *  ring cell of the landmark (visit, since the centre can block). */
  ax: number; ay: number;
  targetName: string;
  /** What to carry (deliver) or seek (visit). */
  what: string;
}

const ERRAND_WHAT = [
  "a parcel", "a letter", "seed packets", "a jar of honey", "a spool of wire",
  "a cake of soap", "a bag of salt", "a roll of cloth", "a pot of glue", "a pouch of tea",
] as const;

/** A visit errand's landmark must be within this many tiles (Manhattan) of
 *  the offering town's hub, so the auto-walker's detour stays inside the
 *  between-encounter gap budget. */
const VISIT_MAX_TILES = 100;

/** The landmark a region's plan actually places, computed purely and memoized:
 *  planRegion is a deterministic function of (seed, rx, ry), so this is stable
 *  across residency/load state. A plan run is ~0.1 ms; the cache is bounded
 *  (FIFO) and filled by the budgeted fact job (residency.runBudget), never by
 *  the on-demand dialog resolver or the plaza offer — they read only ready
 *  facts (pureLmPeek), so a cold cache degrades to "no landmark" instead of
 *  running a plan outside the per-tick budget.
 *
 *  Two cheap paths avoid the planRegion run:
 *  - Wilderness regions (no town, no gate road): the roll's first candidate
 *    always fits, so `landmarkFor` is exactly the plan's placement (the same
 *    equivalence the sim's placedLandmark() relies on).
 *  - Developed regions whose roll placed no landmark: `landmarkRoll` is a
 *    cheap hash roll; a null roll means the plan places no landmark either. */
const pureLmCache = new Map<string, Landmark | null>();
const PURE_LM_CAP = 4096;
/** Number of calls to purePlacedLandmark (tests assert the on-demand dialog
 *  resolver and the plaza offer never compute at runtime: boot and the
 *  budgeted fact job compute, they read only the cache). */
export let pureLmCallCount = 0;
function pureLmKey(seed: number, rx: number, ry: number): string { return seed + ":" + rx + "," + ry; }
/** Whether a region's pure placed landmark is cached (ready to read). */
export function pureLmIsWarm(seed: number, rx: number, ry: number): boolean {
  return pureLmCache.has(pureLmKey(seed, rx, ry));
}
/** Read a region's pure placed landmark from the cache, or undefined when it
 *  has not been computed yet. Never computes: the on-demand dialog resolver
 *  and the plaza offer read only ready facts, so a cold cache degrades
 *  instead of running a plan outside the per-tick budget. */
export function pureLmPeek(seed: number, rx: number, ry: number): Landmark | null | undefined {
  return pureLmCache.get(pureLmKey(seed, rx, ry));
}
/** Write a region's pure placed landmark into the cache (the budgeted fact
 *  job calls this when a plan run completes). */
export function pureLmSet(seed: number, rx: number, ry: number, lm: Landmark | null): void {
  if (pureLmCache.size >= PURE_LM_CAP) {
    // Bounded FIFO: evict a batch of the oldest entries (insertion-ordered).
    const evict = Math.floor(PURE_LM_CAP / 8);
    let n = 0;
    for (const key of pureLmCache.keys()) { if (n++ >= evict) break; pureLmCache.delete(key); }
  }
  pureLmCache.set(pureLmKey(seed, rx, ry), lm);
}
/** The landmark a region's plan actually places, as a pure function of
 *  (seed, rx, ry). Computes and caches on a miss; callers that must not
 *  compute (the on-demand dialog resolver, the plaza offer) use pureLmPeek
 *  instead. */
export function purePlacedLandmark(seed: number, rx: number, ry: number): Landmark | null {
  pureLmCallCount++;
  const cached = pureLmPeek(seed, rx, ry);
  if (cached !== undefined) return cached;
  let lm: Landmark | null;
  if (isWilderness(seed, rx, ry)) {
    lm = landmarkFor(seed, rx, ry);
  } else if (!landmarkRoll(seed, rx, ry)) {
    lm = null;
  } else {
    lm = planRegion(seed, rx, ry).landmark ?? null;
  }
  pureLmSet(seed, rx, ry, lm);
  return lm;
}

/** Pre-compute a region's landmark (fills the pure cache). Boot warms the
 *  start window's town scans with this; the runtime path warms via the
 *  residency fact queue instead. */
export function warmLandmark(seed: number, rx: number, ry: number): void {
  purePlacedLandmark(seed, rx, ry);
}

/** Test-only: clear the pure landmark cache so a windowReady/build can be
 *  observed against a cold cache. */
export function __pureLmClearForTest(): void {
  pureLmCache.clear();
}

/** The town's errand, if it has one: carry something to a road-linked
 *  neighbour town, or go and see the nearest landmark within two regions.
 *  Pure in (seed, rx, ry): every fact comes from the point functions
 *  (regionHub / regionGates / purePlacedLandmark), never residency or load
 *  state, so the same town always offers the same errand. A delivery target
 *  must sit behind an active gate (a real road connection). */
export function townErrand(seed: number, rx: number, ry: number, landmarkOf: (rx: number, ry: number) => Landmark | null = (a, b) => purePlacedLandmark(seed, a, b)): Errand | null {
  const here = regionHub(seed, rx, ry);
  // Road-linked neighbour towns only: a delivery target must be reachable by
  // the town's own road, not merely the nearest hub in the square.
  let bestTown: { rx: number; ry: number; d: number; tie: number } | null = null;
  const g = regionGates(seed, rx, ry);
  const gates = [g.n, g.e, g.s, g.w];
  for (let d = 0; d < 4; d++) {
    if (!gates[d]!.active) continue;
    const [dx, dy] = GATE_DELTA[d]!;
    const trx = rx + dx, try_ = ry + dy;
    const h = regionHub(seed, trx, try_);
    if (!h.town) continue;
    const dist = Math.abs(h.x - here.x) + Math.abs(h.y - here.y);
    const tie = growHash(seed, trx, try_, 0xe2a0) % 10007;
    if (!bestTown || dist < bestTown.d || (dist === bestTown.d && tie < bestTown.tie)) bestTown = { rx: trx, ry: try_, d: dist, tie };
  }
  // Nearest landmark within two regions: the plan's actual placement (pure),
  // so the target is reachable and the offer matches what the world places.
  // Capped to VISIT_MAX_TILES: a farther landmark would make the auto-walker's
  // detour exceed the between-encounter gap budget.
  let bestLm: { rx: number; ry: number; d: number; tie: number } | null = null;
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    if (!dx && !dy) continue;
    const trx = rx + dx, try_ = ry + dy;
    const lm = landmarkOf(trx, try_);
    if (!lm) continue;
    const dist = Math.abs(lm.cx - here.x) + Math.abs(lm.cy - here.y);
    if (dist > VISIT_MAX_TILES) continue;
    const tie = growHash(seed, lm.rx, lm.ry, 0xe2a1) % 10007;
    if (!bestLm || dist < bestLm.d || (dist === bestLm.d && tie < bestLm.tie)) bestLm = { rx: lm.rx, ry: lm.ry, d: dist, tie };
  }
  const roll = growHash(seed, rx, ry, 0xe2a2) % 10007;
  const wantVisit = roll < 5000;
  if (wantVisit && bestLm) {
    const lm = landmarkOf(bestLm.rx, bestLm.ry)!;
    const appr = landmarkApproach(lm, here.x, here.y);
    return {
      kind: "visit", orx: rx, ory: ry, trx: bestLm.rx, try: bestLm.ry, tx: lm.cx, ty: lm.cy,
      ax: appr.x, ay: appr.y,
      targetName: regionName(seed, bestLm.rx, bestLm.ry), what: `see the ${lm.kindName}`,
    };
  }
  if (bestTown) {
    const h = regionHub(seed, bestTown.rx, bestTown.ry);
    const what = ERRAND_WHAT[growHash(seed, rx, ry, 0xe2a3) % ERRAND_WHAT.length]!;
    return {
      kind: "deliver", orx: rx, ory: ry, trx: bestTown.rx, try: bestTown.ry, tx: h.x, ty: h.y,
      ax: h.x, ay: h.y,
      targetName: regionName(seed, bestTown.rx, bestTown.ry), what,
    };
  }
  if (bestLm) {
    const lm = landmarkOf(bestLm.rx, bestLm.ry)!;
    const appr = landmarkApproach(lm, here.x, here.y);
    return {
      kind: "visit", orx: rx, ory: ry, trx: bestLm.rx, try: bestLm.ry, tx: lm.cx, ty: lm.cy,
      ax: appr.x, ay: appr.y,
      targetName: regionName(seed, bestLm.rx, bestLm.ry), what: `see the ${lm.kindName}`,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Lines.
// ---------------------------------------------------------------------------

function pick(table: readonly string[], seed: number, a: number, b: number, salt: number): string {
  return table[growHash(seed, a, b, salt) % table.length]!;
}

function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? `{${k}}`));
}

/** One villager's lines, generated from the town's facts. `used` lists the
 *  fact categories that actually made it into the lines (always >= 2: a
 *  role's preferred facts, falling back across the four). */
export function townTalk(
  seed: number, plan: RegionPlan, villager: number, facts: TownFacts,
  errand: Errand | null, helped: boolean,
): { lines: string[]; used: FactKind[] } {
  const role = villagerRole(villager);
  const preferred = ROLE_FACTS[villager % VILLAGER_ROLES.length]!;
  const available: FactKind[] = ["biome", "size", ...(facts.neighbors.length ? (["neighbor"] as FactKind[]) : []), ...(facts.landmark ? (["landmark"] as FactKind[]) : [])];
  const used: FactKind[] = [];
  for (const kind of preferred) if (available.includes(kind)) used.push(kind);
  for (const kind of available) if (used.length < 2 && !used.includes(kind)) used.push(kind);

  // Base vars shared by every line; neighbour and landmark facts keep their
  // OWN direction/name slots so a neighbour line never borrows the landmark's
  // direction (or vice versa).
  const base: Record<string, string | number> = {
    n: plan.houses, size: facts.size, name: plan.name,
    biome: plan.hub.biome,
  };
  const nVars = facts.neighbors.length
    ? { ...base, nname: facts.neighbors[0]!.name, ndir: facts.neighbors[0]!.dir }
    : null;
  const lVars = facts.landmark
    ? { ...base, lkind: facts.landmark.kind, ldist: facts.landmark.dist, ldir: facts.landmark.dir }
    : null;

  const lines: string[] = [`${role}: ${plan.name}`];
  for (const kind of used) {
    if (kind === "biome") lines.push(pick(BIOME_LINES[plan.hub.biome as Biome]!, seed, plan.rx, plan.ry, 0xb101 + villager));
    else if (kind === "size") lines.push(fill(pick(SIZE_LINES, seed, plan.rx, plan.ry, 0xb102 + villager), base));
    else if (kind === "neighbor") lines.push(fill(pick(NEIGHBOR_LINES, seed, plan.rx, plan.ry, 0xb103 + villager), nVars!));
    else lines.push(fill(pick(LANDMARK_LINES, seed, plan.rx, plan.ry, 0xb104 + villager), lVars!));
  }
  if (helped) lines.push(pick(HELPED_LINES, seed, plan.rx, plan.ry, 0xb105));
  else if (errand) {
    const table = errand.kind === "visit" ? VISIT_ERRAND_LINES : ERRAND_LINES;
    lines.push(fill(pick(table, seed, plan.rx, plan.ry, 0xb106), { what: errand.what, target: errand.targetName, kind: errand.what.replace("see the ", "") }));
  } else lines.push(pick(NO_ERRAND_LINES, seed, plan.rx, plan.ry, 0xb107));
  return { lines, used };
}

/** The notice-board lines, including the errand offer. */
export function townPlaque(seed: number, plan: RegionPlan, facts: TownFacts, errand: Errand | null, helped: boolean): string[] {
  const lines = [
    `<${plan.name}>`,
    helped ? pick(PLAQUE_HELPED, seed, plan.rx, plan.ry, 0xb108) : pick(PLAQUE_LINES, seed, plan.rx, plan.ry, 0xb109),
  ];
  if (errand) {
    const table = errand.kind === "visit" ? VISIT_ERRAND_LINES : ERRAND_LINES;
    lines.push(fill(pick(table, seed, plan.rx, plan.ry, 0xb10a), { what: errand.what, target: errand.targetName, kind: errand.what.replace("see the ", "") }));
  } else if (facts.neighbors.length) {
    const names = facts.neighbors.map((n) => `${n.name} (${n.dir})`).join(", ");
    lines.push(`Roads run to ${names}.`);
  } else {
    lines.push("No road leaves this place.");
  }
  return lines;
}

// ---------------------------------------------------------------------------
// On-demand dialog tokens.
//
// The window build bakes `{x:<key>}` tokens into the text commands instead of
// the expanded lines, and the sim's textTokens resolver expands them when a
// box opens (the talk frame). So the per-region line generation (townFacts /
// townErrand / townTalk / townPlaque) never runs inside a window-build slice
// or on a window-swap frame: it runs on the talk frame, where a dialog is
// open and the player is reading. The key freezes every input the lines
// depend on (region, villager, helped-at-build-time), so the expanded lines
// are identical to the old build-time bake — a pure function of (seed,
// region, villager, helped).
// ---------------------------------------------------------------------------

/** Number of lines townTalk produces (role line + 2 fact lines + 1 tail). */
export const TALK_LINE_COUNT = 4;
/** Number of lines townPlaque produces (name + plaque line + roads/errand). */
export const PLAQUE_LINE_COUNT = 3;

/** The {x:} key for a villager dialog line (the project's textTokens
 *  allowlist lists these exact keys — see window.ts). */
export function villagerTokenKey(rx: number, ry: number, house: number, helped: boolean, line: number): string {
  return `v:${rx}:${ry}:${house}:${helped ? 1 : 0}:${line}`;
}

/** A villager dialog line token: `v:rx:ry:house:helped:line`. */
export function villagerToken(rx: number, ry: number, house: number, helped: boolean, line: number): string {
  return `{x:${villagerTokenKey(rx, ry, house, helped, line)}}`;
}

/** The {x:} key for a notice-board plaque line. */
export function plaqueTokenKey(rx: number, ry: number, helped: boolean, line: number): string {
  return `p:${rx}:${ry}:${helped ? 1 : 0}:${line}`;
}

/** A notice-board plaque line token: `p:rx:ry:helped:line`. */
export function plaqueToken(rx: number, ry: number, helped: boolean, line: number): string {
  return `{x:${plaqueTokenKey(rx, ry, helped, line)}}`;
}

// ---------------------------------------------------------------------------
// Plaza flowers.
// ---------------------------------------------------------------------------

const IMPROVE_TILE = [42, 29, 35, 42] as const; // FLOWER_PROP, BUSH, CACTUS, FLOWER_PROP (snow: flowers, not grey shrubs)

/** Decor cells a helped town gains: a few flowers around its plaza. Only
 *  walkable, undeveloped cells are picked (never a road, house or prop), so
 *  the flowers never block and never overlap the town. Pure in the plan. */
export function improvementCells(plan: RegionPlan): { x: number; y: number; tile: number }[] {
  const out: { x: number; y: number; tile: number }[] = [];
  const tile = IMPROVE_TILE[plan.hub.biome]!;
  // Ring the plaza at distance 2..5, deterministic order.
  const offsets = [
    [2, 2], [-2, 2], [2, -2], [-2, -2],
    [3, 1], [-3, 1], [3, -1], [-3, -1],
    [1, 3], [-1, 3], [1, -3], [-1, -3],
    [4, 0], [-4, 0], [0, 4], [0, -4],
    [5, 2], [-5, 2], [5, -2], [-5, -2],
  ] as const;
  for (const [dx, dy] of offsets) {
    const x = plan.hub.x + dx, y = plan.hub.y + dy;
    const lx = x - plan.x0, ly = y - plan.y0;
    if (lx < 0 || ly < 0 || lx >= 96 || ly >= 96) continue;
    const i = ly * 96 + lx;
    const f = plan.flags![i]!;
    if (f & 0x13) continue; // F_ROAD | F_BLOCK | F_UPPER: never on a road, house or prop
    out.push({ x, y, tile });
    if (out.length >= 4) break;
  }
  return out;
}
