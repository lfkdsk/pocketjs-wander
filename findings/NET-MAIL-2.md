# NET-MAIL-2 交付报告

## 结论

好友明信片已经补齐寄件幂等、主动过期清理和回信，并完成 Wander 客户端、Hosted Room、
Auth Durable Object、预算模型与真实 workerd 的端到端验收。客户端在响应丢失后保留同一份草稿
和同一个请求 id；Auth 的成功回执保证重试只返回原卡 id，不再投递、不再扣每日额度，也不再
发送第二次在线提示。读过的卡可以直接回信，浏览器只提交不透明的卡 id，原寄件账号只在 Auth
内部解析。

过期卡现在通过复用 Auth 既有 alarm 的时间索引主动清理，即使双方账号都不再上线也会收敛；
单次 wake 最多处理 64 个索引或迁移行，不新增常驻 Worker 或轮询。回信和普通寄件共享双向好友、
每日五封、32 封信箱、30 日 TTL、预设句和邮戳验证。单向好友请求与解除好友后的回信均由服务器
拒绝。

真实 workerd 演示证明 A 的首次成功响应被验收 harness 丢弃并经另一个 Room 重连后，以相同
request id 重发：B 最终只有一张卡，A 的额度只从 5 降到 4；B 随后成功回信，单向请求者寄件仍
得到 `not-friends`。四个规定的隔离变异都被行为断言杀死；双语桌面两档与手机双朝向均通过机器
断言和肉眼核对。两仓最终门禁都是 0 fail、0 skip。

## 提交、范围与发布顺序

- Wander 已测试 HEAD：`333751f3e9e8b958f89c313a696b949b0ca7f2aa`。本报告及最终门禁
  JSON 是其后的 report-only 交付，不改变已测试运行时代码。
- Server 已测试 HEAD：`cd3757f24236d9a9cb64b95e4208fa3b20298eb1`；它的
  `vendor/pocketjs-wander` 精确固定在客户端/验收脚本提交
  `b950ac4fd9daedca9591612fd8c2dc315c425bc6`。Wander 后续提交只增加机器报告与预算证据，
  因此不需要再移动运行时 gitlink。
- `.gitmodules` 仍是公开 GitHub URL；两仓都没有提交 `bun.lock`，没有 merge commit，也没有
  push、部署、开 PR 或修改 GitHub。
- 发布顺序必须是 **先 Wander，后 Server**：先让 Server 所固定的 Wander commit 可从公开仓
  获取，再发布 Server。

能力按加法式 capability 上线：`postcards` 保留原信箱，`postcardReplies` 开启不透明 id 回信，
`postcardIdempotency` 开启严格结果关联和响应丢失重放。旧服务器缺少后两个字段时，客户端把它们
规范为 `false`，不会误开新行为。

## 1. 寄件幂等与兼容边界

共享协议要求新寄件带 16–80 字符的 sender-scoped `requestId`；普通目标 `targetGithubId` 与回信
目标 `replyToPostcardId` 必须且只能出现一个。客户端把待发送状态保存为 `{requestId, draftKey}`：
相同草稿重新确认继续使用原 id，改动收件目标、句子或邮戳才生成新 id。服务器宣告幂等能力时，
客户端只接受匹配该待处理 id 的结果；旧服务器没有能力字段时仍兼容原结果。

Auth 只给成功投递写回执，回执同时保存规范化 payload 指纹、原卡 id、原结果状态和逻辑过期时间。
相同 payload 的重放只精确读取 sender account 与 receipt 两行，返回原卡 id/status，写入数为 0，
不会再扣 daily counter，也不会触发 Room 的第二次 unread fanout。相同 id 换 payload 返回
`request-conflict`；逻辑 TTL 已过但物理 sweep 尚未执行时返回 `request-expired`；失败请求不占用
receipt。旧客户端不带 id 的请求仍可寄件，但明确没有跨响应丢失的幂等保证。

receipt 的逻辑窗口与卡片一致，为 30 天。物理删除在逻辑到期后的下一个 UTC 午夜进行，因此最多
同时存在 31 个日 cohort；每日最多五次成功寄件使单一 sender 最多归属 155 个 receipt 和 155 个
expiry reference。这个窗口同时覆盖合理的断线重试，并给存储留下确定上界。

## 2. 主动 TTL 清理与存储上界

每次成功投递在原 inbox/outbox 行之外写一条按到期时间排序的全局 expiry index。Auth 复用完整
账号删除已经使用的 alarm 槽：每次 wake 先处理一个至多 64 行的明信片批次；还有 backlog 时调度
紧接着的 continuation，否则只保留最早的删除截止时间或下一次 UTC 午夜。迁移游标以同样的 64 行
上限给已有卡补索引，故升级不会制造一次无界扫描。

