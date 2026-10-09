# NET-WORLD-D：出生、相遇与轻量互动

## 结论

D 期四项都按设计 §5/§7 实现并通过验收，范围没有扩大（没有 E 期的输入打包、计量改造和 v3 退役；
设计里"双方确认后的精确 marker"不在本期任务范围内，没有做）：

1. **安全出生槽**：每次准入以锚点（新玩家 = 出生城镇广场 hub，回归玩家 = 存档位置）为中心，
   按账号稳定哈希选起点，在半径 6 的环上顺序走，取第一个"当前成长相位下不阻挡、且没有别的玩家站着"的格。
   32 人同时准入落在 32 个互不相同的可走格上；存档格被占或长出障碍时外移一环，而不是叠人或进墙。
2. **稳定 realm 重进与邀请**：WELCOME4 之后客户端把 realm 记在票据旁，之后每次重连带 `?realm=`；
   菜单 L 向服务器要一份邀请，得到只含 `code/realm/expiresIn` 的回复，可分享的令牌是 `<realm>.<CODE>`；
   网页把它做成本页 URL 加 `#invite=<token>` 的链接（页面层有复制按钮），打开链接的人以
   `?realm=<realm>&invite=<CODE>` 进入**同一个** realm。满员时客户端明确显示 `WORLD FULL`（慢速重试，
   菜单 R「any world」可放弃钉住），无效/过期邀请 `1008 invite`，不存在的 realm `1008 realm`，
   都不会被悄悄送进别的 realm。邀请 1 小时有效、每 realm 最多 64 个活码、每人每分钟最多 3 个，不消耗。
3. **远方玩家方向带**：同 realm、在 AOI 之外的玩家每秒以 `FAR_PLAYERS` 行（id、8 向象限、距离档）
   送达，一行 6 字节，没有任何坐标字段；屏幕边缘画一个方块加「名字 · near/far/distant/remote」。
   在 AOI 内的玩家只在精确快照里，不会同时出现在方向带；3 秒没有更新的标记自动消失。
4. **预设表情**：5 个预设（`o/` 挥手、`\o/` 欢呼、`->` 指路、`?` 疑问、`!!` 集合），R 打开选择条，
   发出去的是 `COMMAND` 里 1 字节的 id；服务器每人每秒最多接受 1 个，立刻回 `EMOTE` 给 AOI 内所有人
   （含自己），客户端在名字牌上方画 5 秒气泡，不落盘，后到的人永远看不到。**没有任何自由文本入口**：
   客户端能发的只有输入流、这些 1 字节命令和固定的认证/邀请请求，服务器对任何陌生文本类型不回应。

联机禁用换种子和默认空闲漫游保持 C 期状态（`autoMode = __onlineAutoWalk === true`，SQUARE 没有绑定）。

## 交付版本与发布顺序

| 仓库 | 基线 | 本次 HEAD |
| --- | --- | --- |
| PocketJS Wander | `f6eeab0` | 实现 `2fbec189c729`（本报告为其后续提交） |
| Pocket Online Server | `546d40e` | `c841099ff9c2`（子模块 `vendor/pocketjs-wander` 指向 `2fbec189c729`，其内嵌 `vendor/pocket-rpgkit` 指向 `43e13fed9c37`） |
| Pocket RPG Kit（页面层） | `0fcb5f01` | `43e13fed9c37`（只改网页播放器：`tools/web/player.js`、`i18n.ts`、`site.css`、一份 Chrome 测试、状态清单一行） |

发布顺序与 A–C 期一致：**先服务器**（schema v2 是附加一张 `realm_invite` 表，v1 库原地前移；旧网页
继续工作：它不发 `inviteq`、不带 `?realm=`，服务器对未知文本类型不回应，`FAR_PLAYERS`/`EMOTE` 是
旧客户端不认识的新 kind，旧客户端的消息分支直接忽略），**再网页**（组件仓页面层 + Wander 新 pak），
桌面版随 Wander 构建。先发网页也不会坏：新客户端对旧服务器只是收不到方向带/表情，邀请回复不来则
通知栏不显示。

