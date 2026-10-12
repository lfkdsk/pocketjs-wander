# NET-MAIL-1 交付报告

## 结论

好友明信片已经完成客户端、Hosted Room、Auth 持久层和 Cloudflare 用量模型的端到端实现。
玩家面对任一已建成城镇的告示板时，CIRCLE 仍读告示，CROSS 打开邮局；HUD 显示服务器
给出的未读数。寄件流程只能从互为好友的列表、六条中英双语预设句和自己首发现过的地标
邮戳中选择，没有自由文本入口。

离线投递由 Auth Durable Object 持久化。收件人不在线时明信片仍进入信箱，下次在任一邮局
打开即可读取。服务器权威执行 32 封容量、每人每 UTC 日 5 次成功寄件、30 日 TTL、双向
好友校验、精确账号 incarnation 校验和地标 FIRST 校验。真实 workerd 三端流程证明 A 能给
离线 B 寄信，B 重连后读到，非好友 C 给 A 寄信被拒。

隐私边界也已锁定：收件人只得到卡片 id、寄件显示名、预设句 id、服务器派生的地标种类、
时间与已读状态，不得到寄件人的 realm、坐标、账号 id、版本、token 或位置。解除好友会
撤回双方尚未读的卡片，已读历史保留至 TTL；完整删除账号会同时清除收件箱、寄件反向引用、
计数和受影响好友的可见 revision。

四个要求的隔离变异都被对应测试杀死；双语桌面两档 3 倍图、英文竖屏和中文横屏真实触控
流程都通过并经肉眼检查。Wander 和 Server 的最终构建、类型检查与完整测试均为 0 fail。

## 提交、范围与发布顺序

- Wander 已测试代码 HEAD：`a24bec9a8dfc060aacfd600aa529b5ad6ec48e6f`。本报告由其后的
  report-only 提交加入，不改变已测试运行时代码。
- Server 已测试 HEAD：`302cc7411496bce0b613fd6499e8e71ecb40acc6`，其
  `vendor/pocketjs-wander` 精确指向上述 Wander HEAD。
- `.gitmodules` 保持公开 GitHub URL；没有提交 `bun.lock`，没有 merge commit，也没有 push、
  部署、开 PR 或修改 GitHub。
- 发布顺序必须是 **先 Wander，后 Server**：先让上述 Wander commit 在公开仓可获取，再发布
  固定该 gitlink 的 Server commit。

`postcards` 是 hosted realm 的加法式 capability。客户端只有在服务器明确宣告
`realmFeatures.postcards === true` 时才显示邮局和未读提示。Loopback Bun server 没有耐久账号
和信箱，故意不宣告该 capability，也不会伪装成可以离线投递。

## 1. 预设明信片与邮局交互

共享协议固定六个句子 id：`hello`、`recommend`、`thanks`、`memory`、`cheer`、
`meet-again`。每个 id 都有英文和中文显示文案；客户端请求只带收件好友 id、句子 id，以及
可选的 `{rx, ry}` 地标证明。解析器拒绝未知句子、非 int32 坐标、自寄、畸形卡片、重复 id、
越界计数和不一致的 unread/total，因此任意自由文本都不能变成卡片正文。

客户端采用 controller-first 状态机：

1. 在已建成告示板前按 CROSS 打开邮局；
2. `MAILBOX`/`信箱` 查看按新到旧排列的卡片，打开未读卡时发送一次权威 read；
3. `SEND` 先选互为好友的收件人，再选预设句，再选 `NO POSTMARK` 或私有旅行日志里的地标；
4. review 页显示最终收件人、双语正文和邮戳，确认后才发送；
5. 服务器结果失败时保留可读的拒绝原因，不把本地草稿误当成已投递。

HUD 的 `MAIL n` / `信 n` 来自 `postcardStatus`，不是客户端推测。投递给在线好友时，同 realm
直接推送，跨 realm 通过收件人 session 路由发送 best-effort 状态提示；断线、超时或丢提示时，
下次连接/status/mailbox 获取仍是唯一权威结果。

真实手机验收还发现并修复了一个共享按键冲突：玩家在邮局告示板前且合作差事处于
`X CANCEL` 时，取消 READY 必须优先于打开邮局。最终英文竖屏和中文横屏都用真实触控证明
取消命令与普通邮局打开各自可达。

## 2. 服务器权威与离线投递

职责分为三层：

- Room 绑定已认证 socket 身份，验证玩家当前确实面对一个已建成告示板，并负责同/跨 realm
  的状态路由；
- RealmStore 用 `(region, account id, account version, incarnation token)` 精确验证寄件人是该
  地标的 FIRST，只把世界生成器算出的地标种类交给 Auth；
