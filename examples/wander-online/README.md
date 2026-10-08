# wander-online

A multiplayer demo for the [wander](../wander) world, with an authoritative
server, client-side prediction and remote interpolation. Protocol v4 streams
the endless deterministic world at signed absolute coordinates. Protocol v3
and its frozen 96×96 window remain available as a legacy room.

**Localhost only.** The server binds `127.0.0.1` and never listens on a
non-loopback interface. There are no accounts, no persistence and no
anti-cheat; this is a netcode demo, not a hosted service.

## Run

```sh
# 1. the area server (Bun): 20 Hz authoritative, 10 Hz AOI snapshots
bun run examples/wander-online/server/server.ts --allow-guests

# 2a. desktop clients (two windows)
bun tools/desktop.ts wander-online
bun tools/desktop.ts wander-online

# 2b. or a browser tab
bun tools/web.ts wander-online
# serve dist/web and open the wander-online player page
```

The committed client URL ends in `/ws`; current clients map that stable base
to `ws://127.0.0.1:8080/ws/v4`. A v3 client can still connect directly to
`/ws`. Each local guest joins with a random name and colour and walks on its
own (auto-walk) until a d-pad key takes over. The HUD shows world coordinates,
connection status, current-room and whole-service online counts
(`ROOM n · ALL m`), RTT and correction count.

## How it works

```
client (PocketJS app, 60 Hz)          server (Bun/Worker, 20 Hz)
─────────────────────────────         ────────────────────────────
sample held d-pad                     one RealmArena per v4 room
predict: realm mover (1 ref tick)     signed world + shared chunk cache
INPUT(seq, buttons) ────────────────► queue per player, consume 1/ref tick
                                      movement × 3 per frame
                                      sparse AOI (Chebyshev radius 16)
STATE4(frame, epoch, ack, entities) ◄─ full idempotent snapshot, 10 Hz
reconcile(ackSeq, my mover)
  match?  nothing
  differ? roll back + replay unacked
remote players: interpolate at now−100 ms
```

- **Endless realm.** Both sides call the existing pure Wander generator at
  the fixed `COMPLETE` phase. Each player pins a 3×3 chunk neighbourhood;
  the server keeps their union plus reusable inactive chunks, with a 1,800
  reference-tick TTL, a hard 512-chunk LRU and a hard 160-plan LRU. Active
  chunks and plans are never evicted. Generation receives 2,000 work units
  per reference tick, and an unready destination is solid, so a player waits
  on the last verified tile rather than entering unknown terrain
  ([`net/realm-world.ts`](net/realm-world.ts)).
- **Prediction.** The v4 client builds the same streamed world and moves
  through the kit's existing movement reducer via a local 5×5 passage table.
  It folds every held input locally, one reference tick per input. Pressing a
  key moves the local player on the same frame — no input latency. The v3
  fallback keeps its frozen-window predictor in [`net/world.ts`](net/world.ts).
- **Reconciliation.** Every snapshot carries `ackSeq`, the last INPUT
  sequence the server applied for the recipient. The client keeps a 128-entry
  ring of predicted states; on a snapshot it compares the predicted mover at
  `ackSeq` with the authoritative one. A mismatch rolls the mover back and
  replays the unacked inputs (rollback-and-replay). The whole movement state
  (phase, walking, stepDir) is on the wire, so a correction is complete and
  does not cascade. With a reliable in-order transport and no server
  underflow, corrections stay at zero.
- **Interpolation.** Remote players render 100 ms behind real time,
  interpolated between the two snapshots bracketing that time
  ([`net/interpolate.ts`](net/interpolate.ts)). One dropped packet costs
  nothing; snapshots are idempotent.
- **Recovery.** A socket close reconnects with exponential backoff (1 s →
  10 s cap) and re-joins; a server restart looks the same. Two seconds
  without a snapshot freezes local gameplay and starts a fresh join, so a
  stalled client cannot diverge from the server. WELCOME4 and STATE4 carry a
  connection epoch; a new epoch clears prediction and interpolation history
  before rebasing at the new authoritative spawn. This first phase stores no
  world or player progress across a server restart.

## Wire format

Little-endian, single source in [`net/protocol.ts`](net/protocol.ts):