## 实现

### 出生槽（`examples/wander-online/net/spawn.ts`、`server/realm-area.ts`）

- `spawnRing(d)` 给出切比雪夫距离恰为 d 的环（顺时针），`pickSpawn(anchor, hash, free, radius=6)` 从
  环 0 到环 6、每环从 `hash % len` 起循环取第一个 `free` 的格。`spawnHash` 是 FNV-1a。
- `RealmArena.tryAdd(name, color, look, at?, restore?, spawnKey=name)`：先推进世界时钟并
  `prime` 锚点的 3×3 区块，`free(tx,ty)` = `collisionAt` 已就绪且不阻挡且没有玩家占着（中途行走的
  玩家算在出发格上，与 AOI 索引一致）。存档锚点周围全满时退回出生城镇；连出生城镇 13×13 全满才
  站在锚点上（这个生成器不会出现，只为保证准入总能完成）。玩家记录多了 `spawn: {tx,ty,ring}` 供诊断。
- 本地 Bun 服务器用 `githubId` 或 `name:sid` 做哈希键，托管服务器传账号 id。

### 邀请与 realm 钉住（`shared/invite.ts`、`net/client.ts`、两端服务器、页面层）

- `shared/invite.ts`：常量（`INVITE_TTL_SEC=3600`、`INVITE_MAX_LIVE=64`、`INVITE_ISSUE_PER_MIN=3`、
  8 位 Crockford 风格字母表）、`newInviteCode`、`parseInviteToken`/`formatInviteToken`、
  `realmJoinUrl`（手工拼 query，QuickJS 没有 `URL`）、`InviteTable`（本地服务器的内存表）、
  关闭原因 `REALM_CLOSE_REASON = { invite, realm }`。
- 客户端：`OnlineClientOpts.realm/invite/onRealm`；`connectUrl()` 带上 `?realm=&invite=`；WELCOME4 时
  `realmPin = realmId`、丢掉 invite、回调 `onRealm`（视图 `saveRealm`，网页再发 `inviteConsumed`）；
  `requestInvite()` 发 `{"type":"inviteq"}`，回复存成 `inviteToken`；`leaveRealm()` 先摘掉旧 socket 的
  回调再关闭并立即重连（否则旧 socket 的 close 会清掉新连接的状态）；`hud().rejectText` 在钉住 realm 时把
  `full` 显示为 `WORLD FULL`；`invite`/`realm` 两个 token 走「不自动重连」策略。
- 本地服务器：升级时解析 `realm`/`invite`，不匹配或无效在 `open` 里 `1008` 关闭（Bun 的 upgrade 之后才能
  关闭）；`inviteq` 走每连接 `SlidingWindow(3/min)`；时钟传 `() => Date.now()`（第一版直接传了
  `Date.now` 的引用，测试里拨时钟就穿不透，已改）。
- 托管服务器：Worker 把 `?realm=` 直接路由到 `v4:<realm>`，**不做 /count 扫描**（预算门只预留实际
  发生的扫描数 0），未知 realm 在 Worker 直接 `1008 realm` 不唤醒任何 Room；Room 在 `admissionDecision`
  里、**取 IP 槽之前**校验邀请码（SQLite `realm_invite` 表：只有 `code` 与 `expires_at_ms`），
  schema v1→v2 是幂等附加迁移；`inviteq` 由 CSPRNG 生成码、每 sid 3/min。
- 真实演示还暴露了 Durable Object 的一个 hibernation 边界：最后一个 socket 的 close callback 执行时，
  `getWebSockets()` 仍可能枚举到这个正在关闭的 socket。收尾修复只把“其它 socket”视作房间仍存活，确保
  Meter 收到最终在线数 0；专门回归测试模拟了 close callback 内仍可枚举当前 socket 的宿主行为。
