# 首个产品变更（待定）验收记录

## 接入前基线

- 源码工作树起点为 `main` 的 `8cc9900`，已有未跟踪的 `.agents/`，其中包含 `init-stdd`。
- 静态核对公开入口从 [OpenAPI](../../packages/protocol/openapi.json) 和 [SDK](../../packages/sdk/README.md) 开始。会话、执行、SSE、身份与数据边界从[现行规格索引](../../specs/README.md)进入现有设计和运维合同。
- 从 [package.json](../../package.json) 和[开发与 CI 指南](../../docs/operations/development-and-ci-guide.md)确认产品验证入口。协议同步用 `pnpm check:api`，定向回归按受影响场景选取，适用的完整门禁按指南执行。
- 既有受测版本、具名结论和已知失败见 [PROGRESS](../../docs/PROGRESS.md)。新主机未持有原本机证据，原验收未独立复核。

## 接入核查

本轮核查 STDD/SDD 工作区接入。产品定向测试、构建、完整验证、CI 和手工体验本轮均未执行。

- `git diff --check` 通过。核对 35 个新增脚手架文件、两处导航改动和其中 107 处本地链接及锚点。
- `python3 -B scripts/check_traceability.py` 成功，输出 0 份现行格式规格、0 条需求、0 个场景。当前已有行为通过规格索引引用既有合同。
- 在临时目录验证了新建变更、重复建档保护及 REQ/AC 关联的通过与失败样例。`git_range.py` 使用已有本地提交完成只读对比。
- 对当前工作树重复预演初始化，结果为 0 新增、0 受阻。

### 接入复核修正

- 初始定向验证中有 7 项结果与预期不符，复现了缩进标题和 HTML 注释造成的漏检。最终 CLI 在隔离目录通过 24 项定向检查，覆盖缩进标题、章节边界、隐藏场景和关联、注释闭合线、围栏与跨行代码、转义、重复编号与未知关联。
- 实际受测的 `scripts/check_traceability.py` SHA-256 为 `aeb63a8ee47377da237f48806bc5e76c5fe3c4ee688f8aecf55eb58f6361d3b8`。仓库内运行结果仍为 0 份现行格式规格、0 条需求、0 个场景。
- 隔离建档检查确认生成的任务将定向和完整检查交给 root，验收模板要求绑定受测字节。复核了 107 处本地链接及锚点。本节记录 STDD 接入验证。

## 首个产品变更的验收

产品需求、规格、实施方案和验收场景待定。选定后按[验收记录模板](../../docs/stdd/templates/verification.md)分别记录该切片的修改前基线、实际受测版本和实现后结果。