一个到期索引会删除 inbox、outbox reference、expiry index 和关联 receipt，并推进确实受影响的
收件人 revision。完整账号删除也清掉该账号收发卡及全局索引引用。整个机制不需要常驻 isolate、
周期轮询或额外 Worker。

保守的单账号归属上界是：

```text
32 inbox + 155 outbox + 155 receipts + 155 expiry references + 2 counters = 499 rows
```

对 `A` 个仍存在的账号，outbox 与全局最多 `32A` 个 inbox 一一对应，得到更紧的服务级明信片
上界 `376A + 2`（含 migration cursor 与 alarm state）。账号人口本身没有全局上限，因此不存在
与 `A` 无关的有限总行数；文档明确写出这一边界，没有把 per-account 限额误报成全服务常数。

## 3. 回信、好友约束与 wire 隐私

客户端在已读卡详情中显示 `REPLY` / `回信`，之后仍走原来的预设句、可选自己的邮戳和 review
流程。请求只含 `replyToPostcardId`；Auth 在寄件人自己的 inbox 中解析原 sender id，然后在同一
事务里重新验证双方好友边。卡已读后解除好友，不能靠保留的卡绕过验证；只有单向 pending request
也不能寄普通卡或回信。回信与普通寄件共同消耗 sender 的每日五次上限，并受收件信箱容量、TTL、
句子白名单和精确 account-incarnation 地标 FIRST 校验。

公开卡片的精确键仍只有 `expiresAt`、`id`、`postmark`、`read`、`senderName`、`sentAt`、
`sentenceId`。服务器只在 Auth 私有行保存 sender account id，以便回信解析、解除好友、到期和完整
删除；该 id、realm、坐标、token 与自由文本都不会序列化给浏览器。权威 status 数据字段与实现
一致，精确为 `revision`、`unread`、`total`、`dailyRemaining`。

## 4. 真实 workerd 响应丢失与回信演示

机器证据在 `reports/net-mail-2-demo.json`。验收从真实 workerd WebSocket 收到并丢弃第一次成功帧，
随后断开、经另一个 Room 重新连接，并用完全相同的 request id 与 payload 重试。这是应用 harness
层对已到达响应的丢弃，不是假装为底层网络抓包注入；它仍准确覆盖了“服务端已提交、客户端没有
消费成功响应”的故障窗口。

- 首次与重试都返回卡 `pc_mv4t23kv_1toc6ls049p48b`，`samePostcardId=true`；
- A 的 `dailyRemaining` 从 5 到 4，只消耗 1；
- B 离线后重连看到 `unread=1`、`total=1`，且信箱中只有这一个 id；
- B 通过这张卡的不透明 id 回给 A，A 得到 `unread=1`、`total=1`；
- 只有单向 pending edge 的 C 寄件得到 `{ok:false, reason:"not-friends"}`；
- 演示同时锁定四个 status 字段与七个公开卡片字段，没有账号 id 泄漏。

该演示属于完整 Server suite 的真实 `wrangler dev`/workerd 集成测试，不以 loopback fixture 代替
Durable Object、SQLite 或 Room 路由。

## 5. Cloudflare 扫描行预算与停机线

更新后的模型把回信 source 精确读取、幂等重放、expiry alarm wake、Meter 请求、索引读取和实际
删除行全部加入 ledger，并继续按 Cloudflare **扫描行** 口径计费。常见月度点为 31 天、100 DAU、
500 次成功寄件（其中 250 次回信）、50 次幂等重放、50 张卡分 25 批主动过期：

| 月度增量 | 常见负载 |
| --- | ---: |
| inbound controls / internal DO requests / request units | 7,250 / 7,525 / 7,887.5 |
| short wakes / short-wake seconds / GB-s | 14,800 / 148 / 18.944 |
| storage row reads / writes | 55,650 / 4,725 |
| Workers Paid 包含池内增量 | **$0** |
| 全部用量按 overage 单价的等价值 | **$0.006200575/月** |
| hard stop | **false** |

`reports/net-mail-2-budget.json` 是模型的精确输入与输出。模型分别比较 request、GB-s、row reads、
row writes 的包含额度；任一维进入 overage 就设置 `hardStop=true`。当前常见负载全部在包含池内，
所以符合“不花钱”的发布约束；如果部署参数把任一维推到超额，发布必须停止并重新评估。

## 6. 变异辨识力

四个单点变异分别在独立 disposable worktree 中执行，从未修改交付分支。完整命令与红灯摘要在
`reports/net-mail-2-mutations.md`。