- 页面层（组件仓 `43e13fe`）：启动时从 fragment 取 `invite=`（保留旁边的 OAuth 参数再剥离）、存
  sessionStorage 以撑过 GitHub 跳转、暴露 `__pocketInvite`；`__pocketAuthEvent({type:"invite"})` 显示
  `#auth-invite-box`（只读链接、复制、关闭、有效分钟提示，中英文）；`inviteConsumed` 清掉。

### 方向带（`net/far.ts`）

`farDir(dx,dy)` 以 atan2 分 8 个 45° 锥，`farBand(dist)` 以 64/256/1024 分 4 档，`farRowsFor` 只产出
切比雪夫距离 **严格大于** AOI 半径的玩家（AOI 边上的在 STATE4 里）。两端服务器每 `FAR_INTERVAL_SEC`（1 s）
给每个接收者发一次（没人远就不发）。客户端收到 STATE4 时把快照里出现的 id 从 `far` 删掉、把超过
`FAR_TTL_MS` 的删掉。视图在 `fieldRoot` 里、渲染环之后挂一个屏幕坐标层：`farMarkerPoint` 取屏幕中心沿
象限方向射到「避开状态板、底部条和边距」的内接矩形上的交点，方块贴边，标签在内侧（右半屏右对齐）。

### 表情（`net/emote.ts`）

`EMOTE_TABLE` 五项（ASCII 字形，任何字槽都有），`COMMAND.emote = 4`、`EMOTE 0x26 = id u32 + emote u8`
（6 字节严格解码，id 范围外返回 null）。`RealmArena.applyEmote` 校验 id 和 `EMOTE_MIN_INTERVAL_MS`，
放进 `pendingEmotes`，宿主 `drainEmotes()` 后按 `emoteRecipients(from, aoi)` 发送。客户端自身也有 1 秒
门槛（不发），气泡只在服务器回显后出现；`expireEmotes(now)` 每帧清理。视图里气泡是名字牌上方的
30×14 奶油色小板，停靠时清空文字并移出屏幕。

### HUD 与输入

- `hud.ts`：`helpRect` 加宽到 420（帮助行多了 `R EMOTE`，12 px 字槽实测 402 px）；`menuRect` 高 124
  （7 行：新增 `L: invite a friend`、`R: any world · CROSS: close`），在 272 高时 `y1` 恰好等于 LOG 条
  `y0`，布局测试仍判不相交；`emoteBarRect`/`emoteCell`（占通知带位置，打开时隐藏通知）；
  `farMarkerRect`/`farMarkerPoint`/`FAR_LABEL_W=200`。
- 选择条打开时 d-pad 归选择条（像对话框一样不走路），LEFT/RIGHT 选、CIRCLE 发并关闭、CROSS/R 关闭、
  触摸点格直接发。
- 发布状态新增 `far[]`、`emotes{}`、`emoteBar`、`invite`、`realmPin`，供 `web-check` 与演示脚本读取。

## 测试

### Wander（`bun run test`：415 pass / 0 fail，33 个文件，92.10 s；`bunx tsc --noEmit` exit 0）

- `tests/wander-online-meet.test.ts`（15 例）：象限/距离档与 6 字节行（截断、尾字节、坏象限/档、重复都拒）；
  表情表与 6 字节编解码、`COMMAND` 11 字节只有 u8 extra；竞技场表情 1 秒 1 个、AOI 内外收件人、
  坏 id/错区域拒绝且不碰 journey；环走顺序与哈希、**32 人同时准入 32 个互异可走格且都在 hub 6 格内，
  第 33 人被拒**；回归玩家存档格空闲则原位、被占或阻挡则外移一环；邀请纯逻辑（表界限、过期是开区间、
  令牌解析、URL 拼接）；真回环服务器：邀请人与受邀人同 realm、回复键恰为 `code/expiresIn/realm/type`
  且 JSON 里没有邀请人名字、受邀后 invite 被消费、下次连接只带 `?realm=`；未知/畸形/过期邀请
  `1008 invite`，错 realm `1008 realm`，客户端显示 `INVITE INVALID OR EXPIRED` 不重试、`leaveRealm()`
  后进入；钉住的 realm 满员（cap=1）客户端显示 `WORLD FULL` 且 `rejectReason=full`；`inviteq` 3/min 后
  `inviteError`，`{"type":"chat"}`/`{"type":"say"}` 没有任何回复也不到达别人；**连刷 5 个表情只有 1 个
  EMOTE 到达自己和邻居**、后加入者收不到、越界 id 不关连接；用 fast 位把第二人走出 AOI 后，第一人收到
  只含 id/dir/band 的 8 字节 FAR_PLAYERS，而 STATE4 不再带那个人。
