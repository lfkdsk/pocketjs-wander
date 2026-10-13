# Pocket RPG Kit capability and performance advance

## Verdict

PASS. Wander and Wander Online now consume Pocket RPG Kit
`be938da56905c96410ed9db4cf0345eca10cfc99`, advanced from
`189a6f0dd2c4642fcff6fcecdd02d8e4a5985091`. The component gitlink is the
only runtime-source change in Wander. No application workaround, capability
declaration change, PocketJS change, server change, push or deployment was
required.

Both application repositories pass their complete gates with zero skipped
tests. Frozen saves and online local state remain compatible, all six protocol
versions are unchanged, and the optional-module and capability mutations both
turn their guards red. All four QuickJS cold-start profiles are below the
allowed +3%; the worst point estimate is +0.215%.

## Revisions under test

| Item | Baseline | Candidate |
| --- | --- | --- |
| Wander runtime source | `b827e9a` | `bf87e52e9afb3feaa56336363aa4750c12c6b714` |
| Pocket RPG Kit | `189a6f0dd2c4642fcff6fcecdd02d8e4a5985091` | `be938da56905c96410ed9db4cf0345eca10cfc99` |
| Nested PocketJS | `862040bd77edc49b1f815beff63952b6616a14c6` | unchanged |
| Hosted server | `4e9693629150a3cba6d5cc23f5c57724d1706aec` | unchanged |

The report commit follows the tested runtime commit and changes only evidence
files. The component range is linear: 35 commits, 41 changed files and
`+3,641/-490`. It includes the immediate-event route-speed fix, strict screen
capability admission and cleanup coverage, unused streamed-roam drift
recovery, immutable battle-frame allocation reduction, cumulative QuickJS
drift guards, and their documentation.

The nested PocketJS revision and release desktop host are unchanged; the host
binary SHA-256 remains
`1a770226187efc49b5f413c83ee00357dea3a024343c874d67206baf53ba16e7`.
Wander's lockfile is also unchanged at
`217c8997a58f169ee0f1e60ee5d8b63d49f321fab56a79a6d0ab297f683286c9`.

## Capability admission

Wander declares only the fail-soft game-text-token facility and passes its
resolver directly. It has no RPG Maker text, screen, travel or battle content
trigger, so the new strict capability admission correctly accepts the existing
project without a declaration or import change.

The clean application starts normally. In an isolated mutation, a `screenTone`
command was added to a common event without registering its optional runtime.
Real Wander startup exited 1 with:

```text
RPG Maker screen: commands screenTone require the optional rpgMakerText runtime
```

This proves nested/common-event admission is active in the integration rather
than being covered only by component-unit tests. The mutation was discarded.

## Save, local state and protocol compatibility

The frozen pre-upgrade fixture has SHA-256
`34759b2f90d5885fc57112c49a79ebc79b5f296a0cce2e925987d4e81f2676ef`.
Its single-player travel log and errand state restore byte-for-byte, preserve
their digests, and continue stepping. Its stored web ticket and realm selection
rejoin `cedar-realm`, remain byte-identical in the storage bridge, and continue
sending movement input after admission.

The protocol matrix remains:

| Surface | Version |
| --- | ---: |
| World | 4 |
| World state | 1 |
| Generator | 1 |
| Authentication | 3 |
| Social | 1 |
| Postcard | 1 |

Focused compatibility, authentication and isolation coverage completed
`22 pass, 0 fail, 0 skip`. Protocol codec and legacy-path coverage completed
`89 pass, 0 fail, 0 skip`, and the real loopback client/server reconnect group
completed `18 pass, 0 fail, 0 skip`.

## Package isolation and size

Both revisions were built from the same Wander source tree. Compressed sizes
use deterministic `gzip -n -9`.

| Artifact | Baseline raw / gzip | Candidate raw / gzip | Raw delta | Gzip delta |
| --- | ---: | ---: | ---: | ---: |
| Wander JS | 900,396 / 190,644 B | 906,826 / 191,625 B | +6,430 B (+0.714%) | +981 B (+0.515%) |
| Wander pak | 1,132,768 / 73,951 B | unchanged | 0 B | 0 B |
| Wander Online JS | 1,147,109 / 246,681 B | 1,153,539 / 247,644 B | +6,430 B (+0.561%) | +963 B (+0.390%) |
| Wander Online pak | 2,543,120 / 328,885 B | unchanged | 0 B | 0 B |

The input manifests are byte-identical across the comparison: 608 modules for
Wander and 633 for Wander Online. Both pak files are byte-identical. Exact
bytes, hashes and deltas are recorded in `reports/net-bump-4-size.json`.

The clean bundle-isolation gate passes `2/2`. Neither application admits the
optional RPG Maker battle, text, screen, styled-choice or component-travel
implementation. In a separate mutation worktree, statically importing
`rpgmaker-text.ts` from the ordinary session path admitted both
`rpgmaker-screen.ts` and `rpgmaker-text.ts`; the unchanged gate then failed
both applications (`0 pass, 2 fail`, exit 1). The assertion therefore detects
the required isolation regression.

## QuickJS performance

All results use the release PocketJS desktop QuickJS host. Each workload ran
three baseline-candidate-candidate-baseline rounds in one measurement window.
No subagent or other task-local heavy command ran concurrently.

### Cold start

The machine load average was `7.12 / 6.52 / 6.81`, but the selected CPU 16 was
98.20% idle over the five-second preflight and exclusively hosted each
benchmark process. Each slot used one unmeasured warmup runtime and seven
measured runtimes. The gate compares the mean of six per-revision slot
medians.

