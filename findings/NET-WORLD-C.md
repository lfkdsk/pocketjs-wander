# NET-WORLD-C：单机玩法接入联机权威（修复 2 后交付）

## 结论

修复 1 复审判定的阻断项与两项非阻断缺口都已处理，旅程容量、双 session CAS、CJK 字体与服务器校验保持不变：

1. **创建角色的名字输入与共享校验一致**：网格字符集由共享常量 `NAME_ASCII_CHARSET`
   生成，与 `validateName` 的 ASCII 部分逐字相等（66 个格子：字母、数字、空格、`_`、`.`、`-`，
   不再有 `'`、`!`、`?`）；网页版在创建角色时由页面层提供可用输入法的文本框，与 Sign out 按钮走
   同一对钩子（`__pocketAuthEvent` / `__pocketAuthCommand`）；网格与文本框两条路径提交前都先过
   共享 `validateName`，不合法时不发请求，原因以中英文显示在创建界面页脚和页面文本框旁。
   真实 Chrome 演示里网页客户端用文本框输入中文名「演示网页」创建成功，HUD 名字行逐格判定为真字形。
2. **顺带发现并修复的回归**：创建完成后进入世界，地图区域全黑（页面上一轮看不出来，因为演示账号
   都是预先建好档案的）。原因是世界渲染根节点挂在 `Show when={screen() === "world"}` 下，创建界面
   把它卸载后宿主节点被回收，再挂回去的是死节点。现在该节点全程挂载，非世界画面把它折叠成 0×0。
3. **完整演示的超时**：本轮在重启阶段复现出两个超时并都定位修复——桌面客户端 60 s 生命周期在加入创建
   阶段后撑不到服务器重启完成（改 90 s）；以及我新加的名字断言读到的是按消息重建的 roster（欢迎之后的
   ROSTER 只带新加入者，浏览器不是最后一个重连时就看不到自己），现在发布整张表。上一轮 1/5 的 hard cutoff
   超时没有留下诊断，本轮 11 次运行未再出现；为它补了页面存活诊断，并修掉了服务器侧唯一能造成「永远
   joined」的机制（Meter 上报无超时会卡死上报链与 tick）。最终版本连续 5 次完整演示全过，见下表。
4. **测试缺口**：FIFO 降级方向（先丢最旧 talked、再丢最旧 helped）有可杀测试；帧缓冲中的方框
   （缺字形的替代矩形）有判别规则与正反两向测试，名字牌也做了语义像素检查。

## 交付版本

| 仓库 | 复审基线 | 本次 HEAD |
| --- | --- | --- |
| PocketJS Wander | `221fa55`（报告 `29f68af`） | 实现 `1658dd8`（本报告为其后续提交） |
| Pocket Online Server | `b34b648` | `92e552b`（子模块 `vendor/pocketjs-wander` 指向 `1658dd8`，其内嵌 `vendor/pocket-rpgkit` 指向 `395edafa`） |
| Pocket RPG Kit（页面层） | `baae0620`（Wander 原子模块指针） | `395edafa`，分支待 commander 合并后再推；Wander 子模块指针已指向它 |

组件仓的改动只有网页播放器页面（`tools/web/player.js`、`tools/web/i18n.ts`、`tools/web/site.css`）、
一份页面测试与状态清单一行，不涉及引擎。

## 修复 1：创建角色的名字输入

### 一份常量生成网格与校验

`examples/wander-online/shared/name-charset.ts` 新增 `NAME_ASCII_CHARSET`（= 字母 + 数字 + `" _.-"`），
`nameCodePointAllowed` 的 ASCII 分支改为查这份常量的集合，`nameGridCharset()` 把同一常量展开成网格格子。
`OnlineView.tsx` 的 `makeNameState` 把它作为 `charset` 传给组件仓的 `nameInputRules.start`，
`maxLength` 用共享的 `NAME_MAX`（12）。66 格 + BACK/OK/CANCEL 在 10 列上占 7 行，仍在场景的 8 行面板内；
空格格子显示为 `SP`。

### 网页文本框（页面层）

组件仓 `tools/web/player.js` 的 `initAuthUI` 里，在 Sign out 旁加了隐藏的 `#auth-name-box`
（label、`#auth-name` 输入框、`#auth-name-submit` 按钮、`#auth-name-error`），协议：

- 游戏 → 页面：`__pocketAuthEvent({ type: "nameInput", title, maxLength, value, error })` 打开（首次
  用 `value` 预填，之后的事件不覆盖玩家正在输入的内容；`error` 非空时显示在框旁）；
  `{ type: "nameInputEnd" }` 与 `{ type: "logout" }` 关闭并清空。