- `tests/wander-online-meet-view.test.ts`（7 例，sim 宿主）：480×272 与 960×544 下远方玩家是边缘方块
  （语义像素 ≥20 个黄点）加 CJK 名字标签（宽度 ≤ `FAR_LABEL_W`），走进 AOI 后标签消失、走出后再报告
  重新出现、3 秒无报告过期；R 打开选择条、方向键不走路、CIRCLE 发 `kind=4, extra=cheer`、服务器回显前
  没有气泡、回显后有奶油色板 ≥200 像素、1 秒内第二次不发、5 秒后气泡与像素都没了、CROSS 关闭；远端玩家
  的表情气泡画在它的 CJK 名字牌上方且画面里没有别的奶油色板；菜单 L 发 `inviteq`、通知显示
  `INVITE realm-test.ABCDEFGH · 60 min`、页面收到 `{type:"invite", token, expiresIn}`、页面
  `inviteEnd` 命令清掉通知、帮助行仍在 `helpRect` 内；启动带 `__pocketInvite` 时第一条连接 URL 是
  `ws://fake/ws/v4?realm=realm-test&invite=ABCDEFGH`、钉住 realm、页面收到 `inviteConsumed`，菜单 R 后
  下一条 URL 不带任何参数并重新加入。
- 调整的既有测试：`wander-online-realm.test.ts`（签名坐标锚点现在落在环内的安全格，断言改为比对竞技场的
  实际位置）、`wander-online-realm-acceptance.test.ts`（两名玩家各自从自己的出生格起算路线，并断言两格不同）、
  `wander-online-journey-view.test.ts`（帮助行文本）。
- `tests/lib/fake-online-socket.ts` 新增 `heartbeatEntities`、`inviteReply`、`urls`。

### 变异（每个 mutant 使用独立 detached worktree，交付树始终未改）

| mutant | 目标测试 | 实际结果 |
| --- | --- | --- |
| 删除客户端对 native transport 已关闭时 `SocketError("closed")` 的容忍，让 queued `open` 继续抛错 | `wander-online-client-core` 的 immediate-refusal 用例 | **杀死**：`not.toThrow()` 收到 `SocketError: socket is not open`，0 pass / 1 fail；原实现同一用例 1 pass / 0 fail |
| 把浏览器邀请入口从 URL fragment 错写成 query | `wander-online-web-check` 的 real-fragment 用例 | **杀死**：期望 `#invite=…`，实际为 `?invite=…`，0 pass / 1 fail；原实现同一用例 1 pass / 0 fail |
| 恢复旧的“`getWebSockets().length > 0` 就不报空房”判断 | `room-do` 的 closing-socket-still-enumerable 用例 | **杀死**：期望 Meter `count: 0`，实际保持 `count: 1`，0 pass / 1 fail；原实现同一用例 1 pass / 0 fail |

三处 mutant 均在失败后连同各自的隔离 worktree 删除；交付仓没有接受任何变异改动。

### Pocket Online Server（`bunx tsc --noEmit` exit 0；单元 194 pass / 0 fail；集成 `wrangler dev` 17 pass / 0 fail）