| Application / viewport | Baseline -> candidate | Delta | Bundle-eval delta | Gate |
| --- | ---: | ---: | ---: | --- |
| Wander 480x272 | 117.380 -> 115.134 ms | -1.913% | -1.927% | pass |
| Wander 960x544 | 146.771 -> 145.146 ms | -1.107% | -1.414% | pass |
| Wander Online 480x272 | 58.602 -> 58.562 ms | -0.068% | -0.032% | pass |
| Wander Online 960x544 | 59.106 -> 59.233 ms | +0.215% | +0.152% | pass |

All four rows are within the +3% ceiling; the worst is +0.215%.

### Single-player roaming frames

The runner was pinned to CPU 14 and the QuickJS host to CPU 15. Their
five-second preflight idle rates were 98.00% and 97.19%, respectively. Each
slot ran 480 ticks, discarded the first 120, and retained 360 QuickJS work-time
samples. Six slots contribute 2,160 samples per revision.

| Metric | Baseline | Candidate | Delta |
| --- | ---: | ---: | ---: |
| Mean work time | 1,374.367 us | 1,340.300 us | -34.067 us (-2.479%) |
| Mean slot p95 | 2,072.167 us | 2,049.167 us | -1.110% |
| Mean 95% CI | [1,301.628, 1,447.106] us | [1,289.214, 1,391.386] us | — |

Using the six independent slot means, the conservative two-sided Welch 95%
interval for candidate minus baseline is `[-112.288, +44.155] us`
(`[-8.170%, +3.213%]` of the baseline mean). The point estimate improves by
2.479%, but the interval crosses zero, so the change is not statistically
distinguishable. Full slot values and methodology are in
`reports/net-bump-4-performance.json`.

## Online and gameplay regression

- A mixed three-client local run used two real desktop QuickJS hosts and one
  real Chrome client. All three joined the same world and exposed the expected
  remote players without console errors.
- Three independent live WebSocket clients completed a cooperative delivery.
  The first courier waited at 1/2, the friend received one privacy-safe notice,
  the nonfriend received no identified notice, the anonymous board showed one
  waiter, both couriers completed, and the observer received authoritative
  revision 3. The structured transcript passes in
  `reports/net-bump-4/three-client-coop.json`.
- Three live clients advanced a daily delivery from zero through a cooperative
  completion. Both final couriers retained private contribution credit, all
  clients saw four level-2 festival cells, and the same three connections
  rolled from UTC day 20025 to 20026. The structured transcript passes in
  `reports/net-bump-4/three-client-daily-goal.json`.
- The full client and server suites cover player cards and tiered achievements,
  postcard send/read/reply and loss-safe replay, daily goals, cooperative
  deliveries, and FIRST listing/privacy behavior. The visual matrix exercises
  each corresponding screen in the shipping clients.

## Visual acceptance

Generated visual reports pass their semantic-pixel, required-text and geometry
checks.

| Surface | Coverage | Result |
| --- | --- | --- |
| Desktop online world and entry flows | 24 PNGs; 480x272 and 960x544, native and nearest-neighbour 3x | pass |
| Desktop player card, achievements, social and FIRST | 56 PNGs; both desktop sizes, EN/ZH where applicable, native and 3x | pass |
| Real Chrome mobile | 34 DPR-3 screenshots; 390x844 portrait and 844x390 landscape | pass |

Representative images were opened and inspected manually at the final review:
the 480x272 three-player world at 3x, the 960x544 FIRST board at 3x, the real
Chrome portrait player card and the real Chrome landscape Chinese postcard
reply. Terrain and labels remain legible, modal borders stay inside the game
viewport, Chinese glyphs render correctly, and touch controls do not obscure
the active panels. The mobile report records no failures or console errors.

## Final gates

| Repository / gate | Result |
| --- | --- |
| Wander web and desktop builds | pass |
| Wander TypeScript | pass |
| Wander full suite | 523 pass, 0 fail, 0 skip; 45 files; 501,127 assertions |
| Wander compatibility/auth/isolation focus | 22 pass, 0 fail, 0 skip |
| Wander protocol/legacy focus | 89 pass, 0 fail, 0 skip |
| Wander real loopback reconnect focus | 18 pass, 0 fail, 0 skip |
| Hosted server TypeScript | pass |
| Hosted server full suite | 352 pass, 0 fail, 0 skip; 16 files; 3,648 assertions |
| Static RPG Maker text mutation | expected red: 0 pass, 2 fail, exit 1 |
| Missing capability mutation | expected red: startup exit 1 with named `screenTone` error |

The server gates ran from a clean checkout at
`4e9693629150a3cba6d5cc23f5c57724d1706aec`; its lockfile SHA-256 remains
`fd4e3e0124ad02caa43e0a0c86cdce3fe90545db35584bbbc2f6cac0f2c7766f`.

## Release order and server decision

The component revision is already the tested component `main`; publish the
Wander gitlink advance after that revision is available. The server does not
change and requires no redeployment. Only the client-side component gitlink
moved, while the wire-version matrix, frozen online storage keys and values,
server persistence behavior, nested PocketJS revision and all server source
remain unchanged. No synchronized cutover is needed.

服务器不动、无需重新部署。

subagent 使用：3 个 / 分别复核组件兼容与声明边界、隔离变异与测试辨识力、在线与视觉验收清单 / 并行只读核对节省了时间，所有重门禁、实机画面检查、变异执行与性能测量均由主 agent 串行完成

PASS
