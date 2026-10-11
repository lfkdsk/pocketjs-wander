# NET-COOP-2 交付报告

## 结论

找搭档、匿名公告板人数、READY 倒计时与主动取消，以及 COOP-1 复审列出的六项
遗留都已在 Wander 与 hosted server 完成。好友提示只发给当前 realm 中可见的
双向好友，并且同一个 READY deadline 最多提示一次；非好友收不到可识别的姓名、
身份或位置。任何到达合作差事实体公告板的玩家都可以看到该 offer 的匿名
`waiting/required`，但响应不包含等待者身份、玩家坐标或目标坐标。

合作结算现在同时校验发放 offer 与目标，两个“目标相同但 offer 不同”的玩家不会
配对。能力消息尚未到达时，客户端不会把确定性的合作 offer 永久按单人接受；
READY 过期会主动推送一次新状态；目标 `region_state` 缺失时先以已鉴权 incarnation
补发现行，再完成共享改造，补行或改造失败则结算抛错，不会静默完成。

四项隔离变异均做到基线绿、单点故障红、恢复绿；两仓最终门禁 0 fail；三个真实
WebSocket 客户端、英中双语两尺寸 3 倍截图，以及真实 Chrome 的手机双朝向触控
流程全部通过。

## 提交、范围与发布顺序

- Wander 已测试代码 HEAD：`ba7a52b7c8e91f734a7692b36151addeaafdefce`，基线
  `674998d6b4f19f9afb301f7cc28c9ea446881abf`。本报告由其后的 report-only
  提交加入，不改变已测试运行时代码。
- Server HEAD：`27bb8121fd50289552bdc2139aac08cac631bf1f`，基线
  `e5ad05f76c5704537bca854d63f8c981dbe2f601`。
- Server 的 `vendor/pocketjs-wander` 精确指向上述 Wander HEAD；`.gitmodules`
  仍保持公开 GitHub URL。
- 没有 push、部署、开 PR 或修改 GitHub；没有提交 `bun.lock`。所有提交作者均为
  `lfkdsk <lfkdsk@gmail.com>`，无额外作者尾注。

发布顺序必须是 **先 Wander，后 Server**：先让 Wander 提交可由公开仓获取，再
发布固定该 gitlink 的 server。`coopPartnerFinding` 是可选、加法式 capability；
只有精确的 `true` 才启用新消息和界面。旧 co-op server 不宣告它时，客户端不会
请求公告板、接受好友等待提示或显示取消入口。

## 1. 找搭档与隐私取舍

### 好友路径

当玩家第一次进入有效 READY 状态时，Room 用现有 Auth `/social/view` 获取隐私
权威视图，随后重新核对同一个玩家、同一个 authoritative READY deadline 仍然有效。
只有满足下列全部条件的在线接收者会收到 `coopFriendWaiting`：

- 双方是 Auth 返回的双向好友；
- 等待者没有隐藏在线状态；
- 双方当前都在这个 Room，因此在同一 realm；
- 等待者仍携带该 offer，READY 未取消、未过期、未结算。

消息只带等待好友的稳定身份/显示名、目标城镇名、物品文案和 deadline。好友刷新
`socialGet` 时会得到同一份 `coopWaiting` 摘要，客户端把这些行排序到 Friends 页
顶部并显示 `COOP WAIT` / `合作等待`。同一 session 重放 READY 不延长 TTL，也不会
重复通知；瞬时 Auth 失败允许在下一次 authoritative 状态变更时重试。

### 匿名公告板路径

本实现选择“实体公告板对所有到场玩家显示匿名计数”，而不是只对好友显示。原因是
它提供的是特定合作 offer 的短期可组队性，不是某个非好友的 presence：

- 请求必须由已鉴权、已加入该 realm 的玩家在对应公告板近旁发出；离板探测无响应；
- 请求和响应都以发放 offer 坐标为 scope，只返回 `waiting` 与固定 `required`；
- 不返回等待者姓名、账号/session/player id、玩家坐标或差事目标坐标；
- 计数随 30 秒 READY、取消和结算立即失效。

这个选择会有意透露“这个公开 offer 此刻有匿名搭档可用”，但无法把该事实关联到
任何非好友，也不给出其精确位置；玩家已经站在该 offer 的实体公告板旁，发放地点
本身不是隐私信息。它在保持非好友身份/在线状态/位置不可识别的同时，让公告板真正
能承担找搭档功能。Hosted 集成测试同时验证非好友收不到 identified push、隐藏好友
不出现在等待详情中、板外请求被忽略。

## 2. READY 生命周期和客户端体验