- 页面 → 游戏：Enter 或点击 Create 调 `__pocketAuthCommand("name", text)`（去首尾空白；空内容不提交；
  输入法合成中的 Enter 忽略）。原有的 `("signout")` 不变。
- 按键隔离：游戏的键盘监听挂在 `#stage` 上而不是 document，页面只在加载与明确点击时把焦点交给游戏，
  文本框自身也 stopPropagation；组件仓测试 `tests/web-name-input.test.ts`（9 例，真实 Chrome + CDP）
  覆盖显示/隐藏、真实 `Input.insertText` 中文输入与 Enter 提交、合成中不提交、错误显示与清除、
  按键不外泄、语言切换。标签与占位文案走页面 i18n（en/zh）。

游戏侧（`OnlineView.tsx`）：进入创建界面发 `nameInput`，创建成功、roster 到达或退出登录时发
`nameInputEnd`；收到 `("name", text)` 把文本原样放进网格缓冲区并走与网格 OK 相同的提交路径
（`submitPageName` → `submitCreate`），超长不截断而是按 `name-too-long` 拒绝。

### 提交前校验与中英文提示

`submitCreate` 先调共享 `validateName`，被拒时 `rejectCreate` 释放提交锁、重置场景（缓冲区与 look 保留）、
在页脚显示原因并把同一文案发给页面文本框；服务器的 `createError` 也走同一恢复路径。文案在
`examples/wander-online/create-text.ts`：英文一行、中文一行（中文由十六进制码点拼出，不写汉字字面量，
因为构建会把模块里所有字符串字面量扫进每个字槽的图集；测试断言每个中文码点都在名字字体集合里）。

### 测试与变异

- `tests/wander-online-name-input.test.ts`（5 例）：网格 ≡ 校验允许的 ASCII（逐字相等、无重复、`'!?`
  不在网格、`" _.-"` 在网格）；网格、校验与常量同源；引擎保留全部 66 格、7 行、`maxLength` 12；
  只用网格字符拼出的名字除黑名单外永不被字符集拒绝；每个拒绝原因都有中英文且中文可渲染。
  变异（在工作树里改 `nameGridCharset`，用完 `git checkout` 还原）：
  - 网格加 `!` → 3 例失败（`toEqual` / `toBe` / 格数）；
  - 网格去 `_` → 3 例失败。
- `tests/wander-online-auth-sim.test.ts`（16 例，新增 6 例）：网格能输入空格、`_` 与数字并创建
  `octo _1`；黑名单名在客户端被拒（中英文文案、不发 CREATE），BACK 删掉后改名创建成功；页面文本框
  输入「演示网页」→ CREATE 名字为该中文、look 为所选、HUD/roster 显示该名、`nameInputEnd` 只发一次；
  `bad!name`、片假名、`admin`、13 个汉字、纯空白各自被客户端按正确原因拒绝且不发 CREATE，再输入合法名
  创建成功；创建界面之外的页面命令被忽略；**创建后世界像素与直接进入世界完全相同**（回归测试，
  变异：把渲染根放回 `Show` 下即全黑）。
- 服务器侧校验照旧：`tests/auth-do.test.ts`、`tests/room-do.test.ts` 的字符集/黑名单拒绝用例未动，仍通过。

### 真实 Chrome 证据

`examples/wander-online/web-check.ts` 新增 `--create-name/--create-look/--expect-name`：票据无档案时等创建界面，
确认页面文本框已显示，把焦点交给 `#stage` 后用真实按键（`KeyE` 切到 look 面板、`ArrowRight`×10）选 look 40，
再把焦点交给 `#auth-name`，用 CDP `Input.insertText` 输入中文（输入法提交的同一路径），点击 Create，
等创建界面退出且文本框隐藏，再把焦点交回游戏。加入后要求 roster 里本人名字等于所输入；截图后按
canvas 的实际位置与缩放（`getBoundingClientRect` × devicePixelRatio，480 版为 1.5 设备像素/逻辑像素）
逐格判定 HUD 名字行。演示第 2 次运行的输出：

```text
WEBCHECK_NAME {"name":"演示网页","myId":3,"canvas":{"x":337.5,"y":301.5,"scale":1.5},"cells":["演:glyph:46/6","示:glyph:28/9","网:glyph:55/3","页:glyph:31/6"]}
WEBCHECK {... "name":"演示网页","look":40,"created":true,"consoleErrors":0,"restarted":{"droppedStatus":"reconnecting", ...}}
```