- Auth 在一个事务中验证寄件人与收件人账号、双向好友边、每日计数、收件箱容量，清理过期
  行，再写入 inbox、sender outbox reference、daily counter 和双方 revision。

信箱上限是 32 封活卡；每日上限只计算成功投递，非好友、伪造句子、伪造邮戳、满信箱等失败
不会消耗配额；UTC 日切换后计数自动归零。每封卡 30 日后过期，status/mailbox/send/read 都会
执行有界清理。首次 read 将卡标已读并推进 revision，重复 read 幂等且不再写入。

公开卡片不会存坐标或寄件人的稳定账号标识。sender account id 只存在 Auth 内部的删除/反向
引用结构，Room 的 session 列表也只用于内部路由，二者都不会转发给浏览器。客户端自报的
postmark 文字永远不会进入 Auth；只有 Room 验证通过后派生的地标 kind name 可存储和展示。

## 3. 解除好友与完整删除

解除好友后立即删除双方之间所有 **未读** 卡片及相应 outbox reference；这样 former friend
不能靠好友关系已撤销前塞入一封尚未看到的消息，在解除后继续完成一次新的接触。已经读过的
卡片是收件人已知历史，保留到原 30 日 TTL，避免静默重写已知记录。解除好友不退还当日寄件
配额，防止反复加好友/删好友刷写入。

完整账号删除扫描该账号收、发两侧的有界前缀，删除收到的卡、寄出的卡、反向引用、daily 和
revision 行。每个确实失去卡片的 peer mailbox revision 恰好推进一次，即使该 peer 同时失去
多封卡；悬空或损坏的反向引用可以清理，但不会制造一次虚假的可见 revision。

跨 realm 好友在解除关系的一瞬间不新增一条专用 HUD fanout；Auth 中的未读删除立即生效，
客户端在下一次权威 status/mailbox refresh 收敛。这不影响投递或隐私语义，但若以后要求
毫秒级 UI 收敛，需要把 `/social/remove` 的 peer session 路由和相应用量一并设计。

## 4. 伪造请求的拒绝面

以下输入都在服务器端拒绝，而不是依赖客户端 UI：

- 非互为好友、目标不存在、目标正在删除、自寄或旧账号 incarnation；
- 六个白名单之外的句子 id，或者试图加入自由正文；
- 不在已建成邮局前发送 get/read/send；
- 不存在的地标、他人 FIRST、错误 account version、旧 incarnation token 或任意伪造坐标；
- 畸形卡片 id、越界数值和超出控制面滑动窗口的请求。

postmark 坐标仅是 request-time proof。RealmStore 必须找到当前寄件账号精确 incarnation 的 FIRST
记录，Room 才把该坐标对应的纯函数地标种类传给 Auth。公开 mailbox 因而只会出现例如
`Ancient Tree` 的展示值，不会出现证明坐标。

## 5. 真实三端离线演示

机器证据在 `reports/net-mail-1-demo.json`，由真实 workerd 路径生成：

- A 的 send 结果为 `{operation: "send", ok: true}`，当时 B 没有在线 socket；
- B 之后上线并在邮局打开信箱，权威 unread 为 1，句子 id 为 `thanks`；
- 非好友 C 给 A 寄件得到 `{ok: false, reason: "not-friends"}`；
- B 读取后 unread 变成 0、revision 变成 2；
- 收件卡的精确公开键只有 `expiresAt`、`id`、`postmark`、`read`、`senderName`、
  `sentAt`、`sentenceId`。

这条演示和完整 server integration suite 使用相同的 Worker/Room/Auth/SQLite 代码，不以 loopback
fixture 代替耐久投递。

## 6. Cloudflare 扫描行预算与停机线

常见负载模型按 31 日、100 DAU、每账号每天一次 status 和一次 mailbox open、每账号每月 5 次
成功寄件、其中 250 次带邮戳、每次成功寄件一次 read、250 次跨 realm 在线提示计算。SQLite
按 **扫描行** 而不是返回行计费，所以 status/mailbox/read 都加入平均 inbox scan，send 同时加入
inbox 与 outbox scan，邮戳加入一行精确 FIRST lookup，批量过期按每封两行删除加每批一次 revision
写入。

| 月度增量 | 常见负载 |
| --- | ---: |
| status / mailbox / successful sends / reads | 3,100 / 3,100 / 500 / 500 |
| stamped sends / cross-realm pushes | 250 / 250 |
| inbound controls / internal DO requests / request units | 7,200 / 7,450 / 7,810 |
| short wakes / short-wake seconds / GB-s | 14,650 / 146.5 / 18.752 |
| storage row reads / writes | 54,650 / 3,625 |
| Workers Paid 包含池内增量 | **$0** |
| 全部用量按 overage 单价的等价值 | **$0.00508555/月** |
| hard stop | **false** |