协议保留固定 11-byte `COMMAND` frame，新增 kind `7`：
`cancelCoopErrand`。玩家等待时 HUD 显示剩余秒数与 `X CANCEL` / `X 取消`；按下
CROSS/X 只撤销 readiness，不丢弃仍携带的 journey。同一账号开多个 session 时，
从任一 session 取消会清除该 identity 的全部实时 readiness 并向每个 session 推送
一次 `cancelled`。

客户端现在将 `realmFeatures` 分成三态处理：

- 尚未收到：对确定性合作 offer 显示“正在确认世界特性”，不发送 accept；
- 明确 `coopErrands: false`：按单人 offer 接受，兼容旧 server；
- 明确 `coopErrands: true`：发送合作 accept。

服务器在 TTL 到期的那一 step 删除持久 READY，并把该玩家标记为 dirty，推送一次
`expired`；下一 step 不会重复。好友提示的 one-shot key 是原始 `expiresAt`，所以
READY 重放不能续期或刷屏。网页游戏还补上了生成 player 的 `__pocketPageLang`
语言桥接：页面切到中文时，游戏内合作 HUD、notice 与 Friends 详情会同步中文，
测试专门从这一生产入口验证，不再依赖测试 locale hook。

## 3. COOP-1 遗留逐项结果

| 复审观察 | 处理 | 证据行为 |
| --- | --- | --- |
| capability 到达前按 CROSS 可能永久单人接受 | 已修 | 未收到特性时不发命令并显示确认提示；明确 false 才 solo，true 才 co-op |
| 同目标但不同 offer 可配对 | 已修 | readiness 保存 `offerRx/offerRy`，配对、presence 与匿名计数都比较完整 offer + target |
| 缺失 `region_state` 时改造静默跳过 | 已修 | 先用 authenticated account/version/token `discoverRegion`，再 `improveRegion`；仍失败则抛错 |
| READY 过期后客户端消息滞后 | 已修 | 到期删除后推送一次 `expired`，下一 step 不重复 |
| demo 未断言 observer revision 相等 | 已修 | v2 demo 断言 Observer 行 revision 与 authoritative shared revision 同为 `3` |
| 榜单预算按返回行而非扫描行 | 已修 | 以 `L + O` 每次完整扫描建模，并锁定扫描斜率、额度内 $0 与超额 hard-stop |

README 的配对措辞已改为“exact same offer to the same target”，与实现一致；两仓
`docs/status.md` 均把本批能力标为 Done。

## 4. 三客户端演示

机器证据为 artifact `49743`，schema `wander-online-coop-demo/v2`。A、B、C 是三名
通过本地 GitHub stub 鉴权并经 `/ws/v4` 加入的独立客户端：A 与 B 是模拟的双向
可见好友，C 是非好友。Loopback host 故意没有持久好友库，因此 demo 清楚标记了
唯一的替代部分：好友 recipient routing 由 demo 按 hosted server 的 mutual-visible
规则投影；READY、公告板查询、journey 结算和共享 region revision 都走真实
loopback authoritative arena/WebSocket。

确定性结果：

- A READY 后保持 `1/2`，目标改造仍是 `0`；B 收到且只收到一次 identified hint；
- C 收到 `0` 个 identified hint，在真实公告板只看到匿名 `1/2`；
- B 赶到后 A/B 的私有 journey 各完成一次，`helpedCount` 都从 `0` 到 `1`；
- 共享改造只从 `0` 到 `1`；Observer 收到一次改造，revision `3` 等于权威 revision `3`。

Hosted 的实际 Auth 好友过滤不是由这个镜像替代验证，而是由 Server
`tests/room-do.test.ts` 的 A/B/C 集成流程覆盖。

## 5. 扫描行预算、ledger 与停机线

所有新路径沿用现有 sequenced Meter：WebSocket control 进入 inbound ledger，
Room→Auth `/social/view` 进入 internal DO request，Auth/Realm SQL 使用实际 rows-read/
rows-written helper。一次被拒绝的无效命令仍保持零 SQL 成本；没有为了预同步好友
提示而引入额外读写。

自动化模型假设 31 天、100 DAU、每天每账号一次合作 participation、一次合作公告板
刷新、一次 FIRST-board 刷新，成功结算恰好两人；每月 100 次 consent change，
平均 8 个双向好友。令 `L` 为每 realm 的 `landmark_first` 扫描行，`O` 为
`leaderboard_opt_in` 扫描行：

| 增量项 | 月度结果 |
| --- | ---: |
| participations / settlements | 3,100 / 1,550 |
| inbound controls | 12,500 |
| Room→Auth internal requests | 1,550 |
| request units | 2,175 |
| short-wake duration | 1.984 GB-s |
| row reads | `40,300 + 3,200 × (L + O)` |
| row writes | 15,600 |

