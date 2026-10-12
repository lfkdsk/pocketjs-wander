# Pocket RPG Kit advance and binary waiter hardening

## Verdict

PASS. Wander and Wander Online now consume Pocket RPG Kit
`189a6f0dd2c4642fcff6fcecdd02d8e4a5985091`. The component gitlink is the
only runtime-source change in Wander; no application workaround and no
component modification were required. Save data, local online state and every
wire version remain compatible.

Both repositories pass their complete gates with zero skipped tests. The two
binary integration waiters now share one event-driven overall timeout, and a
two-CPU constrained run with a competing load completed the whole workerd
integration file 30 times without a failure. All four decisive QuickJS cold
start profiles are within the +3% ceiling; the worst result is +0.425%.

## Revisions under test

| Item | Baseline | Candidate |
| --- | --- | --- |
| Wander source | `dc7cb6127ea4c60ab0c30c028a373dac92d1ed94` | `3714c6a24699b95fea700d85db8cec99d0701bdf` |
| Pocket RPG Kit | `2a37b9aa5c6f464087cc5d97a815a38d2000acbd` | `189a6f0dd2c4642fcff6fcecdd02d8e4a5985091` |
| Nested PocketJS | `862040bd77edc49b1f815beff63952b6616a14c6` | unchanged |
| Hosted server | `6bfc36db216d018e63294c506423646f85a3ffc3` | `4e9693629150a3cba6d5cc23f5c57724d1706aec` |

The server candidate pins Wander `3714c6a`. Its committed submodule URL remains
the public GitHub URL; local URL rewrites were not committed. Neither branch
contains a merge commit, and no push or deployment was performed.

The new component revision includes the scene-freeze and rewind copy-on-write
fixes, immediate facing and background-stack support, and corrected audio-gain
projection. Wander needed no source adaptation after the advance. The nested
PocketJS revision did not move, so no wasm rebuild attributable to a PocketJS
change was needed beyond the clean-checkout build used by the gates.

## Compatibility and protocol

The pre-upgrade single-player fixture restores byte-for-byte state, preserves
travel and errand progress, and continues stepping. The pre-upgrade online
ticket and realm state rejoin the same realm and continue sending input. The
focused compatibility, authentication and bundle-isolation command completed
`22 pass, 0 fail` across three files.

The protocol matrix is unchanged:

| Surface | Version |
| --- | ---: |
| World | 4 |
| World state | 1 |
| Generator | 1 |
| Authentication | 3 |
| Social | 1 |
| Postcard | 1 |

No synchronized protocol cutover is required. Existing incompatible clients
retain the established private `4000` upgrade-required path.

The Wander lockfile remains
`217c8997a58f169ee0f1e60ee5d8b63d49f321fab56a79a6d0ab297f683286c9`;
the server lockfile remains
`fd4e3e0124ad02caa43e0a0c86cdce3fe90545db35584bbbc2f6cac0f2c7766f`.

## Package isolation and size

Both revisions were built from the same Wander source tree. Compressed sizes
use deterministic `gzip -n -9`.

| Artifact | Baseline raw / gzip | Candidate raw / gzip | Raw delta | Gzip delta |
| --- | ---: | ---: | ---: | ---: |
| Wander JS | 890,187 / 188,693 B | 900,396 / 190,644 B | +10,209 B (+1.147%) | +1,951 B (+1.034%) |
| Wander pak | 1,132,768 / 73,951 B | unchanged | 0 B | 0 B |
| Wander Online JS | 1,136,900 / 244,731 B | 1,147,109 / 246,681 B | +10,209 B (+0.898%) | +1,950 B (+0.797%) |
| Wander Online pak | 2,543,120 / 328,885 B | unchanged | 0 B | 0 B |

Input counts and their manifests are unchanged: 608 modules for Wander and 633
for Wander Online. Both pak files are byte-identical across the comparison.
The detailed bytes and SHA-256 values are in
`reports/net-bump-3-size.json`.

The clean isolation gate passes `2/2`: neither bundle admits the optional RPG
Maker battle, text, screen, styled-choice or component-travel implementation.
In a disposable worktree, statically importing `rpgmaker-text.ts` admitted both
`rpgmaker-screen.ts` and `rpgmaker-text.ts`; the same gate then failed both
applications (`0 pass, 2 fail`, exit 1). The isolation assertion therefore
detects the required regression.

## QuickJS performance

All measurements use the release PocketJS desktop QuickJS host and the same
compiled benchmark binary (SHA-256
`ba8aac66187409f7da970451303f2a617329194c6d0664c4dba6ff3db68bde78`).
Each workload ran three baseline-candidate-candidate-baseline rounds.

The first complete cold matrix ran while system load was about 11 and showed
large scheduler spikes. Before inspecting a replacement result, the complete
four-profile rerun was declared decisive. Its preflight load was
`3.33 / 6.82 / 8.38`; CPU 11 was 97.38% idle over the five-second sample and
then exclusively hosted the benchmark processes. Each slot used one unmeasured
warmup runtime and seven measured runtimes. The gate is the mean of six
per-revision slot medians.

### Cold start

| Application / viewport | Baseline -> candidate | Delta | Bundle-eval delta | Gate |
| --- | ---: | ---: | ---: | --- |
| Wander 480x272 | 117.112 -> 116.533 ms | -0.495% | -0.172% | pass |
| Wander 960x544 | 144.665 -> 144.361 ms | -0.210% | -0.370% | pass |
| Wander Online 480x272 | 58.833 -> 59.083 ms | +0.425% | +0.862% | pass |
| Wander Online 960x544 | 58.959 -> 58.873 ms | -0.146% | +0.078% | pass |

