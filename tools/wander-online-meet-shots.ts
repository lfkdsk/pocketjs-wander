// tools/wander-online-meet-shots.ts — capture the realm meeting features of
// wander-online (far-player edge markers, emote bubbles, the emote picker,
// the menu with the invite line and the invite notice) at 480x272 and
// 960x544, each also 3x zoomed, with a Chinese display name in every scene.
//
//   bun tools/wander-online-meet-shots.ts [outdir]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootWorld } from "../vendor/pocket-rpgkit/vendor/pocketjs/hosts/sim/sim.ts";
import { appBundle } from "../tests/helpers/boot.ts";
import { fakeOnlineSocketFactory, type FakeOnlineOpts } from "../tests/lib/fake-online-socket.ts";
import { encodePNG } from "../vendor/pocket-rpgkit/vendor/pocketjs/tests/png.ts";
import { BTN } from "../vendor/pocket-rpgkit/vendor/pocketjs/framework/src/input-api.ts";
import { encodeEmote, encodeFarPlayers, encodeRoster, type WireEntity } from "../examples/wander-online/net/protocol.ts";
import { EMOTE } from "../examples/wander-online/net/emote.ts";
import type { PocketSocket } from "@pocketjs/framework/socket";
import type { OnlinePublished } from "../examples/wander-online/OnlineView.tsx";

const out = process.argv[2] ?? "./wander-online-shots";
mkdirSync(out, { recursive: true });

const SEED = 1593842689;
const HUB = { x: 438, y: 42 };
const GROWN_MS = 10_000_000;
const CJK_NAME = "演示网页";
const CJK_FAR = "远方的朋友";

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

interface World {
  frame: (b: number) => void;
  tick: () => void;
  render: () => Uint8Array;
  ticksPerFrame: number;
}

const state = (): OnlinePublished | undefined => (globalThis as { __onlineState?: OnlinePublished }).__onlineState;

function pump(w: World, frames: number, mask = 0): void {
  for (let i = 0; i < frames; i++) {
    w.frame(mask);
    for (let t = 0; t < w.ticksPerFrame; t++) w.tick();
  }
}

function press(w: World, btn: number): void {
  pump(w, 1, btn);
  pump(w, 1, 0);
}

const waitFor = async (w: World, pred: () => boolean, what: string, timeoutMs = 8000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    pump(w, 1);
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timeout waiting for ${what}`);
};

function shot(name: string, w: number, h: number, fb: Uint8Array): void {
  writeFileSync(join(out, `${name}.${w}x${h}.png`), encodePNG(fb, w, h));
  writeFileSync(join(out, `${name}.${w}x${h}-3x.png`), encodePNG(scale3(fb, w, h), w * 3, h * 3));
  console.log(`wrote ${name}.${w}x${h}.png (+3x)`);
}

const remote = (id: number, tx: number, ty: number, color: number): WireEntity => ({
  id, tx, ty, px: 0, py: 0, dir: 0, phase: 0, stepDir: 0, moving: false, walking: false, color,
});

async function scene(W: number, H: number): Promise<void> {
  const remotes: WireEntity[] = [];
  let sock: PocketSocket | null = null;
  const opts: FakeOnlineOpts = {
    mode: "welcome4",
    name: CJK_NAME,
    look: 40,
    ticket: "t1",
    realm: { tx: HUB.x, ty: HUB.y, seed: SEED, epoch: 5, id: "plaza-1" },
    serverTimeMs: GROWN_MS,
    heartbeat: true,
    heartbeatEntities: () => remotes,
    population: { roomOnline: 4, allOnline: 9 },
    inviteReply: { type: "invite", code: "K7MQ2XJ4", realm: "plaza-1", expiresIn: 3600 },
    onSocket: (s) => { sock = s; },
  };
  (globalThis as { __onlineState?: OnlinePublished }).__onlineState = undefined;
  const w = (await bootWorld(
    appBundle("wander-online"),
    60,
    {
      __onlineUrl: "ws://fake/ws",
      __onlineAuth: { kind: "ticket", ticket: "t1" },
      __onlineSocketFactory: fakeOnlineSocketFactory(opts),
    },
    undefined,
    { width: W, height: H },
  )) as unknown as World;
  const push = (buf: ArrayBuffer) => sock!.onMessage?.(new Uint8Array(buf));
  pump(w, 5);
  await waitFor(w, () => state()?.status === "joined", "joined");
  await waitFor(w, () => (state()?.villagers ?? 0) >= 1, "residents");
  push(encodeRoster([
    { id: 2, name: "DemoOne", look: 20 },
    { id: 3, name: CJK_FAR, look: 12 },
    { id: 4, name: "Bob", look: 33 },
  ]));
  // One walker beside us, two far away: one north-east and near, one
  // south-west and distant.
  remotes.push(remote(2, HUB.x + 3, HUB.y + 1, 2));
  await waitFor(w, () => (state()?.remote.length ?? 0) === 1, "the nearby walker");
  push(encodeFarPlayers([{ id: 3, dir: 1, band: 0 }, { id: 4, dir: 5, band: 2 }]));
  // Both bubbles: ours (cheer) and the neighbour's (wave).
  push(encodeEmote({ id: 1, emote: EMOTE.cheer }));
  push(encodeEmote({ id: 2, emote: EMOTE.wave }));
  pump(w, 6);
  shot("meet-far-and-emotes", W, H, w.render());

  // The emote picker, third cell selected.
  press(w, BTN.RTRIGGER);
  press(w, BTN.RIGHT);
  press(w, BTN.RIGHT);
  pump(w, 2);
  shot("meet-emote-picker", W, H, w.render());
  press(w, BTN.CROSS);

  // The menu with the invite line.
  press(w, BTN.SELECT);
  pump(w, 2);
  shot("meet-menu", W, H, w.render());

  // L mints the invite: the notice shows the token.
  press(w, BTN.LTRIGGER);
  await waitFor(w, () => (state()?.invite ?? "") !== "", "invite token");
  pump(w, 4);
  shot("meet-invite-notice", W, H, w.render());
  w.frame(0);
}

async function main() {
  for (const [W, H] of [[480, 272], [960, 544]] as const) await scene(W, H);
}

await main();
