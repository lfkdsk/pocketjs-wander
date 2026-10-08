// tests/wander-online-view.test.ts — the online view on the deterministic
// sim host: the world renders real terrain (not a monochrome grid), the
// viewport fills the window at 480x272 and 960x544, the creation preview
// changes with the selected look, the HUD hides debug by default, and a
// tap on the charset grid types.
import { describe, expect, test } from "bun:test";
import { bootWorld, treeHasText } from "../vendor/pocket-rpgkit/vendor/pocketjs/hosts/sim/sim.ts";
import { __packTouch } from "../vendor/pocket-rpgkit/vendor/pocketjs/framework/src/touch.ts";
import { appBundle, appPreflight } from "./helpers/boot.ts";
import { fakeOnlineSocketFactory } from "./lib/fake-online-socket.ts";
import { BTN } from "@pocketjs/framework/input";
import { FACING_CH, lookFrameRGBA, type LookPose } from "../examples/wander/look-assets.ts";
import { createLayout, createNameGrid, statusPlate } from "../examples/wander-online/hud.ts";
import type { OnlinePublished } from "../examples/wander-online/OnlineView.tsx";
import { encodeRoster, encodeState, encodeWelcome, type WireEntity } from "../examples/wander-online/net/protocol.ts";
import type { PocketSocket, SocketCloseEvent } from "@pocketjs/framework/socket";

const preflight = appPreflight("wander-online");
if (!preflight.ok) console.warn(`wander-online view tests skipped: ${preflight.reason}`);
const simDescribe = preflight.ok ? describe : describe.skip;

interface World {
  frame: (b: number, a?: number, t?: readonly number[]) => void;
  tick: () => void;
  render: () => Uint8Array;
  getTree: () => unknown;
  ticksPerFrame: number;
}

async function boot(
  auth: unknown,
  socketFactory: (url: string) => unknown,
  width = 480,
  height = 272,
  globals: Record<string, unknown> = {},
): Promise<World> {
  // Sim globals are process-wide; never let a previous boot satisfy a new
  // world's async join/probe predicates.
  (globalThis as { __onlineState?: OnlinePublished }).__onlineState = undefined;
  (globalThis as { __onlineVillagerPositions?: Record<string, VillagerProbe> }).__onlineVillagerPositions = undefined;
  return (await bootWorld(
    appBundle("wander-online"),
    60,
    {
      __onlineUrl: "ws://fake/ws",
      __onlineAuth: auth,
      __onlineSocketFactory: socketFactory,
      ...globals,
    },
    undefined,
    { width, height },
  )) as unknown as World;
}

function pump(w: World, frames: number, mask = 0, touches?: readonly number[]): void {
  for (let f = 0; f < frames; f++) {
    w.frame(mask, undefined, touches);
    for (let t = 0; t < w.ticksPerFrame; t++) w.tick();
  }
}

const state = (): OnlinePublished | undefined =>
  (globalThis as { __onlineState?: OnlinePublished }).__onlineState;

