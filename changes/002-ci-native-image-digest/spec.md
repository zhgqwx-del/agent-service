# CI-01 Docker 镜像摘要校验规范

## 范围

GitHub Actions 的 `image (agent-runner)` 作业在发布样例原生配置检查中验证 nginx 和 promtool 两个工具镜像。本变更新增对固定 manifest 原始字节的独立校验。 [CI 工作流](../../.github/workflows/ci.yml) · [原失败作业](https://github.com/zhgqwx-del/agent-service/actions/runs/44507127998/job/135501533641)

## 需求

### REQ-CIIMAGE-001 固定镜像内容

沿用两个镜像引用和各自的 manifest、config pin。每个引用经现有 `native()` 执行一次 Buildx 原始 manifest 读取。对未重排的输出字节计算 SHA-256，与 manifest pin 精确比较。通过后解析为单平台镜像 manifest，比较其中的 `config.digest` 与 config pin。读取失败、字节或 config pin 不匹配及解析失败均阻断该步骤。

### REQ-CIIMAGE-002 本地镜像身份

保留固定引用以 Linux amd64 拉取，以及对本地 `inspect` 平台与 `RepoDigests` 的精确检查。独立验真后，`.Id` 必须等于本镜像的 config pin 或 manifest pin。记录返回值及其摘要种类，并保留已核验的两种摘要证据。平台错误、引用摘要错误或其它 `.Id` 均阻断。

### REQ-CIIMAGE-003 原生检查与证据

成功路径要求原 24 个原生命令和新增的 `nginx-manifest`、`promtool-manifest` 各执行成功并结清，保留 5 个隔离容器和原有的结清证明、资源及源码检查。systemd、nginx 和 Prometheus 语法检查及失败证据上传仍通过现有工作流执行，报告绑定源码 SHA、run 和 attempt。 [协作与门禁约定](../../AGENTS.md)

## 验收场景

### AC-CIIMAGE-001 验证固定 manifest 和 config

关联 [REQ-CIIMAGE-001](#req-ciimage-001-固定镜像内容)。

- **Given** 原 nginx 与 promtool 固定引用对应的原始 manifest 字节。
- **When** 原生步骤按引用读取并核验镜像内容。
- **Then** 记录每个镜像各自匹配的 manifest SHA-256 与 config 摘要。

### AC-CIIMAGE-002 拒绝无效 manifest 证据

关联 [REQ-CIIMAGE-001](#req-ciimage-001-固定镜像内容)。

- **Given** 读不到原始 manifest，或分别提供摘要错误的原始字节、匹配摘要但不可解析的内容、索引或缺少有效 config 的形状，以及与 pin 不符的 config。
- **When** 镜像内容校验。
- **Then** 原生步骤失败，并记录触发的检查。成功结果和后续解析均未开始。

### AC-CIIMAGE-003 区分两种本地镜像 ID

关联 [REQ-CIIMAGE-002](#req-ciimage-002-本地镜像身份)。

- **Given** 内容核验通过，原生 `inspect` 返回 Linux amd64 和匹配的 `RepoDigests`。
- **When** 分别检查 config 型和 manifest 型 `.Id`。
- **Then** 两种精确值均通过且摘要种类可区分。单独换成其它 ID、错误平台或不匹配的 `RepoDigests` 时拒绝。

### AC-CIIMAGE-004 运行全部原生门禁

关联 [REQ-CIIMAGE-003](#req-ciimage-003-原生检查与证据)。

- **Given** Linux amd64 runner 可使用 Docker 和 Buildx，并获取两个固定镜像。
- **When** 执行现有原生配置步骤。
- **Then** 成功记录含 26 个具名且结清的原生命令、5 个已关闭的容器和原语法检查证据。任何新增读取失败、原检查失败或结清缺证仍阻断。
