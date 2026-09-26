# agent-service 协作约定

## 开始前先读

1. `README.md`：运行方式、API 和当前里程碑摘要。
2. `docs/PROGRESS.md`：顶部当前快照和最后一节是进度事实来源。
3. `docs/design/00-architecture.md`：架构基线与 M0–M4 定义。
4. `docs/operations/local-and-deployment.md`：本地生命周期和未来部署契约。

`docs/review/` 与 `docs/research/` 是时间点快照；其中的旧测试数量、缺陷和“下一步”不能覆盖 `docs/PROGRESS.md` 的最新结论。

## 当前阶段

- M0 完成。
- M1 核心运行范围完成；OpenAPI/生成 SDK 与完整数据生命周期仍未闭环。
- M2 核心验收完成，处于冻结前收尾；尚未正式进入 M3。
- M3 的 MCP/skills/hooks 主体和 M4 的生产化主体尚未开始。
- 当前优先债务是 session 创建与首条事件原子化、`0007 -> 0008` 历史升级夹具；随后补齐 M1 的契约与生命周期缺口，再正式进入 M3。

## 工作边界

- 当前先保证本机和 CI 可重复运行。staging/production 的 Kubernetes、云资源和拓扑要等用户提供真实参数后再生成。
- 本机 `.env` 可用于用户明确允许的本地验证；不得提交、打印或写入文档/日志。
- 修改前检查工作树并保留用户已有改动。完成后按风险运行相应测试，并同步 `README.md` / `docs/PROGRESS.md`。

常用入口：

```bash
scripts/local-service.sh verify
scripts/local-service.sh verify-real
scripts/local-service.sh acceptance
```
