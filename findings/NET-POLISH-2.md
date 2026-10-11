# NET-POLISH-2：联机收尾第二轮

## 结论

四项收尾均完成：客户端不再发出浏览器禁止的 `1008`，本地名字牌在亮色地形上有四向深色描边，远方玩家提示使用独立的确定性时钟，手机网页在 390×844 与 844×390 两种 DPR 3 视口中可以只靠触摸完成起名、表情、邀请和退出登录。Wander、Pocket RPG Kit 与服务器门禁全部通过，三轮桌面 + 桌面 + Chrome 完整演示也全部通过。

本报告记录的发布代码头为：

- Pocket RPG Kit：`1147cf56976c4f938360d96e10e05da7b4ecf882`
- PocketJS Wander：`06484b16cbde1e14ef6399294241f30e734ad792`
- Pocket Online Server：`7046887bfe64cc6e50febbcc6ad21cef6f2c2c28`

服务器提交已经把 `vendor/pocketjs-wander` 固定到上述 Wander 代码头；`.gitmodules` 仍是公开的 GitHub URL。报告提交本身只增加这份 findings 文件，不改变服务器需要固定的运行时代码。

## 1. 合规的升级关闭

### 规范结论

- [RFC 6455 §7.4.1](https://www.rfc-editor.org/rfc/rfc6455#section-7.4.1) 把 `1008` 定义为端点报告策略违规的标准状态码；服务端用它拒绝不兼容客户端是合适的。
- [RFC 6455 §7.4.2](https://www.rfc-editor.org/rfc/rfc6455#section-7.4.2) 保留 `4000..4999` 给应用双方私用。
- [WHATWG WebSocket `close()`](https://websockets.spec.whatwg.org/#dom-websocket-close) 只允许浏览器脚本主动提供 `1000` 或 `3000..4999`；其他值会抛 `InvalidAccessError`，reason 的 UTF-8 长度上限是 123 bytes。因此客户端主动发 `1008` 不合规，而 `4000/upgrade-required` 合规；reason 是 16 个 ASCII bytes。
- Cloudflare Durable Objects 在兼容日期不早于 `2026-04-07` 时会自动回复收到的 Close 帧并完成关闭握手，见 [Durable Object WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)。服务器的 `compatibility_date` 是 `2026-10-01`；Room 清理不依赖对端 close code，所以接收客户端私有码无需新增服务器分支。

### 修复与兼容性

不兼容或残缺的 `WELCOME4` 现在由客户端主动关闭为 `4000/upgrade-required`，并立即停在 `WORLD UPDATE REQUIRED`，不再重连。关闭回声的 `4000/upgrade-required` 也保持该状态。服务器主动拒绝旧协议仍然是 `1008/upgrade-required`，没有改成私有码。

| 组合 | 玩家看到的结果 |
| --- | --- |
| 旧客户端 → 新服务器 | 服务器仍发 `1008/upgrade-required`；旧客户端继续显示 `WORLD UPDATE REQUIRED`，不重连。 |
| 新客户端 → 旧服务器 | 客户端发浏览器允许的 `4000/upgrade-required`；旧 Bun/Worker 清理路径不读取该码。关闭回声后新客户端仍显示升级提示，不重连。 |
| 新客户端 → 新服务器 | 同上，并由当前 Cloudflare 兼容日期自动完成关闭握手。 |

测试用 socket harness 现在执行与生产相同的主动关闭码校验，残缺 `WELCOME4` 必须精确产生 `4000/upgrade-required`；测试同时固定零重连、明确 HUD 文案和服务端 `1008` 兼容。聚焦测试结果为 `14 pass, 0 fail`。隔离副本中把实现变异回客户端 `1008` 后，同一用例变为 `0 pass, 1 fail`，精确报 `RangeError: invalid client WebSocket close code 1008`，因此该回归能识别原缺陷。

## 2. 雪地可读的本地名字牌

本地白色名字下面现在有四份 `#0b1626` 文本，分别偏移左、右、上、下一个逻辑像素。五个文本节点放在同一个 `NAME_LABEL_W × 12` 容器中：每帧只移动容器，名字变化时才改五份文本。远端黄色名字牌没有改变，也没有增加遮住地图的大底板。

帧缓冲测试在固定 seed 的草地、沙地、雪地和水边四个位置分别拍一帧空名字背景与一帧 `Octo`，然后要求每个方向都存在“白色前景相邻的新增深色像素”。删掉任意方向或把描边改白都会失去对应的方向像素，测试不是只检查文本节点存在。

两档要求的雪地 3× 截图已肉眼检查：白字与汉字边缘都能从雪地分离，描边没有形成实心底衬或盖住角色。

| 截图 | 像素尺寸 | Fleet artifact |
| --- | ---: | ---: |
| `snow-nameplate.480x272-3x.png` | 1440×816 | `48170` |
| `snow-nameplate.960x544-3x.png` | 2880×1632 | `48171` |

## 3. FAR 与快照频率解耦

旧实现只在快照帧进入发送循环，再在循环内判断 FAR；实际周期是 `lcm(frameMod, farMod) / tickHz`。部署的 20 Hz tick / 10 Hz snapshot 恰好没有暴露它，但 20 Hz / 6 Hz snapshot 会把本应在 frame 20、40 发出的 FAR 推迟到 frame 60。

本地 Bun 服务器和 hosted Room 现在分别计算 `snapshotDue` 与 `farDue`，任意一个到期就进入分发；快照内容只在 `snapshotDue` 路径发送，FAR 只在 `farDue` 路径发送。二者同帧时仍严格先 `STATE4`、后 `FAR_PLAYERS`，没有远方玩家时仍不发空帧。

两仓回归都使用故意不整除的 20 Hz / 6 Hz：frame 18 的 `STATE4` 先证明玩家已经离开 AOI，frame 20、40 必须收到 FAR，frame 19、39 不能早发，frame 60 必须先观察到 `STATE4` 再观察到 FAR。隔离副本中把 Wander 外层条件变异回仅快照到期时分发后，聚焦用例变为 `0 pass, 1 fail`，在 frame 20 精确得到 `far20 = null`；旧嵌套因此不能漏过回归。

### 带宽与成本

一份含 `n` 个远方玩家的应用负载为 `2 + 6n` bytes，每个客户端每秒至多一份；`n = 0` 时不发送。32 人房间中每人最多看到 31 个远方玩家：

| 场景 | 应用负载 |
| --- | ---: |
| 单客户端、31 个远方玩家 | `2 + 6×31 = 188 B/s` |
| 一间 32 人满房 | `32×188 = 6,016 B/s` |
| 四间满房、128 客户端 | `24,064 B/s` |
| 四间满房、31 天 | `64,453,017,600 B = 64.453 GB` |

188-byte 服务端帧需要至少 4-byte 无 mask WebSocket header，因此传输层最低界是 `192 B/client/s`、四间满房 `65.824 GB/month`，尚未计算 TCP/TLS/IP 开销。部署参数原本就是 20/10，旧实现已经每秒发送一次，所以本次修复的部署增量是 `0 B/client/s`、`0 B/month`。出站 WebSocket 消息不计为 Durable Object request，本次也不增加入站消息、upgrade 或房间占用时长，因此增量 Cloudflare 成本为 `$0/month`。

## 4. 手机触屏

Wander 的网页清单现在声明 DPAD、CIRCLE、CROSS、TRIANGLE、SQUARE、L/R、SELECT 与 START，触摸用户可以到达 RTRIGGER 表情栏和 SELECT → LTRIGGER 邀请流程。Pocket RPG Kit 的通用网页播放器同时完成：

- 页面起名、Create、Sign out、邀请输入、Copy、Close 与全屏工具的触摸高度至少 44 CSS px；
- 页面要显示起名框或邀请框时先退出 immersive，避免面板在游戏后面出现；
- 844×390 landscape 的 d-pad 与紧凑三列 action cluster 垂直居中在画面左右边缘，避开 status、LOG、ERRAND、help 四个 HUD 区域，也留出中间 50% 主要游戏画面；
- pad 隐藏切换的可见状态与 immersive 退出路径已修正。

专用验证器启动真实 Chrome，用 CDP 设置 `mobile:true`、DPR 3 与 touch emulation，并以 `Input.dispatchTouchEvent` 触发每次操作；没有用鼠标 click 代替触摸。它在 `390×844@3` 与 `844×390@3` 中都完成：触摸聚焦名字输入、真实文本插入、Create 入服、打开/关闭表情栏、SELECT → LTRIGGER 生成邀请、Copy 校验剪贴板、Close 收起面板、Sign out 回到登录门。

结果为 `PASS`：`failures=[]`、`consoleErrors=[]`，所有页面目标至少 44 px，关键 HUD overlap 数为 0，中央游戏区 overlap 数为 0。八张原分辨率截图（每个视口各有 name、emote、invite、signed-out）均已肉眼检查，报告和截图为 Fleet artifacts `48178..48186`。

Pocket RPG Kit 的真实 Chrome 起名/邀请 immersive 退出回归以及相关静态套件结果为 `78 pass, 0 fail, 832 expect()`；组件 TypeScript 检查 exit 0。

## 门禁、演示与画面核对

所有重命令串行运行。

| 检查 | 结果 |
| --- | --- |
| Wander `bun run build` | exit 0 |
| Wander `bunx tsc --noEmit` | exit 0 |
| Wander `bun run test` | 424 pass，0 fail，499731 `expect()`，33 files |
| Pocket RPG Kit 聚焦 Chrome/静态套件 | 78 pass，0 fail，832 `expect()` |
| Pocket RPG Kit `bunx tsc --noEmit` | exit 0 |
| Server `bun run typecheck` | exit 0 |
| Server `bun run test` | 218 pass，0 fail，1706 `expect()`，9 files |

三轮独立的桌面 + 桌面 + Chrome 演示全部达到 `online=3`、`allOnline=3`、两个 remotes、实际移动，且浏览器 console error 为 0。演示脚本现在显式传入 `--auto-walk`；在线自动行走仍是产品中的 opt-in，不依赖旧默认值。

附加压力路径也通过：150 ms 模拟单程延迟时实测约 317 ms RTT、0 corrections；强制服务器重启后网页和桌面都重新加入，网页 epoch 改变并看到 `online=2`；100 bots 时 `seenAvg=88.5`、`seenMax=100`，900 个 QuickJS 帧的记录均值 683 µs、p95 738 µs，记录所用 p99 取样为 921 µs。三轮网页帧、重启两端、延迟帧、bot 日志与 trace 都已检查或解析，Fleet artifacts 为 `48187..48212`。

肉眼检查覆盖两档名字牌、八张手机截图、三轮最终 Chrome 帧、重启网页/桌面帧与延迟帧；没有发现名字融入雪地、触控遮住关键 HUD、邀请面板不可达或重连后停在旧 epoch 的问题。

## 提交与发布顺序

Wander 功能提交：

- `acb7bd7 fix(online): use a private upgrade close code`
- `d44e26a fix(online): decouple far-player cadence`
- `dbef02a fix(online): outline the local nameplate`
- `1a9aae7 fix(web): make online controls touch reachable`
- `06484b1 fix(demo): opt into online auto-walk`

服务器提交：

- `eed513b fix(room): decouple far-player cadence`
- `0d73359 docs: quantify far-player traffic`
- `7046887 chore: pin network polish Wander`

发布必须按依赖顺序进行：Pocket RPG Kit `1147cf56` → Wander `06484b16` → Server `7046887` → 部署。未 push、未部署、未修改 GitHub 状态。

相邻但不属于本轮升级拒绝路径的客户端主动 `1012/prediction rebase` 保持原状；它应单独评估私有码迁移，不能与本次已验证的发布链混在一起。

subagent 使用：6 个 / 分别负责关闭码规范审查、关闭码实现、FAR 节奏审查、FAR Wander 实现、手机触屏审查、名字牌与像素测试方案审查；并行完成独立核对，节省了规范、测试切口与视口问题定位时间。

PASS
