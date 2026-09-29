// examples/wander/window.ts — the walkable session's sliding window.
//
// The kit's engine (src/engine/session.ts) walks one bounded map. The
// endless world gives it a WINDOW: the 3 x 3 chunks around the player's
// chunk, emitted as a normal rpgkit-project/v1 document the way
// examples/grow/grow-project.ts exports a grown village:
//
//   ground   "ninja.<cell>": developed ground (road, plaza, field) or the
//            biome's base tile — the same ids grow-project writes
//   upper    the sparse star layer (houses, fences, props, bushes and the
//            wilderness stamps visible at build time) when asked for: the
//            engine never reads it, so the live session's window leaves it
//            out and the render ring draws that layer from chunk data; an
//            exported window (includeUpper) is the complete document
//   passage  "block" on houses, fences, props (grow-project's rule) and on
//            the trunk row of multi-cell wilderness stamps (trees and
//            boulders); canopies and bushes stay walkable, bodies pass under
//   events   one per resident whose whole road walk fits in the window
//            (blocks:true, a repeat moveRoute, a line of dialogue), and a
//            plaque on each town's notice board; each is gated on a switch
//            the simulation sets when growth births it
//
// When the player enters a new chunk the simulation builds the next window
// in budgeted slices, then swaps it in: the session state is translated by
// the origin shift (the floating origin), so tile and pixel positions stay
// small and exact and nothing on screen moves. Residents present in both
// windows keep their walk state; new ones spawn at their door.

import type { GameEvent, MapDef, Project, TileId } from "../../src/engine/types.ts";
import { STAMP_END } from "../grow/grow-stamps.ts";
import { blocksAt, groundAt, roadAt, upperAt, type ChunkData } from "./chunk.ts";
import { regionKey, type Residency } from "./residency.ts";
import { F_BLOCK, type RegionPlan } from "./region.ts";
import { BIOME_BASE_TILE, CHUNK, REGION, REGION_CHUNKS, regionGates } from "./world.ts";

export const WINDOW_CHUNKS = 3;
export const WINDOW = CHUNK * WINDOW_CHUNKS; // 96 tiles
export const MAP_ID = "wander";
export const VILLAGER_SPRITE = "../grow/assets/grow-villager.png";

const SHEET = { id: "ninja", cols: 256, rows: Math.max(1, Math.ceil(STAMP_END / 256)), pak: "chunks" } as const;
/** Interned tile id strings: the window build copies references only. */
const TILE_IDS: readonly string[] = Array.from({ length: SHEET.cols * SHEET.rows }, (_, i) => `ninja.${i}`);
export function seedHex(seed: number): string {
  return (seed >>> 0).toString(16).toUpperCase().padStart(8, "0");
}

/** An event the simulation switches on when growth reaches it. */
export interface WindowActor {
  id: string;
  switchId: string;
  born: number;
  rx: number;
  ry: number;
}

export interface WindowBuild {
  /** Centre chunk. */
  cx: number;
  cy: number;
  /** World tile of the window's top-left cell (the session origin). */
  x0: number;
  y0: number;
  project: Project;
  /** Born road cells at build time (row-major window cells); the
   *  simulation keeps it current as roads grow. */
  roads: Uint8Array;
  /** Growth tick of each overlapping region the build reflects. */
  ticks: Map<number, number>;
  actors: WindowActor[];
}

export function windowOrigin(cx: number, cy: number): { x0: number; y0: number } {
  return { x0: (cx - 1) * CHUNK, y0: (cy - 1) * CHUNK };
}

/** The window's chunk coordinates, row-major. */
export function windowChunks(cx: number, cy: number): [number, number][] {
  const out: [number, number][] = [];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) out.push([cx + dx, cy + dy]);
  return out;
}

export function windowRegions(cx: number, cy: number): [number, number][] {
  const out: [number, number][] = [];
  const seen = new Set<number>();
  for (const [x, y] of windowChunks(cx, cy)) {
    const rx = Math.floor(x / REGION_CHUNKS), ry = Math.floor(y / REGION_CHUNKS);
    const k = regionKey(rx, ry);
    if (!seen.has(k)) { seen.add(k); out.push([rx, ry]); }
  }
  return out;
}

function villagerLines(plan: RegionPlan, seed: number): string[] {
  return [
    `VILLAGER: Welcome to ${plan.name}.`,
    `The road grew here when you came near,`,
    `from seed 0x${seedHex(seed)}, region ${plan.rx},${plan.ry}.`,
  ];
}
function plaqueLines(plan: RegionPlan, seed: number): string[] {
  const g = regionGates(seed, plan.rx, plan.ry);
  const roads = [g.n.active ? "north" : "", g.e.active ? "east" : "", g.s.active ? "south" : "", g.w.active ? "west" : ""].filter(Boolean);
  return [
    `<${plan.name}>`,
    `Grown by rule from seed 0x${seedHex(seed)} the day you found it.`,
    roads.length ? `Roads run ${roads.join(", ")}.` : "No road leaves this place.",
  ];
}

/**
 * Build the window around chunk (cx, cy) in slices. Every chunk of the
 * window and the plans of every region it overlaps must be resident.
 * `tickOf` gives each region's growth tick at build time; `start` is the
 * player's world tile (the document's start cell).
 */
