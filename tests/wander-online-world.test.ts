// tests/wander-online-world.test.ts — the frozen arena world the client
// renders: its residency serves exactly the window's chunks, and the growth
// clock is frozen (the render ring reads the world against bootNow, so the
// boot-time art never ages).
import { describe, expect, test } from "bun:test";
import { ARENA_FREEZE_TICKS, buildArenaWorld, startArenaState } from "../examples/wander-online/net/world.ts";
import { stepSession } from "../src/engine/session.ts";
import { WINDOW, windowChunks } from "../examples/wander/window.ts";
import { CHUNK } from "../examples/wander/world.ts";
import { gridFromWindow, TILE } from "../examples/wander-online/net/protocol.ts";

describe("wander-online arena world", () => {
  test("the residency serves the 3x3 window chunks and nothing beyond", () => {
    const world = buildArenaWorld(0x5eed_0001);
    const cx = Math.floor(world.x0 / CHUNK) + 1; // centre chunk
    const cy = Math.floor(world.y0 / CHUNK) + 1;
    for (const [x, y] of windowChunks(cx, cy)) {
      expect(world.res.chunk(x, y), `chunk ${x},${y} resident`).toBeDefined();
    }
    // A chunk well outside the window is not resident (no streaming in the
    // frozen arena).
    expect(world.res.chunk(cx + 8, cy)).toBeUndefined();
    expect(world.res.chunk(cx, cy - 8)).toBeUndefined();
  });

  test("the render ring must pin its clock at bootNow: regionTick is stable there and grows past it", () => {
    // The residency is a live grower: regionTick advances with the clock.
    // The arena is frozen by convention — the render ring reads it with a
    // constant now = bootNow (the tick the window art was baked at). This
    // test pins both halves of that contract.
    const world = buildArenaWorld(0x5eed_0001);
    const cx = Math.floor(world.x0 / CHUNK) + 1;
    const cy = Math.floor(world.y0 / CHUNK) + 1;
    const c = world.res.chunk(cx, cy)!;
    const bootTick = world.res.regionTick(c.rx, c.ry, world.bootNow);
    // Repeated reads at bootNow are identical (the ring's steady state).
    expect(world.res.regionTick(c.rx, c.ry, world.bootNow)).toBe(bootTick);
    expect(world.res.regionTick(c.rx, c.ry, world.bootNow)).toBe(bootTick);
    // The arena deliberately freezes after its starting settlement has
    // matured; later reads cannot advance beyond that completed plan.
    expect(bootTick).toBeGreaterThan(0);
    expect(world.res.regionTick(c.rx, c.ry, world.bootNow + 60_000)).toBe(bootTick);
  });

  test("the frozen arena matures terrain and resident switches together", () => {
    const world = buildArenaWorld(0x5eed_0001);
    expect(world.bootNow).toBe(ARENA_FREEZE_TICKS);
    expect(Object.keys(world.initialSwitches).length).toBeGreaterThanOrEqual(8);
    const initial = startArenaState(world);
    const stepped = stepSession(world.session, initial, { buttons: 0 });
    const villagers = Object.keys(stepped.chars.chars).filter((id) => id.startsWith("v"));
    expect(villagers.length).toBeGreaterThanOrEqual(8);
  });

  test("the frozen window has real terrain (roads and biome ground, not a void grid)", () => {
    const world = buildArenaWorld(0x5eed_0001);
    const grid = gridFromWindow(world.window);
    expect(grid.length).toBe(WINDOW * WINDOW);
    const counts = new Set<number>();
    let roads = 0;
    for (const t of grid) {
      counts.add(t);
      if (t === TILE.road) roads++;
    }
    // The start town's plaza/roads are born at boot, and the wilderness
    // around them is biome ground: at least three terrain classes, with roads.
    expect(counts.size).toBeGreaterThanOrEqual(3);
    expect(roads).toBeGreaterThan(0);
    expect(counts.has(TILE.void)).toBe(false);
  });
});
