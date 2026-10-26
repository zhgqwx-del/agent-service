# 单机基础指标与告警样例

仅提供现有 Prometheus 可加载的数据配置，不安装 Prometheus/Alertmanager、Grafana、agent 或任何新服务，不配置或发送通知。仅加载规则而没有可达的值守/通知渠道，不代表有人收到告警。上线前由操作者核实规则已加载、两 role 均实际采集，并落实 Prometheus 自身停机的外部监视；已停的 Prometheus 不能用自己的规则发出告警。

## 接入已有采集器

1. 在两份受保护角色环境中显式设 `METRICS_ENABLED=1`，分别提供独立的 `METRICS_BEARER_TOKEN`（各32–256位token-safe ASCII，且与业务/admin/internal/model/master key分离）。当前 production 样例显式要求1；产品默认0或误关闭仍会返回404，不能当作采集成功。
2. 通过受保护通道把各 role 的**裸 token**分别放到 `prometheus.yml.example` 指定的 router/runner `credentials_file`，不含 `Bearer ` 前缀、引号或配置语句。两个文件不同、当前采集进程可读，建议文件0600、私有目录0700；owner按现采集进程设计。不要把 token 放入YAML、命令行、URL、日志或仓库。样例没有凭据正文。
3. 样例按现单机端口8080/8787、同一host/network namespace的loopback部署。容器中的127.0.0.1是容器自身，不能照搬到远端采集；其它拓扑应显式审阅私网/TLS/凭据传输，而不是将runner或metrics开放公网。`authorization.type=Bearer`+`credentials_file`复用Prometheus正式配置合同，关闭redirect，不继承业务鉴权。
4. 人工将 `alerts.yml.example` 作为实际 `/etc/agent-service/monitoring/alerts.yml` 安装，将 scrape 样例合并到已有采集器配置。全局scrape15s、timeout5s（timeout不超过interval）、规则evaluation15s。目录/端口/文件变化需同步两份配置和 expected job 名；不能删掉缺失目标告警来消除告警。
5. 目标采集与规则求值尚未验收。实际加载前由root/操作者在选定Prometheus版本运行正式 `promtool check config` / `promtool check rules`；再核targets/rules状态。应验证：错误token/metrics关闭/进程停止会失败；移除一个target仍由 `absent(up{job=...})` 报警；200但没有对应role uptime样本也报错；加入真实或受控样例的5xx和Gateway unavailable计数会触发对应规则。未授权时不故障注入实际生产实例。规则文件未加载不可能自证正常。

## 指标与告警含义

规则只使用实际L0字段：HTTP `agent_service_http_requests_total` 的 `component/method/route/status_class`，Gateway `agent_service_provider_gateway_rejections_total` 的 `component/scope/reason`，以及 `agent_service_process_uptime_seconds{component=...}`。`job/instance`由Prometheus目标产生，不是owner或业务标签。targets失踪时无up series仍告警；没有业务流量时HTTP/Gateway按需创建的counter series缺失是正常，不能反推“没有故障/配置已启用”。两条事件规则另检查首次出现的非零series，避免把惰性创建counter的第一条失败硬当作已存在的0基线；这不是逐事件、无损或持久审计保证。

`quota_unavailable`、`breaker_unavailable`、`local_unavailable`来自实际派发前拒绝观察；最后一项还可能是其它本地原因，不能只凭指标断言fleet故障。正常 `quota_rpm/quota_concurrency` 是配置生效时的限流，不当作基础设施故障。本样例不发明 `gateway_unavailable` 指标，不把router普通503强行解码为某类模型失败。无流量时当前L0不会主动测试Redis/fleet；启动时仍按正式Gateway nonce/fresh-fleet合同验真，周期依赖探测另由实际运维负责，本样例不创建新probe服务。

HTTP计数、handlers和duration止于**响应头就绪**，不是SSE全生命周期、活跃turn数或模型/账单成功。异步turn即使已202，后续仍可能quota/failed/interrupted；应查询持久turn/event。Gateway IO completed也仅代表完整2xx传输，不代表SSE解析或业务完成。两角色不能相加当业务请求数，指标重启会清零、可以丢失/饱和，不能用于费用结算或数据删除证明。5xx规则排除health/ready/openapi/internal_control；基础阈值是“5分钟内观察到故障、持续1分钟”，仅是初始运维候选，不是SLO或容量结论。

## 目标环境仍须覆盖

本样例不提供实际ready探测、磁盘空间、MySQL/Redis持久化、备份新鲜度或恢复成功指标，也不凭L0推断这些健康。最小上线清单中的这些项目仍须由现宿主机/托管服务监控和实际恢复验收覆盖，不能伪造不存在的app metric。磁盘/备份阈值依部署大小与RPO填写。

正式配置参考：

- [Prometheus 配置](https://prometheus.io/docs/prometheus/latest/configuration/configuration/)
- [告警规则](https://prometheus.io/docs/prometheus/latest/configuration/alerting_rules/)

代码来源：`packages/protocol/src/runtime-metrics.ts` 的真实render/闭合labels；`packages/providers/src/service.ts` 的实际rejection分类；双role app `/metrics` 的独立token/404/401/no-store合同。样例不改变产品指标或安全语义；实际采集、规则触发和通知链须由目标环境验收。

部署顺序与真实资源清单见 [单Linux部署手册](../../docs/operations/initial-production.md)；本文件只维护采集/规则接入，不替代该手册的停服、身份、持久化和R1门禁。
