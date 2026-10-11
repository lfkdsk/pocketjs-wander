# NET-SOCIAL-3 交付报告

## 结论

匿名健康检查已经改为从零构造的递归白名单；精确用量、IP、在线人数与
realm 运维遥测只在 Bearer 鉴权后的 `/ops/health` 返回。手机横屏的社交面板
缩进左右浮动游戏手柄之间，真实 Chrome 验证器会在面板打开后检测所有可见
`[data-button]` 控件与面板的相交。两项隔离变异均变红，两仓最终门禁和一次
完整本机三端演示均为 0 fail。

## 提交与范围

- Wander 实现提交：`96f007c83804e9150ef9de2900eb03e15d6f97a4`，基线
  `00458a8a20501647c2d1ff440181eeea63106879`。本报告由其后的纯文档提交加入。
- Server HEAD：`70e57bd5005af0bc28fc8f9003e8c3110d6cc960`，基线
  `c1eb70c9051b612fa19b4c985becf0b098d920d7`。
- Server 的 `vendor/pocketjs-wander` 指向上述 Wander 实现提交；`.gitmodules`
  保持 `https://github.com/lfkdsk/pocketjs-wander.git`。
- 没有 push、部署或修改 GitHub；所有提交作者均为
  `lfkdsk <lfkdsk@gmail.com>`，无额外作者尾注。

## 1. 健康检查的公开/运维边界

匿名 `GET /health` 不再 spread Meter snapshot，也不再依赖字段黑名单。响应只由
以下正向 schema 构造：

| 路径 | 允许键 |
| --- | --- |
| 根 | `month`, `thresholds`, `over`, `onlineBand`, `protocols`, `realmCount`, `realms` |
| `thresholds.soft|hard` | `fraction`, `requests`, `gbSeconds`（计划阈值，不是当前用量） |
| `over.soft|hard` | `over`, `requests`, `gbSeconds`（是否越线） |
| `protocols` | `v3Enabled`, `v4Enabled` |
| `realms[]` | `name`, `band` |

因此当前用量 `requests`/`gbSeconds`、storage 行计数、`ips`、精确 `online`、
`onlineGeneration`，以及 realm 的精确人数、驻留/缓存/积压/时间戳都不能从公开
响应穿出。测试向 snapshot 同时注入顶层、阈值层、越线层和 realm 层的未知键，
递归扫描任何非白名单路径都会失败；真实 workerd 集成也执行同一检查，部署
workflow 的发布后 smoke 同样递归拒绝额外键。

`GET /ops/health` 在唤醒 Meter 之前校验 `Authorization: Bearer <OPS_TOKEN>`。
令牌缺失、错误，或服务端未配置 `OPS_TOKEN` 都返回 401 且不触碰 Meter/Room；
授权后才返回精确用量、IP、在线人数、generation 和 realm 运维遥测。旧的计量
集成测试、三端演示的精确在线排空检查和预算触发器也已迁到这个运维端点，避免
为了工具兼容重新扩大公开响应。

README 运行手册和 `docs/status.md` 已同步公开 schema、运维调用方式、未配置时
的 fail-closed 行为，以及发布前必须配置外部长随机令牌的要求。

## 2. 手机横屏社交浮层

真实 `844x390@3` 页面在 raster density 2 下得到 `633x292` 的游戏逻辑视口。
该 wide 1x landscape 分支将面板宽度限制为 360 logical px，保留 120 px 的详情
文本净宽；标签显示预算由实际 `labelWidth` 推导，不会挤入详情列。普通 480x272、
960x544 和手机竖屏仍走原有响应式上限。

验证器先通过真实触摸流程创建角色并打开社交面板，再把逻辑面板矩形投影到 live
canvas 的 CSS 坐标，逐一检查所有可见 `[data-button]` 控件。正向报告在
`390x844@3` 与 `844x390@3` 的 `socialOverlaps` 都为空，控制台错误也为空。
这里的契约是规格所指的浮动游戏手柄（包括 A/CIRCLE 与方向键）；独立的全屏
页面工具栏 `#pad-toggle`/`#immersive-exit` 不在这项 A 键回归断言内。

我以 3 倍原图肉眼打开并检查了两张社交关键帧：

- `/var/tmp/fleet/4300/mobile-verify-final/portrait-390x844-social.png`：
  `1170x2532`，标签/详情清晰，手柄位于 canvas 下方；SHA-256
  `1c5a5f594caf889f0893ad9acde136db42e32c671008985203a90eb0b3aaa067`。
- `/var/tmp/fleet/4300/mobile-verify-final/landscape-844x390-social.png`：
  `2532x1170`，方向键与 A/B/X 控件都和面板留有空隙；SHA-256
  `b68ce53c32473adb6bfb98ce06c8e345fb2178f97d29686fe55048facf129250`。

