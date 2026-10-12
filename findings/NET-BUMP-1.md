# Pocket RPG Kit bump and online regression

## Verdict

The component upgrade is functionally compatible, but it is not releasable yet.
All save, protocol, bundle-isolation, online-play, visual, build, typecheck and
test gates passed with no skipped tests. The blocking gate is reproducible
QuickJS cold-start regression above the allowed 3%: Wander at 480x272 regressed
14.269% by the mean of slot medians (6.753% by the median), while Wander Online
regressed 3.434% at 480x272 and 5.269% at 960x544. No Pocket RPG Kit source was
changed in this branch.

## Revisions under test

| Item | Baseline | Candidate |
| --- | --- | --- |
| Wander | `2d6768ecfe8f6e7453547cfc637a2512b9d40e1a` | `38a4674dfd159a44732edc19f430568089b8b04e` |
| Pocket RPG Kit | `a4dc4e72341ae6aa7373623f83dbd07124316a6d` | `0aecc05a6f911208cc5df8041fd00e76a6f35a1b` |
| Nested PocketJS | `862040bd77edc49b1f815beff63952b6616a14c6` | `862040bd77edc49b1f815beff63952b6616a14c6` |
| Hosted server | `cd3757f24236d9a9cb64b95e4208fa3b20298eb1` | `92e8190` |

The server candidate pins Wander `38a4674`. The measured application bundles
are from `39be230`; `38a4674` changes only benchmark tooling and the structured
performance report, not either shipped application. The nested PocketJS commit
is identical on both sides, so this comparison isolates the Pocket RPG Kit
change.

## Upgrade, save and protocol compatibility

- Moving the component gitlink was sufficient for the applications: no Wander
  runtime adaptation and no component patch were required.
- `tests/fixtures/pre-upgrade-state.json` was generated before moving the
  component pointer. `tests/wander-upgrade-compat.test.ts` restores its travel
  log and errand state, verifies byte-for-byte reserialization, then advances
  the simulation successfully.
- `tests/wander-online-auth-sim.test.ts` restores a pre-upgrade ticket and realm
  state, rejoins that realm and continues emitting input.
- The schemas remain additive. Protocol versions are unchanged: world `4`,
  world-state `1`, generator `1`, auth `3`, social `1`, postcard `1`.
- No protocol synchronization is required and the existing private close code
  `4000` / `upgrade-required` path remains unchanged.
- The optional RPG Maker battle rules and battle UI are absent from both input
  manifests and both bundles. `tests/wander-bundle-isolation.test.ts` pins this.

## Size

All compressed measurements use deterministic `gzip -n -9`.

| Application artifact | Baseline raw / gzip | Candidate raw / gzip | Raw delta | Gzip delta |
| --- | ---: | ---: | ---: | ---: |
| Wander JS | 849,902 / 180,440 B | 925,217 / 194,700 B | +75,315 B (+8.862%) | +14,260 B (+7.903%) |
| Wander pak | 1,132,768 / 73,949 B | 1,132,768 / 73,952 B | 0 B | +3 B (+0.004%) |
| Wander Online JS | 1,086,786 / 232,804 B | 1,147,248 / 245,106 B | +60,462 B (+5.563%) | +12,302 B (+5.284%) |
| Wander Online pak | 2,543,120 / 328,885 B | 2,543,120 / 328,885 B | 0 B | 0 B |

The Wander JS growth is attributed by the input manifest to
`rpgmaker-text.ts`, `travel.ts`, `ChoiceColourLine.tsx` and
`choice-colour.ts`; Wander Online adds only `rpgmaker-text.ts` and `travel.ts`.
Neither manifest contains an optional battle input. Full data is in
`reports/net-bump-1-size.json`.

## QuickJS performance

The benchmark used one isolated CPU, three baseline-candidate-candidate-baseline
rounds, six baseline and six candidate slots per application, 480 measured
frames after 120 warmup frames, 32 current-protocol realm clients for Wander
Online, and seven fresh processes per cold-start slot. No other heavy command
ran during timing.

### Roaming frames

| Workload | Mean, baseline -> candidate | Mean delta | p95, baseline -> candidate | p95 delta | Gate |
| --- | ---: | ---: | ---: | ---: | --- |
| Wander | 1,286.217 -> 1,231.833 us | -4.228% | 2,217.833 -> 2,100.667 us | -5.283% | pass |
| Wander Online, 32 players | 1,195.550 -> 1,158.717 us | -3.081% | 1,887.500 -> 1,872.833 us | -0.777% | pass |

The online frame runner creates deterministic v4 realm clients, waits for each
`WELCOME4`, and sends six-tick input batches. The older standalone `bots.ts`
intentionally exercises the frozen pre-v4 room and is therefore not a valid v4
population load. The online process-to-first-tick cross-check still regressed
3.792% even though steady frames improved.

### Cold start

The gate uses the mean of per-slot seven-run medians; the median-of-slot-medians
is included to show robustness.

| Application / viewport | Baseline -> candidate mean | Mean delta | Median delta | Bundle-eval delta | Gate |
| --- | ---: | ---: | ---: | ---: | --- |
| Wander 480x272 | 112.071 -> 128.062 ms | +14.269% | +6.753% | +14.193% | **fail** |
| Wander 960x544 | 142.873 -> 146.919 ms | +2.832% | +2.553% | +2.899% | pass |
| Wander Online 480x272 | 55.391 -> 57.293 ms | +3.434% | +2.892% | +4.270% | **fail** |
| Wander Online 960x544 | 55.305 -> 58.219 ms | +5.269% | +4.809% | +5.460% | **fail** |

