# 自查发现（写代码的人自己复核，2026-09-26）

与四份专项 review（01–04）并行进行，只记录我亲手验证过的结论。

## 已修复

### B1 [blocker] 同一 runner 上并发 startTurn 会创建两个 turn
- **位置**：`packages/core/src/session/host.ts` 的 `startTurn`
- **成因**：忙检查 `this.active.get(sessionId)` 与 `this.active.set(...)` 之间有 5 个 await（getSession / getAgent / lease.acquire / providers.resolve / listItems）。两个并发请求都看到"空闲"；租约拦不住，因为两次 acquire 的 owner 相同，Lua 脚本走 `owner == ARGV[1]` 分支返回**同一个 fence**，于是两个 turn 用同一 fence 交错写入，`session.status` 只指向其中一个，另一个的 `finishTurn` 又会误删对方的 active 条目。
- **影响**：事件交错、工具重复执行、turn 泄漏 —— 正是租约机制要防的数据损坏，但发生在租约保护不到的进程内。
- **修复**：按 sessionId 串行化 startTurn（`startQueue`，见 `host.ts` 的 `startTurn` → `startTurnLocked`）；`finishTurn` 的 active 删除改为身份校验。
- **回归测试**：`packages/core/test/host.test.ts` 新增两条（reject 策略下只允许一个成功；steer 策略下第二个折叠进第一个 turn）。修复前两条均失败，修复后通过。

## 已验证正确

### S1 优雅下线（SIGTERM）
实测：turn 进行中发 SIGTERM → runner 等 13s 让 turn 自然跑完（`stop_reason=end_turn`，不是 interrupted）→ 客户端收到完整事件序列含 `turn/completed` → session 回 `idle` → Redis 租约释放 → 进程退出。符合设计 §4.3 的 drain 行为。

### S2 手动验收脚本
`scripts/demo.sh` 十个环节全通过：鉴权三态、agent/session 创建、流式 turn（seq 单调）、消息历史、`?after=` 重放（只含更大 seq、不含 delta）、幂等重放、跨轮上下文、maxSteps 安全阀、BYOK 写入不可读回。

## 新发现（未修）

### B2 [high] 没有生产构建路径，只能靠 tsx 运行
- **现象**：`node --experimental-strip-types src/main.ts` 启动失败 —— `ERR_MODULE_NOT_FOUND: .../packages/core/src/ids.js`。
- **成因**：workspace 包的 `main`/`exports` 直接指向 `./src/index.ts`，而源码用 `.js` 后缀的 ESM specifier（TS NodeNext 要求）。tsx 会重写这些 specifier，原生 node 不会。
- **影响**：容器镜像里要么装 tsx（多一层、启动慢、非预期的生产依赖），要么先 `tsc` 产出 dist 并把 `exports` 指向 dist。上云前必须解决，并且要有一个"构建产物能启动"的 CI 检查。
- **建议**：`packages/*` 的 `exports` 改为 `{"import": "./dist/index.js", "types": "./dist/index.d.ts"}` + `publishConfig`，开发态靠 tsconfig paths / tsx；或直接用 esbuild 打成单文件。两种都要在 CI 里跑一次 `node dist/main.js --healthcheck`。

### B3 [medium] `busyPolicy: "queue"` 未实现
协议声明了三档（`steer | queue | reject`），`host.ts` 只区分 steer 与其他，`queue` 实际走 reject 返回 `session_busy`。要么实现排队，要么从协议里去掉该枚举值（我倾向一期去掉，M3 再加，避免客户端按文档写代码却拿到 409）。

### B4 [medium] `lastCompactionSeq` 读的字段没有任何写入方
`host.ts` 末尾的 `lastCompactionSeq(session)` 读 `session.metadata.lastCompactionSeq`，但全仓没有写入该字段的地方（压缩摘要级功能未实现）。当前恒为 `-1`，即每次 turn 都从头投影全部 items（上限 5000）。长会话下是性能与成本问题，不是正确性问题。要么实现压缩并写入该字段，要么在代码里标注 TODO 并加一个 items 数量的告警阈值。
