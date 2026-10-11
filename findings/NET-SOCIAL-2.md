# NET-SOCIAL-2 social follow-up

Date: 2026-10-11

## Result

All five follow-up findings are resolved. The Wander client clears stale nearby-player state synchronously on a passive disconnect, the narrow social home screen uses complete short labels with a 120 px text cell, anonymous monitoring exposes only population bands, verified accounts without a character can inspect and completely delete retained data, and friend removal is explicitly idempotent. Both repositories pass their complete gates, the two phone orientations were visually reviewed, and the local three-end social flow completed through account deletion.

## Reviewed heads

| Repository | Baseline | Delivered implementation head |
| --- | --- | --- |
| `lfkdsk/pocketjs-wander` | `9ebb562ada6edc8955f50ea93c103fd13fa7f312` | `bf9f0b7d350beea962af2e866093eb817c250c28` |
| `lfkdsk/pocket-online-server` | `58d30125a1cc5466ef047b9b5559856b1e95705e` | `c1eb70c9051b612fa19b4c985becf0b098d920d7` |

The server submodule records Wander `bf9f0b7d350beea962af2e866093eb817c250c28` and keeps the public GitHub submodule URL. The Wander branch adds this report after the implementation commit; the reviewed executable client code remains `bf9f0b7d`.

## Follow-up findings

### 1. Passive disconnect state

`OnlineClient` now completes its disconnect-state transition first and then synchronously publishes an empty roster. Consumers therefore observe `reconnecting`, `retrying`, or `rejected` together with no nearby players instead of retaining the last roster until the next connection succeeds.

The focused test drives a passive close after a populated roster and requires the final callback to be `{ids: [], status: "reconnecting"}` before retry. Removing the empty-roster callback in an isolated mutation changed the result to `0 pass / 1 fail`, because that callback was absent.

### 2. Narrow social details

The home rows use deliberate single-line details: `REQUESTS`, `POPULATION`, and `PRIVACY`. PocketJS wraps only at explicit newlines, so the layout reserves a 128 px detail column with an 8 px gutter, leaving a 120 px text cell at scale 1. This strategy avoids implicit wrapping and preserves the full words on both 390x844 portrait and 844x390 landscape phones.

The layout test asserts the panel is in bounds and the net detail text width is at least 120 px in both orientations. Mutating the detail column from 128 px back to 112 px made the focused test fail with `expected >= 120, received 104` (`0 pass / 1 fail`).

The real Chrome DPR 3 verifier passed in both orientations with no horizontal overflow, no console error, and every touch target at least 44 px. I opened both social screenshots and checked the rendered glyphs: all three detail labels are complete and remain inside the panel. The landscape controls are translucent over the game canvas but do not clip or remove the detail glyphs.

Primary visual artifacts:

- Phone portrait social screen: artifact `48883`, SHA-256 `1c5a5f594caf889f0893ad9acde136db42e32c671008985203a90eb0b3aaa067`.
- Phone landscape social screen: artifact `48884`, SHA-256 `f12ed0b32da3b64bc7bde077b452e82d317398ff0f85f57c2abcc285e3c08ab9`.
- Phone verification report: artifact `48893`, verdict `PASS`, no failures or console errors.
- Eight-frame social contact sheet: artifact `48894`, SHA-256 `88bdfa664a74ce698efe1a0b6df680c4e1ed3cb8ad3524db8d59958ce2608980`.

The simulator keyframe generator also required the expected screen text and more than 100 pixels of the selected-row fill color `#354968` before writing each Friends, Worlds, My Data, and delete-confirm PNG. All eight base captures and their 3x review copies passed; the contact sheet was opened and visually checked.

### 3. Public health privacy and operations monitoring

Anonymous `GET /health` now returns top-level `onlineBand` plus one `band` per realm. Anonymous `/stats` and `/stats/v4` likewise retain simulation telemetry while replacing exact population with a band. The accepted vocabulary is the same as the world picker: `empty`, `quiet`, `lively`, `busy`, or `full`.

Exact Room statistics moved to `/ops/stats` and `/ops/stats/v4`. They return `401` before any Meter or Room wake unless `Authorization: Bearer <OPS_TOKEN>` matches a configured Worker secret. The README runbook documents both public and operator probes, and the deployment smoke check now requires valid bands and rejects top-level or per-realm `online` fields.

The unit test checks every population-band boundary and recursively rejects `online`, `players`, `count`, `roomOnline`, and `allOnline` on anonymous responses. Replacing a realm `band` with exact `online` in an isolated mutation produced `0 pass / 1 fail` because the expected band was absent. The full integration test was also changed from expecting exact `online` to recursively rejecting exact-population keys.

### 4. Verified accounts without a character profile

Auth now returns the verified account id and account version with `needCreate`. Room binds that identity to the socket and exposes only `selfGet` and `deleteAll` until character creation; it ignores client-supplied identities and does not open the remaining social or world surface.

