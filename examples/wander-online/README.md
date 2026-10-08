# wander-online

A local multiplayer demo: the [wander](../wander) world shared by a small
authoritative server, with client-side prediction and remote interpolation.
Two desktop windows and a browser tab on the same machine see each other
walk around the same frozen window.

**Localhost only.** The server binds `127.0.0.1` and never listens on a
non-loopback interface. There are no accounts, no persistence and no
anti-cheat; this is a netcode demo, not a hosted service.

## Run

```sh
# 1. the area server (Bun): 20 Hz authoritative, 10 Hz AOI snapshots
bun run examples/wander-online/server/server.ts

# 2a. desktop clients (two windows)
bun tools/desktop.ts wander-online
bun tools/desktop.ts wander-online

# 2b. or a browser tab
bun tools/web.ts wander-online
# serve dist/web and open the wander-online player page
```

Every client connects to `ws://127.0.0.1:8080/ws`, joins with a random name
and colour, and walks on its own (auto-walk) until a d-pad key takes over.
The HUD shows the connection status, current-room and whole-service online
counts (`ROOM n · ALL m`), RTT and correction count.

## How it works

```
client (PocketJS app, 60 Hz)          server (Bun, 20 Hz)
─────────────────────────────         ─────────────────────────
sample held d-pad                     one Arena = one frozen wander
predict: stepSession(1 ref tick)      window + one shared Session
INPUT(seq, buttons) ────────────────► queue per player, consume 1/ref tick
                                      stepSession × 3 per frame
                                      AOI snapshot (Chebyshev radius 16)
STATE(frame, ackSeq, entities) ◄────── full idempotent snapshot, 10 Hz
reconcile(ackSeq, my mover)
  match?  nothing
  differ? roll back + replay unacked
remote players: interpolate at now−100 ms
```

- **Prediction.** The client builds the same frozen window from the WELCOME
  seed ([`net/world.ts`](net/world.ts)) and folds every held input through
  the kit's `stepSession` locally, one reference tick per INPUT. Pressing a
  key moves the local player on the same frame — no input latency.
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
  stalled client cannot diverge from the server.

## Wire format

Little-endian, single source in [`net/protocol.ts`](net/protocol.ts):

| message | bytes | fields |
| --- | ---: | --- |
| JOIN (text) | — | `{"type":"join","name","color","v"?:2}` |
| INPUT | 7 | `0x01` seq u32, buttons u16 |
| INPUT_BATCH | 6 + 2n | `0x03` firstSeq u32, count u8, buttons[count] u16 (v2: up to 3 ticks per message) |
| PING | 9 | `0x02` id u32, t u32 |
| WELCOME | 17 + 9216 | `0x10` you u32, seed u32, x0 i32, y0 i32, grid |
| STATE | 10 + 12n [+ 4] | `0x20` frame u32, ackSeq u32, n u8, entities, optional roomOnline u16 + allOnline u16 |
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
INPUT by default), so a v1 client works against a v2 server; a v2 client
needs a v2 server. JOIN carries `"v":2` so servers can tell them apart.

## Files

| file | role |
| --- | --- |
| [`net/protocol.ts`](net/protocol.ts) | wire format, shared by server, client and bots |
| [`net/world.ts`](net/world.ts) | the frozen window both sides predict through |
| [`net/predict.ts`](net/predict.ts) | prediction + rollback-and-replay reconciliation |
| [`net/interpolate.ts`](net/interpolate.ts) | remote entity interpolation |
| [`net/client.ts`](net/client.ts) | the PocketJS net client (socket, reconnect, freeze, rejection policy) |
| [`server/area.ts`](server/area.ts) | the authoritative arena (input queues, AOI) |
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
- `tests/wander-online-client.test.ts` — the `OnlineClient` lifecycle against
  a real loopback server: join, transport-drop reconnect, server-restart
  rejoin, and the epoch reset (a fresh join rebuilds the predictor ring and
  clears the interpolator, so two sessions' entities never mix).
- `tests/wander-online-shared.test.ts` — the shared hosted-server logic
  under a fake clock: Origin whitelist, sliding-window rate limit, room
  picker, IP counter, idle tracker, billing conversion, month ledger +
  budget breaker, batch codec, snapshot builder. Each assertion is
  mutation-checked.

## Acceptance demo

`demo.sh` runs the whole acceptance case on 127.0.0.1 and prints a JSON
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

The same arena runs on Cloudflare Workers + Durable Objects, in the
private `pocket-online-server` repository, which vendors this repository
as a submodule and imports the shared modules above — the Worker adds only
the routing, the hibernation-shaped wrappers and the limits; no game
logic is copied.

- **Architecture.** A Worker routes `/ws` upgrades to the least-loaded
  Room DO (after an Origin whitelist) and serves `/health`. Each Room DO
  runs one `Arena` behind the WebSocket Hibernation API: a 20 Hz alarm
  ticks only while the room is occupied, so an empty room hibernates. A
  single Meter DO bills raw room deltas to Cloudflare's units (inbound
  messages 20:1 to requests, 128 MB-s to GB-s), accumulates per UTC
  month in DO storage, and opens a budget breaker at 80 % of the plan
  inclusion that refuses new joins ("closed for the month") while
  existing sessions continue.
- **Limits.** Up to 4 rooms (least-loaded), 32 players/room, 2
  connections/IP, 30 inbound messages/s/connection (sliding window),
  64 B/message, 5-minute idle kick — every refusal is a WebSocket close
  with code 1008 and a reason token the client's HUD shows
  (`full`/`rest` retry on a slow backoff; `rate`/`ip`/`origin` do not
  reconnect). All limits are `wrangler.toml` vars.
- **Server URL.** The client reads `online-config.json` from its pak
  (committed default = the local Bun server). Point a build at the
  Worker with `WANDER_ONLINE_URL=wss://… bun tools/desktop.ts
  wander-online` (or `--url`); the web build reads the same pak file.
- **Local run.** In the server repo: `bunx wrangler@3.99.0 dev`, then
  point a client at `ws://127.0.0.1:8787/ws`. The server repo's
  integration suite spawns `wrangler dev` and asserts the three-client
  mutual-visibility flow plus every limit over real WebSockets.
- **Deploy.** Push to the server repo's `main` (the workflow deploys
  when the Worker changes) or dispatch it manually; secrets live in the
  `cloudflare` GitHub environment. See the server repo's README for the
  one-time setup. The kit side is not deployed by that workflow.

The pure logic is tested here (`tests/wander-online-shared.test.ts`,
fake clock, mutation-checked); the Worker-shaped wrappers and the
`wrangler dev` integration live in the server repo.