480×272 与 960×544 的网页截图已肉眼核对：页面顶栏「Signed in as 演示网页」，HUD 第二行「演示网页 · ROOM 3 · ALL 3」，
本人名字牌「演示网页」，旁边「DemoOne」名字牌，地图正常绘制。

### 顺带修复：创建后世界全黑

第一次演示（截图检查失败）暴露出创建后地图区域全黑、只有 HUD 的问题；用 sim 宿主复现：直接 `welcome4`
进入世界，地图区非黑像素 62400；`needCreate` → 创建 → `welcome4` 则为 0。原因：`fieldRoot` 是命令式节点
（RenderRing 往里画），之前放在 `<Show when={screen() === "world"}>` 内；创建界面出现时 Solid 卸载它，
框架的 `removeNode` 把节点加入 `sweepSet`，几帧后宿主节点被回收；创建完成再 `insertNode` 的是已回收的节点。
修复：该容器全程挂载，非世界画面时宽高置 0（`OnlineView.tsx` 渲染树开头的注释说明了原因）。
回归测试见上（创建后像素计数 = 直接进入的 62400）。

## 修复 2：完整演示的超时

### 上一轮失败的分析

上一轮失败日志（第 2 次）的现象：预算 trip 与两次拒绝探针都通过后，legacy v3 浏览器在 30 s 内一直报告
`status:"joined"`、`x:39,y:41,moving:true`，当时的 wrangler 与 Chrome 诊断目录已不存在。能确定的事实：

- Meter 的月账本单调递增，trip 之后每次 `/report` 的 ack 都带 `hard.over = true`，Room 收到后必然
  `enterHardCutoff` → 关闭全部 socket（1008 `rest`），legacy 客户端对 `rest` 的策略是慢速重连并显示 `retrying`。
- 浏览器端 `__onlineState` 由游戏每帧写入，页面的 socket 事件也只在帧里处理；一个页面循环停了的页面
  （`__pocketPlayer.state === "error"`、`document.hidden` 暂停、或 rAF 被节流）会永远报告最后一帧的
  `joined`，而 CDP 读到的正是这个陈旧值。
- 服务器侧只有一条路能让 Room 永远学不到 cutoff：`/report` 的 DO-to-DO fetch 没有超时，上报是串行链，
  `stepOnce` 还 await 周期上报——一次挂起的上报会让后续上报全部排队、tick 循环停摆。

两种机制本轮都做了处理：

- `scripts/demo-budget.ts wait-browser` 每次轮询读取页面播放器的 `state`/`frames`/`document.hidden`/
  overlay 文案；页面循环报错时立即失败并带上页面错误，超时时把等待期间的帧数一起打印。再出现一次就能
  直接分辨是页面陈旧还是服务器没关。
- Room 的 `/report` 与 `/online` fetch 加 `AbortSignal.timeout(METER_TIMEOUT_MS)`（默认 5000，`config.ts`）。
  新测试 `a report the Meter never answers is abandoned at the deadline, kept as debt, and the next report still
  learns the cutoff`：永不应答的 Meter 下 `reportUsage` 在 100 ms 期限内拒绝（去掉 signal 则 2 s 竞速超时），
  欠账存入 `usage-debt`，Meter 恢复并越过硬阈值后下一次上报带走欠账（`awakeSeconds: 2`）、
  `hardCutoffActive()` 为真、在线 socket 收到 1008 `rest`。

### 本轮复现并定位的两个超时

把网页客户端改为在演示里自己创建角色后，完整演示在重启阶段频繁超时（第 3、5、6、7、9、10、11 次），现象都是
浏览器在新 epoch 重连后 `online:1, allOnline:1, remote:[]`，直到超时。两个原因，分别有日志证据：

1. **桌面客户端的生命周期**（第 3 次）：两个桌面客户端的最后一行 `ONLINE` 与截图都在 04:24:58 / 04:25:00 写出
   （`--quit-after` 到期），而 wrangler 第二次启动的日志从 04:24:58 才开始：创建角色阶段（等创建界面、按键选
   look、输入、创建、重连）发生在桌面启动之后、重启之前，把重启推后约 10 s，60 s 的窗口不够。修复：`SECONDS_RUN`
   60 → 90（脚本注释写明窗口内要容纳的阶段）。