The self-data wire shape is `{login, profile, friends, incoming, outgoing, visible, realms}`, where `profile` may be `null`. The client fetches this summary after `needCreate`; SELECT on the creation screen opens My Data, displays `NO PROFILE @login`, and the same two-press delete confirmation performs complete deletion without creating a throwaway character.

Complete deletion invalidates the account incarnation, removes sessions, link records, the reverse link index, all friendship/request edges, realm-owned private rows, and the Auth account/job records. The operation remains retryable and does not report success until every known realm acknowledges its idempotent purge.

Restoring the former `profile` prerequisite in deletion begin made the focused legacy-account test fail with `{ok:false, reason:"delete-refused"}` (`0 pass / 1 fail`). Client simulation separately proves that a profileless account opens the empty summary, sends no `CREATE`, completes `deleteAll`, and clears its local ticket.

### 5. Idempotent friend removal

Removing a current friend or any pending edge still clears both accounts. Removing an account with no edge also returns `ok:true, state:"removed"`, performs zero storage-row writes, and reveals nothing about the target relationship. The protocol and status documentation now state this contract.

An isolated mutation that returned `friend-target` when the write set was empty made the focused friendship test fail (`0 pass / 1 fail / 27 expects`): the test expected `{ok:true, state:"removed", storageRowWrites:0}` for both repeated removal and a never-related account.

## Isolated mutation matrix

Every mutation was made in a detached temporary worktree, run against one focused test, then restored and removed. No mutation touched either delivery worktree.

| Requirement | Focused command | Observed mutant result |
| --- | --- | --- |
| Clear roster on passive close | `bun test tests/wander-online-client-core.test.ts -t 'a passive close publishes an empty roster'` | `0 pass / 1 fail`; empty reconnecting roster update missing |
| Preserve narrow detail text | `bun test tests/wander-online-social-panel.test.ts -t 'phone portrait and landscape reserve'` | `0 pass / 1 fail`; expected `>=120`, received `104` |
| Hide exact public population | `bun test tests/worker.test.ts -t 'health uses the exact world-picker band boundaries'` | `0 pass / 1 fail`; expected realm band, received `undefined` |
| Delete a profileless account | `bun test tests/auth-do.test.ts -t 'a legacy profile-less account'` | `0 pass / 1 fail`; received `delete-refused` |
| Idempotent no-edge removal | `bun test tests/auth-do.test.ts -t 'request needs acceptance'` | `0 pass / 1 fail / 27 expects`; received `friend-target` |

## Final validation

| Repository / check | Final result |
| --- | --- |
| Wander `bunx tsc --noEmit` | exit 0 |
| Wander `bun test tests/` | 446 pass, 0 fail, 500,039 expects, 35 files |
| Wander `bun run build` | exit 0; `wander-online.pak` 2,543,120 bytes and JS 1,011,193 bytes |
| Wander `bun run web` | exit 0; both public pages built |
| Phone `bun tools/wander-online-mobile-verify.ts ...` | PASS at 390x844 and 844x390, DPR 3; 0 browser errors |
| Social keyframes `bun tools/wander-online-social-shots.ts ...` | exit 0; required text and selected-row semantic pixels passed for every frame |
| Server `bun run tsc` | exit 0 |
| Server `bun test tests/*.test.ts` | 261 pass, 0 fail, 2,526 expects, 9 files |

The first server-wide run exposed one stale integration expectation that still required exact realm `online` from `/health` (`260 pass / 1 fail`). The follow-up test commit inverted that assertion to require `band` and recursively reject exact-population aliases; the final server-wide run above is clean.

The local three-end acceptance was also rerun directly:

```text
bun test tests/integration.test.ts -t 'friends confirm, locate and join across realms before complete deletion'
1 pass, 0 fail, 75 expects
```

That flow connected Alice, Bob, and Cara, accepted a friendship, toggled visibility, located and joined a friend across realms, read self data, completed deletion across both realms, rejected the deleted account's old ticket, and removed the deleted identity from the surviving clients' graphs.

Both worktrees end clean, `git diff --check` is clean, every commit has author `lfkdsk <lfkdsk@gmail.com>`, and no lockfile changed.

## Publication order

1. Configure a long random `OPS_TOKEN` Worker secret before enabling the exact operator probe. Do not place it in repository files.
2. Publish the server head first.
3. Verify anonymous `/health` has a valid top-level `onlineBand`, every realm has a valid `band`, and neither level contains exact population. Verify `/ops/stats/v4` is `401` without the bearer and returns exact stats only with the operations token.
4. Publish the Wander client/web after the server checks pass. The server remains compatible with the older profiled self-data payload, while the new client understands both profiled and `profile:null` summaries.

No push or deployment was performed.

Subagent usage: 4 / passive-disconnect roster, narrow social UI, profileless deletion, and server health-band review / yes, the independent reviews ran in parallel and shortened discovery and test design.

PASS