| 单点故障 | 对应红灯 |
| --- | --- |
| 关闭成功 receipt 的 replay early-return，使同 id 再投一张 | 第二次得到不同卡 id，收件箱从 1/1 变 2/2，写入 7 行；`0 pass / 1 fail` |
| replay 分支再次增加 daily counter | 期望 `dailyRemaining=4`，实际为 3；`0 pass / 1 fail` |
| alarm 跳过到期行删除 | expiry index、inbox、outbox 三类行继续存在；`0 pass / 1 fail` |
| 回信绕过双向好友检查 | 解除好友后回信意外成功并写 7 行；`0 pass / 1 fail` |

四次都是对应行为断言失败，不是编译失败或无关红灯；因此分别证明测试能识别重复投递、重复扣额、
惰性残留和回信好友绕过。

## 7. 双语桌面与手机验收

桌面/PSP 逻辑视口的公开清单在 `reports/net-mail-2-postcard-shots/report.json`：EN/ZH ×
`480x272`/`960x544` × unread/read/reply-review/ordinary-review，共 16 个场景；每个保留 native 与
nearest-neighbour 3× 图，共 32 PNG。报告为 `PASS`，所有必需文字实际宽度都小于可用宽度，panel、
title、ink、accent、selected 五类语义像素均非零。

真实 Chrome 报告在 `reports/net-mail-2-mobile/report.json`：英文 `390x844@3` portrait 与中文
`844x390@3` landscape 都通过真实触控读卡、进入直接回信、在模拟丢响应后用同一 request id 提交
两次，并完成其余移动端控制流程。两方向的 request 都只有 `replyToPostcardId`，没有直接目标账号；
`failures=[]`、`consoleErrors=[]`，流程保留 32 张 PNG。

我打开英文竖屏 read/reply-review、中文横屏 read/reply-review，以及两档 3× 桌面关键帧肉眼核对。
标题、长预设句、收件人、邮戳和确认提示都清楚可辨，没有截断、replacement glyph、错误收件人或
控制层遮挡。所有生成 PNG 已作为 Fleet artifact 登记；仓库提交的是可复现脚本与机器清单，避免
把 7.5 MB 二进制证据塞进 Git 历史。

## 8. 最终门禁

精确机器汇总保存在 `reports/net-mail-2-gates.json`。

| 仓库/检查 | 最终结果 |
| --- | --- |
| Wander `bun run build:wasm` | exit 0；当前 359,729-byte wasm 已重编 |
| Wander `bun run build` | exit 0 |
| Wander `bun test tests/` | **508 pass / 0 fail / 0 skip / 41 files / 500,915 assertions** |
| Wander `bunx tsc --noEmit` | exit 0 |
| Server `bun test tests/*.test.ts` | **341 pass / 0 fail / 0 skip / 15 files / 3,568 assertions** |
| Server `./node_modules/.bin/tsc --noEmit` | exit 0 |
| 真实 workerd response-loss/retry/reply/pending-friend 演示 | **PASS**；完整 Server suite 内执行 |
| 双语桌面两档截图 | **PASS**；16 scenes，32 PNG，native + 3× |
| 真实 Chrome 手机 | **PASS**；双朝向，32 PNG，0 failure，0 console error |
| 四项隔离变异 | 全部 exit 1，均为 **0 pass / 1 fail** |

两次完整 `bun test` 汇总都没有 skipped 行或跳过测试；报告中的 `0 skip` 是最终全量运行结果，不是
把 focused test 的 filtered-out 数误算为 skip。

## 9. 已知边界

- 幂等窗口是成功投递后的 30 天；再晚的重试已经超出承诺。下一 UTC 午夜前的物理残留会明确返回
  `request-expired`，不会悄悄当作新请求。
- 旧客户端不带 request id 的寄件为了滚动升级仍被接受，但没有响应丢失幂等保证；新客户端始终带 id。
- 真实演示在 harness 层丢弃已收到的第一次成功帧，没有做内核级丢包注入；它覆盖的是应用需要保证的
  “服务端提交成功、客户端未消费响应”窗口。
- 总存储行数随 extant account 数量 `A` 线性增长；实现给出 per-account 与 `376A + 2` 上界，不能在
  没有限制账号总数时声称一个全局常数。

subagent 使用：3 / `acceptance_scout` 核对验收、变异与证据边界，`client_scout` 审查客户端协议、
回信 UI 与双语/移动端验收，`server_scout` 审查 Durable Object 幂等、alarm 清理、存储上界与预算 /
三块独立审查并行完成，节省了方案交叉核对时间；主 agent 完成实现集成、所有重门禁、真实演示、
隔离变异、肉眼验图、提交与最终判定。

PASS
