# NET-EVENT-1 交付报告

## 结论

Realm 每日共同目标已经在本地 Wander host 与 hosted server 两条路径完成。目标由
真实 realm seed、realm id 和 UTC 日纯函数生成，使用现有包裹递送或地标发现事实，
需求量为 3–5。服务器持有唯一权威进度；HUD 和公告板显示双语目标、数值与图形
进度条及 UTC 倒计时；完成只广播一次，并将目标城镇升级为 level 2 节日外观。

节日选择永久保留，而不是次日回退。它记录 realm 曾共同完成的目标，也避免每天为
外观重置增加写入；新目标仍会在 UTC 00:00 原子切换，所以永久外观不会延续旧目标
的进度。每名玩家只在自己的私有旅程里保留贡献过的 UTC 日，公开消息没有贡献者
名单、账号字段，也没有扩展发现榜单。

本次修复明确了满额边界语义：每个服务器接受、匹配当前目标且 source id 未重复的
事实都会原子写入 fact 行和该玩家的私有贡献日，即使共享目标已经在同一合作批次的
前一条事实处满额。共享 progress 与 revision 封顶，完成广播和节日转换仍只发生一次；
重复 source id 才返回未 credited 且不产生新写入。

COOP-2 的两个遗留也已关闭：同一账号 incarnation 的任一在线 session 都能撤销
READY，即使该 session 从未自己发过 READY；hosted server 测试同时锁定完整
offer + target 比较，不同 offer 即使抵达同一目标也不能误配。

六项要求的隔离变异全部变红；三名真实 WebSocket 客户端在 progress=required-1
处由两名 courier 合作送达，两人的私有贡献日都保留；节日绘制与不重连跨日演示
通过。桌面两档与手机双朝向的双语 3 倍图、真实 Chrome 手机流程均通过；两仓最终
类型检查、构建和完整仓库测试均为 0 fail。

## 提交、范围与发布顺序

- Wander 已测试代码 HEAD：`5cc95f159ddc224fee8e35ddedf1e0593a0cf673`，修复基线
  `0ebfaa5096636f4066fc35efc623403008f4c700`。本报告由其后的 report-only 提交加入，
  不改变已测试运行时代码。
- Server HEAD：`d6540692faa7bb154d7f3b79776632a8b6e813c6`，修复基线
  `4010c35733135a53b3766817cd8b0d30281a0ba1`；修复分支为
  `net-event-1-fix1`，已有提交未被改写。
- Server 的 `vendor/pocketjs-wander` 精确指向上述 Wander HEAD；`.gitmodules`
  仍是公开 GitHub URL。
- 没有 push、部署、开 PR 或修改 GitHub；没有提交 `bun.lock`。提交作者是
  `lfkdsk <lfkdsk@gmail.com>`，没有额外作者尾注或 merge commit。

发布顺序必须是 **先 Wander，后 Server**：先让 Wander commit 可由公开仓获取，
再发布固定该 gitlink 的 server commit。`dailyGoals` 是加法式 capability，客户端
只有在收到精确的 `true` 后才消费每日目标消息；旧 server 不宣告时不会显示空壳
HUD 或公告板目标。

## 1. 目标生成与玩家界面

`generateDailyGoal(seed, realm, day)` 不读取环境时钟，也不使用随机源。它先用稳定
realm hash 与 UTC day 选择目标种类、需求量和搜索起点，再从真实世界生成器挑选：

- delivery：必须是 `townErrand` 实际生成的包裹差事，offer 与 target 坐标都进入
  goal id 和贡献匹配；
- landmark：复用首次发现事实，并选择一个真实城镇作为节日目标；
- 两类都生成 canonical UTC 日期、严格 deadline 和可复算 goal id。

客户端严格解析服务器 snapshot，拒绝派生字段不一致、越界数量或未来贡献历史。
它对同一天、同 revision 的状态只接受单调进度，完成提示按 goal id 去重。HUD 在
480 宽度使用上下两行，在 960 宽度使用同一行；公告板复用相同文本。HUD 与公告板
都有独立轨道和按 `progress / required` 比例填充的图形进度条，同时保留 `n/required`
文本。中英文目标、进度和 `HH:MM:SS UTC` 倒计时都来自一套生产 formatter。

## 2. 服务器权威、原子跨日与恢复

Hosted store 使用 schema v7 的 `daily_goal`、`daily_goal_fact`、
`daily_goal_contribution` 和 `daily_goal_festival`。客户端只提交已有 reducer 接受的
游戏事实，realm/day/goal id 由 host 在同一个捕获的 `nowMs` 上附加，不能由客户端
伪造。

