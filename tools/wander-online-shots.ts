// tools/wander-online-shots.ts — capture the wander-online screens (web
// login guide, desktop link-code keypad, character creation, three-player
// world, menu) at 480x272 and 960x544, 3x zoomed.
//
//   bun tools/wander-online-shots.ts [outdir]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootWorld } from "../vendor/pocketjs/hosts/sim/sim.ts";
import { appBundle } from "../tests/helpers/boot.ts";
import { fakeOnlineSocketFactory } from "../tests/lib/fake-online-socket.ts";
import { encodePNG } from "../vendor/pocketjs/tests/png.ts";
import { BTN } from "../vendor/pocketjs/framework/src/input-api.ts";
import { encodeRoster, encodeState, encodeWelcome, type WireEntity } from "../examples/wander-online/net/protocol.ts";
import type { PocketSocket, SocketCloseEvent } from "@pocketjs/framework/socket";

const out = process.argv[2] ?? "/tmp/wander-online-shots";
mkdirSync(out, { recursive: true });

function scale3(src: Uint8Array, w: number, h: number): Uint8Array {
  const dst = new Uint8Array(w * 3 * h * 3 * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = (y * w + x) * 4;
      for (let dy = 0; dy < 3; dy++) {
        for (let dx = 0; dx < 3; dx++) {
          const di = ((y * 3 + dy) * (w * 3) + (x * 3 + dx)) * 4;
          dst[di] = src[si]!;
          dst[di + 1] = src[si + 1]!;
          dst[di + 2] = src[si + 2]!;
          dst[di + 3] = 255;
        }
      }
    }
  }
  return dst;
}

async function boot(
  auth: unknown,
  width: number,
  height: number,
  socketFactory?: (url: string) => unknown,
  globals: Record<string, unknown> = {},
) {
  return (await bootWorld(
    appBundle("wander-online"),
    60,
    {
      __onlineUrl: "ws://fake/ws",
      __onlineAuth: auth,
      __onlineSocketFactory: socketFactory ?? fakeOnlineSocketFactory({ mode: "needCreate", login: "octo", ticket: "t1" }),
      ...globals,
    },
    undefined,
    { width, height },
  )) as unknown as {
    frame: (b: number) => void;
    tick: () => void;
    render: () => Uint8Array;
    ticksPerFrame: number;
  };
}

function pump(w: ReturnType<typeof boot> extends Promise<infer T> ? T : never, frames: number, mask = 0): void {
  for (let i = 0; i < frames; i++) {
    w.frame(mask);
    for (let t = 0; t < w.ticksPerFrame; t++) w.tick();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A fake socket that admits the player into a room with two other named
 *  players, so the world shot shows the multiplayer roster (name labels
 *  over every walker). */
function threePlayerSocketFactory(): (url: string) => PocketSocket {
  return () => {
    let opened = false;
    let state: "connecting" | "open" | "closing" | "closed" = "connecting";
    let frame = 0;
    const sendState = () => {
      frame++;
      const entities: WireEntity[] = [];
      // Two remotes walking east of the player, one above the other.
      for (let i = 0; i < 2; i++) {
        entities.push({
          id: i + 2,
          tx: 54 + i * 2,
          ty: 44 + i * 3,
          px: 0,
          py: 0,
          dir: 3,
          phase: 0,
          stepDir: 3,
          moving: true,
          walking: true,
          color: i,
        });
      }
      sock.onMessage?.(new Uint8Array(encodeState(frame, frame, entities)));
    };
    const sock: PocketSocket = {
      url: "fake://online",
      protocol: "",
      get readyState() {
        return state;
      },
      onOpen: undefined,
      onMessage: undefined,
      onClose: undefined,
      onError: undefined,
      send(data: string | ArrayBuffer): boolean {
        if (!opened) return false;
        if (typeof data !== "string") return true;
        let msg: { type?: string };
        try {
          msg = JSON.parse(data);
        } catch {
          return true;
        }
        queueMicrotask(() => {
          if (msg.type === "join") {
            const grid = new Uint8Array(96 * 96);
            sock.onMessage?.(new Uint8Array(encodeWelcome(1, 0x5eed_0001, 0, 0, grid)));
            sock.onMessage?.(
              new Uint8Array(encodeRoster([
                { id: 1, name: "Octo", look: 3 },
                { id: 2, name: "Alice", look: 20 },
                { id: 3, name: "Bob", look: 40 },
              ])),
            );
            sock.onMessage?.(JSON.stringify({ type: "ready", ticket: "t1", login: "octo" }));
            sendState();
          } else if (msg.type === "input") {
            sendState();
          }
        });
        return true;
      },
      close(code = 1000, reason = ""): void {
        if (!opened) return;
        opened = false;
        state = "closed";
        sock.onClose?.({ code, reason, clean: code === 1000 } as SocketCloseEvent);
      },
    };
    queueMicrotask(() => {
      opened = true;
      state = "open";
      sock.onOpen?.();
    });
    return sock;
  };
}
async function shot(name: string, w: number, h: number, fb: Uint8Array): Promise<void> {
  writeFileSync(join(out, `${name}.${w}x${h}.png`), encodePNG(fb, w, h));
  writeFileSync(join(out, `${name}.${w}x${h}-3x.png`), encodePNG(scale3(fb, w, h), w * 3, h * 3));
  console.log(`${name}.${w}x${h}.png`);
}

async function main() {
  for (const [w, h] of [[480, 272], [960, 544] as const]) {
    // 1. Web login guide (the OAuth button itself belongs to the host page).
    {
      const world = await boot(null, w, h, undefined, { __pocketWeb: true });
      pump(world, 20);
      await sleep(50);
      pump(world, 10);
      await shot("login-guide", w, h, world.render());
      world.frame(0);
    }

    // 2. Desktop six-digit link-code keypad.
    {
      const world = await boot(null, w, h);
      pump(world, 20);
      await sleep(50);
      pump(world, 10);
      await shot("desktop-link-code", w, h, world.render());
      world.frame(0);
    }

    // 3. Character creation.
    {
      const world = await boot({ kind: "github", token: "x" }, w, h);
      pump(world, 20);
      await sleep(50);
      pump(world, 10);
      await shot("create-character", w, h, world.render());
      world.frame(0);
    }

    // 4. Three players in the world.
    {
      const world = await boot({ kind: "ticket", ticket: "t1" }, w, h, threePlayerSocketFactory());
      pump(world, 30);
      await sleep(50);
      pump(world, 30);
      await shot("world-3p", w, h, world.render());
      // 5. The SELECT menu over the same world.
      pump(world, 2, BTN.SELECT);
      pump(world, 4);
      await shot("menu", w, h, world.render());
      world.frame(0);
    }
  }
}

await main();
