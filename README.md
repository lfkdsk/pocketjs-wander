# pocketjs-wander

An endless grown world that streams in around the player, running on
[PocketJS](https://github.com/pocket-nexus/pocketjs) (desktop, web, devices)
and built with [Pocket RPG Kit](https://github.com/lfkdsk/pocketjs-rpgkit).
Towns grow as you reach them; landmarks, rumors and errands wait in the
wilds; and when you put it down, the world wanders itself. A local
multiplayer demo shares one world between desktop hosts and a browser tab.

| A grown town beside a snow border (sim golden) | On the desktop host, walking to a clicked tile |
| --- | --- |
| ![Wander at 960x544](tests/goldens/wander.960.2100.png) | ![Wander at 480x272](tests/goldens/wander.480.300.png) |

## Run it

```sh
bun run setup        # submodules (Pocket RPG Kit + PocketJS) and dependencies
bun run build:wasm   # the PocketJS core the sim host and web build use
bun run build        # wander and wander-online bundles + paks (dist/)
bun run desktop      # wander in a desktop window (add wander-online for the demo)
bun run web          # the browser-playable site in dist/web (wander only)
```

Serve `dist/web` with any static file server and open the wander page.
DPAD walks; any key takes over from the auto-walk and 10 idle seconds hand
it back; TRIANGLE toggles fast travel, SQUARE rolls a new seed, CIRCLE reads
a town's notice board. Click or tap a tile to walk there.

The world, its residency and the auto-walk trajectory are deterministic at
60/30/20/4 Hz: two runs agree tick for tick, and a serialize/restore round
trip continues the same session (pinned by `tests/wander-f1.test.ts` and
`tests/wander-f2.test.ts`).

## Local multiplayer demo

wander-online shares one frozen wander window between a Bun authoritative
server (20 Hz, 10 Hz area-of-interest snapshots, loopback-only) and clients
with prediction (rollback-and-replay against `ackSeq` watermarks) and 100 ms
remote interpolation:

```sh
bun run examples/wander-online/server/server.ts   # the authoritative server
bun run desktop wander-online                     # a desktop client (run twice for two windows)
bun run web wander-online                         # a browser tab (serve dist/web)
```

`bun run online:demo` runs the full acceptance demo — two desktop hosts and
a browser tab seeing each other (repeated three times), a 150 ms latency
phase, a server-restart-under-live-clients phase, and a 100-bot load phase
— and writes screenshots and a JSON summary. See
[`examples/wander-online/README.md`](examples/wander-online/README.md) for
the protocol, the demo phases and the Cloudflare deployment notes.

wander-online is a local demo: the server binds loopback and the published
web site only ships wander.

## Layout

- `examples/wander/` — the endless world: pure chunk generation
  (`chunk.ts`, `region.ts`, `world.ts`), focus-driven residency
  (`residency.ts`), the streaming window (`window.ts`), the auto-walk
  driver (`driver.ts`), towns, landmarks, errands and the travel log, the
  pooled-node renderer (`wander-render.ts`, `WanderView.tsx`), and the
  deterministic simulation (`wander-sim.ts`) that live play and replays
  share.
- `examples/wander-online/` — the multiplayer demo: protocol, prediction
  and interpolation (`net/`), the authoritative server (`server/`), the
  runtime-agnostic shared logic (`shared/`, also used by the Cloudflare
  deployment) and the acceptance demo (`demo.sh`, `web-check.ts`).
- `tests/` — the suites: per-tick contracts, the F1/F2 feature sweeps,
  looks, HUD, rendering goldens, and the online client/server/net/shared
  suites. `tests/goldens/` holds the pinned frames.
- `tools/` — build / desktop / web wrappers and the evidence-shot tools
  (`wander-f1-shots.ts`, `wander-f2-shots.ts`, `wander-char-shots.ts`).
- `vendor/pocket-rpgkit/` — the Pocket RPG Kit submodule: the engine and UI
  modules the world is built with, the grow example's art it draws, and the
  PocketJS checkout nested inside it.

## Relationship to the other repos

- **[pocketjs-rpgkit](https://github.com/lfkdsk/pocketjs-rpgkit)** — the
  reusable RPG runtime. wander imports its engine (`session`, `passability`,
  `motion-clock`, `movement`, `interpreter`, `clone`) and UI (`DialogBox`,
  `PlayerSprite`, `TileTextureCache`) through the submodule, and draws the
  rule-grown settlement's committed art from `examples/grow/` in place.
  This repo was split out of pocketjs-rpgkit with its history; the engine
  and grow stay there.
- **[pocket-online-server](https://github.com/lfkdsk/pocket-online-server)**
  — the private hosted counterpart of the demo: the runtime-agnostic logic
  in `examples/wander-online/shared/` (snapshot builder, admission limits,
  monthly budget breaker) is shared with its Cloudflare Workers + Durable
  Objects deployment.

## License and attribution

Code: MIT, see [LICENSE](LICENSE). Art: CC0 (Ninja Adventure Asset Pack —
Pixel-Boy and AAA) and CC-BY 3.0 (Lanea Zimmerman (Sharm), "Tiny 16", via
OpenGameArt.org), with generated composites dedicated under CC0. Full
provenance in [ATTRIBUTION.md](ATTRIBUTION.md).