2. **我自己的名字断言读到的是增量 roster**（第 5–11 次）：加了 `WEBCHECK_TRACE` 的第 11 次给出完整时间线——重启后
   6 s 浏览器已 `joined, online=3, all=3, remotes=2`，并保持 80 s；服务器侧（临时 `console.log`，未提交）同期每 100 帧
   都向三个 socket 发快照，`players=3`。超时的是 `--expect-name` 的条件 `roster[myId].name === 名字`：
   `__onlineState.roster` 原来由每条 ROSTER 消息重建，而欢迎之后的 ROSTER 只带新加入的玩家，所以浏览器不是最后
   一个重连时，发布的 roster 里只有后来者（`roster=["3"]`），没有它自己。80 s 后桌面客户端到期退出，状态才变成
   `online:1`。修复在客户端：发布的 roster 改为镜像本 epoch 已知的整张表（`OnlineView.tsx` `onRoster`），
   退出登录时一并清空；`tests/wander-online-auth-sim.test.ts` 在创建后注入一条只含新玩家的 ROSTER，断言自己的
   条目仍在。名字牌一直用的是整张表，所以画面从未受影响；这只是诊断数据与我的新断言之间的不一致。

上一轮报告的 1/5（hard cutoff 阶段 legacy v3 浏览器不变 `retrying`）在本轮 11 次运行里没有再出现；为它加的
页面存活诊断与 Meter 上报超时见上一节。

### 连续运行

全部在本机、同一命令 `bash scripts/demo-cf.sh`（`WANDER_DIR` 指向本分支工作树、预编译的无头桌面宿主、
预先准备的 legacy kit 检出），诊断目录保留：

| 次 | 版本 | 结果 | 网页创建 | 共享花（960 桌面） | cutoff |
| --- | --- | --- | --- | --- | --- |
| 1 | 名字检查未按 canvas 位置采样 | FAIL（截图检查） | 创建成功，HUD 名字行采样位置错 | — | — |
| 2 | 采样修正 | PASS | 4/4 字形，look 40 | 4/4 | 两端 retrying |
| 3 | 同上 | FAIL（重启阶段） | 4/4 | — | — |
| 4 | `SECONDS_RUN` 90 | PASS | 4/4 | 4/4 | 两端 retrying |
| 5–7 | 同上 | FAIL（重启阶段：名字断言读增量 roster） | 4/4 | — | — |
| 9–11 | 服务器临时诊断、`WEBCHECK_TRACE` | FAIL（同上，拿到时间线） | 4/4 | — | — |
| **12** | 发布整张 roster | **PASS** | 4/4 字形，look 40 | 4/4 | 两端 retrying |
| **13** | 同上 | **PASS** | 4/4 | 4/4 | 两端 retrying |
| **14** | 同上 | **PASS** | 4/4 | 4/4 | 两端 retrying |
| **15** | 同上 | **PASS** | 4/4 | 4/4 | 两端 retrying |
| **16** | 同上 | **PASS** | 4/4 | 4/4 | 两端 retrying |

最终版本连续 5 次（12–16）全部通过，每次都包含：网页客户端经页面文本框创建中文名「演示网页」并选 look 40、三端
加入、服务器重启后三端重连、共享花 4/4 落在推导位置、legacy v3 与 v4 并存 `ALL=2`、硬阈值后两个浏览器都变
`retrying`。第 8 次（运行于 roster 修复前、`SECONDS_RUN` 90 后）也通过；8 之前与 12 之后的版本差异只有发布 roster
的方式与 web-check 的可选 trace。

## 测试缺口

### FIFO 降级方向

`tests/wander-online-journey.test.ts`：原用例补充「接近满界」与「0.6 界」两档下，保留的 talked 恰为原列表尾部
（`full.talked.slice(dropped)`）、保留的 helped 恰为原 helped 尾部、errand/Bloom/计数不变；新增用例把界压到
talked 全空、helped 被裁到 `0 < n < HELP_CAP`，断言 `dropped === TALK_CAP + (HELP_CAP - kept)`、尾部一致、
往返一致、Bloom 仍记得每个被裁的镇。变异（把 `fitJourney` 的 `slice(1)` 改成 `slice(0, -1)`，隔离副本中执行后还原）：
只改 talked → 1 例失败（`kept talked towns are the newest tail`）；只改 helped → 2 例失败；两者都改 → 2 例失败。
该文件 23 例通过。

### 方框（tofu）识别

