# NET-WORLD-A：联机无界移动第一期验收

## 结论

A 期已形成最小闭环：新客户端通过 `/ws/v4` 进入有符号世界坐标的无界
realm，服务器与客户端复用同一套 Wander 生成器和移动规则；服务端按玩家
3×3 区块并集维持权威碰撞，客户端预测、回滚和流式渲染可跨越原 96 格边界。
原 `/ws` 继续提供字节兼容的 v3 frozen-window 房间。

本期严格不做持久化。地形使用固定 `COMPLETE` phase；服务器重启后客户端
会自动重连、收到新 epoch、清空旧预测历史并从新的权威出生点继续移动，
不会恢复重启前坐标、成长或进度。

## 交付版本

| 仓库 | 分支 | 基线 | 已验收实现/文档 HEAD |
| --- | --- | --- | --- |
| PocketJS Wander | `net-world-a` | `3c660b2` | `7cb6afd` |
| Pocket Online Server | `net-world-a` | `5d2bbe9` | `e963253` |

本报告作为 Wander 的后续交付提交；服务器子模块已指向 Wander
`7cb6afd`。Pocket RPG Kit 和 PocketJS 都无需修改。没有 push、部署或修改
远端配置。

## 实现

### Wander 客户端与共享世界

- `WORLD_PROTOCOL_VERSION=4` 新增 WELCOME4/STATE4：实体位置使用 signed
  i32，欢迎包携带 `generatorVersion`、`realmId`、`realmRevision`、服务器
  时间和连接 epoch；解码器要求精确包长。
- `MultiFocusWorld` 直接调现有 `planRegionJob`、`chunkJob` 和
  `blocksAt(..., COMPLETE)`。每个玩家钉住周围 3×3 chunks；TTL 为 1,800
  reference ticks，硬上限为 512 chunks / 160 plans，LRU 优先于 TTL，active
  chunk 和 active plan 都不是淘汰候选。
- 绝对坐标 mover 没有复制移动规则，而是把当前位置附近投影成 5×5
  `PassageTable` 后调用 Pocket RPG Kit 的 `stepMovementLegacy`。未就绪地形
  和 signed-i32 边缘均视为 solid，因此只能停在最后已验证格。
- `RealmArena` 在每个 20 Hz host frame 折叠三个 60 Hz reference ticks；每
  reference tick 的生成预算为 2,000 units。AOI 改为 signed-coordinate 稀疏
  索引。
- `RealmPredictor` 保留 seq/ack 和 rollback-and-replay，但把 epoch 纳入契约。
  epoch 不匹配要求 rebase；新 WELCOME4 会同时清掉旧输入历史和远端插值。
- `OnlineView` 从 realm 的 chunk source 流式绘制，并在 HUD/诊断状态中显示
  世界坐标、realm、生成器版本和 epoch。
- 本地 Bun server 同时提供 `/ws` v3 与 `/ws/v4` v4。现有配置仍可写稳定的
  `/ws`；当前客户端会把它映射到 `/ws/v4`，旧客户端自身仍直连 `/ws`。

### Cloudflare 服务端

- Worker 对 `/ws` 和 `/ws/v4` 分流；v4 Durable Object 名使用 `v4:` 前缀，
  与 legacy room 完全隔离，同时复用既有 `ROOM` binding/class、账号、限流、
  计量和 20 Hz 调度。
- v4 JOIN 必须声明协议 4 和匹配的生成器版本，否则以 1008
  `upgrade-required` 拒绝；v3 JOIN/消息未改。
- `/stats/v4` 暴露协议、帧、active/resident chunks、resident plans 和生成
  backlog。开发态可用 signed-i32 的远端出生坐标做验收；生产环境会忽略该
  配置。
- `scripts/demo-cf.sh` 构建网页与桌面客户端，创建三份隔离的临时凭据，运行
  三端互见，真实停止并重启 `wrangler dev`，等待新 epoch 后再抓取四张 3×
  截图并做尺寸、覆盖率和 HUD 颜色像素断言。

## 自动化验收

| 要求 | 结果 | 自动化证据 |
| --- | --- | --- |
| 正/负方向各走至少 500 格并越过旧边界 | 起点 `(60,55)`；正向终点 `(619,-134)`，X 净增 559；负向终点 `(-534,-51)`，X 净减 594 | `tests/wander-online-realm-acceptance.test.ts` |
| 1,000 坐标地形/碰撞一致 | 32 个远距离 signed chunks 内抽 1,000 格；terrain byte 与 `generateChunk` 一致，collision 与 `blocksAt(..., COMPLETE)` 一致 | 同上 |
| 20/60 Hz mover 一致 | 同一 600-reference-tick tape 的完整 mover 相等 | `tests/wander-online-realm.test.ts` |
| 跨 chunk 预测纠正率不升高 | 旧 96×96 范围内、范围外和单独跨 chunk 用例均为 0 次纠正，前后均为 0% | 两个 realm 测试文件 |
| 斜跨角点峰值 | 一次新增 5 chunks、3 plans；缺块期间 mover 停在最后已验证格 | `tests/wander-online-realm-world.test.ts` |
| 32 人驻留上限 | 完全分散时 active=288；迁移期间 resident chunks=512、plans=160；TTL 后只剩 288 active chunks，active 数据全程未被淘汰 | `tools/net-world-a-bench.ts` 与 realm-world 测试 |
| 重启自动重连 | 两次真实 `wrangler dev` 启动；epoch 从 `3206582883` 变为 `4218894586`，Chrome 和两个 QuickJS desktop 都先观察到 reconnecting，再以新 epoch 加入并继续移动 | `scripts/demo-cf.sh` 实测日志 |
| v3 legacy 保持 | `/ws` 返回 v3 WELCOME，`/ws/v4` 返回 WELCOME4/STATE4，使用不同 DO 身份；真实 workerd 集成测试通过 | `tests/integration.test.ts`、`tests/room-do.test.ts` |

