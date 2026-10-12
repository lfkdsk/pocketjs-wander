# Pocket RPG Kit capability-isolated bump

## Verdict

PASS. Wander and Wander Online now consume the current Pocket RPG Kit main
with the K-PERF-1 capability split. Neither application uses RPG Maker text,
styled choices, tone/weather rules, followers or vehicles, so no capability
wiring was added. Their concrete battle, text, screen, choice and travel
implementations remain outside both bundles.

All compatibility, build, typecheck, test, package, mutation, local-online and
visual gates pass. The previous cold-start blocker is cleared: all four formal
QuickJS profiles are below the +3% ceiling, with a worst result of +2.520%.
Mean roaming-frame time improved by 0.343% for Wander and 3.781% for the
32-player online workload.

## Revisions under test

| Item | Baseline | Candidate |
| --- | --- | --- |
| Wander source | `526d518b559e2b28a3fd4361a6afe6bf9cfe717a` | `a724613cd4b149566191412fc5ca7fdebb513338` |
| Pocket RPG Kit | `a4dc4e72341ae6aa7373623f83dbd07124316a6d` | `2a37b9aa5c6f464087cc5d97a815a38d2000acbd` |
| Nested PocketJS | `862040bd77edc49b1f815beff63952b6616a14c6` | `862040bd77edc49b1f815beff63952b6616a14c6` |
| Hosted server branch | `92e81906352d8f73fdc35a6274b55b9f5b045c8c` | `9fb86fda253289b1360436e0e8fe1796f21d8f8a` |

The candidate server commit pins Wander `a724613`. The report, size and
performance commits that follow are evidence-only: they do not alter either
application bundle. The server's final report-only gitlink advance must point
at the Wander delivery commit containing this report.

The Wander branch did not need rebasing: cached `origin/main` was not ahead of
the starting branch, and no merge commit was created. The server branch was
created directly on top of `net-bump-1`. Committed submodule URLs remain their
public GitHub URLs; local checkout rewrites were not committed.

## Capability integration and compatibility

The component gitlink is the only runtime change needed in Wander. Neither
application declares `system.rpgMakerText`, followers or vehicles. Wander's
fast travel and travel log are application features, not the component's
follower/vehicle capability. Adding any of the opt-in runtimes would therefore
pay for unused code and was intentionally avoided.

The ordinary component graph now reaches only lightweight contracts:

- Wander adds `rpgmaker-text-contract.ts`, `travel-contract.ts`,
  `travel-types.ts` and `choice-text-contract.ts`.
- Wander Online adds the first three contracts.
- Neither graph or final bundle contains any of the eight concrete K-PERF-1
  implementations, either RPG Maker battle directory, or the battle content
  signatures.

The pre-upgrade single-player fixture restores byte-for-byte, preserves travel
and errand state and continues stepping. The pre-upgrade online ticket and
realm state rejoin the original realm and continue sending input. Protocols
remain unchanged: world `4`, world-state `1`, generator `1`, auth `3`, social
`1`, postcard `1`, and incompatible clients still use private close code
`4000`. No synchronized protocol cutover is needed.

The focused compatibility, authentication and isolation command finished with
`22 pass, 0 fail` across three files and no skipped tests.

## Package isolation and size

Both sides were rebuilt with `bun run build`; compressed sizes use deterministic
`gzip -n -9`.

| Artifact | Baseline raw / gzip | Candidate raw / gzip | Raw delta | Gzip delta |
| --- | ---: | ---: | ---: | ---: |
| Wander JS | 849,902 / 180,440 B | 890,187 / 188,693 B | +40,285 B (+4.740%) | +8,253 B (+4.574%) |
| Wander pak | 1,132,768 / 73,949 B | 1,132,768 / 73,951 B | 0 B | +2 B (+0.003%) |
| Wander Online JS | 1,086,786 / 232,804 B | 1,115,908 / 239,209 B | +29,122 B (+2.680%) | +6,405 B (+2.751%) |
| Wander Online pak | 2,543,120 / 328,885 B | 2,543,120 / 328,885 B | 0 B | 0 B |

The remaining JS growth is the ordinary component engine surface added since
`a4dc4e72`, not optional RPG Maker capability code. Compared with the broken
pre-K-PERF upgrade, the capability split removed the accidental text, styled
choice and component-travel implementations. Exact SHA-256 values, normalized
input counts and the forbidden-module list are recorded in
`reports/net-bump-2-size.json`.

The clean isolation test passes `2/2`. In a disposable worktree, replacing the
ordinary session's contract-only dependency with a static import of
`rpgmaker-text.ts` admitted both `rpgmaker-screen.ts` and `rpgmaker-text.ts`.
Both Wander and Wander Online assertions then failed (`0 pass, 2 fail`, exit
`1`). The isolation gate therefore detects the required regression rather than
remaining green through the mutation.

## QuickJS performance

The release QuickJS host was pinned to logical CPU 15 and all measurements ran
serially, with no other heavy command or agent active. Each application used
three baseline-candidate-candidate-baseline rounds. The component-owned
K-PERF-1 helper compiled unchanged against the current PocketJS audio, network
and idle-GC APIs; no scratch shim was required. It was compiled once, then each
cold sample ran as a fresh process.

### Cold start

Each slot had one unmeasured process warmup and seven measured fresh processes.
The gate is the mean of six per-revision slot medians. The median-of-slot-
medians and bundle evaluation are retained as robustness and attribution
cross-checks.