子代理实现，我逐行审过 `worker.ts`、`realm-storage.ts`、`room.ts` 的 diff 并亲自复跑门禁。新增/改动的测试
（17 个 `test(`）：32 人同时准入互异可走格、邀请往返（回复键集合、JSON 无账号信息、SQLite 行只有
`code`/`expires_at_ms`、`/stats.invites`、用量报告的 `storageRowWrites` 覆盖邀请写入、同 Room 准入、错码不
取 IP 槽、过期拒绝、3/min）、cap=1 钉住满员 `full`、邀请在 DO 重建后仍有效、v1→v2 迁移保留行、旧 v3
socket 发 `inviteq`/表情无回复且 `sqlCalls` 为 0、表情 AOI 内 1 次/远处 0 次/后加入 0 次、方向带只对
AOI 外玩家且不与 STATE4 同现、Worker 钉住 realm 不扫 `/count`、未知 realm 不唤醒 Room、invite 透传。

### Pocket RPG Kit 页面层（`bunx tsc --noEmit` exit 0；`web-name-input` + `web-invite-link` 19 pass / 0 fail；其它页面测试 100 pass / 0 fail）

`tests/web-invite-link.test.ts`（10 例，真实 Chrome + CDP，函数从 `player.js` 逐字抽取）：无 auth 无盒子、
事件前隐藏、显示带 `#invite=` 的本页 URL 与分钟提示、复制真的写进剪贴板（`Browser.grantPermissions` +
焦点仿真）与回退路径、关闭发 `("inviteEnd")`、`inviteEnd`/`logout` 隐藏、按键不外泄、带
`#invite=…&oauth_token=…` 导航后 `__pocketInvite` 与 `__pocketAuth` 都正确且 fragment 只剥掉 invite、
sessionStorage 续命与 `inviteConsumed` 清除、中英文标签。

## 截图（两档 × 3 倍，均肉眼核对）

`bun run shots:meet`（`tools/wander-online-meet-shots.ts`，sim 宿主，本人名「演示网页」，远方玩家
「远方的朋友」）在 480×272 与 960×544 各出 4 张：`meet-far-and-emotes`（右上角「远方的朋友 · near」
与方块、左下「Bob · distant」、本人头顶 `\o/`、邻居 DemoOne 头顶 `o/`）、`meet-emote-picker`
（五格选择条，第三格高亮）、`meet-menu`（七行菜单含 `L: invite a friend`、`R: any world · CROSS: close`）、
`meet-invite-notice`（`INVITE plaza-1.K7MQ2XJ4 · 60 min`）。两档下中文名字、标签、菜单、选择条都完整
不截断；状态板、底部条与标记不重叠。

另外逐张打开了第三轮真实 Chrome 演示的 480×272 与 960×544、均以 3× 设备像素密度捕获的 invited、
emote、far、full 八张关键图：真实页面的中英文按钮与中文登录名完整，邀请玩家同画面出现；表情奶油色语义
像素分别为 371/2644，方向带 marker/label 黄像素分别为 81/222 与 576/1772；`WORLD FULL` 在两档均清晰
且未截断，状态文字黄像素为 467/2880。HUD、底栏、方向标记没有越界或互相遮挡。

## 本机三端演示（托管服务器 `scripts/demo-cf.sh`）

在同一个本机构建上连续独立运行三轮，三轮都从新建临时 D1/SQLite 状态开始，并都到达同一条最终结果：
`DEMO-CF PASS (v4 restart; invite + emote + far band in plaza-2; explicit WORLD FULL; v3/v4 ALL=2; both rooms closed at 1008/rest)`。

每轮实际覆盖：

1. 两个 3× 桌面窗口（480×272、960×544）和一个 3× Chrome 页面以不同 look、含中文名同时进入 v4；
   `ROOM 3 / ALL 3` 后在三客户端仍在线时重启真实 `wrangler dev`，三端都观察到重连与新 epoch。
2. 桌面玩家在 `plaza-2` 通过真实菜单签发邀请；浏览器由页面的 `#invite=<token>` 链接进入并确认
   `realmId=plaza-2`、`ROOM 2 / ALL 3`，随后真实按键发出服务器回显表情并走出一格 AOI，得到方向带。