每个事实有稳定 source id；同一已接受事实在 crash replay 中是幂等的，而后续真实
的同类差事仍可贡献。合作结算把两名 courier 的 fact、私有贡献日和共享进度变更放进
同一事务，整批一起提交或回滚。`credited` 表示新 fact 已落库：即使目标在批次中途或
批次开始前已经满额，新的非重复事实与玩家私有贡献日仍会保留；共享 progress 与
revision 保持封顶。SQLite 只在第一次越过完成线时返回 `completedNow` 并排队一次
节日，重复 source id 则没有新写入或广播。

若 host 在进度提交与外观应用之间退出，后续 admission/step 会扫描所有未确认节日，
包括已经跨日的旧目标，补齐城镇行、level 2 与确认标记。

UTC 日由一次事件时钟决定，rollover 先整体替换当前 goal cache，再做贡献匹配。
因此边界上的一条贡献只能属于一天。在线 socket 先收到新日 progress 0，再收到该
日首个事实的 progress 1，不需要重连。玩家贡献历史按 incarnation 私有保存、最新
优先，协议最多 32 日；物理 fact 与历史保留 32 UTC 日，清理不会反向减少已完成
进度。Loopback host 的当前 UTC day 也只允许单调前进；系统时钟回拨不会恢复旧目标、
清空新日进度或重复发送完成广播。

## 3. 节日外观与隐私

完成目标会把目标 region 单调升级到 improvement level 2。Wander 用确定性、可行走
的四个摊位瓦片形成节日环；region eviction 后重建仍得到相同布局。如果靠近 hub 的
首选格在边缘城镇越界或被道路、建筑、upper/花饰占用，生成器按确定性方环继续寻找，
去重并过滤不可用格，因此仍稳定补足四个摊位。level 2 是 realm 共同历史而非当前日
状态，所以跨日只切换目标，不做外观 reset write。

公开 `dailyGoal` frame 只含定义、聚合进度、是否完成与当前 recipient 自己的
`contributed`/私有日期列表。Room 测试对 snapshot 与 wire frame 的 `Object.keys`
使用精确键集断言；三客户端演示也审计所有公开 frame。没有 contributor、account
或 leaderboard 字段。发现榜单仍完全沿用原来的 opt-in 规则，每日目标没有增加公开
排名。

## 4. COOP-2 遗留

READY 现在属于 authenticated account incarnation，不属于提交它的 socket。
Arena 写入或清除 READY 时同步所有同 identity 的在线 player view，持久层仍只有一
行；任何 sibling session 发取消都会删除该行、清空每个 view，并各推送一次
`cancelled`。

配对 filter 同时比较 `offerRx`、`offerRy`、`targetRx` 与 `targetRy`，并要求两个不同
identity 此刻都在权威 plaza。Hosted `room-do.test.ts` 构造两个真实 cooperative
offer，它们有相同 target 但不同 offer；正常实现保持两份 journey 和两行 READY，
目标不发生改造。

## 5. 三客户端演示

机器证据在 `reports/net-event-1-daily-demo.json`，verdict 为 `PASS`。演示使用三个
真实 WebSocket 客户端 Aster、Birch、Clover，id 为 1、2、3；固定 seed
`1593842689`、realm `local`、UTC day `20025` 生成 Lower Limemill cooperative
delivery 目标，需求量 3。

- Aster 的两条真实 delivery fact 先把进度推到 2；此时 Birch 与 Clover 合作送达，
  共享进度封顶在 3，但二人的 fact 与私有贡献日 `[20025]` 都保留；
- 每名客户端恰好收到一次 `completedNow=true`；重复 delivery 产生的额外每日目标
  frame 数都是 0；
- Lower Limemill 权威 region 到达 level 2，四个节日 cell 从 tile 0 变为 tile 41，
  三端都收到同一外观等级；
- 可控时钟推进到下一 UTC 日 `1730246400000` 后，三名客户端 id 仍为 1、2、3，
  socket 数仍为 3；新日 East Elmbury 目标以 progress 0 出现；
- Aster、Birch、Clover 的私有历史都是 `[20025]`，公开 frame 没有贡献者名单或
  排名扩展。

## 6. Cloudflare 扫描行预算与停机线

预算模型按 31 天、4 个活跃 realm、全服务 100 DAU、每账号每天加入一次、每 realm
每天最多 5 个有效事实计。每次加入按 32 日 history cap 的实际扫描行建模；每个事实
保守计入 goal/fact 读取、检查该玩家既有贡献日的 prior-row 读取、进度/事实/私有日/
两类 retention 写入；完成还计入节日 queue、region/world transition 与确认。目标
snapshot/update 是 outbound JSON，不增加 inbound WebSocket request ledger。

