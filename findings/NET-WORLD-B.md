# NET-WORLD-B：realm 共享成长与稀疏持久化验收

## 结论

B 期已形成完整闭环：`/ws/v4` realm 把生成器版本与 seed、区域发现时间、
城镇成长、共享改造、地标首发现和每账号私有进度写入 Durable Object SQLite；
客户端按服务器墙钟从稀疏事实推导成长 phase，使渲染与碰撞使用同一 phase。
玩家位置与朝向以最多每 30 秒一次的 checkpoint 保存，地标发现和断开立即
落盘，没有逐 tick storage 写入。真实 `wrangler dev` 重启后，三端恢复了同一
FIRST 名字、共享花、成长起点和各自 checkpoint/private progress。

原 `/ws` 仍是隔离的 v3 legacy room，不创建 realm SQLite store。实现严格停在
B 期，没有加入告示板、差事、旅记、出生、邀请或表情。

## 交付版本

| 仓库 | B 期起始基线 | 已验收实现/文档 HEAD |
| --- | --- | --- |
| PocketJS Wander | `a743965` | `f97f4d4a027cb94aeedf179694facbb3b26d8df0` |
| Pocket Online Server | `82e4648` | `e5a9f430d3a8cb72d5a574b9c260d80f648fcae7` |

服务器的 `vendor/pocketjs-wander` 子模块指向 Wander
`f97f4d4a027cb94aeedf179694facbb3b26d8df0`。本报告是 Wander 的后续交付提交；
没有 push、部署、开 PR 或修改远端配置。

## 持久化模型与迁移

每个 v4 realm 使用四张稀疏表：

| 表 | 权威内容 | 写入时机 |
| --- | --- | --- |
| `world_meta` | schema version、固定 seed/generator、全 realm 下一 revision | 初始化和共享事实提交 |
| `region_state` | 区域发现时间、发现者、单调 improvement level、共享 revision | 首次到达或改造 |
| `landmark_first` | 地标稳定 id 与唯一 first discoverer/display name | 首次地标到达 |
| `player_world` | 账号私有坐标、朝向、安全 hub、私有发现集合与独立 revision | checkpoint、地标、断开 |

- 当前 `WORLD_STATE_VERSION=1`、`GENERATOR_VERSION=1`。首次打开 A 期无表的
  realm 会事务性建表并写入 metadata；真实的 v0 `world_meta` 数据库也有显式
  v0→v1 迁移测试。未知的未来 schema 版本、seed 或 generator 不匹配会 fail
  closed，不会静默重写世界。
- 区域/地标发现通过事务性 insert-if-absent 与 realm revision 提交实现
  first-writer-wins；失败会整体回滚。即使两个玩家同一时刻进入，也只有一个
  first discoverer，输家读取并广播同一赢家名字。
- 私有发现集合是稳定、有序、去重的 `(rx, ry)` FIFO，硬上限 1,024；协议中的
  `PLAYER_PROGRESS 0x23` 只发给所属账号 socket。共享包只带可公开的 display
  name，不广播账号 id 或别人的私有集合。
- `REGION_STATE 0x22` 携带 discovery time、improvement、FIRST、共享 revision
  和 server time。初始 world-state 到达前客户端不运行预测；late entrant 每次
  `STATE4` 前会先取得当前附近的缓存区域行，因此已被别人预热的区域也不会用
  未发现 phase 先模拟一帧。

## 共享成长、碰撞与改造

区域只持久化 `discoveredAtMs`，成长 tick 由服务器墙钟、60 Hz reference frame
和现有 `GROWTH_TICK_FRAMES=8` 推导并封顶。客户端时钟只单调前进，过期 delta
不能回退成长或 improvement；rollback history 同时保存每个输入对应的 server
timestamp，重放时不会拿“现在”的 phase 改写历史碰撞。

渲染、移动碰撞和权威服务器均调用相同 seed、generator、region phase 与
improvement projection。共享改造单调且幂等；区域 plan 生成或从 cache 恢复时
都会重放现有 improvement cells。验收场景中的 level 1 改造在城镇中心增加四朵
花，三名客户端都收到 level 1。用于触发它的开关同时要求
`ENVIRONMENT=development` 与 `DEV_REALM_IMPROVE=1`；生产配置会忽略它，协议
也没有可供玩家调用的裸改造 RPC。

## 稀疏写入、恢复与计量

- 默认 `REALM_CHECKPOINT_INTERVAL_SEC=30`。移动只标 dirty；定时点最多写一
  次，内容没变则跳过。地标发现和断开会立即 flush。60 Hz reference tick 与
  20 Hz host tick 都不直接写 storage。
- RoomDO 重建会重新打开 SQLite，校验 metadata，并恢复 seed/generator、区域
  discovery origin、成长、improvement、FIRST、玩家坐标/朝向/安全 hub 和每账号
  私有 revision/集合。客户端仍按新 epoch 清掉旧预测历史。
- 每个 RealmStore SQLite cursor 的原生 `rowsRead`/`rowsWritten` 进入 UTC 月度
  Meter ledger 和 `/health`。上报失败时 storage row debt 与原 request/duration
  debt 一起持久化，重建后只确认一次；row 指标是观测项，不改变既有 breaker
  的 request/GB-s 判定。
- legacy v3 使用独立 DO identity，既不建 RealmStore，也不发送 v4 shared/private
  包；测试钉住其 realm SQL 调用数为零。

## 自动化验收

