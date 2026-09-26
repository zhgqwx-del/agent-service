# deepseek-harness：MCP 与 Skills 子系统（源码级笔记）

> 来源：对 `oss-refs/deepseek-harness`（commit ddefc45, 2026-09-17）的源码阅读。这是一次中途被中断的分析任务的部分产出，作为 04 号报告的补充素材保留。

## MCP（packages/mcp/mcp-client, packages/mcp/mcp-resources）

- **传输**：只实现 `stdio` 和 `streamable-http`（`packages/mcp/mcp-client/src/transport.ts:34-44`）。无 SSE-only、无 WebSocket。SDK 为 `@modelcontextprotocol/client@2.0.0`，`versionNegotiation: { mode: 'auto' }`（`connection.ts:258-271`）。
- **配置**：不读 `.mcp.json`。每个 MCP server 是 `cordis.yml` 里的一个插件实例（`@deepseek-ai/dsh-mcp-client`）。Schemastery 联合类型 schema 在 `src/index.ts:119-142`：stdio 分支 `command/args/env/cwd`，http 分支 `url/headers`；公共字段 `serverName`（`/^[A-Za-z0-9_-]{1,32}$/`）、`toolCallTimeoutMs`（默认 60000）、`failOnStartupError`、`maxInstructionBytes`（32768）、`reconnect{enabled,initialDelayMs,maxDelayMs,maxAttempts(10)}`。
- **OAuth**：完全没有。HTTP 鉴权只靠 `headers` 字段由运维方注入。
- **MCP 工具 → 原生工具**：`ctx.tools.register(definition)`（`tools.ts:150`）；公开名 `mcp__<serverName>__<rawName>`，超 64 字符则截断 + 12 位 sha256 后缀（`tools.ts:81-87`）；`inputSchema` 原样透传为 `parameters`（`tools.ts:234`）；`isError` 结果抛为 Error；image 内容块会解码后存入 `AttachmentStore`，失败降级为文本诊断（`tools.ts:386-440`）；audio/resource 块为占位文本。
- **stdio 子进程**：由 SDK 的 `StdioClientTransport` 实际 spawn，dsh 只提供 `{command,args,env: scrubbedParentEnv()+extra, cwd}`（`transport.ts:21-39`）—— 子进程**不继承原始 `process.env`**，继承一份脱敏副本。重连指数退避，超过 `maxAttempts` 后注销全部工具（`connection.ts:225-236`）。
- **mcp-resources**：三个模型可见工具 `list_mcp_resources` / `list_mcp_resource_templates` / `read_mcp_resource`，以 `server` 字符串参数寻址；不是 `@` 提及机制。二进制 `blob` 在渲染层被剥离为占位符（`render.ts:16-24`）。
- **全局状态**：`activeServerNames` 模块级 `WeakMap`（`index.ts:47`）；MCP 包内**无** `homedir()`、无直接 `process.env` 读取。

## Skills（packages/skill/*）

- **SKILL.md frontmatter**（`skill-filesystem/src/index.ts:797-840, 917-929`）：`name`（必填，kebab-case）、`description`（必填）、`whenToUse`、`disable-model-invocation`、`user-invocable`（旧驼峰别名显式拒绝）、`metadata`（透传）。**没有 `allowed-tools`**：skill 不按 frontmatter 限缩工具权限。
- **发现路径**（`roots()`，`index.ts:245-265`，rank 小者优先）：`<project>/.dsh/skills`(100) → `<project>/.agents/skills`(200) → `customSkillDirs`(300) → `$DSH_HOME/skills`(400) → `~/.agents/skills`(500) → `bundledSkillDir`(600, trusted)。`projectRoot` 向上找 `.git`。
- **注入机制**（`tool-skill/src/index.ts`）：① `agent/pre-step` 钩子注入一条 `<available_skills>` 目录消息（按 sha256 摘要去重，只在变化时重发，`213-251, 328-335`）；② 注册 `skill` 工具，参数 `{name}`，返回 `<skill_content>` 渲染块（`81-160`）；③ 用户文本里 `/name` 手势直接注入（`177-204`），这是 `disable-model-invocation` 技能唯一的加载路径。
- **Provider 接口**（`skill/src/index.ts:247-267`）：`SkillProvider{name, list(options), get(candidate, options)}`；`SkillRegistry` 支持 `registerProvider()`、`register()`（运行时临时 skill）、`list()`、`snapshot()`、`get()`；分层合并规则「最近作用域层胜出，同层按 rank」。`SkillProviderControl{signal, invalidate}` 用于缓存失效。
- **全局状态**：`skill-filesystem` 读 `process.env.DSH_AGENTS_HOME` / `DSH_BUNDLED_SKILL_DIR` / `DSH_HOME` 并用 `homedir()`；用 chokidar 监听目录。skill 包内无子进程。

## 对 agent-runner 的直接启示

1. MCP 配置模型（stdio/streamable-http 两分支 + reconnect 策略 + 工具名前缀规则 + 64 字符截断哈希）可以直接借鉴，字段命名都合理。
2. 「MCP server = 一个插件实例」的设计要求每个 server 有独立生命周期与作用域，正是多租户需要的形状（但 dsh 自己没做租户维度）。
3. Skills 的 provider 抽象（`list/get` + 分层 + rank）可以直接移植为「租户级 / 平台级 skill 源」；发现路径要从文件系统换成对象存储 / DB。
4. `scrubbedParentEnv` 这个默认值值得照抄：任何子进程都不该继承 runner 的凭据环境。