All four decisive rows are below the allowed +3%; the worst is +0.425%.

### Single-player roaming frames

The runner was pinned to CPU 14 and the QuickJS host to CPU 15; both CPUs were
95.56% idle in the preflight sample. Each slot ran 480 ticks, discarded the
first 120, and retained 360 work-time samples. Six slots therefore contribute
2,160 samples per revision.

| Metric | Baseline | Candidate | Delta |
| --- | ---: | ---: | ---: |
| Mean work time | 1,354.750 us | 1,336.500 us | -18.250 us (-1.347%) |
| Mean slot p95 | 2,042.333 us | 2,066.833 us | +1.200% |
| Mean 95% CI | [1,277.482, 1,432.018] us | [1,249.912, 1,423.088] us | — |

Using the six independent slot means, the conservative two-sided Welch 95%
interval for candidate minus baseline is `[-120.377, +83.877] us`
(`[-8.885%, +6.191%]` of the baseline mean). The point estimate improves by
1.347%, but the interval crosses zero: the change is not statistically
distinguishable. The slot samples, method and excluded high-load diagnostic
matrix are retained with the performance artifact; the structured decisive
result is `reports/net-bump-3-performance.json`.

## Server waiter hardening

`nextBinary` owns one overall timeout and at most one active `nextMessage()`
resolver. It filters non-target binary frames without creating a polling
timeout per iteration and clears the timer on success or failure. Both
`waitForOnline` and the v3/v4 `STATE4` split check use the helper.

The regression test delays the target beyond the old 500 ms polling slice,
then asserts exactly one pending resolver before delivery and zero afterward.
In a disposable mutation worktree, restoring the old per-slice
`Promise.race` loop made the test fail with `Expected: 1`, `Received: 2`.

Under a CPU 0-1 affinity limit with a competing busy loop on CPU 0, the complete
real-workerd integration file ran 30 times. Every round reported
`21 pass, 0 fail`; the normalized log has SHA-256
`19a91771fe1375fabe31be5b231d022b1487ac8754c90b61391f66c935b29004`.

## Local online and gameplay regression

- One complete local run started two real desktop QuickJS hosts and one real
  Chrome tab. Chrome observed `online=3`, `remotes=2`, zero corrections and
  zero console errors; both desktop logs observed all three clients.
- With 150 ms simulated one-way latency, the desktop client settled at 317 ms
  RTT with zero corrections. After a crash-style server restart, Chrome and
  desktop both rejoined; Chrome changed epoch from `80095341` to `1755656702`.
- The first attempt correctly failed because an existing desktop profile held
  an expired sign-in. The passing run used a fresh isolated application-data
  root; no stored user data was deleted and authentication was not bypassed.
- Three independent WebSocket clients completed a cooperative errand. The
  first courier waited at 1/2, the friend received exactly one privacy-safe
  notification, the nonfriend received zero identified notifications, the
  anonymous board count was 1, and observer and authoritative revisions both
  ended at 3.
- Three live WebSocket clients completed the daily goal from `required - 1`.
  Both couriers retained private contribution credit, four level-2 festival
  stalls appeared, and the same connections rolled to UTC day 20026.
- The real-workerd suite covers postcard response loss and replay through a
  second realm, one delivery and one quota charge, nonfriend rejection, read
  state, and opaque-ID reply. Player cards and tiered achievements remain
  covered by the full client suite and the visual profile matrix.

## Visual acceptance

All generated reports pass their semantic-pixel, text-fit and geometry checks.

| Surface | Coverage | Result |
| --- | --- | --- |
| Journey and cooperative play | 24 scenes, 480x272 and 960x544, EN/ZH, native and nearest-neighbour 3x | pass |
| Daily goals | 16 scenes across desktop and phone-shaped viewports, EN/ZH | pass |
| Social and leaderboard | 12 scenes, both desktop sizes | pass |
| Player card and achievements | 8 scenes, both desktop sizes | pass |
| Postcards | 16 scenes, both desktop sizes, EN/ZH | pass |
| Real Chrome mobile | 34 screenshots: 390x844@3 portrait and 844x390@3 landscape | pass |

Key 3x frames were opened and inspected manually: cooperative READY/countdown,
daily-goal panels, the second achievement page, the Chinese postcard review,
portrait player card/co-op, and landscape postcard/daily-goal states. Text is
legible without clipping, panels stay inside the viewport, and touch controls
do not cover critical content. The mobile report has no failures or console
errors.

## Final gates

| Repository / gate | Result |
| --- | --- |
| Wander application build | pass |
| Wander TypeScript | pass |
| Wander full suite | 523 pass, 0 fail, 0 skip; 45 files; 501,127 assertions |
| Wander compatibility/auth/isolation focus | 22 pass, 0 fail, 0 skip |
| Hosted server TypeScript | pass |
| Hosted server full suite | 352 pass, 0 fail, 0 skip; 16 files; 3,648 assertions |
| Hosted server integration, constrained repeat | 30 x 21 pass, 0 fail |
| Binary waiter focused regression | 3 pass, 0 fail |
| Static RPG Maker text mutation | expected red: 0 pass, 2 fail |
| Old waiter mutation | expected red: pending resolvers 2, expected 1 |

## Release order

Publish Wander first, then publish the server commit that advances its Wander
gitlink. No deployment was performed. Because protocol versions did not move,
the order is for submodule availability rather than an atomic client/server
migration.

subagent 使用：3 个 / 分别复核基线与性能方法、waiter 根因与补丁设计、视觉与联机验收矩阵 / 并行只读核对节省了时间，所有重门禁、变异、实机画面检查与性能测量均由主 agent 串行完成

PASS
