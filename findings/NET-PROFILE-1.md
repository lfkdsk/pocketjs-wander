# NET-PROFILE-1 交付报告

## 结论

玩家名片与服务器权威成就已经在 Wander 和 hosted server 完成。名片包含名字、动态外观、
UTC 加入日期、已获得成就和一枚可选展示邮戳；自己的名片与双向好友名片可看，pending request
和非好友只得到固定的 `forbidden`，不会收到名字、成就、realm、位置或内部鉴权能力。完整账号
删除会同时删除名片上的持久成就与展示邮戳。

成就没有新增一套跟踪系统，只从五类既有持久事实派生：完成差事、看见地标、首发现地标、
保留窗口内参与共同目标的日期、到访 realm 数。每类各三档，共 15 项中英双语成就。Room 从每个
已知 realm 按 exact account incarnation 聚合事实，客户端附带的成就字段完全不参与计算；Auth
以事务持久化已获得 id，并只在首次写入时返回 unlock edge。客户端再以会话集合去重并用 FIFO
顺序显示提示，因此并发解锁不丢失，重放快照也不会重复提示。

本机三账号验收完成了规定路径：A 与好友 B 完成一次合作差事后，A 收到 `errands-1` 解锁；
B 随即在 A 的好友名片看到该成就；非好友 C 的同一读取只得到 `forbidden`。四个规定的隔离变异
全部由对应行为断言杀死。英中双语、480x272/960x544、手机竖屏/横屏、手柄/键盘/真实触控均
通过；两仓最终全量门禁明确为 0 fail、0 error、0 skip。

## 提交、范围与发布顺序

- Wander 已测试运行时代码 HEAD：`e8afcc91fe8be768b38d7fee8c405e4c35c7dd86`，基线
  `424503048f2a1c449c0c579783ae2ceae2a9512b`。本报告是其后的 report-only 提交，不改变
  已测试运行时。
- Server HEAD：`d029b2a061b2cdad33b68e60a8357f5d7ffaa13e`，基线
  `a5681ed0768672fc943d4dfc88e8ec54bba8cad2`。
- Server 的 `vendor/pocketjs-wander` 精确固定在上述 Wander 运行时代码 HEAD；`.gitmodules`
  仍为 `https://github.com/lfkdsk/pocketjs-wander.git`。
- Wander 的 `vendor/pocket-rpgkit` 保持任务开始时的
  `2a37b9aa5c6f464087cc5d97a815a38d2000acbd`，没有移动组件库指针。
- 两仓都没有修改或提交 `bun.lock`，没有 merge commit，也没有 push、部署、开 PR 或修改 GitHub。

发布顺序必须是 **先 Wander，后 Server**：先使 Server gitlink 固定的 Wander commit 可从公开仓
取得，再发布 Server。`realmFeatures.playerProfiles` 是加法式 capability；只有精确的 `true` 才
显示名片入口和接受名片消息，旧服务器缺少该字段时默认关闭，不会误开新协议。

## 1. 成就目录与既有事实来源

| 事实 | 既有权威来源 | 三档阈值 | English names | 中文名称 |
| --- | --- | ---: | --- | --- |
| 完成差事 | 各 realm 私有 `player_world.errands` 中解析出的 `helpedCount` | 1 / 5 / 25 | First Bloom / Roadside Kindness / A Road Remembered | 初绽善意 / 路边善举 / 道路铭记 |
| 看见地标 | 各 realm 私有 `player_world.discoveries` exact set | 1 / 10 / 50 | Eyes on the Horizon / Rumor Walker / No Map Needed | 眺望远方 / 传闻行者 / 无需地图 |
| 首发现地标 | `landmark_first` 的 exact-incarnation 索引行 | 1 / 5 / 20 | First Footprints / Pathfinder / Before the Map | 最初足迹 / 开路者 / 地图之前 |
| 共同目标贡献日 | `daily_goal_contribution` 的 exact-incarnation 日期行 | 1 / 7 / 30 | Shared Morning / Week of Hands / Common Season | 共同清晨 / 携手一周 / 共筑一季 |
| 到访 realm | Auth 已有、同时用于完整删除的 realm 集合 | 2 / 3 / 4 | Across the Gate / Many Horizons / World Walker | 越过门扉 / 多重天际 / 世界行者 |

