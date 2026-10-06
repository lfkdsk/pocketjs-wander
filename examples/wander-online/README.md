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
The HUD shows the connection status, online count, RTT and correction count.

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
| JOIN (text) | — | `{"type":"join","name","color"}` |
| INPUT | 7 | `0x01` seq u32, buttons u16 |
| PING | 9 | `0x02` id u32, t u32 |
| WELCOME | 17 + 9216 | `0x10` you u32, seed u32, x0 i32, y0 i32, grid |
| STATE | 10 + 12n | `0x20` frame u32, ackSeq u32, n u8, entities |
| PONG | 9 | `0x30` id u32, t u32 |
| BYE | 5 | `0x40` id u32 |

Each entity: id u32, tile u8×2, pixel offset i8×2, facing u8, phase u8,
stepDir u8, flags u8 (moving, walking, 4-bit colour). A full 255-entity
snapshot is 3070 bytes, under the socket module's 64 KiB message limit.

## Files

| file | role |
| --- | --- |
| [`net/protocol.ts`](net/protocol.ts) | wire format, shared by server, client and bots |
| [`net/world.ts`](net/world.ts) | the frozen window both sides predict through |
| [`net/predict.ts`](net/predict.ts) | prediction + rollback-and-replay reconciliation |
| [`net/interpolate.ts`](net/interpolate.ts) | remote entity interpolation |
| [`net/client.ts`](net/client.ts) | the PocketJS net client (socket, reconnect, freeze) |
| [`server/area.ts`](server/area.ts) | the authoritative arena (input queues, AOI) |
| [`server/server.ts`](server/server.ts) | Bun WebSocket server, loopback-only |
| [`server/bots.ts`](server/bots.ts) | headless bots for load tests |
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
