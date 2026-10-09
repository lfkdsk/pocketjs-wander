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
`/ws`. Each local guest joins with a random name and colour. The HUD shows
world coordinates, connection status, current-room and whole-service online
counts (`ROOM n · ALL m`) and a nearby landmark's first discoverer. RTT and
correction count remain behind the debug toggle in the SELECT menu.

### Playing in the realm

The single-player gameplay runs on the shared realm with the server as the
authority; every line of text comes from the same pure content functions the
offline game uses (`examples/wander/towns.ts`), so online and offline read
the same words.

| Input | Action |
| --- | --- |
| D-pad | walk (takes over from auto-walk) |
| CIRCLE | talk to the resident in front (the server records the conversation), read the notice board in front, page/close the open dialog |
| CROSS | near a town hub: accept the town's errand, or deliver the one it targets; elsewhere: page the travel log |
| TRIANGLE | request fast mode; the HUD says `FAST` once a snapshot confirms it |
| R | the emote picker: LEFT/RIGHT choose one of five presets, CIRCLE sends it, CROSS or R closes |
| SELECT | the menu: link a device, delete the profile, TRIANGLE toggles debug, START toggles auto-walk, L mints an invite to this world, R leaves for any world |

Residents of the nearby towns walk their routes on the realm clock (a pure
function of the plan, the region's discovery time and the server time, so
no resident state crosses the wire) and never block anyone. The bottom bars
show the private travel log and the nearest rumor (`LOG n · kind    RUMOR:
kind dir dist`) and the active errand with the lifetime helped count; they
hide while a dialog is open. Notices announce accepted/delivered/visited
errands and new sightings (`FOUND: kind`).

Auto-walk is opt-in online: it starts only with the menu's START toggle or
when the page sets `globalThis.__onlineAutoWalk = true` before boot
(`web-check.ts --auto-walk` does that), and nothing resumes it after a
d-pad press.

### Meeting others: spawn slots, invites, far markers and emotes

Admission never stacks players. The server anchors a newcomer at the
starter town hub (or a returning player at its stored checkpoint) and walks
a ring of up to six tiles around it, starting at an offset derived from a
stable per-account hash, until it finds a tile that is neither blocked at
the realm's current growth phase nor under another player
(`net/spawn.ts`, `RealmArena.tryAdd`). Thirty-two players admitted together
therefore stand on thirty-two distinct open tiles beside the plaza, and a
checkpoint that is taken or has grown over moves the player one ring out
rather than into a wall.

