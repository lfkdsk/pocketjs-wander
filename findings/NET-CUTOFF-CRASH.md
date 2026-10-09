# NET-CUTOFF-CRASH：预算硬上限关闭竞态

## 结论

月度硬预算触发 `1008/rest` 时的玩家可见崩溃已修复。客户端现在只忽略底层 WebSocket 已关闭、但 PocketSocket 尚未派发排队中的 close 回调这一短暂窗口产生的 `SocketError(code="closed")`；close 回调仍负责保存服务器关闭原因、显示 `CLOSED FOR THE MONTH` 并安排慢速重试。其他发送错误仍会抛出。

固定的 legacy v3 浏览器在修复前 30 次低阈值硬熔断中复现 1 次崩溃；修复后的当前 v4 浏览器 30 次全部进入 `retrying`，无 `state="error"`、无准备失败。Wander 完整门禁、服务器门禁和三轮完整三端演示均通过。

## 复现与范围校正

最初保存的完整演示失败发生在 legacy v3 浏览器的第一次硬熔断等待，不是当前 v4 浏览器。为了避免把概率性结果误当成版本差异，本次使用同一低硬阈值驱动器分别测量：

| 客户端 | 代码状态 | 结果 |
| --- | --- | --- |
| 当前 v4 | 修复前 | `runs=30 ok=30 error=0 setupFailed=0` |
| 固定 legacy v3 | 修复前 | `runs=30 ok=29 error=1 setupFailed=0` |
| 当前 v4 | 修复后 | `runs=30 ok=30 error=0 setupFailed=0` |

每次运行都使用新的 Wrangler 持久化目录和 Chrome profile，在 CDP 监听器就绪后才跨过低硬阈值。驱动器和完整输出分别保存在 `cutoff-browser-stress.sh`、`stress-pre30.log`、`stress-legacy-pre30.log` 和 `stress-post30.log`。

legacy v3 的第 17 次运行抓到：

```text
The game stopped: socket: socket is not open
SocketError: socket: socket is not open
  at Socket.send
  at OnlineClient.send
  at OnlineClient.flushPending
  at OnlineClient.onFrame
last status="joined", unacked=8
```

当前 v4 在修复前 30 次没有随机撞中该窄窗口，但使用相同的逻辑 `readyState` 检查和二进制发送边界，因此确定性测试可以在当前代码上稳定触发同一异常。

## 根因

这是底层关闭与上层 close 回调之间的竞态，不是重试定时器错误：

1. 浏览器原生 WebSocket 先变为非 `OPEN`。
2. PocketSocket 的 close 事件还在宿主事件队列中，因此客户端看到的逻辑 `readyState` 仍是 `open`。
3. 同一帧的 `onFrame -> flushPending -> send` 通过逻辑检查并尝试发送批量输入。
4. Web 宿主检查原生 `readyState` 后拒绝发送；框架把拒绝转换为 `SocketError(code="closed")`。
5. 旧客户端没有捕获该异常，播放器循环先进入 `state="error"`，排队中的 `onClose(1008, "rest")` 来不及呈现正常提示。

宿主拒绝点在 `vendor/pocket-rpgkit/vendor/pocketjs/hosts/web/socket.js:379`，框架错误转换在 `vendor/pocket-rpgkit/vendor/pocketjs/framework/src/socket-api.ts:170`。真实浏览器栈与这条调用链一致。

正常 `rest` 路径会先等待 15 秒，再等待 30 秒，之后封顶 60 秒。确定性测试在两个连续关闭窗口中验证了前两级退避，说明定时器不是触发崩溃的源头。

## 修复

### 客户端

`examples/wander-online/net/client.ts:868` 的共享二进制 gameplay 发送边界现在：

- 仍先检查逻辑 `readyState`；
- 只捕获 `SocketError` 且 `code === "closed"`；
- 不合成关闭原因、不提前改变连接状态，让排队中的 `onClose` 保持唯一权威；
- 对协议错误及其他异常继续 `throw`，避免掩盖真实故障。

