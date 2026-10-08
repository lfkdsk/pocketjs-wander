# Feature status

This checklist describes what the standalone Wander repository ships today.
Pocket RPG Kit engine features remain tracked in the
[component status](https://github.com/lfkdsk/pocketjs-rpgkit/blob/main/docs/status.md).

| Feature | Status | Notes |
| --- | --- | --- |
| Endless generated world | Done | Wander streams deterministic chunks around the player with bounded residency, towns, landmarks, errands, a travel log, pooled rendering and automatic exploration. Its simulation is pinned at 60/30/20/4 Hz and across save/restore in `tests/wander-sim.test.ts`, `tests/wander-f1.test.ts` and `tests/wander-f2.test.ts`. |
| Character look pool | Done | Sixteen CC0 Ninja Adventure walkers in four build-time palettes provide 64 stable looks through on-demand CLUT8 tilesets; `tests/wander-looks.test.ts` pins identities and pixels. |
| Browser and desktop builds | Done | `bun run web` publishes Wander and Wander Online; `bun run desktop [wander|wander-online]` runs the native host. Both use the nested Pocket RPG Kit and PocketJS submodules. |
| Wander Online world and netcode | Done | The hosted client draws the real streamed world with villagers and named remote walkers; prediction, batched input, reconciliation, interpolation and bounded 32-player rendering are covered by the `tests/wander-online-*.test.ts` suites. |
| Wander Online accounts | Done | The web page supports GitHub OAuth, one-use token exchange, persistent session tickets and character creation. Desktop supports six-digit profile linking; sign-out and confirmed profile deletion clear persisted credentials. |
| Hosted service operations | Partial | The Cloudflare server enforces room, rate, origin, session and monthly-budget limits. Deployment and production monitoring live in `pocket-online-server`; the local Bun server is loopback-only and enables guest access only with `--allow-guests`. |