3. 浏览器页面关闭后总在线数降为 2；邀请 host 退出后降为 1（Meter generation 8→9）。服务器以容量 1
   重启后，用同一个仍有效邀请进入会看到明确 `WORLD FULL`，拒绝页关闭后在线数仍为 1。
4. 同时运行 v3 与 v4 时两边各见 `ROOM 1 / ALL 2`；触发硬预算后两协议房间都关闭，新的两次连接都收到
   `1008 rest`。全程页面 `consoleErrors=0`。

三轮的关键语义数字一致：表情奶油色像素 `[371,2644]`；480 档方向 marker/label `[81,222]`，960 档
`[576,1772]`；满员文字像素 `[467,2880]`。邀请 token 每轮不同且页面链接里的 fragment 与 token 完全一致。

## 线上字节核查

- `FAR_PLAYERS`：头 2 字节 + 每行 6 字节（u32 id、u8 octant、u8 band），`tests/wander-online-meet.test.ts`
  断言真服务器发出的帧恰为 8 字节且行对象只有 `band/dir/id` 三个键；解码器拒绝任何长度偏差，所以不可能
  在行里夹带坐标。
- `EMOTE`：6 字节；`COMMAND`：11 字节，`extra` 是 u8，没有字符串字段。
- 邀请回复：`{"type","code","realm","expiresIn"}` 四个键；SQLite 行只有 `code`、`expires_at_ms`。
- 预算 ledger：邀请的 SQL 行读写走既有 metrics sink（服务器测试断言 mint 之后报告的
  `storageRowWrites > 0`），`inviteq`/表情命令作为 inbound 消息计数，带邀请的升级计入 `upgrades`。

## 文档

Wander：`examples/wander-online/README.md`（控制表、「Meeting others」一节、线格式表三行、文件表四行、
测试列表）、`docs/status.md`（新行「Wander Online meeting others」Done）、`package.json`（`shots:meet`）。
服务器：`README.md`（五张表、「Meeting other players」段、隐私表一行、关闭 token、成本说明）、
`docs/status.md`（四行 Done）。组件仓：`docs/status.md` 页面行扩写。

## 门禁

| 仓库 | 命令 | 结果 |
| --- | --- | --- |
| Wander | `bunx tsc --noEmit` | exit 0 |
| Wander | `bun run build` 后 `bun run test` | 415 pass / 0 fail（33 个文件，92.10 s） |
| Wander | `bun run shots:meet` | 16 张 PNG，肉眼核对 |
| Server | `bunx tsc --noEmit` | exit 0 |
| Server | `bun test tests/room-do.test.ts tests/worker.test.ts tests/realm-storage.test.ts tests/meter-do.test.ts tests/auth-do.test.ts tests/config.test.ts tests/demo-budget.test.ts tests/workflow.test.ts` | 194 pass / 0 fail（1485 expect） |
| Server | `bun test tests/integration.test.ts`（真 `wrangler dev`） | 17 pass / 0 fail |
| Server | `scripts/demo-cf.sh`（三端 + 重启 + 邀请/表情/方向带/满员 + v3/v4 + 预算切断） | 连续 3/3 PASS |
| 组件仓 | `bunx tsc --noEmit` | exit 0 |
| 组件仓 | `bun test tests/web-name-input.test.ts tests/web-invite-link.test.ts` | 19 pass / 0 fail |
| 组件仓 | `bun test tests/web-i18n.test.ts tests/web-oauth-state.test.ts tests/web-site.test.ts tests/web-editor-sharded-host.test.ts` | 100 pass / 0 fail |

三个仓库都没有改 `bun.lock`；提交作者 lfkdsk，无 AI 尾注。

## subagent 使用

2 个 / 一个在服务器仓做 Worker 路由 + RealmStore v2 + Room 的邀请/表情/方向带与 17 个测试，一个在组件仓做
页面层邀请链接盒子与 10 个 Chrome 测试 / 与我并行写客户端视图与 sim 测试，省了约一个小时串行时间；
我逐行审了服务器 diff 并亲自复跑两仓门禁。性能测量期间没有子代理在跑。

PASS
