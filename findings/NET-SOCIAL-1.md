# NET-SOCIAL-1：好友、选世界与自助数据

## 结论

好友、找到好友、世界选择和自助数据已经在 Wander 客户端与在线服务端完整接通。好友必须由接收方确认；非好友不能读取位置；好友关闭在线可见性后只显示 `HIDDEN`，不泄露所在 realm。世界列表只给人口档位，显式选择始终精确加入，满员时明确显示 `WORLD FULL`，默认入口仍沿用填满策略。

“删除全部数据”不是旧的 profile-only 删除：Auth 先冻结账号并失效会话，再要求每个相关 realm 删除该账号 incarnation 的 checkpoint、旅程和邀请、匿名化共享历史中的身份，最后才清除好友边、账号和删除 job；任一 realm 失败都不会报告成功。删除后客户端清票并登出，旧 ticket 不能再加入。

本报告对应的发布代码头为：

- PocketJS Wander：`5685a844fb8fa48c8a30f412349d750614d735d3`
- Pocket Online Server：`58d30125a1cc5466ef047b9b5559856b1e95705e`

服务器的 `vendor/pocketjs-wander` 已固定到上述 Wander 代码头，`.gitmodules` 保持公开 GitHub URL。报告提交本身只增加本 findings 文件，不改变需要固定的运行时代码。

## 1. 好友与位置隐私

### 数据与身份边界

- Auth DO 持有 profile、双向好友集合、incoming/outgoing pending 集合与持久化 presence 开关。边只保存稳定 GitHub id；显示名来自对应 profile，不把好友图复制到 Realm DO。
- 同 realm 发起请求时，客户端只发送该连接的临时 `playerId`；Room 在自己的已认证 roster 中解析目标账号。接受、拒绝、取消和删除使用稳定 `githubId`，不会把临时玩家编号误当账号身份。
- 邀请只在成功入服后利用 Room 私有的发行者元数据创建 pending 边；兑换者仍需明确接受，不会因知道短码直接成为好友。
- `socialGet` 只返回调用者自己的 bounded 好友与 pending 列表。独立 location 查询对非好友返回拒绝；共同好友才能得到 presence/realm。
- 关闭可见性后，即使共同好友也只得到 `presence:"hidden"` 与 `realm:null`。好友删除同时清掉双方边。

Auth 与 Room 都校验 account version。旧 socket 或旧 ticket 不能在同一 GitHub 账号重建后读取/修改新 incarnation 的社交、隐私、自助数据或删除状态。

### 客户端行为

SELECT 菜单的 DOWN 打开 controller-first 社交面板。Friends 页同时显示 incoming、online、hidden、offline、outgoing 与同 realm nearby 玩家；加入在线好友复用对方仅好友可见的精确 realm。服务端发出完整 roster 后客户端整体替换 roster，因此 BYE 后离开的玩家不会残留在“附近玩家”中。

dialog、emote、主菜单和 social panel 统一进入 `inputCaptured`，面板打开时移动、自动行走和网络输入都被消费，不会边操作好友边让角色移动。

## 2. 世界选择

`worldsGet` 对每个配置 realm 只返回 `{realm, band, joinable}`。档位为 EMPTY/QUIET/LIVELY/FULL 等粗粒度文案，不返回精确人数。玩家选择某项后客户端重连到精确 `?realm=`；Worker 跳过默认 `/count` 选择，目标 Room 自己在满员时关闭为 `1008/full`，不会静默落到其他 realm。选择 “any world” 才重新启用既有的 fullest-with-free-slot 策略。

完整门禁发现并修正了一处旧集成夹具：环境从一个 realm 扩成两个、每个容量 3 后，旧测试仍只填 3 人便期待全局 `full`。聚焦复现为 expected `full` / received `auth`；改为先填满两个 realm 的 6 个槽位后，第 7 个连接稳定得到 `full`，聚焦结果 `1 pass / 0 fail / 39 expect()`。

## 3. 自助查看与完整删除

### 玩家可查看的数据

My Data 显示自己的 profile、好友/incoming/outgoing 数量、presence 开关，以及每个访问过的 realm 的 discovery/help/update 摘要。返回值不包含坐标、完整 travel log、删除 capability、incarnation secret 或 realm 内部 token。

删除确认明确列出 `PROFILE + FRIENDS + JOURNEYS`，必须再次按删除键，不能把旧的“删 profile”误解为完整删除。旧 `delete` 控制被拒绝为 `delete-upgrade-required`。

### 跨 DO 删除协议

