# NET-WORLD-E：输入打包、v3 退役与运维

E 期按设计的既定范围完成：v4 输入通过 WELCOME4 能力位协商为 6 个参考 tick/包，服务器仍接受旧的单拍和
3-tick v4 输入；v3 代码保留一个发布周期但默认关闭；`/health` 增加 realm 级运维数据；服务器 README
补齐部署、回滚、监控、预算告警和熔断恢复手册。没有部署、push 或删除 v3 实现。

## 交付版本与发布顺序

| 仓库 | 基线 | 本期实现 HEAD（报告提交前） |
| --- | --- | --- |
| PocketJS Wander | `2a71603` | `f914cd1341d56e226a3734613457e5bd8ca65041` |
| Pocket Online Server | `ef5a8fd6a13d7ab0d3fbc31814475d72de34f5b7` | `ea0c26fd09d50490e91a0c44e9638e60a0d318d3` |

服务器子模块钉在 Wander 的运行时代码提交 `82556a07b1b33e3730c4b84d04bffc3363bc1bbe`；Wander 后续两个提交只增加
可复现测量工具和修正按协商批量边界取样的画面测试。

发布必须保持以下顺序：

1. **先服务器**：发布能同时解码旧单拍、3-tick 和 6-tick INPUT 的版本；探测 `/ws/v4` 两种批量并检查
   `/health`。此时旧 v4 网页仍按 3-tick 正常工作。
2. **再网页**：发布带 WELCOME4 能力协商的 cache-busted v4 包。新客户端碰到回滚后的旧服务器时，因为
   能力位缺失会自动回退 3-tick。
3. v3 的 `V3_ENABLED=1` 逃生开关保留一个发布周期。本期默认值为 `0`，但不删除 legacy Room、协议或测试。

若两端都要回滚，先回滚网页，再选择已知正常的 Worker deployment；realm SQLite 数据不降级、不删除。

## 输入打包与兼容性

协议仍是 v4，消息编号和包头均未变化。WELCOME4 mover flags 的空闲 bit `0x04` 表示服务器接受 6-tick
批量：

- 旧客户端忽略该 bit，继续发送 3-tick 包；
- 新客户端只有看到该 bit 才切到 6，否则保守回退 3；
- 服务端共享 decoder 上限从 3 提到 6，逐 tick 按连续 seq 展开，权威 20 Hz 调度和 ack/reconcile 不变；
- encoder 对 7 tick 明确抛错，不会静默截断；fresh WELCOME、换 realm 和 close 都清空半包，旧 epoch 的 seq
  不会混入新连接；
- 本地预测仍在每个 60 Hz 参考 tick 同步执行，等待的是网络打包，不是玩家自己的画面。

服务器集成测试同时发送了旧的 plain INPUT、3-tick INPUT_BATCH 和新的 6-tick INPUT_BATCH；三者都推进相同
的权威 mover。Wander codec 测试钉住 6-tick 18-byte 往返、旧 3-tick 往返和 7-tick 拒绝。

## A/B 测量

`tools/net-world-e-measure.ts` 使用真实 loopback Bun WebSocket server 和两个真实 `OnlineClient`，不是纯函数
估算。两组都采用 20 Hz server、10 Hz snapshot、60 Hz 客户端、100 ms 远端插值、双向各 40 ms 固定模拟
链路（实测 RTT 81 ms）。3-tick 基线只在测量传输层清除 WELCOME4 能力 bit；服务器、预测、回滚、碰撞和
插值代码完全相同。每组做 8 次输入边沿可见性采样，再做 12 秒运动和 0.7 秒排空。命令为：

```sh
bun run tools/net-world-e-measure.ts --out <result.json>
```

### 纠正、手感和消息率