A client that was admitted to a realm remembers it beside its ticket and
asks for the same realm on every reconnect (`?realm=` on the v4 endpoint).
The menu's L mints an **invite**: the server answers with a short code
(`{"type":"invite","code","realm","expiresIn"}`, nothing about the account)
and the client shows the shareable token `<realm>.<CODE>` as a notice; on
the web the player page turns it into a link ending in `#invite=<token>`
with a Copy button, and a page opened through such a link hands the token
to the game (`__pocketInvite`), which joins with `?realm=<realm>&invite=
<CODE>`. The server admits into exactly that realm, or closes with a plain
reason: `1008 full` when the pinned world is at its cap (the HUD says
`WORLD FULL` and retries slowly; the menu's R, "any world", drops the pin),
`1008 invite` for an unknown, malformed or expired code, `1008 realm` for a
world the service does not run. Codes live for an hour, at most 64 per
realm, three per player per minute, and are never consumed: one link can
bring several friends. `shared/invite.ts` holds the rule; the local server
keeps codes in memory, the hosted one in the realm's SQLite.

Players of the same realm outside the AOI appear once a second as a
**far marker**: a square at the screen edge in their compass octant with
the name and a band word (`near` within 64 tiles, `far` within 256,
`distant` within 1024, `remote` beyond). The `FAR_PLAYERS` row is six
bytes, an id, an octant and a band; no coordinate field exists, and a
player inside the AOI is in the exact snapshot and never in the band. A
marker that is not refreshed for three seconds disappears.

**Emotes** are five presets (`o/` wave, `\o/` cheer, `->` point, `?` what,
`!!` gather, `net/emote.ts`). R opens the picker; the choice goes out as a
`COMMAND` whose one-byte `extra` is the preset id, the server accepts at
most one per player per second and echoes an `EMOTE` frame to everyone
whose AOI holds the sender (sender included), and each client draws the
glyph above that walker's name tag for five seconds. Nothing is stored:
a player who arrives later never sees it. There is no free-text message
of any kind; the only things a player can send are inputs, these
one-byte commands and the fixed auth/invite requests.

### Names and the name font

A display name is 1..12 code points from one charset, shared by the client,
the local server and the hosted server (`shared/name-charset.ts`): ASCII
letters and digits, space, `_`, `.`, `-`, and the 3755 level-1 characters of
GB 2312 (the common simplified Chinese set). That charset is exactly what the
app bakes for names: `fonts.json` lists `fonts/NotoSansCJKsc-subset.otf` for
the 12 px slot (the HUD lines, the name tags and the `FIRST` suffix) with
`fonts/cjk-charset.txt`, so every accepted name renders as glyphs on every
host; other scripts, rare Han and accented Latin are refused at creation
rather than drawn as replacement boxes. The 12 px atlas grows by about
0.7 MB in the pak for those glyphs; no other slot carries them. Regenerate
the subset with `bun tools/wander-online-cjk-font.ts` (the pinned Noto
source is downloaded once); `--check` verifies the committed files, and
`tests/wander-online-cjk-font.test.ts` ties the charset, the face, the
manifest and the built atlas together. Name tags are 160 px wide, enough
for twelve 12 px cells.

Character creation uses that rule before anything is sent. The on-screen
grid (d-pad, keyboard, touch) is generated from the same constant as the
validator's ASCII part (`NAME_ASCII_CHARSET`: letters, digits, space, `_`,
`.`, `-`), so it offers exactly the ASCII characters a name may contain and
nothing the server would refuse; `tests/wander-online-name-input.test.ts`
holds the two equal character by character. Chinese names are typed in the
browser: while the creation screen is open the game asks the player page
for its name text box (`__pocketAuthEvent({ type: "nameInput" })`, next to
the Sign out button, so any input method works), and the page hands the
text back through `__pocketAuthCommand("name", text)`. Either path runs the
shared `validateName` on the client first; a refused name never leaves the
client and the reason shows under the grid and beside the page box in
English and Chinese. The server runs the same check again when the CREATE
arrives. The acceptance demo creates the browser's character this way with
a Chinese name (`web-check.ts --create-name`), and checks the HUD name line
of the real Chrome screenshot cell by cell for drawn glyphs
(`glyph-check.ts`).