模型分别对 request、GB-s、row reads、row writes 比较 Workers Paid 包含额度；任一维超过额度就设置
`hardStop=true`。测试放大扫描人口、写入人口和过期批量，确认超额不能静默通过。常见负载全部
在包含额度内，故当前增量为 $0；如果部署参数使任一维进入 overage，本功能按规格停止发布，
而不是把超额费用当作可接受结果。

## 7. 变异辨识力

四个变异各自在独立 disposable worktree 中运行，从未修改交付分支。完整命令与红灯摘要保存在
`reports/net-mail-1-mutations.md`。

| 单点故障 | 对应红灯 |
| --- | --- |
| 删除双方好友边检查，使非好友也能寄 | 期望 `not-friends`，实际收到 `ok:true`、新卡 id 和 5 次写入；`0 pass / 1 fail` |
| 把每日上限 `>=` 改成 `>` | 同一天第六封被接受，信箱 total 变 6；`0 pass / 1 fail` |
| 完整删除时跳过 postcard cleanup | 被删除账号寄给 Bob 的两封未读卡仍在，revision 未推进；`0 pass / 1 fail` |
| 邮戳只检查世界里有地标，不检查 exact FIRST | 第一枚伪造邮戳返回 `ok:true`；`0 pass / 1 fail` |

四个验收测试都准确捕获其对应故障，且失败内容直接落在要求保护的行为，不是无关编译错误。

## 8. 双语截图与手机验收

桌面/PSP 逻辑视口证据在 `reports/net-mail-1-postcard-shots/`：EN/ZH × `480x272`、
`960x544` × unread/read/review，共 12 个场景；每个场景保留 native 和 nearest-neighbour 3× 图，
共 24 PNG。`report.json` 为 `PASS`，逐条测量所有必要文案的实际宽度与可用宽度，并锁定 panel、
title、ink、accent、selected 五类语义像素非空。

真实 Chrome 证据在 `reports/net-mail-1-mobile/`：

- `390x844@3` portrait 使用英文；`844x390@3` landscape 使用中文；
- 两个方向都用真实触控完成建角、面对物理告示板打开邮局、读取一封离线卡、选择离线好友、
  选择最长预设句、选择无邮戳并到达 review；
- 12 个游戏按钮全部可达，所有触控目标至少 44 CSS px；邮局面板、HUD 和两侧控制群没有交叠；
- 未读 badge、标题、正文、邮戳、选中行都有语义像素断言；`failures=[]`、`consoleErrors=[]`；
- 共保留 32 张流程 PNG 和一份 `PASS` report。

我打开英文竖屏 read/review、中文横屏 read/review，以及两档 3× 桌面关键帧肉眼核对。双语正文、
收件人和邮戳清楚可辨，没有截断或 replacement box；选中行与返回/确认提示也保持可读。

## 9. 最终门禁

| 仓库/检查 | 最终结果 |
| --- | --- |
| Wander `bun run build` | exit 0；重新生成当前 source 的 sim bundle 与 pak |
| Wander `bun test tests/`（build 后） | **505 pass / 0 fail / 41 files / 500,870 assertions** |
| Wander `bunx tsc --noEmit` | exit 0 |
| 明信片逻辑 focused tests | **8 pass / 0 fail / 64 assertions** |
| Mounted production postcard flow | **1 pass / 0 fail / 17 assertions** |
| Server `bun test tests/*.test.ts`（最终 gitlink） | **331 pass / 0 fail / 14 files / 3,361 assertions** |
| Server `bunx tsc --noEmit` | exit 0 |
| 真实 workerd A/offline-B/nonfriend-C demo | **PASS** |
| 双语两档截图报告 | **PASS**；12 scenes，24 PNG，native + 3× |
| 真实 Chrome 手机报告 | **PASS**；双朝向，32 PNG，0 failure，0 console error |
| 四项隔离变异 | 全部 exit 1，均为 **0 pass / 1 fail** |

## 10. 已知边界与后续建议

当前 `postcardSend` 没有跨 response loss 的 request id。若 Auth 已提交成功但成功响应丢失，用户
重试可能产生第二封卡并再消耗一次日配额。它不允许越过好友、容量、FIRST 或每日上限，也不影响
本次离线投递验收，但属于可靠性债务；已提交独立后续建议，为 sender 增加有界 idempotency key、
纳入扫描行模型并用 isolate reconstruction/响应丢失测试锁定。

subagent 使用：3 / `acceptance_design` 核对验收与变异设计，`client_design` 负责双语 UI、布局与
截图验收设计，`server_design` 审查持久化、删除收敛和扫描行预算 / 三块可独立审查并行完成，节省
了前期方案与交叉核对时间；主 agent 完成实现集成、长命令、真实演示、隔离变异、肉眼验图、提交
与最终判定。

PASS