所有名称和说明都保存在共享目录中；英文沿用 Wander 生成器的道路、足迹、花开与传闻语气，中文
逐项对应。共同目标的第三档明确写作 “Thirty recorded days” / “三十个有记录的共同目标日”，
因为底层只保留最近 32 天，不把它误写成终身累计。

没有加入合作送达次数、寄出/收到明信片数量等成就：当前持久数据没有可靠的终身计数，规格要求
“不新增追踪”，所以这些候选被明确排除。FIRST 查询最多扫描最高档需要的 20 行；贡献日最多 32
行；名片最多 15 个成就、16 个邮戳选项，均有确定上界。

## 2. 服务器权威、一次性提示与展示邮戳

客户端只发送两种低频 JSON 控制：`profileGet` 带可选目标账号，或 `profilePostmarkSet` 带一个
展示邮戳/空值。即使请求额外附上 `achievements:["realms-4"]`，Room 也只从 realm 私有行重新
聚合五类事实，随后调用共享目录派生 id。跨 realm 任一摘要失败会中止整张快照，避免部分事实
伪装成权威结果。

Auth 的 `/profile/commit` 在事务中合并已存 id 与本次服务器派生 id，并把差集作为
`newAchievements` 返回；并发或重放的下一次调用得到空差集且不写存储。Room 只把 unlock edge
发给本人，好友名片强制 `newAchievements=[]`，同时清空只有本人可用的邮戳候选。客户端还用
bounded session set 与 FIFO 再做一层重放去重：一次收到多个档位会依次显示，重新收到同一快照
不会再次提示。

差事或地标事实持久化后，Room 立即刷新在线本人的名片。因此合作差事完成不需要玩家手动重开
面板即可出现首次解锁提示。15 项目录和 wire parser 都是严格白名单；未知、重复、越界 id 或
朋友快照夹带 owner-only 数据会整包拒绝，而不是宽松渲染。

展示邮戳只来自当前 exact incarnation 的 `landmark_first` 坐标，再用确定性世界生成器还原名称。
Room 每次写入前重新派生候选，Auth 再校验候选数组后持久化；伪造 `Forged Castle` 会得到
`postmark` 错误。已经不再属于当前事实集的旧邮戳会在本人刷新时自动清空。

## 3. 名片隐私、删除与兼容边界

Auth 的 `/profile/view` 同时加载 owner 与 target；目标不是本人时，双方好友集合都必须包含对方。
单向 pending request 不授权名片。拒绝响应固定为 `{ok:false, reason:"forbidden"}` 加 ledger，
不会带目标名字、加入时间、成就、邮戳、realm 列表或 exact-incarnation token。成功时内部 realm
列表和 token 只交给 Room 聚合，浏览器的 `profileSnapshot` 只含展示字段。

名片读取和现有在线/位置隐私规则使用同一双向好友边，但隐藏在线状态不隐藏好友名片：名片是
显式好友可见的低频资料，不带 presence 或位置。非好友仍既看不到名片，也看不到在线状态与位置。

完整自助删除继续走既有两阶段流程：先封锁 admission，逐 realm 清理私有旅程/发现数据，再删除
Auth account 行。成就与展示邮戳都在该 profile 内，因此同一原子账号删除会移除它们；删除后好友
读取变为 `forbidden`。测试还直接序列化存储，确认成就 id 和邮戳文本均不存在，防止只隐藏 UI
却保留数据。

名片保持低频 JSON 控制，没有扩大高频二进制 roster、STATE 或 presence 协议。协议版本仍为 1，
能力缺失即隐藏入口；owner 的异步自动刷新也不会覆盖一个正在等待/显示的好友名片请求。

## 4. 社交面板、输入与响应式布局

SELECT 菜单的社交首页在 capability 开启时新增 My Card；Friends 页对双向好友提供 Card 动作。
名片渲染名字、动态图像外观、UTC `YYYY-MM-DD` 加入日期、展示邮戳和分页成就。本人按 CIRCLE
在 “无邮戳 + 服务器候选” 间循环，CROSS 返回；方向键翻页/移动。键盘、手柄和 hosted 页面触控
都落到同一个 BTN reducer，因此不会维护三套行为。

