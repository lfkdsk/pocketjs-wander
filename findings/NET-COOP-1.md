# NET-COOP-1 交付报告

## 结论

合作差事、按 realm 隔离的首发现排行榜、隐私/删除语义、计量与客户端界面已经
在 Wander 和 hosted server 两仓完成。合作结算由服务器权威判定：单个账号即使
开两个 session 也不能凑人数，两个不同账号必须在同一目标广场的 30 秒 READY
窗口内到场；断线与 Room 重建不会丢失尚未过期的准备进度，竞争完成只会结算一
次。每名参与者分别写入自己的 journey，城镇只得到一次共享改造。

首发现榜默认不公开，未上榜者仍能看到自己的私有名次与 FIRST 数；公开页只包含
显式 opt-in 的显示名、名次与数量，不包含账号、在线状态、好友关系、realm 位置
或坐标。opt-out 立即移除公开行，完整自助删除同时清理合作准备、榜单 consent 与
FIRST 的身份归属，同时保留匿名的共享世界事实。

七项隔离变异全部做到基线绿、单点故障红、恢复后绿；两仓最终门禁 0 fail；双语
两尺寸 3 倍截图、真实 Chrome DPR 3 的手机双朝向和三个独立 WebSocket 客户端的
一次完整合作交付均通过。

## 提交、范围与发布顺序

- Wander 已测试的运行时/文档提交：
  `c7cdb52636658c315b3b287bfb741ff6180cdbb9`，基线
  `ccf23b9`。本报告由其后的 report-only 提交加入，不改变被 server 固定的运行时代码。
- Server HEAD：`e5ad05f76c5704537bca854d63f8c981dbe2f601`，基线
  `8859980`。
- Server 的 `vendor/pocketjs-wander` 精确指向 `c7cdb52636658c315b3b287bfb741ff6180cdbb9`；
  `.gitmodules` 仍是公开 URL
  `https://github.com/lfkdsk/pocketjs-wander.git`。
- 没有 push、部署、开 PR 或修改 GitHub；没有提交 `bun.lock`。所有提交作者均为
  `lfkdsk <lfkdsk@gmail.com>`，无额外作者尾注。

发布顺序必须是 **先 Wander，后 Server**：先让公开 Wander 提交可供 server 的
gitlink 获取，再发布固定该 gitlink 的 server。运行时消息和能力协商均为加法式；
旧客户端会忽略新文本消息，未宣告能力的 server 继续提供单人差事。loopback
server 宣告合作差事，但故意不宣告需要持久身份库的排行榜；hosted server 宣告
两项能力。

## 1. 服务器权威合作差事

合作资格是由 world seed 与发放城镇纯确定的一组 delivery offer，当前稳定为三分
之一。玩家仍各自接受并携带私有 journey；客户端只能发送 accept/READY 意图，
不能提交账号、参与人数、位置、完成结果或城镇等级。

权威结算满足以下约束：

- quorum 按两个不同的 exact account incarnation 计算，同账号的两个 session 只算一人；
- 只有正在目标 region 的 plaza 范围内、且携带完全匹配 offer/target 的玩家才算 present；
- READY 同步写入 SQLite，保留原始 `readyAt`/`expiresAt`，固定 30 秒到期；断线只
  移除 presence，重连或 Room reconstruction 会恢复未过期行；
- 同时到达的候选人按确定顺序配对。结算事务先清除两条持久 READY，再分别完成
  两人的私有 journey，最后把目标城镇从未改造提升为一次共享改造；重放不能重复结算；
- 发给客户端的状态只有 `savedReady`、`presentReady`、`required`、deadline 和 revision
  等聚合值，不暴露合作伙伴身份或位置。

协议继续使用精确 11-byte `COMMAND` frame，新增 kind 5/6；journey 的合作标志复用
保留 flag bit，frame 没有增长。journey 存储升级为 v3，同时保持 v1/v2 读取兼容。
中英文等待/完成提示沿用现有单机生成器的短句风格。

