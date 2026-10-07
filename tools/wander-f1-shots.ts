// tools/wander-f1-shots.ts — capture the F1 evidence set through the BUILT
// "wander" bundle on the deterministic sim host.
//
//   bun run build:wasm && bun run build:example wander
//   bun tools/wander-f1-shots.ts [OUT_DIR]
//
// Every frame is a pure function of the bundle, the seed and the tick:
//
//   f1-rumor-480       bottom line LOG n - <kind> RUMOR: <kind> <dir> <dist>
//   f1-found-480/960   FOUND notice and the landmark on screen together
//   f1-wild-480/960    a wilderness landmark (no houses around it)
//   f1-journal-480/960 the travel log paged open + the minimap gold dot
//   f1-39936d2c-300s-480/960  seed 0x39936d2c at elapsed 300 s, HUD past
//                      300 tiles from spawn (fast walk, same virtual clock)
//
// The 300 s frame is captured at exactly 18 000 reference ticks (300 s),
// not on a distance trigger.

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { bootWorld } from "../vendor/pocket-rpgkit/vendor/pocketjs/hosts/sim/sim.ts";
import { BTN } from "../vendor/pocket-rpgkit/vendor/pocketjs/contracts/spec/spec.ts";
import { encodePNG } from "../vendor/pocket-rpgkit/vendor/pocketjs/tests/png.ts";
import { appBundle } from "../tests/helpers/boot.ts";
import { clearOfHud, landmarkBox } from "../examples/wander/hud.ts";

interface SimWorld {
  frame: (b: number, a?: number, t?: readonly number[]) => void;
  tick: () => void;
  render: () => Uint8Array;
  ticksPerFrame: number;
}

const root = resolve(import.meta.dir, "..");
const outDir = resolve(process.argv[2] ?? join(tmpdir(), "wander-shots"));
mkdirSync(outDir, { recursive: true });

async function boot(seed: number, w: number, h: number, fast = false): Promise<{ world: SimWorld; sim: any }> {
  const world = (await bootWorld(appBundle("wander"), 60, { __wanderSeed: seed, __wanderFast: fast }, undefined, { width: w, height: h })) as unknown as SimWorld;
  const sim = (globalThis as any).__wanderSim;
  return { world, sim };
}

function pump(world: SimWorld, frames: number): void {
  for (let f = 0; f < frames; f++) {
    world.frame(0);
    for (let t = 0; t < world.ticksPerFrame; t++) world.tick();
  }
}

function save(name: string, fb: Uint8Array, w: number, h: number): void {
  writeFileSync(join(outDir, `${name}.png`), encodePNG(fb, w, h));
  console.log(`  ${name}.png (${w}x${h})`);
}

const SEED = 0x5eed_0001;

// --- f1-rumor-480: the bottom line, complete and untruncated -------------
{
  const { world, sim } = await boot(SEED, 480, 272);
  pump(world, 120); // 2 s: town grown, a rumor is on the HUD
  const rumor = sim.nearestRumor();
  if (!rumor) throw new Error("no rumor at 2 s");
  save("f1-rumor-480", world.render(), 480, 272);
}