1. Auth 原子提交 deletion job，阻止新 admission/社交操作，失效旧 account version、sessions 与 device links，并冻结“账号已知 realm ∪ 当前配置 realm”。
2. 每个 realm 得到由随机 per-account-incarnation secret 与 realm 名派生的 HMAC-SHA256 base64url token。不同 realm 的 token 不同，且 token 不含 GitHub id 或版本。
3. Realm 在一个事务中写入 token-only fence，删除该 incarnation 的 checkpoint/旅程与发行者邀请，把共享 FIRST/region 归属改成 `Former traveler`，但保留共享世界事实。
4. 所有 realm 都确认后，Auth 清理 reciprocal friend/pending 边、账号和 deletion job。完成后 Auth 不留下 id/version tombstone 或 secret→identity 映射。

Auth alarm 一次重试一个 realm，同一个 job 与 purge 都幂等；socket 丢失、响应丢失、DO isolate 重启或中途失败都能继续收敛。部分 purge 返回 `deleteAllError` 并保持客户端登录以便重试，绝不提前发送成功。旧 incarnation 的延迟 retry 只能命中旧 token fence，不能删除重建账号的数据。

单元测试直接检查 Auth storage 与两个 Realm SQLite：账号、job、sessions、device links、好友和 pending 边消失；个人行与邀请消失；共享归属被匿名化；fence 只有 43 字符 opaque token；重建账号仍可保存和读取自己的新数据。

## 4. 三客户端真实服务演示

最终服务端代码头上，真实 `wrangler dev` + workerd + 假 GitHub API 的三客户端流程为 `1 pass / 0 fail / 75 expect()`：

1. Alice 在同 realm 用 Bob 的临时 player id 发请求；Bob 接受前双方不是好友，Cara 作为非好友不能看到他们的位置。
2. Bob 接受后 Alice 能看到 Bob 在线及 realm；Bob 隐身后 Alice 只看到 hidden/null，再打开可见性后恢复。
3. Bob 正常离开 plaza-1、进入 plaza-2 并写入最终 checkpoint；Alice 从好友位置精确加入 plaza-2。
4. Alice 的自助数据同时列出 plaza-1 与 plaza-2 的旅程摘要，然后执行 `deleteAll`。
5. Alice 旧 ticket 被拒绝；Bob 与 Cara 的社交快照中不再有 Alice，验证 reciprocal edge 清理。

命令：

```text
bun test tests/integration.test.ts -t "friends confirm, locate and join across realms before complete deletion"
1 pass / 17 filtered out / 0 fail / 75 expect() calls
```

Room 聚焦门禁同时固定社交调用与 storage ledger delta：

```text
bun test tests/room-do.test.ts -t "same-realm requests require acceptance|self data fans out across realms"
2 pass / 106 filtered out / 0 fail / 48 expect() calls
```

## 5. 预算 ledger 与月度增量

新增 Worker/Room/Auth/Meter 请求、WebSocket inbound 聚合、短 wake，以及 Auth/Realm storage row reads/writes 都进入月度 ledger。Room 在发送前持久化 immutable pending usage envelope，Meter 以 `{reporter, sequence}` 保存游标；响应丢失后的同序号重放成功但不重复累计，新用量进入下一序号。

常见负载模型假设 31 天、100 DAU、4 realms、每账号 8 个好友；每天两次好友列表和一次世界列表；每月 50 次邀请辅助的好友流程；每账号每月一次隐私变更和一次跨两个已访问 realm 的自助清单。增量为：

| 维度 | 月增量 |
| --- | ---: |
| 客户端 control | 9,600 |
| 内部 DO 请求 | 15,900 |
| request ledger units | 16,380 |
| 短 wake 估算 | 32.64 GB-s |
| storage row reads | 106,150 |
| storage row writes | 350 |

完整删除随 realm、社交边、device link 与归属历史数量变化，不用一个会误导的固定数字；实际请求与行读写仍全部计量。

按 2026-10-11 Cloudflare Workers Paid 公布的 inclusion，此例在账号级 included pools 尚有余量时增量费用为 `$0`。完全耗尽 inclusion 后，未做账单单位取整的用量等价是 `$0.00332115`（约 `$0.00332/月`）；Cloudflare 对各 metered dimension 分别向上取整，如果四个维度都恰好首次越界，账单阶梯可能是 `$13.651`。因此前者不是最低发票金额，实际边际费用取决于账号当月已有 overage。

## 6. 画面与手机触控