三个真实 WebSocket 客户端的确定性演示使用 seed `1593842689`。Alice 和 Bob 分别
把 `a bag of salt` 送到 `(0,-1)` 的 Upper Greennook plaza tile `(39,-49)`；第一人
READY 后保持 `1/2` 且改造为 0，第二人到场后两人的 `helpedCount` 都从 0 变为 1，
共享改造只从 0 变为 1，未参与的 Observer 收到同一个 revision。完整机器证据为
artifact `49517`。

## 2. 首发现排行榜、隐私与删除

排行榜按 realm 从权威 `landmark_first` 聚合，不从普通 personal discoveries 推导，
也不维护可能漂移的第二份 score。默认没有 consent 行，因此玩家默认不公开。
查询永远返回调用者自己的 private rank/count；未 opt-in 的分数仍影响竞争名次，
但公开 leaders 最多 20 行，且只有 `{rank, name, firsts}`。

opt-in 绑定 exact account incarnation；opt-out 删除 consent 后同次响应即不再公开。
所有 get/set 都从已鉴权 socket 的 `PlayerRec` 取身份，客户端不能代填账号。严格
parser 会拒绝畸形边界，同时只投影上述公开字段；好友以外玩家的在线状态和位置
从未进入排行榜存储或响应。

完整自助删除沿用现有两阶段 deletion saga。每个 realm 在同一事务内写 exact-token
fence、删除 READY 与 consent，并把该 incarnation 的 FIRST 署名匿名化；共享地标和
城镇改造事实不回退。旧 incarnation 的延迟 READY、consent 或 checkpoint 会被 fence
拒绝。删除结束后后续榜单不再出现原显示名。

## 3. 计量与常见负载预算

所有新增 SQL 通过现有 RealmStore rows/run helper，读写增量进入已有 Meter ledger；
没有另造旁路计数。正常路径的精确测量是：

| 操作 | SQL row reads | SQL row writes |
| --- | ---: | ---: |
| 两名参与者的一次合作结算 | 9 | 10 |
| 20 个公开行并附本人名次的一次榜单刷新 | 21 | 0 |
| opt-in 或 opt-out 并返回榜单 | 21 | 1 |

月度示例假设 31 天、100 DAU、四个 realm、每账号每天一次合作 participation、每次
恰好两名参与者，即每月 3,100 次 participation / 1,550 次 settlement；另有每账号
每天一次榜单刷新（3,100 次）与每月 100 次 consent change。

| 增量来源 | inbound controls | row reads | row writes |
| --- | ---: | ---: | ---: |
| 合作 accept + READY + settlement | 6,200 | 13,950 | 15,500 |
| 排行榜刷新 | 3,100 | 65,100 | 0 |
| consent toggle + response | 100 | 2,100 | 100 |
| **合计** | **9,400** | **81,150** | **15,600** |

按现有 ledger 的 `20 inbound controls = 1 request unit`，增量是 470 request units。
这些动作发生在已连接玩家的 Room 内，因此模型新增 duration 是 0 GB-s；额外在线
时长仍由原 occupied-room clock 计量。包含额度耗尽后的未取整等价费用为
`$0.01575165/month`，包含池尚有余量时为 `$0`；若这是 request/read/write 三个维度
各自的首个独立计费单位，取整台阶可为 `$1.151`。

删除成本保持参数化：删除 `D` 个账号、每账号覆盖 `V` 个已访问/配置 realm 时，
复用已有 `D × V` Room purge 请求；新增表最多增加 `2 × D × V` 次 READY/consent
row write，另加 `F` 条带身份 FIRST 的匿名化写。空行不产生写入。

## 4. 客户端、双语与手机画面

Capability negotiation 控制 Discovery 入口、排行榜请求/切换和 co-op HUD；客户端
在切 realm、断线和 sign-out 时清掉相关状态。中英文合作等待/完成 notice 和排行榜
private/listed/opted-out 页面都使用有界短文案。中文 notice 改用已烘焙 CJK 的 12 px
字体槽，复跑后不再出现 tofu。

