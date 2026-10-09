# WANDER-FAR-FLAKE：远方玩家测试确定性

## 结论

失败不是 FAR codec 的问题，也不是单纯把 12 秒 timeout 调大就能解决。原测试把两类与目标合同无关的
非确定性绑进了 setup：

1. loopback server 由真实 `setInterval(1000 / hz)` 推进，测试却以 12 秒墙钟为模拟进度上限；繁忙的
   event loop 不保证在这段墙钟内执行足够的权威帧。
2. guest sid 来自随机数并参与 spawn hash，walker 的出生格因此不固定；原测试又要求它一直向东穿过
   真实碰撞地形，若出生行被阻挡，它会永远留在 AOI 内，server 按协议不会发送空 FAR frame。

FAR 还有一层 cadence 嵌套：snapshot 只在 `frame % frameMod === 0` 时进入 `broadcast()`，FAR 又在其中
要求 `frame % farMod === 0`。当前测试的 20 Hz / 10 Hz 参数分别得到 2 / 20，正好每秒命中；但这仍取决于
墙钟 timer 获得调度。

## 修复

- `ServerOpts.manualTick` 可以关闭自动 timer；`ServerHandle.advance(frames)` 复用完整的生产 frame 路径：
  两个 arena step、changed-row flush、snapshot cadence 和 FAR cadence 都没有被测试绕过。
- FAR 集成测试改用专用 manual server，真实 WebSocket、join、server broadcast、wire 编码和测试端解码仍然
  全部参与。
- 收到两个 WELCOME 后推进到权威 frame 2，先断言 AOI 内 STATE4 精确包含 near 与 walker。
- guest spawn 和穿越地形只是 setup，不是本用例要验证的移动合同；测试把权威 walker 放到 near 正东
  `aoi + 1` 的整 tile 位置，再精确推进到 frame 20。
- frame 20 的 STATE4 精确只含 near；紧随其后的 FAR 精确等于 walker 的 `{ dir: 2, band: 0 }`。
- 对真实收到的 wire 断言 8 bytes，并继续钉住 6-byte row。原测试只检查两个常量相加，没有检查网络帧。
- 3 秒 socket 等待只作为 I/O 死锁保护；模拟进度已经完全由 frame count 决定。

移动/碰撞的辨识力没有丢失：权威 fast movement 与 predictor lockstep 已由
`tests/wander-online-journey.test.ts` 的独立 reducer 测试覆盖。本测试现在只验证标题承诺的同一权威时刻
AOI exact entity 与 FAR row 的互斥合同。

## 压力复跑

修复前的用例隔离单跑通过（1 pass，约 1.23 s），与“隔离稳定、全量负载偶发失败”的既有观察一致。
修复后隔离单跑为 1 pass / 0 fail，约 0.26 s。

随后启动 4 路并发、共 20 个独立 Bun 进程，每个只跑目标真实 loopback 用例：

```text
stress_passes=20
exit 0
```

20/20 全部通过；每次用例本体约 36–53 ms，不再等待 20 Hz 墙钟 timer 推进游戏时间。

## 变异辨识力

三项变异都在独立 worktree 中执行，未修改交付分支：

| 变异 | 目标用例的实际结果 |
| --- | --- |
| server 不发送 `FAR_PLAYERS` | FAIL，`Received: null`，命中 `expect(farWire).not.toBeNull()` |
| `farRowsFor` 的方向统一偏转一个 octant | FAIL，期望 `dir: 2`、实际 `dir: 3` |
| FAR row 从 6 bytes 扩成 10 bytes | FAIL，真实 frame 期望 8 bytes、实际 12 bytes |

这三项分别证明测试仍能识别“根本不发帧”、方向语义错误和 wire 隐私宽度回退。

## 门禁

| 命令 | 结果 |
| --- | --- |
| `bun run build` | exit 0，约 4.44 s |
| `bun run build:wasm` | exit 0，生成 360011-byte wasm |
| `bun run test` | 422 pass / 0 fail，499702 expect，33 files，92.07 s |
| `bunx tsc --noEmit` | exit 0，约 5.92 s |
| `git diff --check` | exit 0 |

`bun.lock` 未改；工作树干净。

## 后续建议

一般配置下 FAR 的实际周期是 `lcm(frameMod, farMod) / hz`，不一定等于文档承诺的一秒；若该周期达到
客户端 3 秒 TTL，marker 可能在下一次报告前过期。当前 20 Hz / 10 Hz 配置没有这个产品行为问题，且它与
本次 CI flake 的确定性修复可独立处理；建议后续把 FAR dispatch 从 snapshot cadence 中拆出，并保持同帧
时 STATE4 先于 FAR 的现有顺序。

subagent 使用：3 个 / 分别审查 timer 与随机 spawn 根因、确定性 helper/清理设计、历史与变异方案 / 只读并行审查节省了约 20 分钟，主 agent 复核实现并亲自跑完所有门禁。

PASS