The private journey row (`net/journey.ts`) is JSON bounded by a derived
worst case: full helped and talked lists at int32 coordinates, a saturated
Bloom and a saturated count come to 1874 bytes under a 2048-byte cap, so
every reachable journey fits; a row that still would not fit drops its
oldest talked, then oldest exact helped entries (the Bloom and the count
keep them helped) rather than failing. `mergeJourney` three-way merges one
account's journey written by two sessions.

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
REGION_STATE(revision, clock, rows) ◄─ shared growth / first / improvement
PLAYER_PROGRESS(revision, landmarks) ◄─ recipient-only private history
```

- **Endless realm.** Both sides call the existing pure Wander generator at
  the phase derived from each region's shared `discoveredAtMs` and the
  server's wall clock. An unknown region is undiscovered; once its sparse
  row arrives, rendering and collision use the same growth phase on both
  sides. Monotonic improvement deltas replay the existing town flower stamp
  idempotently, including after a plan is evicted and regenerated. Each
  player pins a 3×3 chunk neighbourhood;
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
  before rebasing at the new authoritative spawn. The loopback Bun server is
  intentionally ephemeral. The hosted Durable Object server restores the
  realm seed, sparse region rows, shared improvements, landmark firsts and
  the reconnecting account's private checkpoint before it admits input.

## Wire format

Little-endian, single source in [`net/protocol.ts`](net/protocol.ts):

| message | bytes | fields |
| --- | ---: | --- |
| JOIN (text) | — | `{"type":"join","v":3,...credential fields...}` |
| JOIN v4 (text) | — | `{"type":"join","v":4,"supportedGeneratorVersions":[1],"worldStateVersion":1,...credential fields...}` |
| INPUT | 7 | `0x01` seq u32, buttons u16 |
| INPUT_BATCH | 6 + 2n | `0x03` firstSeq u32, count u8, buttons[count] u16 (v2: up to 3 ticks per message) |
| PING | 9 | `0x02` id u32, t u32 |
| WELCOME | 17 + 9216 | `0x10` you u32, seed u32, x0 i32, y0 i32, grid |
| WELCOME4 | 42 + realm id | `0x11` you, seed, generator, epoch, signed mover, revision, server time, realm id |
| STATE | 10 + 12n [+ 4] | `0x20` frame u32, ackSeq u32, n u8, entities, optional roomOnline u16 + allOnline u16 |
| STATE4 | 14 + 18n [+ 4] | `0x21` frame u32, ackSeq u32, epoch u32, n u8, signed-coordinate entities, optional population |
| REGION_STATE | variable | `0x22` flags, realm revision, server time, signed region rows with discovery time, improvement, row revision and first-discoverer display name |
| PLAYER_PROGRESS | variable | `0x23` private revision and signed landmark-region pairs; sent only to its account's socket |
| COMMAND | 11 | `0x04` kind u8 (accept/deliver/talk/emote), rx i32, ry i32, extra u8 (resident index or emote id) |
| FAR_PLAYERS | 2 + 6n | `0x25` n u8, rows of id u32, octant u8, band u8; once a second, only players outside the AOI |
| EMOTE | 6 | `0x26` id u32, emote u8; to every AOI that holds the sender, never stored |
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

The endless route requires JOIN `"v":4`, generator capability `1` and world
state capability `1`. It rejects a legacy or mismatched capability with
`upgrade-required`. Prediction and input remain gated until the initial
`REGION_STATE` arrives, so a client never takes a step against guessed growth
collision. `/ws` and `/ws/v4` use separate arenas, so adding v4 does not
migrate or reinterpret a legacy room.

## Files

| file | role |
| --- | --- |
| [`net/protocol.ts`](net/protocol.ts) | wire format, shared by server, client and bots |
| [`net/world.ts`](net/world.ts) | the frozen window both sides predict through |
| [`net/predict.ts`](net/predict.ts) | prediction + rollback-and-replay reconciliation |
| [`net/realm-world.ts`](net/realm-world.ts) | signed-coordinate generation residency and movement adapter |
| [`net/realm-state.ts`](net/realm-state.ts) | sparse shared-region projection, monotonic revisions and wall-clock phase |
| [`net/realm-predict.ts`](net/realm-predict.ts) | v4 epoch-aware prediction + rollback-and-replay |
| [`net/interpolate.ts`](net/interpolate.ts) | remote entity interpolation |
| [`net/spawn.ts`](net/spawn.ts) | the hashed ring walk that picks a free, unblocked spawn tile |
| [`net/far.ts`](net/far.ts) | octant and distance band of far players, the only thing the band leaks |
| [`net/emote.ts`](net/emote.ts) | the five preset emotes and their limits |
| [`shared/invite.ts`](shared/invite.ts) | invite tokens, lifetimes and the realm pin query |
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
- `tests/wander-online-world-state.test.ts` — strict shared/private codecs,
  growth collision parity, historical-time rollback and idempotent
  improvement replay after regeneration.
- `tests/wander-online-realm-acceptance.test.ts` — 1,000-coordinate generator
  parity and two predicted clients walking more than 500 tiles in opposite
  directions beyond the old boundary without extra corrections.
- `tests/wander-online-client.test.ts` — the `OnlineClient` lifecycle against
  a real loopback server: join, transport-drop reconnect, and server-restart
  rejoin. A restart is pinned to a different epoch and must rebuild both
  clients' predictor rings and clear interpolation, so two sessions' state
  can never mix.
- `tests/wander-online-meet.test.ts` — safe spawn slots (32 players at
  once on 32 open tiles), invites and realm pins against the loopback
  server (same realm, explicit `full`/`invite`/`realm` refusals, expiry,
  no account data in the reply, no free-text message), the far-player band
  (octant + band, never a coordinate, never alongside the exact snapshot)
  and emotes (AOI-only, once a second, never replayed).
- `tests/wander-online-meet-view.test.ts` — the same features on screen:
  far markers with a CJK name at both viewport sizes, the emote picker and
  bubbles, the invite notice and page events, the realm pin at boot.
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
  runs one `Arena` or `RealmArena` behind the WebSocket Hibernation API. v4
  realms keep sparse shared rows and per-account checkpoints in Durable
  Object SQLite, flush dirty movers at a bounded cadence, and restore them
  before reconnect admission. A
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