成就说明按显示宽度拆成完整行，不使用省略号。480x272 与 960x544 都采用七行面板并保留第二页；
手机竖屏在 canvas 下方放置至少 44 CSS px 的触控目标，手机横屏将面板收进左右浮动手柄之间的
安全通道。外观预览复用角色 sprite 动画时钟，不引入新的头像资源或网络字段。

README 已写明入口、权限、权威来源、一次性提示、邮戳切换、能力回退和删除语义；功能状态清单已
把玩家名片/成就标为 Done，并链接实现与测试。

## 5. 三账号合作验收

Server 的 Room 集成测试使用三个独立鉴权账号和真实 Room/RealmStore 路径：Alice 与 Bob 建立
双向好友，Observer 保持非好友。Alice/Bob 接受同一合作差事后，两人同时 READY；服务器只结算
一个 pair、将双方 `helpedCount` 从 0 增至 1，并持久化目标改造。

随后机器断言得到：

- Alice 和 Bob 的自动 owner snapshot 都首次包含 `newAchievements:["errands-1"]`；
- Alice 再次读取自己的名片得到 `newAchievements:[]`；
- 好友 Bob 读取 Alice，看到 `name:"Alice"` 与 `achievements:["errands-1"]`，但没有 owner-only edge；
- 非好友 Observer 的同一读取只得到 `{type:"profileError", reason:"forbidden"}`。

因此规定的 “A 完成一次合作差事触发成就、好友 B 看见、非好友 C 看不见” 在同一权威结算流程中
完成，没有用手工注入的客户端卡片替代。

## 6. Cloudflare 扫描行预算与停机线

预算模型按 Durable Object SQLite **扫描行** 计费，而不是按最终 15 个成就或 16 个邮戳的返回行
计费。常见月度点为 31 天、100 DAU、每账号每天 1 次本人名片和 1 次好友名片、每账号每月 5 次
成就刷新/5 次首次写入、全服务 100 次邮戳更换、平均到访 2 个 realm、每 realm 平均扫描 5 条
FIRST 与 4 条贡献日。

| 月度增量 | 常见负载 |
| --- | ---: |
| request units | 17,715 |
| short-wake GB-s | 22.272 |
| storage row reads | 149,700 |
| storage row writes | 600 |
| Workers Paid 包含池内增量 | **$0** |
| 全部用量按 overage 单价的等价值 | **$0.00368535/月** |
| hard stop | **false** |

模型包含客户端 control 折算、Room/Auth/远端 Realm 的 internal request、每次短 wake、owner 与好友
授权行、`player_world` point lookup、FIRST/贡献日实际扫描、首次 unlock 写入和邮戳写入。每个维度
分别与 Cloudflare included pool 比较；requests、GB-s、row reads 或 row writes 任一超出即
`hardStop=true`。常见点全部在额度内，因此本次满足 $0 增量约束；部署参数若产生任一 overage，
必须停止发布并重新评估。

## 7. 变异辨识力

四次变异都在独立 disposable worktree 中执行，交付 worktree 从未被变异。每项先有对应正向绿灯，
应用一个单点故障后得到行为红灯，再删除副本：

| 单点故障 | 实际红灯 |
| --- | --- |
| 删除 `/profile/view` 的双向好友检查，让非好友读取 | Auth 隐私测试原本期望 `forbidden`，实际收到 Alice 的完整 card 与内部 target capability；`0 pass / 1 fail` |
| 把客户端请求中的 `achievements:["realms-4"]` 提交为已获得 | Room 权威测试在 Alice card 中看见伪造的 `realms-4`，违反“请求与 Auth call 都不含该 id”；`0 pass / 1 fail` |
| 完整删除时保留 account/profile 行 | 删除测试的存储快照仍包含 `errands-1` 与 `Old Well`；`0 pass / 1 fail` |
| 移除客户端 `announcedAchievements` 去重 guard | 重放相同 owner snapshot 后 notice 从预期空串变成 `ACHIEVEMENT · First Bloom`；整个 mounted 文件 `2 pass / 1 fail` |