| message | bytes | fields |
| --- | ---: | --- |
| JOIN (text) | — | `{"type":"join","v":3,...credential fields...}` |
| JOIN v4 (text) | — | `{"type":"join","v":4,"generatorVersion":1,...credential fields...}` |
| INPUT | 7 | `0x01` seq u32, buttons u16 |
| INPUT_BATCH | 6 + 2n | `0x03` firstSeq u32, count u8, buttons[count] u16 (v2: up to 3 ticks per message) |
| PING | 9 | `0x02` id u32, t u32 |
| WELCOME | 17 + 9216 | `0x10` you u32, seed u32, x0 i32, y0 i32, grid |
| WELCOME4 | 42 + realm id | `0x11` you, seed, generator, epoch, signed mover, revision, server time, realm id |
| STATE | 10 + 12n [+ 4] | `0x20` frame u32, ackSeq u32, n u8, entities, optional roomOnline u16 + allOnline u16 |
| STATE4 | 14 + 18n [+ 4] | `0x21` frame u32, ackSeq u32, epoch u32, n u8, signed-coordinate entities, optional population |
| PONG | 9 | `0x30` id u32, t u32 |
| BYE | 5 | `0x40` id u32 |

Each entity: id u32, tile u8×2, pixel offset i8×2, facing u8, phase u8,
stepDir u8, flags u8 (moving, walking, 4-bit colour). A full 255-entity
snapshot with the optional population tail is 3074 bytes, under the socket
module's 64 KiB message limit. The tail follows the counted rows, so old
clients ignore it; new clients talking to an old server fall back to the AOI
count for both HUD values.

**Batching (v2).** The client predicts one reference tick per INPUT as
before, but packs every 3 ticks (60 Hz reference) into one INPUT_BATCH
message, so the wire rate is 20 Hz at any host rate. The server expands
a batch into the same per-tick input queue, so prediction,
reconciliation and the zero-correction lockstep are unchanged. Both
servers decode INPUT_BATCH and plain INPUT (the bots still send plain
INPUT by default), so a v1 client works against a batching-capable server.
The current authenticated protocol requires JOIN `"v":3`; batching was
introduced by v2 and remains part of v3.

The endless route requires JOIN `"v":4` and `generatorVersion:1`. It rejects
legacy or mismatched generator capability with `upgrade-required`. `/ws` and
`/ws/v4` use separate arenas, so adding v4 does not migrate or reinterpret a
legacy room.

## Files

| file | role |
| --- | --- |
| [`net/protocol.ts`](net/protocol.ts) | wire format, shared by server, client and bots |
| [`net/world.ts`](net/world.ts) | the frozen window both sides predict through |
| [`net/predict.ts`](net/predict.ts) | prediction + rollback-and-replay reconciliation |
| [`net/realm-world.ts`](net/realm-world.ts) | signed-coordinate generation residency and movement adapter |
| [`net/realm-predict.ts`](net/realm-predict.ts) | v4 epoch-aware prediction + rollback-and-replay |
| [`net/interpolate.ts`](net/interpolate.ts) | remote entity interpolation |
| [`net/client.ts`](net/client.ts) | the PocketJS net client (socket, reconnect, freeze, rejection policy) |
| [`server/area.ts`](server/area.ts) | the authoritative arena (input queues, AOI) |
| [`server/realm-area.ts`](server/realm-area.ts) | v4 authoritative realm (streaming budget, sparse AOI) |
| [`server/server.ts`](server/server.ts) | Bun WebSocket server, loopback-only |
| [`server/bots.ts`](server/bots.ts) | headless bots for load tests (`--batch` for hosted servers) |
| [`shared/snapshot.ts`](shared/snapshot.ts) | the broadcast snapshot builder, shared by the Bun server and the Cloudflare Room DO |
| [`shared/limits.ts`](shared/limits.ts) | admission limits (rate window, origin, room pick, IP, idle), pure |
| [`shared/meter.ts`](shared/meter.ts) | monthly budget breaker + billing conversion, pure |
| [`online-config.json`](online-config.json) | server URL baked into the pak (deploy config; `tools/desktop.ts --url`) |
| [`OnlineView.tsx`](OnlineView.tsx) | the SolidJS view (grid, players, HUD) |

## Tests

- `tests/wander-online-net.test.ts` — wire roundtrips, prediction parity
  (zero corrections in lockstep), rollback-and-replay with unacked inputs
  (tick-by-tick parity after a correction), interpolation, TTL.
- `tests/wander-online-server.test.ts` — arena determinism, the 20 Hz → 3
  reference-tick fold, input queue ordering, AOI shape, loopback-only binding,
  and a real-WebSocket end-to-end exchange (two clients see each other,
  snapshots ack input sequences, PING/PONG).
- `tests/wander-online-realm-world.test.ts` — signed edges, 3×3 active
  unions, diagonal frontier size, budget stalls, TTL/LRU caps and active-plan
  pinning.
- `tests/wander-online-realm.test.ts` — v4 arena, 20/60 Hz replay,
  epoch-aware prediction and sparse signed-coordinate AOI.
- `tests/wander-online-realm-acceptance.test.ts` — 1,000-coordinate generator
  parity and two predicted clients walking more than 500 tiles in opposite
  directions beyond the old boundary without extra corrections.