// --- f1-found: FOUND notice and the landmark on screen together -----------
// Capture when the landmark is FULLY in view (not at the edge, not under the
// HUD bars): after discovery, keep walking until the landmark centre sits in
// the central band of the viewport and the player is a few tiles from it, so
// the landmark is identifiable at a glance.
for (const [w, h, tag] of [[480, 272, "480"], [960, 544, "960"]] as const) {
  const { world, sim } = await boot(SEED, w, h);
  // Walk to the nearest undiscovered landmark (the HUD rumor points at it),
  // so the discovery is deterministic and quick instead of waiting for the
  // auto-walker to wander past one.
  const rumor = sim.nearestRumor();
  if (!rumor) throw new Error(`no rumor at boot at ${w}x${h}`);
  sim.goto(rumor.x, rumor.y);
  let captured = false;
  let discovered = false;
  for (let f = 0; f < 60 * 120 && !captured; f++) {
    world.frame(0);
    for (let t = 0; t < world.ticksPerFrame; t++) world.tick();
    if (sim.log.version > 0) discovered = true;
    if (!discovered) continue;
    // Landmark centre screen position (the camera centres on the player).
    const p = sim.playerPx;
    const sx = rumor.x * 16 - p.x + w / 2;
    const sy = rumor.y * 16 - p.y + h / 2;
    const pt = sim.playerTile;
    const dist = Math.abs(pt.x - rumor.x) + Math.abs(pt.y - rumor.y);
    // Capture when the landmark's WHOLE 3 x 3 footprint (not just its
    // centre anchor) is clear of every HUD bar and the player is a few tiles
    // from it, so every standing stone is identifiable at a glance. The old
    // centre-point band check passed by 0.16 px while the footprint sat
    // under the LOG/RUMOR bar.
    const goodX = sx > w * 0.18 && sx < w * 0.82;
    const clear = clearOfHud(landmarkBox(sx, sy), w, h);
    if (goodX && clear && dist >= 3 && dist <= 16) {
      save(`f1-found-${tag}`, world.render(), w, h);
      console.log(`    landmark screen=(${sx.toFixed(0)},${sy.toFixed(0)}) dist=${dist}`);
      captured = true;
    }
  }
  if (!captured) throw new Error(`no good f1-found frame in 120 s at ${w}x${h}`);
}

// --- f1-wild: a wilderness landmark (no houses around it) ----------------
const WILD = { x: -142, y: 214 }; // closest pure-wilderness landmark to spawn
for (const [w, h, tag] of [[480, 272, "480"], [960, 544, "960"]] as const) {
  const { world, sim } = await boot(SEED, w, h);
  sim.goto(WILD.x, WILD.y);
  // Walk to the landmark (fast: ~133 s at 8 tiles/s = ~8000 frames).
  for (let f = 0; f < 60 * 200; f++) {
    world.frame(0);
    for (let t = 0; t < world.ticksPerFrame; t++) world.tick();
    const p = sim.playerTile;
    if (Math.abs(p.x - WILD.x) + Math.abs(p.y - WILD.y) <= 4) break;
  }
  save(`f1-wild-${tag}`, world.render(), w, h);
}

// --- f1-journal: the travel log paged open + minimap gold dot -------------
for (const [w, h, tag] of [[480, 272, "480"], [960, 544, "960"]] as const) {
  const { world, sim } = await boot(SEED, w, h);
  // Walk until at least one landmark is logged (the start-town linger plus
  // the walk to the first landmark can take a minute or two).
  for (let f = 0; f < 60 * 180 && sim.log.total === 0; f++) {
    world.frame(0);
    for (let t = 0; t < world.ticksPerFrame; t++) world.tick();
  }
  if (sim.log.total === 0) throw new Error(`no discovery in 180 s at ${w}x${h}`);
  // CROSS pages the travel log open.
  world.frame(BTN.CROSS);
  for (let t = 0; t < world.ticksPerFrame; t++) world.tick();
  pump(world, 30); // let the page settle
  save(`f1-journal-${tag}`, world.render(), w, h);
}

// --- f1-39936d2c-300s: seed 0x39936d2c at elapsed 300 s -----------------
for (const [w, h, tag] of [[480, 272, "480"], [960, 544, "960"]] as const) {
  const { world, sim } = await boot(0x39936d2c, w, h, true);
  const spawn = { ...sim.playerTile };
  pump(world, 300 * 60); // exactly 300 virtual seconds
  const p = sim.playerTile;
  const dist = Math.round(Math.hypot(p.x - spawn.x, p.y - spawn.y));
  console.log(`  39936d2c 300 s: spawn=(${spawn.x},${spawn.y}) pos=(${p.x},${p.y}) dist=${dist}`);
  if (dist <= 300) throw new Error(`300 s distance ${dist} <= 300`);
  save(`f1-39936d2c-300s-${tag}`, world.render(), w, h);
}

console.log(`shots -> ${outDir}`);