四次失败分别由规格要求的非好友泄漏、客户端伪造、删除残留和重复提示断言触发，不是编译失败、
依赖缺失或无关测试红灯。

## 8. 双语桌面与手机画面验收

桌面/PSP 逻辑视口报告 `profile-report.json` 为 `PASS`：EN/ZH × 480x272/960x544 × 两页，
共 8 个语义场景，每个保留 native 与 nearest-neighbour 3× 图，共 16 PNG。断言逐行检查包括换行后
的完整英文/中文说明，并要求 selected-row 语义像素非零；因此测试不会把“文本节点存在但画面截断”
误判为成功。

真实 Chrome 手机报告为 `PASS`，`failures=[]`、`consoleErrors=[]`：

- 英文 `390x844@3` portrait 通过真实触控从 Friends 打开 Mia 的好友名片，请求精确为
  `{type:"profileGet", githubId:72, v:1}`；panel/title/selected 像素分别为
  163,099 / 4,706 / 37,526，社交面板与触控控件 overlap 为空。
- 中文 `844x390@3` landscape 走同一请求和沉浸式触控布局；panel/title/selected 像素分别为
  128,155 / 3,874 / 28,345，左右浮动手柄与名片面板 overlap 为空。

我打开并肉眼核对了英文 480x272 第二页 3×、中文 960x544 第一页 3×、英文手机竖屏和中文手机
横屏关键帧。名字、头像、日期、邮戳、成就名、档位与完整说明均可辨；分页没有丢字，面板没有越界，
触控层没有挡住卡片内容，也没有 replacement glyph。

## 9. 最终门禁

| 仓库/检查 | 最终结果 |
| --- | --- |
| Wander `bun run tsc` | exit 0 |
| Wander `bun test tests/` + JUnit 节点审计 | **523 pass / 0 fail / 0 error / 0 skip / 45 files / 501,127 assertions** |
| Wander `bun run web` | exit 0；Wander 与 Wander Online 两个 web game 构建成功 |
| Server `bun run tsc` | exit 0 |
| Server `bun test tests/*.test.ts` + JUnit 节点审计 | **351 pass / 0 fail / 0 error / 0 skip / 16 files / 3,677 assertions** |
| 三账号合作解锁/好友读取/非好友拒绝 | **PASS**；完整 Server suite 内执行 |
| 桌面双语两档截图 | **PASS**；8 scenes / 16 PNG / native + 3× |
| 真实 Chrome 手机双朝向 | **PASS**；0 failure / 0 console error / 0 overlap |
| 四项隔离变异 | 全部按预期红灯 |

JUnit 分别对 523 与 351 个 `<testcase>` 计数，并单独确认 `<failure>`、`<error>`、`<skipped>`
节点均为 0；报告中的 0 skip 不是从 console 没出现 skip 字样推断。最终检查还确认两仓工作树在
报告前干净、两个 `bun.lock` 无差异、Server gitlink 与公开 URL 正确、组件库指针未移动。

## 10. 已知边界

- 共同目标档位是最近 32 天保留窗口内的 distinct recorded days，不承诺终身累计；文案已明确。
- FIRST 聚合为最高目录档位只扫描 20 行，展示邮戳最多取其中 16 个唯一名称；这是有意的固定成本边界。
- 已取得的 id 以历史 unlock union 保存，因此将来某个旧事实离开保留窗口不会撤销已经解锁的成就。
- 隐藏 presence 的双向好友仍可看名片，但卡片不包含 presence、realm 或位置；非好友两者都不可见。
- 本批没有为合作次数或明信片收发量增加新计数；等服务器将来有独立、可删除、可计费的终身事实后，
  才适合另加目录项。

subagent 使用：3 / `server_facts` 只读核对既有事实、服务器权威与删除边界，`test_infra` 核对门禁、
变异和截图 harness，`wander_ui` 核对客户端协议、面板布局与输入路径 / 三块审查并行完成，节省了
交叉核对时间；主 agent 完成实现集成、所有重门禁、隔离变异、肉眼验图、报告、提交与最终判定。

PASS