| 要求 | 结果 | 主要自动化证据 |
| --- | --- | --- |
| 同区同时进入，恰好一个 FIRST | 两名玩家的 landmark row 都显示同一赢家；数据库只有一条 FIRST | `tests/room-do.test.ts`、`tests/realm-storage.test.ts` |
| 两端每个成长 phase 的碰撞与单机一致 | discovery 前、成长中、完成后的共享 world collision 与相同 seed/phase 的单机 projection 相等 | `tests/wander-online-world-state.test.ts`、`tests/wander-online-realm-acceptance.test.ts` |
| 帮助城镇后双方看到改造 | improvement 单调持久化；cache rebuild 重放四朵花；所有客户端为 level 1 | 两仓 realm/world-state 测试与真实 demo |
| DO 重建恢复全部 B 期状态 | seed、phase origin、improvement、FIRST、checkpoint facing/position 和 private revision 均恢复 | `tests/room-do.test.ts`、`tests/realm-storage.test.ts` |
| 无逐 tick 写；30 秒上限 | 大量 ticks 后 30 秒前零新增 checkpoint write，边界只增一行，之后不重复；未变化玩家跳过 | `tests/room-do.test.ts` |
| A 期旧 realm 初始化与 v0 迁移 | 无表数据库初始化；真实 v0 metadata 数据库升级为四表 v1 | `tests/realm-storage.test.ts` |
| 私有进度不泄露 | 每个玩家只收到自己的 progress set，peer socket 不出现对方私有坐标 | `tests/room-do.test.ts`、`tests/wander-online-client-core.test.ts` |
| v3 与 ledger | v3 零 realm SQL；v3/v4 双路、storage row health/debt 与 hard cutoff 均通过 | server integration/meter/room 测试与 demo |

## 三端重启演示与画面

`scripts/demo-cf.sh` 使用固定 seed `0x5f001c01`，从 `(438,42)` 进入 region
`(4,0)`：这里同时是 12 户雪镇和 OLD CAMP 地标，并有四个改造花位。脚本创建
三个隔离账号，真实启动两次 `wrangler dev`，要求浏览器先观察到 reconnecting
再以新 epoch 加入，并硬断言重启后三端均为：

- `landmarkFirstName="DemoOne"`
- `progressCount=1`
- `improvementLevel=1`

最终输出为 `DEMO-CF PASS (v4 restart; v3/v4 ALL=2; both rooms closed at
1008/rest)`。后半段还让 pinned v3 browser 与 v4 browser 各自看到
`ROOM 1 · ALL 2`，再用低 hard budget 要求旧、新两种 room 及 fresh probes 都以
1008 `rest` 关闭。

两张最终语义截图分别是 1440×816（逻辑 480×272 的 3×）和 2880×1632
（逻辑 960×544 的 3×）。自动像素断言均得到 `firstInk=65`、
`flowerMatches=4`。逐张肉眼检查确认：`FIRST DemoOne` 可读，三名玩家与 12 户
雪镇清楚可辨，中心四朵共享花存在；大画幅还显示完整城镇和无黑边的周边无界
地形。

## SQLite 月成本估算

按 31 天、每个在线玩家每 30 秒都 dirty 的保守上限估算；Cloudflare 2026-10-08
公布的 Paid inclusion 是每月 250 亿 row reads、5,000 万 row writes 和 5 GB-month：

| 场景 | checkpoint writes | critical writes | 总 writes/月 | 保守存储 | inclusion 内增量 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 常见负载：平均 16 在线 | 1,428,480 | 24,614 | 1,453,094 | 5.95 MiB | $0 |
| 四房满载：128 持续在线 | 11,427,840 | 491,288 | 11,919,128 | 112.98 MiB | $0 |

四房 checkpoint-only 上限是 368,640 writes/day，即 11,427,840 writes/31-day
month。若账号中其他负载已耗尽全部 inclusion，模型中的 write 与 byte-month
部分约为常见负载 `$1.453 + $0.0012`、四房满载 `$11.919 + $0.0237`；row-read
overage 另以 `$0.001/million` 计，并已通过 `/health` 暴露。实际未变化玩家会
跳过写，因此这两个 checkpoint 数是上界而非预期值。

## 最终门禁

| 仓库 | 命令 | 结果 |
| --- | --- | --- |
| Wander | `bun run build` | exit 0；wander 与 wander-online web/desktop bundles 构建成功 |
| Wander | `bun run test --reporter=dot` | 330 pass / 0 fail，481,028 assertions，26 files |
| Wander | `bun run tsc` | exit 0，无诊断 |
| Server | `bun run test --reporter=dot` | 183 pass / 0 fail，1,117 assertions，9 files |
| Server | `bun run typecheck` | exit 0，无诊断 |
| 三端 | `bash scripts/demo-cf.sh` | exit 0；共享状态、真实重启、v3/v4、hard cutoff 与两档截图均通过 |

两仓 `git diff --check` 与 `bash -n scripts/demo-cf.sh` 通过，工作树在报告前均
干净，`bun.lock` 均无改动。

## 发布与回滚顺序

1. 先发布 server HEAD `e5a9f430d3a8cb72d5a574b9c260d80f648fcae7`，让
   SQLite v1 schema、双栈 `/ws`/`/ws/v4`、storage ledger 与新包型先就位；smoke
   两条协议路由和 `/health`。旧客户端此时继续只走 v3。
2. 再发布 Wander client HEAD `f97f4d4a027cb94aeedf179694facbb3b26d8df0` 的 web
   与 desktop bundle。其 v4 JOIN 要求 world-state capability，不会在旧服务器上
   假装成功。
3. 客户端需要回滚时只回滚 web/desktop，server 可继续双栈。server 需要回滚时
   先回滚客户端；保留 SQLite 表与数据，A 期 server 会忽略它们，不做破坏性
   downgrade。

subagent 使用：3 个 / 分别审查验收覆盖与 late-entry 次序、实现服务器持久化修复、实现 Wander 协议与客户端；并行实现和交叉审查缩短了交付时间，真实 demo 与最终全量门禁由主 agent 串行完成。

PASS