One Wander candidate slot was 186.601 ms, but removing sensitivity to that
slot does not clear the gate: the median-of-slot-medians still regresses
6.753%. Wander Online 960x544 is independently stable at +5.269% mean and
+4.809% median. The failing deltas track bundle evaluation, and both applications
already import concrete component modules rather than a broad package barrel.
Avoiding the cost in Wander would require duplicating or forking component
interpreter/session/dialog logic, so the fix belongs in Pocket RPG Kit.

The structured samples and gate calculation are in
`reports/net-bump-1-performance.json`. A minimal rerun is:

```sh
bun tools/desktop.ts wander --build-only
bun tools/desktop.ts wander-online --build-only
taskset -c <isolated-cpu> env KP1_RUNS=7 KP1_BENCH_ROOT=<scratch> \
  vendor/pocket-rpgkit/tools/kp1-quickjs-bench.sh dist/linux-app wander
taskset -c <isolated-cpu> env KP1_RUNS=7 KP1_BENCH_ROOT=<scratch> \
  vendor/pocket-rpgkit/tools/kp1-quickjs-bench.sh dist/linux-app wander-online
```

Run those commands for each slot in baseline-candidate-candidate-baseline order
at both revisions. The checked-in KP1 helper currently needs a scratch-only host
adapter before it can collect samples against the pinned PocketJS: its
`AppSupervisor::new` call lacks `&AudioHost`, and its `Runtime` initializer lacks
`_audio_host`, `audio` and `network`. The unmodified helper exits 101 with
E0061/E0063. The adapter and compiler log are retained as task artifacts; the
component checkout itself remains untouched.

## Online and visual regression

- Three real clients entered one v4 realm, each saw the other two, and retained
  zero prediction corrections. Restart and rejoin produced a new epoch. A
  150 ms one-way latency run reported about 316-317 ms RTT and zero corrections.
- A 100-bot full-window trace measured 786 us mean, 592 us p50, 1,314 us p95
  and 1,589 us p99.
- Mutual friendship, private presence, world joining, account self-service and
  the opt-in FIRST-finder board were exercised. Nonfriends received no
  identified cooperative state or exact private location.
- Three WebSocket clients completed one cooperative delivery: the first courier
  waited at 1/2, the second completed both private journeys, the target improved
  exactly once, and the observer received the authoritative revision.
- Three live clients completed the daily goal at `required - 1` through a
  cooperative delivery; both couriers retained private credit, the level-2
  festival appeared, and midnight rollover produced the next goal without a
  reconnect.
- The real-workerd postcard flow discarded the first send response, retried the
  same request in another realm, delivered one card, charged one quota unit,
  rejected a nonfriend, marked the card read and completed an opaque-id reply.
- Mobile Chrome passed at 390x844@3 in English portrait and 844x390@3 in Chinese
  landscape with no failures or console errors. Every page-owned and game-pad
  touch target met 44 CSS pixels; controls and panels did not overlap.
- Desktop scenes at 480x272 and 960x544 were captured with nearest-neighbour 3x
  review copies. Cooperative journey, daily goal, social/leaderboard and
  postcard reports passed their fit and semantic-pixel assertions. The retained
  frames were also inspected visually; English and Chinese copy was not clipped.

## Budget correction

Postcard expiry cleanup now counts one migration-cursor probe for every batch:

```text
expiry cleanup reads = expired cards * 3 + cleanup batches
                     = 50 * 3 + 25
                     = 175 reads/month
```

At the documented common point this produces 55,675 storage-row reads and a
total overage-equivalent estimate of $0.0062006/month; `hardStop` remains false.
The server ledger test pins the per-batch slope, and the README and
`reports/net-mail-2-budget.json` use the corrected formula.

## Mutation checks

Both required isolated mutations went red:

1. Injecting the optional RPG Maker battle rules into a Wander bundle was
   rejected by the bundle input/content isolation test.
2. Replacing the frozen pre-upgrade save with a rejected version made the
   compatibility restore test fail.

The mutations ran in disposable copies and did not alter either delivery
worktree.

## Final gates

| Repository / gate | Result |
| --- | --- |
| Baseline Wander build | pass |
| Baseline Wander TypeScript | pass |
| Baseline Wander tests | 508 pass, 0 fail, 0 skip |
| Upgraded Wander build | pass |
| Upgraded Wander TypeScript | pass |
| Upgraded Wander tests | 513 pass, 0 fail, 0 skip |
| Hosted server TypeScript | pass |
| Hosted server scoped suite | 341 pass, 0 fail, 0 skip |
| Real-workerd integration | 20 pass, 0 fail, 0 skip |

Both lockfiles retain their original hashes. The server changes are limited to
the Wander gitlink plus the postcard budget formula, its tests and its public
documentation.

## Release decision and order

Do not publish the current candidate. First fix the Pocket RPG Kit cold-start
regression and update its stale KP1 host adapter, then repeat the same interleaved
gate. Once all cold-start rows are at or below +3%, publish Wander first and the
server gitlink second. The protocol did not move, so this is not an atomic
client/server protocol cutover and no special `4000` migration is needed.

subagent 使用：4 个 / 兼容与协议审计、在线验收矩阵、预算审计、体积性能与变异设计 / 并行核对节省了时间

BLOCKED
