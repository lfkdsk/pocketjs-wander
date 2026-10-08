# Feature status

This checklist describes what the standalone Wander repository ships today.
Pocket RPG Kit engine features remain tracked in the
[component status](https://github.com/lfkdsk/pocketjs-rpgkit/blob/main/docs/status.md).

| Feature | Status | Notes |
| --- | --- | --- |
| Endless generated world | Done | Wander streams deterministic chunks around the player with bounded residency, towns, landmarks, errands, a travel log, pooled rendering and automatic exploration. Its simulation is pinned at 60/30/20/4 Hz and across save/restore in `tests/wander-sim.test.ts`, `tests/wander-f1.test.ts` and `tests/wander-f2.test.ts`. |
| Character look pool | Done | Sixteen CC0 Ninja Adventure walkers in four build-time palettes provide 64 stable looks through on-demand CLUT8 tilesets; `tests/wander-looks.test.ts` pins identities and pixels. |
| Browser and desktop builds | Done | `bun run web` publishes Wander and Wander Online; `bun run desktop [wander|wander-online]` runs the native host. Both use the nested Pocket RPG Kit and PocketJS submodules. |
| Wander Online world and netcode | Done | Protocol v4 streams the deterministic world at signed absolute coordinates through `/ws/v4`, with server authority, prediction/rollback, epoch-safe reconnects, sparse AOI and bounded 32-player rendering. The legacy frozen-window v3 room remains available at `/ws`. The HUD shows world coordinates and distinguishes current-room from whole-service presence (`ROOM n · ALL m`); see `examples/wander-online/README.md` and the `tests/wander-online-*.test.ts` suites. |
| Wander Online accounts | Done | The web page supports GitHub OAuth, one-use token exchange, persistent session tickets and character creation. Desktop supports six-digit profile linking; bilingual web sign-out delegates to the same game path as in-game sign-out, clears persisted credentials, and immediately follows runtime page-language changes. |
| Hosted service operations | Partial | The Cloudflare server enforces room, rate, origin, session and monthly-budget limits. Deployment and production monitoring live in `pocket-online-server`; the local Bun server is loopback-only and enables guest access only with `--allow-guests`. |