export function* windowJob(
  res: Residency, seed: number, cx: number, cy: number,
  tickOf: (rx: number, ry: number) => number,
  start: { x: number; y: number; dir: "down" | "left" | "up" | "right" },
  includeUpper = false,
): Generator<number, WindowBuild> {
  const { x0, y0 } = windowOrigin(cx, cy);
  const chunks: ChunkData[] = [];
  const ticks = new Map<number, number>();
  for (const [x, y] of windowChunks(cx, cy)) {
    const c = res.chunk(x, y);
    if (!c) throw new Error(`wander: window chunk ${x},${y} is not resident`);
    chunks.push(c);
    const k = regionKey(c.rx, c.ry);
    if (!ticks.has(k)) ticks.set(k, tickOf(c.rx, c.ry));
  }
  const ground: TileId[] = new Array(WINDOW * WINDOW);
  const roads = new Uint8Array(WINDOW * WINDOW);
  const upper: [number, TileId][] = [];
  const passage: [number, "block"][] = [];
  for (let wy = 0; wy < WINDOW; wy++) {
    const crow = Math.floor(wy / CHUNK) * WINDOW_CHUNKS;
    const ly = wy % CHUNK;
    for (let wx = 0; wx < WINDOW; wx++) {
      const c = chunks[crow + Math.floor(wx / CHUNK)]!;
      const i = ly * CHUNK + (wx % CHUNK);
      const k = ticks.get(regionKey(c.rx, c.ry))!;
      const at = wy * WINDOW + wx;
      const g = groundAt(c, i, k);
      ground[at] = TILE_IDS[g || BIOME_BASE_TILE[c.terrain[i]! & 3]]!;
      if (roadAt(c, i, k)) roads[at] = 1;
      if (includeUpper) {
        const u = upperAt(c, i, k);
        if (u) upper.push([at, TILE_IDS[u]!]);
      }
      if (blocksAt(c, i, k)) passage.push([at, "block"]);
    }
    if ((wy & 3) === 3) yield 4 * WINDOW;
  }

  // Residents and plaques of every overlapping region.
  const events: GameEvent[] = [];
  const actors: WindowActor[] = [];
  for (const [rx, ry] of windowRegions(cx, cy)) {
    const plan = res.plan(rx, ry);
    if (!plan) throw new Error(`wander: window plan ${rx},${ry} is not resident`);
    if (plan.empty || !plan.hub.town) continue;
    for (const v of plan.villagers) {
      // The whole walk must fit inside the window (the map edge blocks).
      if (v.minX <= x0 || v.minY <= y0 || v.maxX >= x0 + WINDOW - 1 || v.maxY >= y0 + WINDOW - 1) continue;
      const switchId = `b:${v.id}`;
      events.push({
        id: v.id,
        name: `${plan.name} resident`,
        x: v.x - x0,
        y: v.y - y0,
        pages: [{
          condition: { switch: switchId },
          trigger: "action",
          sprite: "villager",
          blocks: true,
          moveRoute: { steps: [...v.route], repeat: true, skippable: false },
          commands: [{ op: "text", lines: villagerLines(plan, seed) }],
        }],
      });
      actors.push({ id: v.id, switchId, born: v.born, rx, ry });
    }
    const px = plan.hub.x + 1, py = plan.hub.y + 1;
    if (px > x0 && py > y0 && px < x0 + WINDOW - 1 && py < y0 + WINDOW - 1) {
      const li = (py - plan.y0) * REGION + (px - plan.x0);
      const born = plan.flags![li]! & F_BLOCK ? plan.born![li]! : 0;
      const id = `plaque${rx}_${ry}`;
      events.push({
        id, name: `${plan.name} plaque`, x: px - x0, y: py - y0,
        pages: [{ condition: { switch: `b:${id}` }, trigger: "action", sprite: null, commands: [{ op: "text", lines: plaqueLines(plan, seed) }] }],
      });
      actors.push({ id, switchId: `b:${id}`, born, rx, ry });
    }
  }
  events.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  yield 200;

  const map: MapDef = {
    id: MAP_ID,
    name: `Wander ${x0},${y0}`,
    width: WINDOW,
    height: WINDOW,
    sheets: [SHEET.id],
    ground,
    ...(includeUpper ? { upper } : {}),
    passage,
    events,
  };
  const project: Project = {
    format: "rpgkit-project/v1",
    title: `Wander 0x${seedHex(seed)} at ${x0},${y0}`,
    tileSize: 16,
    start: { map: MAP_ID, x: start.x - x0, y: start.y - y0, dir: start.dir },
    sheets: [{ ...SHEET }],
    items: [],
    sprites: { villager: { kind: "image", src: VILLAGER_SPRITE } },
    maps: [map],
  };
  return { cx, cy, x0, y0, project, roads, ticks, actors };
}

export function buildWindow(
  res: Residency, seed: number, cx: number, cy: number,
  tickOf: (rx: number, ry: number) => number,
  start: { x: number; y: number; dir: "down" | "left" | "up" | "right" },
  includeUpper = false,
): WindowBuild {
  const job = windowJob(res, seed, cx, cy, tickOf, start, includeUpper);
  for (;;) {
    const r = job.next();
    if (r.done) return r.value;
  }
}
