// tools/wander-char-shots.ts — capture the W-CHAR evidence set through the
// BUILT "wander" bundle on the deterministic sim host.
//
//   bun run build:wasm && bun run build:example wander
//   bun tools/wander-char-shots.ts [OUT_DIR]
//
// Every frame is a pure function of the bundle, the seed and the tick:
//
//   char-town-480/960      one grown town: several villagers in distinct
//                          looks, the player among them
//   char-towns-480/960     two towns of different seeds side by side, to
//                          compare how the look pool dresses different worlds
//   char-player-480/960    the player (a pool look) walking with villagers
//
// All captures are at 480x272 and 960x544; open the 3x copies to inspect.

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { bootWorld } from "../vendor/pocket-rpgkit/vendor/pocketjs/hosts/sim/sim.ts";
import { encodePNG } from "../vendor/pocket-rpgkit/vendor/pocketjs/tests/png.ts";
import { appBundle } from "../tests/helpers/boot.ts";

interface SimWorld {
  frame: (b: number, a?: number, t?: readonly number[]) => void;
  tick: () => void;
  render: () => Uint8Array;
  ticksPerFrame: number;
}

const root = resolve(import.meta.dir, "..");
const outDir = resolve(process.argv[2] ?? join(tmpdir(), "wander-char-shots"));
mkdirSync(outDir, { recursive: true });

async function boot(seed: number, w: number, h: number): Promise<{ world: SimWorld; sim: any }> {
  const world = (await bootWorld(appBundle("wander"), 60, { __wanderSeed: seed, __wanderVillagerLooks: {} }, undefined, { width: w, height: h })) as unknown as SimWorld;
  const sim = (globalThis as any).__wanderSim;
  return { world, sim };
}

function pump(world: SimWorld, frames: number, mask = 0): void {
  for (let f = 0; f < frames; f++) {
    world.frame(mask);
    for (let t = 0; t < world.ticksPerFrame; t++) world.tick();
  }
}

function scale3(src: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h * 9 * 4);
  const stride = w * 3;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const at = (y * w + x) * 4;
    for (let dy = 0; dy < 3; dy++) for (let dx = 0; dx < 3; dx++) {
      out.set(src.subarray(at, at + 4), ((y * 3 + dy) * stride + x * 3 + dx) * 4);
    }
  }
  return out;
}

function save(name: string, fb: Uint8Array, w: number, h: number): void {
  writeFileSync(join(outDir, `${name}.png`), encodePNG(fb, w, h));
  writeFileSync(join(outDir, `${name}-3x.png`), encodePNG(scale3(fb, w, h), w * 3, h * 3));
  console.log(`  ${name}.png (${w}x${h})`);
}

/** Pump until at least `minLooks` distinct villager looks are on screen,
 *  then return the framebuffer. */
async function captureTown(seed: number, w: number, h: number, minLooks = 4, growSeconds = 8): Promise<Uint8Array> {
  const { world, sim } = await boot(seed, w, h);
  pump(world, 60 * growSeconds);
  let fb = world.render();
  // Walk a little so villagers are mid-stride and spread out.
  for (let f = 0; f < 120; f++) {
    pump(world, 1, (f >> 4) & 1 ? 1 : 2); // alternate LEFT/RIGHT
    const looks = (globalThis as any).__wanderVillagerLooks ?? {};
    const distinct = new Set(Object.values(looks as any[]).map((v: any) => v.lookId)).size;
    fb = world.render();
    if (distinct >= minLooks) break;
  }
  return fb;
}

const SEED_A = 0x5eed_0001;
const SEED_B = 0x5eed_0002;

for (const [w, h] of [[480, 272], [960, 544]] as const) {
  const tag = `${w}x${h}`;
  console.log(`-- ${tag} --`);
  // One grown town: several villagers in distinct looks + the player.
  save(`char-town-${tag}`, await captureTown(SEED_A, w, h), w, h);
  // A second world's town, to compare how the pool dresses a different seed.
  save(`char-towns-${tag}`, await captureTown(SEED_B, w, h), w, h);
  // The player walking among villagers (hold RIGHT for a moment first).
  {
    const { world } = await boot(SEED_A, w, h);
    pump(world, 60 * 6);
    pump(world, 30, 2); // RIGHT
    pump(world, 6);
    save(`char-player-${tag}`, world.render(), w, h);
  }
}
console.log(`shots in ${outDir}`);
