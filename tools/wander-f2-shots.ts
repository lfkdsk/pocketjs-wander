// tools/wander-f2-shots.ts — capture the F2 evidence set through the BUILT
// "wander" bundle on the deterministic sim host.
//
//   bun run build:wasm && bun run build:example wander
//   bun tools/wander-f2-shots.ts [OUT_DIR]
//
// Every frame is a pure function of the bundle, the seed and the tick:
//
//   f2-villagers-480/960   a villager dialog open (role + lines)
//   f2-errand-480/960      the ERRAND HUD line, complete and untruncated
//   f2-delivered-480/960   DELIVERED notice + plaza flowers
//   f2-auto-talk-480/960   a villager dialog opened by the auto-walker
//   f2-return-480/960      the first town's flowers after 40 helps
//
// All captures are at 480x272 and 960x544; open the 3x copies to inspect.

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { bootWorld } from "../vendor/pocket-rpgkit/vendor/pocketjs/hosts/sim/sim.ts";
import { BTN } from "../vendor/pocket-rpgkit/vendor/pocketjs/contracts/spec/spec.ts";
import { encodePNG } from "../vendor/pocket-rpgkit/vendor/pocketjs/tests/png.ts";
import { appBundle } from "../tests/helpers/boot.ts";
import { regionOf } from "../examples/wander/world.ts";

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

function pump(world: SimWorld, frames: number, mask = 0): void {
  for (let f = 0; f < frames; f++) {
    world.frame(mask);
    for (let t = 0; t < world.ticksPerFrame; t++) world.tick();
  }
}

function save(name: string, fb: Uint8Array, w: number, h: number): void {
  writeFileSync(join(outDir, `${name}.png`), encodePNG(fb, w, h));
  console.log(`  ${name}.png (${w}x${h})`);
}

const SEED = 0x5eed_0001;
const ROLES = ["FARMER", "BAKER", "ELDER", "TRAVELER", "GUARD", "HERBALIST", "CHILD", "MASON"];
const isVillagerDialog = (sim: any): boolean => {
  const m = sim.state.interp.modal;
  if (!m || m.kind !== "text") return false;
  const first = m.lines?.[0] ?? "";
  return ROLES.some((r) => first.startsWith(`${r}:`));
};

/** Pump until a villager dialog is open with at least one content line, then
 *  capture. `skip` dialogs are passed over first, so a later capture shows a
 *  different villager (and different lines) than the first. */
async function captureDialog(name: string, w: number, h: number, maxSeconds = 180, skip = 0): Promise<void> {
  const { world, sim } = await boot(SEED, w, h);
  let seen = 0;
  for (let f = 0; f < 60 * maxSeconds; f++) {
    world.frame(0);
    for (let t = 0; t < world.ticksPerFrame; t++) world.tick();
    if (isVillagerDialog(sim)) {
      // Wait for the typewriter to lay down at least one content line.
      let lined = false;
      for (let s = 0; s < 60 * 3 && !lined; s++) {
        const m = sim.state.interp.modal;
        if (m && m.kind === "text" && (m.lines?.length ?? 0) >= 2) lined = true;
        else { world.frame(0); for (let t = 0; t < world.ticksPerFrame; t++) world.tick(); }
      }
      if (lined) {
        // Let the typewriter render visible characters (the lines array is
        // full at open; the glyphs appear over the next ~half second).
        pump(world, 40);
        if (seen >= skip) { save(name, world.render(), w, h); return; }
        seen++;
        // Close this dialog and keep walking to the next villager.
        world.frame(BTN.CIRCLE);
        for (let t = 0; t < world.ticksPerFrame; t++) world.tick();
        pump(world, 30);
      }
    }
  }
  throw new Error(`no villager dialog in ${maxSeconds}s at ${w}x${h}`);
}

// --- f2-villagers: two different villagers in the SAME town ----------------
// The checkpoint is "same town, two different villagers, different lines", so
// this walks to the start town, talks to villager A (capture), then talks to
// villager B in the same town (capture). Both dialogs must show different
// roles and different lines.
// [dx, dy, button, facingIndex] — facingIndex matches the sim's encoding
// (0=down, 1=left, 2=up, 3=right).
const DIRS: [number, number, number, number][] = [
  [0, 1, BTN.DOWN, 0],
  [-1, 0, BTN.LEFT, 1],
  [0, -1, BTN.UP, 2],
  [1, 0, BTN.RIGHT, 3],
];

/** Pump until `pred` or timeout. Returns true if pred held. */
function pumpUntil(world: SimWorld, sim: any, seconds: number, pred: () => boolean): boolean {
  for (let f = 0; f < 60 * seconds; f++) {
    if (pred()) return true;
    world.frame(0);
    for (let t = 0; t < world.ticksPerFrame; t++) world.tick();
  }
  return pred();
}