每次实际等待只查一次 Auth；8 个好友时读取 owner 加每名好友的 account/session，
即 `1 + 2×8 = 17` 行、月度 26,350 行。`LIMIT 20` 只限制返回行，不限制扫描行，
因此榜单刷新和 consent 后返回的榜单都按 `L + O` 计。

常见点 `L=1,000`、`O=20` 得到 3,304,300 reads、15,600 writes；四项额度都仍在
Cloudflare Workers Paid 包含池内，实际增量为 **$0**。假设账号已在所有维度进入
overage，未按计费单位取整的 usage-equivalent 为 **$0.01925535/月**。模型逐维输出
`overage` 与 `hardStop`；例如 `L=8,000,000` 时 reads 为 25,600,040,300，超过
25B 包含额度，`hardStop=true`。按规格，这种结果必须停止发布并降低负载或取得明确
预算批准；本次常见负载没有触线。自动化测试锁定总数、每增加一条扫描源行就增加
3,200 reads、额度内 $0 以及超额停机线。

## 6. 变异辨识力

四个变异各自在隔离副本中运行，没有改交付 worktree；每项都先确认基线绿，应用
单点故障后目标断言变红，再恢复并确认绿：

| 单点故障 | 实际红灯 |
| --- | --- |
| 把 identified READY hint 也发给非好友 | A/B/C 测试的 “a nonfriend receives no identified hint” 失败 |
| 去掉配对时的 offer 坐标比较 | 两个同目标、不同 offer 的第二人错误完成，而不是继续各自 `1/2` 等待 |
| 到期删除 READY 后不把状态标 dirty | 期望的一次 `expired` 消息缺失 |
| 缺行时跳过 authenticated region materialisation | 目标行没有以 level 1 恢复，journey/共享改造一致性断言失败 |

这四项分别直接覆盖规格要求的四个必红变异：非好友泄漏、不同 offer 配对、过期不
推送、缺 region 静默跳过。

## 7. 双语、输入和画面验收

桌面截图报告是 artifact `49744`：EN/ZH × `480x272`/`960x544`，覆盖匿名公告板、
好友一次性提示、Friends 等待行、READY 倒计时、取消和完成，共 24 个语义场景；
每个场景都有原尺寸与 nearest-neighbour 3× 图，共 48 张合作功能图。断言检查文本
树、公告板深色面板、好友选中行、橙色 ERRAND/倒计时和蓝色 notice。中文抗锯齿
颜色使用限定在 HUD rect 内的容差计数，避免把地图像素误算为文字。

真实 Chrome 手机报告是 artifact `49745`，覆盖：

- `390x844@3` portrait，英文；
- `844x390@3` landscape，中文与 immersive controls；
- 真实 OAuth callback、WebSocket、触控、公告板 action、Friends 导航、倒计时取消、
  邀请复制和退出；
- 每个触控目标至少 44 CSS px，无横向溢出，critical HUD、中央 playfield、社交面板
  与浮动 controls 的 overlap 均为 0，console error 为空。

桌面 harness 使用统一 BTN 输入层逐步驱动 CIRCLE/CROSS/方向/菜单路径，因此手柄与
键盘映射执行同一生产逻辑；手机用 CDP `dispatchTouchEvent` 走实际触屏按钮。报告
共保留 22 张 DPR 3 手机 PNG。我肉眼打开并核对了两档桌面的英中公告板、好友列表、
倒计时/取消 3× 图，以及英文竖屏和中文横屏的对应手机原图：字形可辨、无截断，
notice/HUD/社交面板与触控控件没有遮挡。

## 8. 最终门禁

| 仓库/检查 | 最终结果 |
| --- | --- |
| Wander `bunx tsc --noEmit` | exit 0 |
| Wander `bun test tests/` | **470 pass / 0 fail / 36 files / 500,334 assertions** |
| Wander `bun tools/build.ts wander-online` | exit 0；pak 与 JS 构建成功 |
| Wander `bun run web` | exit 0；Wander 与 Wander Online 两个网页构建成功 |
| Server `bunx tsc --noEmit`（最终 gitlink） | exit 0 |
| Server `bun run test`（最终 gitlink） | **291 pass / 0 fail / 12 files / 2,835 assertions** |
| 三客户端 demo | **PASS**；好友提示 1、非好友 identified 0、匿名等待 1、revision 3=3 |
| 桌面截图报告 | **PASS**；24 个合作场景，英中双尺寸，原图 + 3× |
| 手机报告 | **PASS**；两朝向、22 图、0 overlap、0 console error |

subagent 使用：3 / 分别扩展三客户端隐私 demo、扩展桌面与手机视觉验收、复核并实现扫描行预算模型 / 是，三个互不重叠的证据批次并行完成，主 agent 负责整合、长命令、变异、肉眼复核和最终门禁，明显节省了时间。

PASS