长距离测试运行结果为 2 pass / 0 fail / 15,306 assertions。它直接使用生产
生成器、`RealmArena` 和 `RealmPredictor`，没有替代生成器或简化 mover。

## 32 人 CPU 与内存

基准以 Node v22.23.1（与 workerd 同为 V8 系）启动三个独立、带
`--expose-gc` 的进程。每个热样本是一个 20 Hz 服务端 frame：折叠三个
reference ticks，并每两帧为 32 人各构造一次 10 Hz sparse AOI snapshot。

| 指标 | run 1 | run 2 | run 3 | 三次中位 |
| --- | ---: | ---: | ---: | ---: |
| cold 32-player active build | 103.814 ms | 106.166 ms | 125.988 ms | 106.166 ms |
| 十列 LRU 迁移 | 293.422 ms | 305.195 ms | 335.781 ms | 305.195 ms |
| CPU median / 20 Hz frame | 0.8331 ms | 0.8923 ms | 1.0973 ms | 0.8923 ms |
| CPU p95 / 20 Hz frame | 1.0986 ms | 1.4159 ms | 1.8604 ms | 1.4159 ms |
| CPU p99 / 20 Hz frame | 1.3886 ms | 1.8220 ms | 2.2765 ms | 1.8220 ms |
| CPU max / 20 Hz frame | 1.4808 ms | 2.1140 ms | 5.2567 ms | 2.1140 ms |
| V8 retained | 17,037,108 B | 17,035,564 B | 17,037,380 B | 17,037,108 B |
| RSS delta | 58,769,408 B | 47,722,496 B | 46,501,888 B | 47,722,496 B |

三次均为 active 288、LRU 峰值 512 chunks / 160 plans、TTL 后 288 chunks、
logical resident 12,378,352 B、500 个热 frames、288,000 wire bytes。中位 CPU
折算为约 0.2974 ms/reference tick；最慢一次的最慢 frame 仍为 5.2567 ms，
低于 50 ms 的 20 Hz 拍窗。

## 三端、重启与画面

真实 `wrangler dev` 验收同时运行两个 headless QuickJS desktop host 和一个
headless Chrome host。重启后的最终状态为：

- Chrome：`online/allOnline=3/3`、2 个 remotes、坐标 `(640,-642)`、
  corrections=0、consoleErrors=0。
- 两个 desktop：均为 `online/allOnline=3/3`、realm `plaza-1`、generator 1、
  新 epoch，坐标约 `(640,-647)`。
- 四张截图尺寸分别为 1440×816（逻辑 480×272 的 3×）和 2880×1632
  （逻辑 960×544 的 3×），网页/桌面各一张。自动检查均为 coverage=1，
  地形颜色数 174–519，名字/HUD 的黄色、蓝色和浅色像素均存在。
- 四张图又逐张肉眼检查：远离原点的地形填满画面、无黑边，玩家名字、
  在线 HUD 和世界坐标均清晰可读。

## 门禁

| 仓库 | 命令 | 结果 |
| --- | --- | --- |
| Wander | `bun run build` | exit 0；生成 web/desktop bundles |
| Wander | `bunx tsc --noEmit` | exit 0，无诊断 |
| Wander | `bun run test` | 313 pass / 0 fail，480,929 assertions，25 files |
| Server | `bunx tsc --noEmit` | exit 0，无诊断 |
| Server | `bun run test` | 131 pass / 0 fail，859 assertions，6 files；含真实 workerd integration |
| 三端 | `bash scripts/demo-cf.sh` | exit 0；三端互见、真实重启、新 epoch、远端双尺寸截图均通过 |

服务器测试脚本使用根级 `tests/*.test.ts`，避免 Bun 的目录过滤把 vendor
子模块测试误纳入服务器门禁。两仓 `bun.lock` 均无改动。

## 发布与回滚顺序

1. 先发布服务器双栈版本，分别 smoke `/ws` v3、`/ws/v4` v4 和
   `/stats/v4`。此时旧网页仍进入原 legacy room。
2. 再发布带 v4 客户端的网页和桌面包；已缓存的旧客户端继续走 v3，不需要
   同步切换。
3. 若客户端需回滚，只回滚网页即可，服务器继续保留 v3/v4。若服务器需
   回滚，先停止发布 v4 客户端；A 期没有持久化 schema 需要降级。

## 明确非目标与后续边界

- 没有 checkpoint、DO 世界状态或重启后的坐标/成长恢复。
- 没有共享成长、NPC authority、告示板、差事、旅记、表情、邀请、出生槽或
  远方玩家提示。
- v4 的“无界”是相对旧 96×96 窗口而言；wire 坐标范围为 signed i32。
- 同一 realm 内才互见；不同 room/realm 不承诺同坐标互见。

subagent 使用：4 个 / 分别核对验收计划、realm 核心、服务器架构与 Wander 架构；并行只读分析缩短了接口核对时间，性能测量期间未运行 subagent 命令。

PASS