| 月度增量 | 常见负载 |
| --- | ---: |
| joins / completions / credited facts | 3,100 / 124 / 620 |
| storage row reads | 104,656 |
| storage row writes | 3,844 |
| inbound messages / request units / GB-s | 0 / 0 / 0 |
| Workers Paid 包含池内成本 | **$0** |
| 全部用量按 overage 单价的等价值 | **$0.003948656** |
| hard stop | **false** |

模型逐维比较 25B reads 与 50M writes 包含额度；任一维度超出即
`hardStop=true`。测试分别放大 read scan 与 write population，确认两条超额路径都会
触发停机。本次常见负载没有触线。

## 7. 变异辨识力

六个变异各自在独立副本中运行，交付 worktree 从未被修改；实际命令和红灯
摘要保存在 `reports/net-event-1-mutations.md`。

| 单点故障 | 实际红灯 |
| --- | --- |
| 把 `Math.random()` 混入 goal realm hash | 同 seed/realm/day 的第二次结果产生不同 id、数量、offer、target 与城镇；稳定性 deep-equal 失败 |
| UTC day 判断向后偏移一分钟 | 边界贡献后期望的新日 0、1 两个 frame 都缺失，收到 `[]` |
| 完成时再广播一次 `completedNow` | 每个 socket 收到 2 次，断言要求恰好 1 次 |
| 停止同步同账号 sibling READY | B 取消后 A 的 READY 结构仍存在，`toBeNull` 失败 |
| 删除 hosted partner filter 的 offer 坐标比较 | 同 target 的第一份不同 offer journey 被错误完成为 `null` |
| 把目标满额短路挪回 fact/私有日写入之前 | completion-edge 批次第二项应 `credited:true`，实际为 `false` |

六项目标测试都是 exit 1、`0 pass / 1 fail`，说明要求的故障不能在测试下静默通过。

## 8. 双语、分辨率与手机验收

逻辑视口证据在 `dist/net-event-1/png/`：EN/ZH × `480x272`、`960x544`、
`390x844`、`844x390` × HUD/公告板，共 16 个场景；每个场景保留原图和
nearest-neighbour 3× 图，共 32 PNG。`report.json` 为 `PASS`，并锁定文本可用宽度、
进度轨道/填充宽度以及目标、倒计时和面板的语义像素。单元测试还逐像素验证 0、部分、
满额三种填充状态。我打开由全部 3× 场景组成的桌面与手机联络图肉眼核对；中英文
目标、数值、图形进度条、倒计时和公告板都可辨，且没有截断。

真实 Chrome 证据在 `dist/net-event-1/mobile/`：

- `390x844@3` portrait，英文每日目标与公告板；
- `844x390@3` landscape，中文每日目标与公告板；
- 共保留 26 张手机截图，包含同一生产页面的鉴权、合作、社交和每日目标流程；
- `failures=[]`、`consoleErrors=[]`，daily/HUD/social/control overlap 都为空；
- 所有可操作触控目标至少 44 CSS px。

我另外打开真实 Chrome 的 portrait/landscape 每日 HUD 与公告板关键截图肉眼复核；
中英文图形进度条完整，目标与倒计时不截断，触控控件不遮挡 HUD 或对话框。

## 9. 最终门禁

| 仓库/检查 | 最终结果 |
| --- | --- |
| Wander `bun run tsc` | exit 0 |
| Wander `bun run build` | exit 0；生成 render 测试所需 bundle |
| Wander `bun test tests/`（build 后） | **494 pass / 0 fail / 39 files / 500,759 assertions**；无 skip |
| Loopback 回拨 + 边缘节日摊位 focused tests | **9 pass / 0 fail / 187 assertions** |
| 图形进度条 focused test | **11 pass / 0 fail / 185 assertions**；四视口、中英文、0/partial/full |
| Server `bun run typecheck`（最终 gitlink） | exit 0 |
| Server 三个改动文件 focused tests | **170 pass / 0 fail / 1,607 assertions** |
| Server `bun run test`（最终 gitlink） | **316 pass / 0 fail / 13 files / 3,093 assertions** |
| 三客户端 required-1 合作、节日与跨日 demo | **PASS** |
| 逻辑视口截图报告 | **PASS**；16 场景，32 PNG，双语四视口，原图 + 3× |
| 真实 Chrome 手机报告 | **PASS**；双朝向，26 PNG，0 failure，0 console error |
| 满额短路回归变异 | exit 1，**0 pass / 1 fail**；completion-edge 第二项 `credited:false` 被捕获 |

subagent 使用：3 / `server_f1` 完成 hosted 事务、隐私键集、预算与测试，`wander_state`
完成 loopback 回拨保护、满额贡献与节日摊位回退，`wander_ui` 完成图形进度条、四视口
像素测试与截图工具 / 三块文件边界独立并行，节省了实现与 focused 验证时间；主 agent
完成集成、提交、长命令、隔离变异、三端演示、截图肉眼复核与最终判定。

PASS