| Application / viewport | Startup mean, baseline -> candidate | Mean delta | Median delta | Bundle-eval delta | Gate |
| --- | ---: | ---: | ---: | ---: | --- |
| Wander 480x272 | 118.066 -> 119.528 ms | +1.238% | -0.074% | +1.406% | pass |
| Wander 960x544 | 145.295 -> 148.957 ms | +2.520% | +2.842% | +2.807% | pass |
| Wander Online 480x272 | 61.377 -> 61.321 ms | -0.091% | +0.295% | -0.247% | pass |
| Wander Online 960x544 | 59.630 -> 60.614 ms | +1.650% | +0.923% | +1.363% | pass |

All four decisive startup rows are at or below +3%. This clears the three
failures from the previous component bump. K-PERF-1 also fixed the obsolete
benchmark host adapter and added compile-once support, so Wander carries no
host-side compatibility patch.

### Roaming frames

The frame runner used 480 ticks per slot, discarded the first 120 and retained
2,160 QuickJS work-time samples per revision and workload. The online case
admitted 31 deterministic v4 clients before starting the measured app, for 32
players in the same realm.

| Workload | Mean, baseline -> candidate | Mean delta | Mean slot-p95, baseline -> candidate | p95 delta | Gate |
| --- | ---: | ---: | ---: | ---: | --- |
| Wander | 1,277.817 -> 1,273.433 us | -0.343% | 2,035.167 -> 2,044.167 us | +0.442% | pass |
| Wander Online, 32 players | 1,268.750 -> 1,220.783 us | -3.781% | 1,953.333 -> 1,934.167 us | -0.981% | pass |

Both mean frame times improve. Wander's p95 is statistically flat at +0.442%
and stays well inside the inherited 3% timing tolerance; the online mean and
p95 both improve. All per-slot medians, means, p95s, helper identity and method
metadata are in `reports/net-bump-2-performance.json`.

## Local online and gameplay regression

- Three complete local runs opened two real desktop QuickJS hosts and one real
  Chrome tab in one v4 realm. Chrome reported `online=3`, `remotes=2`, zero
  corrections and zero console errors in all three runs; desktop clients also
  observed the other clients.
- With 150 ms one-way simulated latency, the measured RTT settled at 316-317 ms
  with zero corrections. After a server restart the realm epoch changed from
  `1715653658` to `865943036` and both clients rejoined.
- The 100-bot demonstration reported all 100 clients, and its 900-frame
  QuickJS trace measured 1,003 us mean, 819 us p50, 1,605 us p95 and 1,867 us
  p99.
- Three independent WebSocket clients completed the cooperative errand: the
  first courier waited at 1/2, the second settled both private journeys, the
  town improved exactly once, one friend notification was projected, no
  identified nonfriend notification leaked, and the observer received shared
  revision `3`.
- Three live clients completed the daily goal from `required - 1`; both
  cooperative contributors retained private credit, four level-2 festival
  stalls appeared, and UTC rollover produced the next goal without reconnect.
- Real workerd discarded the first postcard response, retried in another
  realm with the same postcard ID, delivered once, charged one quota unit,
  rejected a nonfriend, marked the card read, and completed an opaque-ID reply.

The first demonstration attempt encountered an expired ticket in the existing
desktop profile. The passing run used a new isolated application-data root; no
user data was deleted and no production authentication behavior was bypassed.

## Visual acceptance

All generated reports passed semantic-pixel, text-fit and geometry assertions:

| Surface | Coverage | Result |
| --- | --- | --- |
| Desktop journey / co-op | 24 scenes, 480x272 and 960x544, EN/ZH, native and nearest-neighbour 3x | pass |
| Desktop daily goal | 16 scenes across desktop and phone-shaped viewports, EN/ZH | pass |
| Desktop social / leaderboard | 12 scenes, 480x272 and 960x544 | pass |
| Desktop postcards | 16 scenes, 480x272 and 960x544, EN/ZH | pass |
| Real Chrome mobile | 32 screenshots: 390x844@3 English portrait and 844x390@3 Chinese landscape | pass |

The retained native and 3x images were opened and visually inspected, including
three-client world, cooperative, daily, social and postcard states. Text was
legible without clipping, panels and controls did not overlap, the playfield
remained visible, and mobile touch targets stayed on-screen. The Chrome report
contains no failures or console errors.

## Final gates

| Repository / gate | Result |
| --- | --- |
| Wander wasm rebuild | pass |
| Wander application build | pass |
| Wander TypeScript | pass |
| Wander full suite | 513 pass, 0 fail, 0 skip; 43 files |
| Wander compatibility/auth/isolation focus | 22 pass, 0 fail, 0 skip; 3 files |
| Hosted server TypeScript | pass |
| Hosted server full suite | 341 pass, 0 fail, 0 skip; 15 files |
| Real-workerd integration cross-check | 20 pass, 0 fail, 0 skip |
| Static RPG Maker text mutation | expected red: 0 pass, 2 fail |

The Wander lockfile remains SHA-256
`217c8997a58f169ee0f1e60ee5d8b63d49f321fab56a79a6d0ab297f683286c9`;
the server lockfile remains
`fd4e3e0124ad02caa43e0a0c86cdce3fe90545db35584bbbc2f6cac0f2c7766f`.
Neither was modified.

## Release order

Publish Wander first, then publish the server commit that advances its Wander
gitlink. No deployment was performed here. Because every online protocol
version is unchanged, this ordering is for submodule availability rather than
an atomic protocol migration; existing clients continue to use the normal
`4000 upgrade-required` path only for genuinely incompatible versions.

subagent 使用：4 个 / 分别核对 capability 接线、包隔离与变异、服务器协议兼容、在线与视觉验收矩阵；并行只读核对节省了时间，重门禁、变异、画面检查和性能测量均由主 agent 完成

PASS