/** Position the player next to a villager and open its dialog. The villager
 *  walks, so this re-aims each attempt. Returns true once a villager dialog
 *  is open. The player is placed directly (a screenshot tool, not a live
 *  player): set the tile/pixel adjacent to the villager, face it, CIRCLE. */
function talkToVillager(world: SimWorld, sim: any, villagerId: string, _seconds = 60): boolean {
  for (let attempt = 0; attempt < 12; attempt++) {
    const ch = sim.state.chars.chars[villagerId];
    if (!ch || !ch.visible) return false;
    // Window-local villager tile; find a walkable adjacent tile for the player.
    const table = sim.session.tables.get(sim.window.project.maps[0].id);
    const W = 96;
    // [playerTx, playerTy, facing] — the player stands adjacent and faces the
    // villager (facing: 0=down, 1=left, 2=up, 3=right).
    const spots: [number, number, number][] = [
      [ch.tx, ch.ty + 1, 2], // player south, face up
      [ch.tx, ch.ty - 1, 0], // player north, face down
      [ch.tx + 1, ch.ty, 1], // player east, face left
      [ch.tx - 1, ch.ty, 3], // player west, face right
    ];
    let placed = false;
    for (const [tx, ty, facing] of spots) {
      if (tx < 0 || ty < 0 || tx >= W || ty >= W) continue;
      // Walkable (not solid) and not occupied by another blocking char.
      const idx = ty * W + tx;
      if (table.solid[idx]) continue;
      let occupied = false;
      for (const id in sim.state.chars.chars) {
        const c = sim.state.chars.chars[id]!;
        if (c.blocks && c.tx === tx && c.ty === ty) { occupied = true; break; }
      }
      if (occupied) continue;
      // Place the player here, standing still, facing the villager.
      sim.state.move.tx = tx; sim.state.move.ty = ty;
      sim.state.move.px = tx * 16; sim.state.move.py = ty * 16;
      sim.state.move.moving = false; sim.state.move.phase = 0;
      sim.state.move.facing = facing;
      placed = true;
      break;
    }
    if (!placed) continue;
    // Press CIRCLE (confirm edge) to open the action dialog.
    world.frame(BTN.CIRCLE);
    for (let t = 0; t < world.ticksPerFrame; t++) world.tick();
    world.frame(0);
    for (let t = 0; t < world.ticksPerFrame; t++) world.tick();
    if (isVillagerDialog(sim)) return true;
  }
  return false;
}

/** Close the open dialog by paging through it. */
function closeDialog(world: SimWorld, sim: any): void {
  for (let f = 0; f < 60 * 5 && sim.state.interp.modal; f++) {
    world.frame(BTN.CIRCLE);
    for (let t = 0; t < world.ticksPerFrame; t++) world.tick();
  }
}

for (const [w, h, tag] of [[480, 272, "480"], [960, 544, "960"]] as const) {
  const { world, sim } = await boot(SEED, w, h);
  pump(world, 60 * 8); // let the start town grow and villagers spawn
  const prx = regionOf(sim.playerTile.x), pry = regionOf(sim.playerTile.y);
  // The two NEAREST villagers of the start town (different roles => different
  // lines), so the walk to each is short and reliable.
  const p0 = sim.playerTile;
  const villagers = Object.keys(sim.state.chars.chars)
    .filter((id) => id.startsWith(`v${prx}_${pry}_`))
    .map((id) => {
      const ch = sim.state.chars.chars[id]!;
      const vx = ch.tx + sim.window.x0, vy = ch.ty + sim.window.y0;
      return { id, d: Math.abs(vx - p0.x) + Math.abs(vy - p0.y) };
    })
    .sort((a, b) => a.d - b.d)
    .slice(0, 2)
    .map((v) => v.id);
  if (villagers.length < 2) throw new Error(`start town has <2 villagers at ${w}x${h}`);
  const lines: string[] = [];
  for (let i = 0; i < 2; i++) {
    const vid = villagers[i]!;
    if (!talkToVillager(world, sim, vid)) throw new Error(`could not talk to ${vid} at ${w}x${h}`);
    // Wait until the typewriter has laid down the full first line (the role
    // line), so the screenshot shows the role and town name untruncated.
    pumpUntil(world, sim, 5, () => {
      const m = sim.state.interp.modal;
      if (!m || m.kind !== "text") return false;
      const firstLen = (m.lines?.[0] ?? "").length;
      return (m.revealed ?? 0) >= firstLen + 1;
    });
    pump(world, 20);
    const m = sim.state.interp.modal;
    const first = m?.lines?.[0] ?? "";
    lines.push(first);
    save(`f2-villagers${i === 0 ? "" : "2"}-${tag}`, world.render(), w, h);
    console.log(`    villager ${i + 1}: ${first}`);
    closeDialog(world, sim);
    pump(world, 30);
  }
  if (lines[0] === lines[1]) throw new Error(`the two villagers said the same line at ${w}x${h}: ${lines[0]}`);
}