| 指标 | 3 tick/包 | 6 tick/包 | 变化 |
| --- | ---: | ---: | ---: |
| INPUT_BATCH cadence | 20.002/s | 10.001/s | -50.000% |
| PING cadence | 0.497/s | 0.498/s | +0.001/s |
| 每客户端稳态入站消息 | **20.499/s** | **10.498/s** | **-48.788%** |
| 相同窗口的参考 ticks | 762 | 762 | 0 |
| 两客户端权威 STATE4 样本 | 254 | 252 | -2（调度边界） |
| corrections / STATE4 | **0 / 254** | **0 / 252** | 都是 0% |
| 本地可见延迟 median / p95 | 9.789 / 15.278 ms | 6.352 / 15.676 ms | -3.437 / +0.398 ms |
| 远端可见延迟 median / p95 | 201.149 / 244.106 ms | 243.673 / 280.479 ms | +42.524 / +36.373 ms |

6-tick 没有增加纠正，本地输入 p95 实质不变；远端观察者增加约 36–43 ms，落在新增的半个 100 ms 打包窗
以内，也没有改变 100 ms snapshot/interpolation 的工作方式。这不是本地操控延迟，且低于一个额外 50 ms
服务器 tick 窗。相对 48.8% 的入站消息下降，没有达到需要退回保守参数的“纠正率或本地手感明显变差”条件，
因此采用 **6 tick/包、约 10 Hz INPUT_BATCH**。

### 31 天满房容量成本

成本表使用实测消息 cadence，假设每房 32 人、31 天持续占用、WebSocket 入站消息按 20:1 折算请求、
128 MB 按十进制 `0.128 GB-s/s`、包含 1M requests 和 400,000 GB-s、超额分别 `$0.15/M requests` 与
`$12.50/M GB-s`，再加 `$5` Workers Paid 基础费。

| 满载 realm | 玩家 | 3-tick billed requests | 6-tick billed requests | GB-s | 3-tick 总额 | 6-tick 总额 | 节省 |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 32 | 87,847,235 | 44,988,549 | 342,835.2 | $18.03 | **$11.60** | $6.43 |
| 2 | 64 | 175,694,469 | 89,977,098 | 685,670.4 | $34.78 | **$21.92** | $12.86 |
| 3 | 96 | 263,541,704 | 134,965,647 | 1,028,505.6 | $52.24 | **$32.95** | $19.29 |
| 4 | 128 | 351,388,938 | 179,954,196 | 1,371,340.8 | $69.70 | **$43.98** | $25.72 |

这张表是**提高或关闭应用 breaker 后的容量模型**，不是默认 breaker 允许持续发生的账单。它只含稳态玩家
INPUT/PING 和持续占用 Room 的 duration，不含 upgrade、Worker 标准请求、控制面 DO 调用、storage、税费或
同账号其它服务。`/health` ledger 与 Cloudflare Billable Usage 仍分别是应用侧估计和账单侧权威；README
明确记录了两者误差边界不能由应用证明为有限值。使用十进制 0.128 GB 而不是旧设计表的 0.125 GiB，是
四满房结果略高于设计约 `$43.59` 的主要原因。

## v3 退役

只读线上核对发生在 2026-10-09：环境变量给出的生产 health endpoint 返回 `online=1`，同时
`/stats?room=plaza-1` 到 `plaza-4` 四个 legacy 房间全部返回 `players=0, protocol=3`。因此当时唯一服务连接
不是 v3，四个配置的 v3 房间连接数均为 0，满足默认关闭依据。

`wrangler.toml` 现在默认 `V3_ENABLED="0"`。关闭时 `/ws` 完成 WebSocket upgrade 后立即以 policy code 1008、
reason `version` 关闭；旧客户端把它显示为明确的 `SERVER UPGRADED`，并停止无意义重连。拒绝发生在 Meter/Room
stub 之前，测试证明不会唤醒 Durable Object。开关设为 `1` 时原 v3 流程、Room 身份和消息格式完全保留；
三端兼容演示显式用 `V3_ENABLED:1`，正是为了验证这一个发布周期的逃生路径。