- `tests/wander-online-client.test.ts` — the `OnlineClient` lifecycle against
  a real loopback server: join, transport-drop reconnect, and server-restart
  rejoin. A restart is pinned to a different epoch and must rebuild both
  clients' predictor rings and clear interpolation, so two sessions' state
  can never mix.
- `tests/wander-online-shared.test.ts` — the shared hosted-server logic
  under a fake clock: Origin whitelist, sliding-window rate limit, room
  picker, IP counter, idle tracker, billing conversion, month ledger +
  budget breaker, batch codec, snapshot builder. Each assertion is
  mutation-checked.

## Acceptance demo

`demo.sh` runs the local v4 acceptance case on 127.0.0.1 and prints a JSON
summary; screenshots go to `--out` (default `./wander-online-shots` under the
system temp dir). All processes are stopped on exit.

```sh
bash examples/wander-online/demo.sh            # 3x mutual visibility + latency + restart + bots
bash examples/wander-online/demo.sh --skip-bots # skip the 100-bot load phase
bash examples/wander-online/demo.sh --runs 1    # one mutual-visibility run
```

- **Mutual visibility** (repeated 3×): the server, then two headless desktop
  hosts, then a headless chrome tab are started in a fixed order. Each
  client's state is read (not its screenshot): the web client is driven over
  the DevTools Protocol (`web-check.ts`) and must report `online === 3` with
  two remote players that move; each desktop log must record `online: 3`.
- **Latency**: a server with `--sim-latency 150` (300 ms RTT) and one desktop
  host: prediction keeps corrections at the join baseline.
- **Restart**: the server is SIGKILLed under a desktop host and a chrome tab
  and restarted; both must drop, reconnect and rejoin (the web client over
  CDP in `--watch` mode, the desktop via its log).
- **Bots**: 100 headless bots plus one desktop host; QuickJS frame time stays
  under the 16.7 ms budget.

## Cloudflare

The same realm arena runs on Cloudflare Workers + Durable Objects, in the
private `pocket-online-server` repository, which vendors this repository
as a submodule and imports the shared modules above — the Worker adds only
the routing, the hibernation-shaped wrappers and the limits; no game
logic is copied.

- **Architecture.** A Worker keeps legacy `/ws` and endless `/ws/v4` in
  disjoint Room DO names (after an Origin whitelist) and serves `/health`,
  `/stats` and `/stats/v4`. Each Room DO
  runs one `Arena` or `RealmArena` behind the WebSocket Hibernation API: a
  20 Hz in-memory interval ticks only while the room is occupied, so an empty
  room can hibernate (alarms retry owed accounting work). A
  single Meter DO bills raw room deltas to Cloudflare's units (inbound
  messages 20:1 to requests, 128 MB-s to GB-s), accumulates per UTC
  month in DO storage, and opens a budget breaker at 80 % of the plan
  inclusion that refuses new joins ("closed for the month") while
  existing sessions continue.
- **Limits.** Realm admission is capped atomically at 32 players before its
  focus set changes; a full local or hosted realm closes the new socket with
  `1008/full`. The hosted service has up to 4 rooms (fullest-with-space), 32 players/room, 2
  connections/IP, 30 inbound messages/s/connection (sliding window),
  512 B/message, 5-minute idle kick — every refusal is a WebSocket close
  with code 1008 and a reason token the client's HUD shows
  (`full`/`rest` retry on a slow backoff; `rate`/`ip`/`origin` do not
  reconnect). All limits are `wrangler.toml` vars.
- **Server URL.** The client reads `online-config.json` from its pak
  (committed default = the local Bun server). Point a build at the
  Worker with `WANDER_ONLINE_URL=wss://… bun tools/desktop.ts
  wander-online` (or `--url`); the web build reads the same pak file.
- **Local run.** In the server repo: `bunx wrangler@3.99.0 dev`, then
  point a current client at `ws://127.0.0.1:8787/ws/v4` (or keep the stable
  `/ws` config and let the client map it). The server repo's
  integration suite spawns `wrangler dev` and asserts the three-client
  mutual-visibility flow, v3/v4 isolation and every limit over real
  WebSockets. Its `scripts/demo-cf.sh` additionally restarts `wrangler dev`
  under three live clients and captures browser and desktop frames at both
  supported viewport sizes.
- **Deploy.** Push to the server repo's `main` (the workflow deploys
  when the Worker changes) or dispatch it manually; secrets live in the
  `cloudflare` GitHub environment. See the server repo's README for the
  one-time setup. The kit side is not deployed by that workflow.

The pure logic is tested here (`tests/wander-online-shared.test.ts`,
fake clock, mutation-checked); the Worker-shaped wrappers and the
`wrangler dev` integration live in the server repo.