`tests/wander-online-client-core.test.ts:156` 模拟底层拒绝发送但逻辑 socket 仍为 open，随后派发 `1008/rest`，并断言游戏帧不崩溃、提示为 `CLOSED FOR THE MONTH`、退避为 15/30 秒。`tests/wander-online-client-core.test.ts:198` 另证非 `closed` 错误仍会抛出。

功能状态已在 `docs/status.md:12` 标为 Done 并链接到确定性覆盖。

### 演示诊断

服务器的 `scripts/demo-budget.ts` 现在在等待熔断结果前启用 CDP Runtime，并有界收集：

- `console.error`；
- 未捕获异常；
- 真实的 `#overlay-message` 文本；
- 玩家 state、帧数和最后发布的在线状态。

若播放器进入 `state="error"`，脚本立即失败并打印 overlay、状态及浏览器错误；超时也附带同样的上下文。`tests/demo-budget.test.ts` 覆盖 console error、warning 过滤和 exception 格式化。

### 回滚运行手册

服务器 `README.md` 的回滚段落现与 GitHub Actions 使用的 API token 凭据方式一致，给出可直接执行的命令：

```sh
set -a; . ~/.config/cloudflare/wander-online.env; set +a
bunx wrangler@3.99.0 deployments list --name wander-online
bunx wrangler@3.99.0 rollback <VERSION_ID> --name wander-online --message "Rollback: <reason>"
```

文档明确 `<VERSION_ID>` 是 deployment 下 `Version(s)` 显示的 Worker Version UUID，不是 deployment id；只有明确要无交互回滚时才加 `--yes`。

## 确定性与变异验证

聚焦命令为：

```sh
bun test tests/wander-online-client-core.test.ts
```

- 加修复前，新竞态测试稳定在第六个批量输入帧抛出 `SocketError: socket: socket is not open`。
- 加修复后：`13 pass, 0 fail`。
- 在隔离 worktree 中把发送边界变异回旧的单行 `socket.send(buf)` 后，同一测试再次稳定抛出 `SocketError`；变异副本随后移除。

因此测试既能识别旧实现，也没有通过吞掉所有发送错误取巧；后一性质由单独的 protocol-error 测试固定。

## 门禁与演示

所有重型命令串行执行。

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| Wander 正式构建 | 通过；`dist/wander-online.js` 966,800 bytes | `wander-build.log` |
| Wander TypeScript + 全量测试 | TypeScript exit 0；422 pass，0 fail，33 files，89.96s | `wander-gates-final.log` |
| 服务器 TypeScript + 全量测试 | TypeScript exit 0；218 pass，0 fail，9 files，16.16s | `server-gates.log` |
| 修复后硬熔断压力 | 30/30 正常，0 error，0 setup failure | `stress-post30.log` |
| 完整三端演示 | 3/3 PASS | `demo-round-1.log`、`demo-round-2.log`、`demo-round-3.log` |

三轮完整演示都覆盖 v4 重启、邀请、表情、远端玩家提示、`WORLD FULL`、v3/v4 同时在线，以及两种协议活动连接被 `1008/rest` 关闭。每轮熔断前播放器为 `state="running"`；熔断后当前 v4 为 `status="retrying"` 且 `rejectText="CLOSED FOR THE MONTH"`，浏览器 console error 计数为零。

第一轮的脱敏截图与状态日志保存在 `demo-round-1-evidence.tar.gz`。已肉眼检查当前 v4 与 legacy v3 的熔断截图，两者都清楚显示 `CLOSED FOR THE MONTH · RETRY 15s`；另一个满房截图清楚显示 `WORLD FULL · RETRY 15s`。

## 提交

Wander：

- `733f8ba fix(online): tolerate close-before-callback sends`
- `5481410 docs(status): mark cutoff close-race recovery`

服务器：

- `18c3929 test(demo): capture browser errors during budget cutoff`
- `9911bd5 fix(demo): report the real player failure overlay`
- `38410dc docs(ops): add exact Worker rollback commands`
- `9fd42c2 chore: pin cutoff-safe Wander client`

没有 push、部署或修改远端状态。

subagent 使用：3 个 / 分别核对客户端竞态与测试切口、追溯历史演示与复现证据、审查服务器诊断和回滚运行手册；只读并行，缩短了根因交叉验证时间。

PASS