正向机器报告是
`/var/tmp/fleet/4300/mobile-verify-final/report.json`（verdict `PASS`、failures
`[]`、consoleErrors `[]`；SHA-256
`1abf01139e11d3725539b3eb8a5ca688f05fe86427ade4f6c3479ae155466e20`）。

## 3. 变异辨识力

所有变异都在隔离副本中完成，未改被交付 worktree：

| 变异 | 命令/结果 |
| --- | --- |
| 公开 `/health` 加回 `ips: 2` | `bun test tests/worker.test.ts -t 'health adds configured realm defaults'` → `0 pass / 1 fail`；deep equality 明确显示收到多余 `ips: 2`。 |
| 横屏面板宽度 360 恢复为 464 | `bun test tests/wander-online-social-panel.test.ts -t 'hosted landscape viewport'` → `0 pass / 1 fail`；label cells 期望 27、实际 34。 |
| 同一旧宽度跑真实 Chrome | `bun tools/wander-online-mobile-verify.ts --out /var/tmp/fleet/4300/mut-wander-mobile` → exit 1；横屏 `socialOverlaps` 为 `RIGHT, CIRCLE, CROSS, SQUARE, LTRIGGER, SELECT`。 |

真实 Chrome 变异报告保存在
`/var/tmp/fleet/4300/mut-wander-mobile/report.json`（verdict `FAIL`，SHA-256
`daa50055f4ba9285c4af5bbda1d262d8ebbc455da44b3422ac88b1965c62f8ec`）。

## 4. 最终门禁

| 仓库/检查 | 最终结果 |
| --- | --- |
| Wander `bun run build` | exit 0；生成 `dist/wander-online.js`/pak 后再跑全量测试 |
| Wander `bun run tsc` | exit 0 |
| Wander `bun test tests/`（构建后） | **447 pass / 0 fail / 500,057 expects / 35 files**，无 skip |
| Wander 手机 Chrome 验证器 | **PASS**；两朝向 failures、consoleErrors、socialOverlaps 均为空 |
| Server `bash -n scripts/demo-cf.sh` | exit 0 |
| Server `bun run tsc` | exit 0 |
| Server `bun test tests/*.test.ts` | **264 pass / 0 fail / 2,566 expects / 9 files** |

首轮 Server 全量门禁曾准确发现旧计量集成测试仍从公开 `/health` 读取精确用量；
该消费者迁到 `/ops/health` 后，focused test 与两次最终全量复跑均通过。没有把
公开响应放宽来迁就旧测试。

## 5. 本机三端演示

命令：

```sh
WANDER_DIR=<wander-worktree> DEMO_TMP_ROOT=<private-scratch> \
  DEMO_EVIDENCE_DIR=<evidence-directory> \
  bash scripts/demo-cf.sh --seconds 90
```

最终输出：

```text
DEMO-CF PASS (v4 restart; invite + emote + far band in plaza-2; explicit WORLD FULL; v3/v4 ALL=2; both rooms closed at 1008/rest)
```

同一次真实 `wrangler dev` 演示中，浏览器与两个桌面端都达到
`online=3/allOnline=3`；停止并重启 server 后三端以新 epoch 重连，浏览器
`consoleErrors=0`。邀请、表情、远端方向带、显式 `WORLD FULL`、legacy v3 与
realm v4 同时在线、两协议 1008/rest 月度切断均通过。预算检查使用鉴权后的
`/ops/health`，在 `requests=5000` 时越线。摘要与语义截图检查保存在
`/var/tmp/fleet/4300/demo-cf-final/demo-cf.log`（SHA-256
`47c28a569e008d0677509998dcd75e7253e714cc8071b82d4d33e066805b5806`）。

## 6. 发布顺序

本任务未部署。实际发布按以下顺序：

1. 先在 Server 环境配置一个外部长随机 `OPS_TOKEN`，并确保新 Wander commit
   已可供 Server 子模块构建读取；不要把令牌写进仓库或普通 Worker vars。
2. 先发布 Server。发布后递归核对匿名 `/health` 只含本报告白名单；确认
   `/ops/health` 无/错 Bearer 均为 401，正确 Bearer 为 200 且返回精确遥测。
3. 最后发布 Wander/web，复跑两朝向手机验证和三端登录/重连 smoke。

subagent 使用：3 / 分别只读审查服务器隐私边界、横竖屏布局与既有验收要求 / 是，三块证据并行收集节省了时间；主 agent 复核实现并独立完成门禁、变异、演示与肉眼截图检查。

PASS