专用 social renderer 对 Friends、Worlds、My Data、delete-confirm 四个状态分别生成 480×272 与 960×544 原图和 nearest-neighbour 3× 图，共 16 张；脚本同时检查标题、行语义、选中框和关键像素。肉眼逐张核对了两档 3× 图：中英文好友名、ONLINE/HIDDEN/OFFLINE、人口档位、realm 摘要、红色不可逆删除提示均清楚，没有空帧、裁切或错误叠层。Fleet artifacts：`48826..48841`。

真实 Chrome 验证器使用 DPR 3 touch emulation，不以鼠标 click 代替触摸。它在 390×844 portrait 和 844×390 landscape 中通过虚拟按键打开/关闭社交面板，并保留每个方向的 name、social、emote、invite、signed-out 五张截图。报告为 `PASS`、`failures=[]`、`consoleErrors=[]`；所有页面交互目标至少 44 CSS px，控制与关键 HUD、中央保留区的 overlap 都为 0。报告是 artifact `48825`，十张截图是 `48815..48824`。

肉眼复核 portrait/landscape social 截图：社交入口、选择框、虚拟方向键与动作键都可辨认；横屏控制留在两侧，面板文字与退出 fullscreen 按钮可读。

## 7. 测试辨识力

最终四个隔离 mutant 都在独立 worktree 中运行并在每次后恢复干净，未进入交付分支：

| mutant | 目标测试实际失败 |
| --- | --- |
| 绕过 pending-edge，未确认直接成为好友 | expected `friend-request`, received `friends`; `0 pass / 1 fail` |
| 隐身仍返回最后 realm | expected `realm:null`, received `plaza-1`; `0 pass / 1 fail` |
| 删除循环遗漏最后一个 realm | `deleteFinishCalls` expected 0, received 1；`0 pass / 1 fail` |
| 精确 realm 错误 fallback 到 `names[0]` | expected `v4:a/ws, v4:b/ws`, received `v4:a/ws, v4:a/ws`; `0 pass / 1 fail` |

四项恢复后聚焦测试全部重新变绿。另有客户端 panel/BYE、Auth token 隔离、Realm 残留检查、Meter sequence replay 和真实三客户端流程覆盖协议解析与最终状态，不只检查函数返回一个 `ok`。

## 8. 最终门禁

所有重命令串行运行。

| 检查 | 结果 |
| --- | --- |
| Wander `bun run build:wasm` | exit 0；`pocketjs.wasm` 360,011 bytes |
| Wander `bun run build` | exit 0；`wander-online.pak` 与 JS bundle 成功生成 |
| Wander `bun run test --reporter=dot` | 441 pass，0 fail，499,997 `expect()`，35 files |
| Wander `bunx tsc --noEmit` | exit 0 |
| Server `bun run test --reporter=dot` | 257 pass，0 fail，2,441 `expect()`，9 files |
| Server `bun run typecheck` | exit 0 |
| 三客户端 workerd 社交流程 | 1 pass，0 fail，75 `expect()` |
| 社交/自助 ledger 聚焦测试 | 2 pass，0 fail，48 `expect()` |

两仓 `git diff --check <base>...HEAD` 均为 exit 0；没有 `bun.lock` 改动。所有功能提交作者为 `lfkdsk <lfkdsk@gmail.com>`，提交正文没有 Co-Authored-By、Generated-with 或 AI 尾注。

## 9. 提交与发布顺序

Wander 功能提交：

- `f6a4226 feat(online): define social data contract`
- `ab092c3 fix(online): randomize account incarnations safely`
- `0d52905 feat(online): switch realms without stale state`
- `9ddbcc0 feat(online): add responsive social panel`
- `c709a39 feat(online): wire social self-service flow`
- `8a984fd fix(online): remove departed nearby players`
- `29b4b46 test(online): verify social views on mobile`
- `5685a84 docs(online): explain social self-service`

Server 分支包含 Auth/Realm 删除、好友、计量与真实集成测试的独立提交，最终三个收尾提交为：

- `38f45f9 chore(vendor): update wander social client`
- `187dd85 docs(server): document social privacy and costs`
- `58d3012 test(server): fill all realms before capacity rejection`

发布顺序必须是：先合并并发布 Wander `5685a84`；再合并已固定该客户端的 Server `58d3012`；最后部署 Server。未 push、未部署、未修改 GitHub 状态。

subagent 使用：3 个 / 分别核对客户端协议与交互、服务端隐私删除边界、测试辨识力与隔离变异 / 并行审查缩短了跨两仓逐项核对时间；重型门禁、集成、画面复核和最终判定由主 agent 串行完成。

PASS