合作截图报告（artifact `49530`）覆盖 EN/ZH × waiting/completed × 480x272/960x544，
共八个场景；每个场景另有 nearest-neighbour 3x 复核图（artifacts `49531`–`49546`）。
语义断言同时检查 HUD/notice 字符串和可见色块。排行榜报告（artifact `49547`）覆盖
EN/ZH × private/listed/opted-out × 两尺寸，共十二个场景及对应 3x 图（artifacts
`49548`–`49571`），并检查 `YOU/你` 私有名次、公开行和 LIST/UNLIST action。

我肉眼打开并核对了代表性的中文合作完成、中文 listed 榜单及真实手机横竖屏原图：
汉字是实际字形，notice、HUD、榜单行和 footer 没有截断；手机社交面板与浮动手柄
没有相交。真实 Chrome 报告（artifact `49572`）在 `390x844@3` portrait 和
`844x390@3` landscape 都为 PASS，12 张 PNG 为 artifacts `49573`–`49584`；所有
触控目标至少 44 CSS px，critical HUD、中央 playfield、social panel 均无 overlap，
console errors 为空。

## 5. 变异辨识力

所有变异只在独立副本运行，没有改交付 worktree。完整记录为 artifact `49516`。

| 单点故障 | 目标测试的实际红灯 |
| --- | --- |
| 允许 READY 玩家选择自己作伙伴 | 首个 READY 错误返回 completed，而不是 waiting；0 pass / 1 fail |
| 共享城镇改造执行两次 | improvement hook 收到 2 次而不是 1 次；0 pass / 1 fail |
| Room admission 丢弃持久 `coopReady` | 重建后的 readiness 为 null；0 pass / 1 fail |
| 强制 private standing 的 `listed=true` | 默认私有断言收到 true；0 pass / 1 fail |
| opt-in 请求被强制写成 opt-out | Alice 仍未上榜，公开 leaders 为空；0 pass / 1 fail |
| opt-out 跳过删除 consent | Alice opt-out 后仍在公开榜；0 pass / 1 fail |
| 自助删除跳过 consent purge | 已删除 Alice 仍以零分公开行出现；0 pass / 1 fail |

每个故障恢复后 focused suite 重新变绿，且 `cmp` 确认三个被变异的实现文件与活跃
worktree 完全一致。这些变异直接覆盖竞争只结算一次、单人不能完成、重连恢复、
默认私有、opt-in/out 和删除消失等验收项。

## 6. 最终门禁

| 仓库/检查 | 最终结果 |
| --- | --- |
| Wander `bun run build` | exit 0；Wander 与 Wander Online 均成功构建 |
| Wander `bunx tsc --noEmit` | exit 0 |
| Wander `bun test tests/` | **463 pass / 0 fail / 36 files** |
| Server `bunx tsc --noEmit` | exit 0 |
| Server `bun test tests/*.test.ts`（最终 gitlink） | **283 pass / 0 fail / 11 files / 2,758 assertions** |
| Server focused integration | **19 pass / 0 fail** |
| 三客户端合作演示 | **PASS**；两名参与者各完成一次，第三端观察到一次共享改造 |

Server 全量门禁的第一轮曾发现 14 个旧测试仍假定 JOIN 后固定只出现旧握手帧；
integration helper 改为按 `type` 消费新增的 `realmFeatures`、`coopErrand` 与 `ready`
后，focused 与最终全量均通过。没有通过放宽生产协议来迁就旧断言。

subagent 使用：6 / 分别收集验收证据、审查客户端、审查 Server Room、实现并审查存储、实现 Wander 合作核心、实现 Wander UI 接线 / 是，独立模块与审查并行明显节省了时间；主 agent 完成跨仓集成、变异、画面复核、门禁与最终判定。

PASS