## `/health` 与运维

Room 在现有定期 `/report` 上顺带上报运维遥测，Meter 与在线房间记录一起持久化；`/health` 读取一次 Meter
snapshot，并为没有报告的配置 realm 填 0/null，因此日常健康检查**不会 fan-out 唤醒所有 Room**。新增字段为：

- 顶层 `protocols.v3Enabled/v4Enabled`、`realmCount`；
- 每 realm 的 `online`、`activeChunks`、`residentChunks`、派生 `cachedChunks`、`residentPlans`、
  `generationBacklog`、`lastCheckpointAtMs`、`reportedAtMs`；
- checkpoint 时间只单调前进，Room `/stats` 也提供同一时间，便于定向诊断。

README 的 runbook 已写明：服务器先行的部署顺序、旧/新 v4 canary、网页与 Worker 回滚、v3 一周期恢复步骤、
应观察的 correction/tick p99/backlog/cache/checkpoint/storage 数字，以及 Cloudflare 告警。建议账户 overage 先设
`$1`，再设经批准的 `$5/$10`；DO requests 与 duration 另看 50%/75%/90% 标线。软熔断先停止准入并查首个
越线维度；硬熔断后已有 socket 已被 `rest` 关闭，不反复重连。首选等待 UTC 月切；只有明确批准费用后才提高
plan quota，不能删 Meter storage 强开服务。

## 验证

| 门禁 | 结果 |
| --- | --- |
| Wander `bun run build` | exit 0，生成当前 `wander-online` desktop/web 输入 |
| Wander `bun run build:wasm` | exit 0，PocketJS wasm 360,011 bytes |
| Wander `bun run test --reporter=dot` | **420 pass / 0 fail / 0 skip**，499,697 assertions，33 files |
| Wander `bunx tsc --noEmit` | exit 0 |
| Server `bun run test --reporter=dot` | **216 pass / 0 fail**，1,701 assertions，9 files |
| Server `bun run typecheck` | exit 0 |
| `bash -n scripts/demo-cf.sh` | exit 0 |
| 本机托管三端完整演示 | **3/3 PASS** |

三轮演示每轮都实际启动 wrangler/workerd、两个 QuickJS desktop 和 Chrome，并完成：

1. 三个 v4 客户端 `ROOM 3 / ALL 3`，活连接下停止并重启服务器，三端看到 reconnecting、新 epoch 并继续移动；
2. 邀请主人钉在 `plaza-2`，网页用真实 invite fragment 进入同一 realm，表情由服务器回显，离开 AOI 后显示
   粗粒度方向带；
3. cap=1 时同一个有效邀请明确显示 `WORLD FULL`，不静默换 realm；
4. 临时打开 v3 开关后，v3 与 v4 各一房且 `ALL=2`；跨过全局 hard request threshold 后，两房的活跃浏览器
   和两次新探针都收到 1008 `rest`；
5. 健康输出含 `realmCount=2` 及两条 realm 结构，重启/邀请/熔断过程中没有 console error。

第一轮保留的关键 PNG 已逐张肉眼打开：960×544 世界帧的中文名、HUD、建筑和 4 朵共享花正常；480×272
受邀帧名字与相遇提示清晰；方向带位于屏幕边缘且标签可读；满房画面明确写 `WORLD FULL · RETRY 15s`；v3/v4
熔断画面都明确写 `CLOSED FOR THE MONTH`。自动像素断言三轮一致：世界 coverage=1，共享花 4/4；表情奶油色
像素 `[371,2644]`；方向 marker/label 为 `[81,222]` 与 `[576,1772]`；满房拒绝文字像素 `[467,2880]`。

subagent 使用：3 个 / 分别只读核对客户端协议兼容与测试面、测量与 Cloudflare 成本口径、服务器 v3/health/运维实现；并行调研节省了定位时间，代码集成、全部重门禁、性能测量和三轮演示均由主 agent 串行完成。

PASS