const waitFor = async (w: World, pred: () => boolean, what: string, timeoutMs = 8000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    pump(w, 1);
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timeout waiting for ${what}`);
};

function press(w: World, btn: number): void {
  pump(w, 1, btn);
  pump(w, 1, 0);
}

function count(fb: Uint8Array, stride: number, pred: (r: number, g: number, b: number) => boolean, x0: number, x1: number, y0: number, y1: number): number {
  let n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = (y * stride + x) * 4;
    if (pred(fb[i]!, fb[i + 1]!, fb[i + 2]!)) n++;
  }
  return n;
}

const black = (r: number, g: number, b: number) => r === 0 && g === 0 && b === 0;

/** The opaque PSM_4444-quantized colors of a look's every frame (any pose,
 *  any facing): the player sprite must show some of them. */
function playerColors(look: number): Set<string> {
  const base = Math.floor(look / 4);
  const palette = look % 4;
  const colors = new Set<string>();
  for (const pose of ["idle", "walkL", "walkR"] as const) {
    for (const facing of ["d", "l", "u", "r"] as const) {
      const rgba = lookFrameRGBA(base, palette, pose, facing);
      for (let i = 0; i < rgba.length; i += 4) {
        if (rgba[i + 3]! < 128) continue;
        const q = (c: number) => (c >> 4) * 17;
        colors.add(`${q(rgba[i]!)},${q(rgba[i + 1]!)},${q(rgba[i + 2]!)}`);
      }
    }
  }
  return colors;
}

const welcome = () => fakeOnlineSocketFactory({ mode: "welcome", name: "Octo", look: 3, ticket: "t1" });
const needCreate = () => fakeOnlineSocketFactory({ mode: "needCreate", login: "octo", ticket: "t1" });

interface VillagerProbe {
  look: number;
  pose: number;
  facing: number;
  x: number;
  y: number;
  sx: number;
  sy: number;
}

/** A socket whose remote player can be placed after the test discovers a
 *  live resident. This makes the remote name occupy that resident's exact
 *  sprite rows, so the framebuffer can prove the label is a top layer. */
function overlapSocketFactory(control: { place: (x: number, y: number) => void }): (url: string) => PocketSocket {
  return () => {
    let opened = false;
    let frame = 0;
    let readyState: "connecting" | "open" | "closing" | "closed" = "connecting";
    const sock: PocketSocket = {
      url: "fake://online-overlap",
      protocol: "",
      get readyState() {
        return readyState;
      },
      onOpen: undefined,
      onMessage: undefined,
      onClose: undefined,
      onError: undefined,
      send(data: string | ArrayBuffer): boolean {
        if (!opened || typeof data !== "string") return opened;
        let msg: { type?: string };
        try {
          msg = JSON.parse(data);
        } catch {
          return true;
        }
        if (msg.type === "join") queueMicrotask(() => {
          sock.onMessage?.(new Uint8Array(encodeWelcome(1, 0x5eed_0001, 0, 0, new Uint8Array(96 * 96))));
          sock.onMessage?.(new Uint8Array(encodeRoster([
            { id: 1, name: "Octo", look: 3 },
            { id: 2, name: "MMMMMMMMMMMM", look: 20 },
          ])));
          sock.onMessage?.(JSON.stringify({ type: "ready", ticket: "t1" }));
        });
        return true;
      },
      close(code = 1000, reason = ""): void {
        if (!opened) return;
        opened = false;
        readyState = "closed";
        sock.onClose?.({ code, reason, clean: code === 1000 } as SocketCloseEvent);
      },
    };
    control.place = (x, y) => {
      const tx = Math.floor(x / 16);
      const ty = Math.floor(y / 16);
      const remote: WireEntity = {
        id: 2,
        tx,
        ty,
        px: Math.round(x - tx * 16),
        py: Math.round(y - ty * 16),
        dir: 0,
        phase: 0,
        stepDir: 0,
        moving: false,
        walking: false,
        color: 1,
      };
      sock.onMessage?.(new Uint8Array(encodeState(++frame, 0, [remote], { roomOnline: 2, allOnline: 9 })));
    };
    queueMicrotask(() => {
      opened = true;
      readyState = "open";
      sock.onOpen?.();
    });
    return sock;
  };
}

simDescribe("wander-online view: the world on screen", () => {
  for (const [W, H] of [[480, 272], [960, 544]] as const) {
    test(`${W}x${H}: real terrain (not monochrome), fills the window, player visible`, async () => {
      const w = await boot({ kind: "ticket", ticket: "t1" }, welcome(), W, H);
      pump(w, 5);
      await waitFor(w, () => state()?.status === "joined", "joined");
      pump(w, 30);
      const fb = w.render();
      // The field is real terrain: many distinct colors, not a flat grid.
      const seen = new Set<string>();
      for (let i = 0; i < fb.length; i += 4) {
        if (fb[i + 3]! < 128) continue;
        seen.add(`${fb[i]! >> 4},${fb[i + 1]! >> 4},${fb[i + 2]! >> 4}`);
      }
      expect(seen.size, "distinct terrain colors").toBeGreaterThan(30);
      // No black gaps: the ring covers the whole viewport (the window is
      // bigger than either viewport, and the camera clamps to it).
      expect(count(fb, W, black, 0, W, 0, H), "black pixels").toBe(0);
      // The player's walker is on screen near the centre.
      const colors = playerColors(3);
      const match = count(
        fb,
        W,
        (r, g, b) => colors.has(`${r},${g},${b}`),
        Math.max(0, W / 2 - 40),
        Math.min(W, W / 2 + 40),
        Math.max(0, H / 2 - 40),
        Math.min(H, H / 2 + 40),
      );
      expect(match, "player sprite pixels near centre").toBeGreaterThan(8);
      // The name label is in the tree.
      expect(treeHasText(w.getTree(), "Octo")).toBe(true);
      expect(state()!.villagers, "mature frozen town has villagers").toBeGreaterThanOrEqual(1);
      w.frame(0);
    });
  }

  for (const [W, H] of [[480, 272], [960, 544]] as const) {
    test(`${W}x${H}: a remote nameplate paints over a resident mounted later`, async () => {
      const control = { place: (_x: number, _y: number) => {} };
      const w = await boot(
        { kind: "ticket", ticket: "t1" },
        overlapSocketFactory(control),
        W,
        H,
        { __onlineVillagerPositions: {}, __onlineDeferVillagers: true },
      );
      pump(w, 5);
      await waitFor(w, () => state()?.status === "joined", "joined");
      await waitFor(
        w,
        () => Object.keys((globalThis as { __onlineVillagerPositions?: Record<string, VillagerProbe> }).__onlineVillagerPositions ?? {}).length > 0,
        "a visible resident",
      );
      const probes = (globalThis as { __onlineVillagerPositions?: Record<string, VillagerProbe> }).__onlineVillagerPositions!;
      const targetId = Object.keys(probes).find((id) => {
        const v = probes[id]!;
        return v.sx >= 40 && v.sx + 16 < W - 40 && v.sy >= 72 && v.sy + 28 < H - 20;
      }) ?? Object.keys(probes)[0]!;
      const target = probes[targetId]!;
      // Create the remote (and its name) while resident mounting is deferred.
      // In the old interleaved sprites/name implementation, residents mounted
      // on the next frame would therefore cover this already-existing name.
      control.place(target.x, target.y + 14);
      pump(w, 1);
      const beforeMount = (globalThis as { __onlineVillagerPositions?: Record<string, VillagerProbe> })
        .__onlineVillagerPositions?.[targetId]!;
      // Two consecutive snapshots pin the interpolation sample at one exact
      // position. A name sits 14 px above its player, crossing the resident.
      control.place(beforeMount.x, beforeMount.y + 14);
      control.place(beforeMount.x, beforeMount.y + 14);
      (globalThis as { __onlineDeferVillagers?: boolean }).__onlineDeferVillagers = false;
      pump(w, 1);

      const current = (globalThis as { __onlineVillagerPositions?: Record<string, VillagerProbe> })
        .__onlineVillagerPositions?.[targetId];
      expect(current).toBeDefined();
      expect(state()?.remote).toHaveLength(1);
      const tree = w.getTree() as { n?: string; k?: unknown[] };
      const findNamed = (node: unknown, name: string): { n?: string; k?: unknown[] } | null => {
        if (!node || typeof node !== "object") return null;
        const item = node as { n?: string; k?: unknown[] };
        if (item.n === name) return item;
        for (const child of item.k ?? []) {
          const found = findNamed(child, name);
          if (found) return found;
        }
        return null;
      };
      const overlay = findNamed(tree, "online-name-overlay");
      expect(overlay, "dedicated name overlay exists").not.toBeNull();
      expect(findNamed(overlay, "online-local-name"), "local name is in the overlay").not.toBeNull();
      expect(findNamed(overlay, "online-remote-name"), "remote name is in the overlay").not.toBeNull();
      const pose = (["idle", "walkL", "walkR"] as const)[current!.pose] as LookPose;
      const source = lookFrameRGBA(Math.floor(current!.look / 4), current!.look % 4, pose, FACING_CH[current!.facing]!);
      const fb = w.render();
      let labelOverOpaqueResident = 0;
      for (let y = 0; y < 12; y++) {
        for (let x = 0; x < 16; x++) {
          if (source[(y * 16 + x) * 4 + 3]! < 128) continue;
          const sx = current!.sx + x;
          const sy = current!.sy + y;
          if (sx < 0 || sx >= W || sy < 0 || sy >= H) continue;
          const i = (sy * W + sx) * 4;
          const sourceI = (y * 16 + x) * 4;
          const sourceIsLabelColor = source[sourceI] === 0xff && source[sourceI + 1] === 0xe9 && source[sourceI + 2] === 0x7a;
          if (!sourceIsLabelColor && fb[i] === 0xff && fb[i + 1] === 0xe9 && fb[i + 2] === 0x7a) labelOverOpaqueResident++;
        }
      }
      expect(labelOverOpaqueResident, "yellow remote-name ink over opaque resident pixels").toBeGreaterThan(0);
      (globalThis as { __onlineVillagerPositions?: Record<string, VillagerProbe> }).__onlineVillagerPositions = undefined;
      (globalThis as { __onlineDeferVillagers?: boolean }).__onlineDeferVillagers = undefined;
      w.frame(0);
    }, 20_000);
  }
});

simDescribe("wander-online view: HUD", () => {
  test("debug info is hidden by default; TRIANGLE toggles it; name and status always show", async () => {
    const w = await boot(
      { kind: "ticket", ticket: "t1" },
      fakeOnlineSocketFactory({ mode: "welcome", name: "Octo", look: 3, ticket: "t1", population: { roomOnline: 3, allOnline: 12 } }),
    );
    pump(w, 5);
    await waitFor(w, () => state()?.status === "joined", "joined");
    pump(w, 12);
    expect(treeHasText(w.getTree(), "Octo")).toBe(true);
    expect(treeHasText(w.getTree(), "ROOM 3 · ALL 12")).toBe(true);
    expect(state()?.online).toBe(3);
    expect(state()?.allOnline).toBe(12);
    expect(treeHasText(w.getTree(), "RTT")).toBe(false);
    press(w, BTN.TRIANGLE);
    pump(w, 12);
    expect(treeHasText(w.getTree(), "RTT")).toBe(true);
    expect(treeHasText(w.getTree(), "CORR")).toBe(true);
    w.frame(0);
  });

  for (const [W, H] of [[480, 272], [960, 544]] as const) {
    test(`${W}x${H}: a 12-code-point name and room/global maxima fit and paint their suffix`, async () => {
      const longName = "MMMMMMMMMMMM";
      const line = `${longName} · ROOM 32 · ALL 128`;
      const w = await boot(
        { kind: "ticket", ticket: "t1" },
        fakeOnlineSocketFactory({
          mode: "welcome",
          name: longName,
          look: 3,
          ticket: "t1",
          population: { roomOnline: 32, allOnline: 128 },
        }),
        W,
        H,
      );
      pump(w, 5);
      await waitFor(w, () => state()?.status === "joined", "joined");
      pump(w, 12);
      expect(treeHasText(w.getTree(), line)).toBe(true);
      const measure = (text: string): number =>
        (globalThis as unknown as { ui: { measureText(value: string, slot: number): number } }).ui.measureText(text, 0);
      const plate = statusPlate(W, H, false);
      expect(measure(line), "measured HUD line fits its explicit text box").toBeLessThanOrEqual(plate.x1 - 18);
      const suffixX0 = 12 + measure(line.slice(0, -3));
      const suffixX1 = 12 + measure(line);
      const suffixInk = count(
        w.render(),
        W,
        (r, g, b) => r === 0x9f && g === 0xd0 && b === 0xff,
        suffixX0,
        suffixX1,
        plate.y0 + 15,
        plate.y0 + 27,
      );
      expect(suffixInk, "the final ALL 128 digits paint inside the plate").toBeGreaterThan(0);
      w.frame(0);
    });
  }
});

simDescribe("wander-online view: character creation", () => {
  test("the look preview changes with the selection and shows n / 64", async () => {
    const w = await boot({ kind: "github", token: "x" }, needCreate());
    pump(w, 5);
    await waitFor(w, () => state()?.screen === "creating", "creating");
    pump(w, 10);
    const tree = w.getTree();
    expect(treeHasText(tree, "1 / 64")).toBe(true);
    // The preview box holds the walker (non-background pixels).
    const l = createLayout(480, 272);
    const fb0 = w.render();
    const boxPixels = count(
      fb0,
      480,
      (r, g, b) => !(r === 11 && g === 22 && b === 38),
      l.previewBox.x0,
      l.previewBox.x1,
      l.previewBox.y0,
      l.previewBox.y1,
    );
    expect(boxPixels, "walker drawn in the preview").toBeGreaterThan(40);
    // L1 focuses the look, RIGHT cycles the base character (look + 4).
    const before = fb0.slice();
    press(w, BTN.LTRIGGER);
    press(w, BTN.RIGHT);
    pump(w, 2);
    expect(treeHasText(w.getTree(), "5 / 64")).toBe(true);
    const after = w.render();
    let changed = 0;
    for (let y = l.previewBox.y0; y < l.previewBox.y1; y++) {
      for (let x = l.previewBox.x0; x < l.previewBox.x1; x++) {
        const i = (y * 480 + x) * 4;
        if (before[i] !== after[i] || before[i + 1] !== after[i + 1] || before[i + 2] !== after[i + 2]) changed++;
      }
    }
    expect(changed, "preview pixels change with the selected base").toBeGreaterThan(40);
    w.frame(0);
  });

  test("a tap on a charset cell types that character", async () => {
    const w = await boot({ kind: "github", token: "x" }, needCreate());
    pump(w, 5);
    await waitFor(w, () => state()?.screen === "creating", "creating");
    pump(w, 10);
    // Tap the centre of the 'B' cell (index 1: row 0, col 1).
    const l = createLayout(480, 272);
    const g = createNameGrid(l);
    const tx = g.x + 1 * g.cellW + (g.cellW >> 1);
    const ty = g.y + 0 * g.cellH + (g.cellH >> 1);
    pump(w, 1, 0, [__packTouch(0, tx, ty)]);
    pump(w, 2);
    expect(treeHasText(w.getTree(), "octoB")).toBe(true);
    w.frame(0);
  });
});