// --- f2-auto-talk: the auto-walker's first villager dialog ------------------
for (const [w, h, tag] of [[480, 272, "480"], [960, 544, "960"]] as const) {
  await captureDialog(`f2-auto-talk-${tag}`, w, h);
}

// --- f2-errand: the ERRAND HUD line after accepting at the plaza -----------
for (const [w, h, tag] of [[480, 272, "480"], [960, 544, "960"]] as const) {
  const { world, sim } = await boot(SEED, w, h);
  pump(world, 60 * 5); // grow the start town
  sim.pressAction(); // accept the start town's errand
  if (!sim.errand) throw new Error(`no errand accepted at ${w}x${h}`);
  pump(world, 8); // let the HUD refresh
  save(`f2-errand-${tag}`, world.render(), w, h);
  console.log(`    errand: ${sim.errand.kind} -> ${sim.errand.targetName}`);
}

// --- f2-delivered: DELIVERED notice + plaza flowers ------------------------
for (const [w, h, tag] of [[480, 272, "480"], [960, 544, "960"]] as const) {
  const { world, sim } = await boot(SEED, w, h);
  pump(world, 60 * 5);
  sim.pressAction(); // accept
  if (!sim.errand) throw new Error(`no errand at ${w}x${h}`);
  const e = sim.errand;
  // Walk to the errand's target tile (the helped town's plaza for deliver).
  sim.goto(e.ax, e.ay);
  for (let f = 0; f < 60 * 120 && sim.mode !== "manual"; f++) { world.frame(0); for (let t = 0; t < world.ticksPerFrame; t++) world.tick(); }
  pump(world, 30);
  // Capture BEFORE (no flowers yet) at the same view the AFTER shot will use.
  save(`f2-before-${tag}`, world.render(), w, h);
  // Complete the errand (deliver: press CROSS at the target; visit: arrive).
  if (e.kind === "deliver") sim.pressAction();
  pump(world, 60 * 2); // settle
  if (sim.helpedCount === 0) throw new Error(`delivery failed at ${w}x${h}`);
  // The DELIVERED notice is up; capture AFTER (flowers on the plaza).
  pump(world, 30);
  save(`f2-delivered-${tag}`, world.render(), w, h);
  const hrx = e.kind === "deliver" ? e.trx : e.orx;
  const hry = e.kind === "deliver" ? e.try : e.ory;
  console.log(`    helped=${sim.helpedCount} town=(${hrx},${hry})`);
}

// --- f2-return: the first town's flowers after 40 helps --------------------
for (const [w, h, tag] of [[480, 272, "480"], [960, 544, "960"]] as const) {
  const { world, sim } = await boot(SEED, w, h);
  pump(world, 60 * 5);
  const sp = sim.playerTile;
  const srx = regionOf(sp.x), sry = regionOf(sp.y);
  sim.__helpForTest(srx, sry); // help the start town
  let helped = 1;
  for (let ry = -8; ry <= 8 && helped < 41; ry++) for (let rx = -8; rx <= 8 && helped < 41; rx++) {
    if (rx === srx && ry === sry) continue;
    const hub = sim.res.hub(rx, ry);
    if (!hub.town) continue;
    sim.__helpForTest(rx, ry);
    helped++;
  }
  // Evict the start plan by walking far, then walk back.
  const far = { x: sp.x + 3000, y: sp.y };
  sim.goto(far.x, far.y);
  for (let f = 0; f < 60 * 400 && sim.mode !== "manual"; f++) { world.frame(0); for (let t = 0; t < world.ticksPerFrame; t++) world.tick(); }
  sim.goto(sp.x, sp.y);
  for (let f = 0; f < 60 * 400 && sim.mode !== "manual"; f++) { world.frame(0); for (let t = 0; t < world.ticksPerFrame; t++) world.tick(); }
  pump(world, 60 * 3); // let the plan regenerate + flowers regrow
  save(`f2-return-${tag}`, world.render(), w, h);
  console.log(`    helped=${sim.helpedCount} startHelped=${sim.isHelped(srx, sry)}`);
}

console.log(`shots -> ${outDir}`);
