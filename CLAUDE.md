# agent-service 项目记忆

开始工作前读取 `AGENTS.md`，并以仓库内的 `README.md`、`docs/PROGRESS.md`、`docs/design/00-architecture.md` 和 `docs/operations/local-and-deployment.md` 为事实来源。

当前检查点是：M0 完成；M1 核心完成但仍有 OpenAPI/生成 SDK、完整数据生命周期缺口；M2 核心验收完成并处于冻结前收尾；M3/M4 尚未正式开始。不要用 `docs/review/`、`docs/research/` 或旧会话记忆中的历史测试数量覆盖最新进度。

本机 `.env` 可按用户授权用于本地验证，但不得提交或回显任何密钥。预发/生产部署等待用户提供真实 Kubernetes、MySQL、Redis、域名/TLS、Secret/KMS 和资源配额后再落地。