缺字形时引擎 `text.rs` 的 cmap 未命中落到 gid 0，advance 仍是整格 12 px（所以宽度检查抓不到）；
`bake-font.ts` 把 gid 0 画成 1 px 空心矩形，7 宽 × 8 高，贴格子左边、底边在基线上一行（格内列 0..6、行 4..11），
格内再无其它墨迹。上一轮 `interiorInk` 的「内部 6×7 盒」正好压在矩形的上边和右边上（≈9 个亮像素 ≥ 3），
所以方框也能过。

新规则（`tests/wander-online-journey-view.test.ts` 的 `cellLooksLikeTofu` / `cellIsGlyph`）：格内墨迹包围盒恰为 7×8、
周长全是墨、内部为空 → 方框；墨迹 ≥ 8 且不是方框 → 字形。HUD 名字行与 FIRST 后缀改用它；名字牌用「相对空名帧
的覆盖差异」作为墨迹谓词（同一次启动里把 roster 名换成空格得到空名帧，并断言名字牌行带在标签框之外逐像素相同），
在开阔地（400,80）检查。新增正向对照用例：片假名名字（不在字体内）在名字行、FIRST 后缀、名字牌三处都被判为方框、
不是字形，而中文名三处都是字形；两档分辨率各一遍。证据（ASCII 画）在报告外的草稿目录，摘录：

```text
tofu name, HUD name line           real CJK name, HUD name line
............ ............           ............ ..########..
#######..... #######.....           ............ ............
#.....#..... #.....#.....           .##########. ............
#.....#..... #.....#.....           ............ ............
#######..... #######.....           ............ .##########.
```

浏览器检查用同一形状规则的独立实现 `examples/wander-online/glyph-check.ts`（按逻辑像素中心采样，支持非整数缩放），
`tests/wander-online-glyph-check.test.ts` 用合成缓冲在 1×、3×、1.5×、2.25× 下验证：7×8 空心环 → `box`、
笔画 → `glyph`、空 → `blank`、环内有墨 → `glyph`、环缺两像素仍 → `box`。

## 文档

- Wander `examples/wander-online/README.md`「Names and the name font」新增创建流程一段（网格来源、页面文本框协议、
  客户端先校验、演示如何创建并检查）；`docs/status.md` accounts 条目改为现在的事实（客户端同一 `validateName`、
  网格同源、网页文本框）。
- 服务器 `README.md` 环境变量表加 `METER_TIMEOUT_MS`；`docs/status.md` 的 Admission limits 与 Budget cutoff demo 条目
  按现状更新。
- 组件仓 `docs/status.md` 加「Player page sign-in chrome」一行；`tools/web.ts` 的 `auth` 注释提到名字框。

## 门禁

| 仓库 | 命令 | 结果 |
| --- | --- | --- |
| Wander `1658dd8` | `bunx tsc --noEmit` | exit 0 |
| Wander `1658dd8` | `bun run test --reporter=dot` | **390 pass / 0 fail**，499253 assertions，31 files（含 `dist` 构建后的 sim 用例） |
| Server `92e552b` | `bun run typecheck` | exit 0 |
| Server `92e552b` | `bun run test --reporter=dot` | **196 pass / 0 fail**，9 files |
| RPG Kit `395edafa` | `bunx tsc --noEmit` | exit 0 |
| RPG Kit `395edafa` | `bun test tests/web-name-input.test.ts tests/web-oauth-state.test.ts` | **19 pass / 0 fail** |
| RPG Kit `395edafa` | `bun test`（全量，未先构建示例） | 3629 pass / 2 fail：`built paks carry the font license`（找到 0 个 pak）与 `rpgmaker-import … not part of any game bundle`（`dist/sunstone.js` 不存在），两者都要求先 `bun run build` 产出示例包，与页面改动无关 |
| 三端完整演示 | `bash scripts/demo-cf.sh` × 5（第 12–16 次） | **5/5 PASS** |

`bun.lock` 在三个仓库都未改动。

## subagent 使用

2 个：一个在组件仓工作树实现页面文本框、样式、i18n、页面测试与状态清单（约 5 分钟，主 agent 复跑其 19 例页面测试并
逐行看了 diff）；一个补 FIFO 方向测试与 tofu 判别（含引擎与烘焙器的查证、ASCII 画证据、隔离变异，约 17 分钟）。
两者与主 agent 的客户端/演示/服务器工作并行，省下的大约是它们各自的工时；子代理结论都由主 agent 复跑后写入本报告。

一处操作失误须记录：清理演示残留进程时，误杀了另一任务工作树（web-demo profile）的一个无头 Chrome 进程；
本任务的端口与目录未受影响，但该任务若当时正在跑浏览器测试可能受到干扰。

PASS
