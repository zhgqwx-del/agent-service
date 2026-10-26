# BYOK 本系统责任来源与只读状态

本文约束已实现的0059责任来源、T3a/T3b消费和只读状态。具名本地/CI验收及运行版本见 [PROGRESS](../PROGRESS.md)。真实厂商撤销由客户负责；本系统KMS销毁/完整生命周期未实现，目标生产仍待验收。

## 责任范围

用户已确认：客户自带模型 key 的厂商侧撤销由客户负责，本系统负责清除自己保存的副本。本包把这项责任决定落实到真实新写入、T3a/T3b 消费和 operator 状态；不调用厂商管理 API，不把客户责任声明当作远端撤销 ACK。

以下四件事分别表达，不合并成“删除完成”：

- live 数据库 credential material 已由精确 T3a 事务清除；
- configured fleet 的受跟踪 runtime 引用已由 T3b 证据释放，不保证 JavaScript 内存清零；
- 可证明来源的 BYOK key，其厂商侧操作由客户负责；
- 备份、日志和其它副本的生命周期仍需独立证明。

平台共享模型 key、共享 envelope master key、仍被收据依赖的 ref key，以及制品加密 key 均不属于单租户销毁目标。真实受管远端 target 不能因为同版出现 BYOK key 就被豁免。0037 grant 硬拒、0054 original-primary-only destructive、外部删除和自动清理关闭、所有全域 completion=false 保持。

## 真实来源与材料粒度

真实链路是 `ProviderService.upsertTenantProvider` 接收新 `apiKey`，加密后产生服务端 admission，再由 store 在来源 CAS 的同一原子边界消费。客户端额外 JSON 字段不能构造 admission；原对象必须在任何 clone/serialization 前校验，绑定 tenant/provider、exact expected source revision 和本次 ciphertext envelope。数据库分配最终 credential version、generation 和 DB 时间。

`secret=undefined` 会保留旧密文；普通配置编辑也会产生新的 `managed_v1` 版本。因此 API 路由、版本 origin 或最近更新时间都不能证明沿用的旧 key 是 BYOK。无新 secret 时，只能从精确前版本的已验责任继承同一材料的来源；缺证据或 legacy 继续 unknown。新 key 不会连带升级自定义 header、endpoint 参数或共享 envelope key 的责任。

原 `upsertProviderConfig` 的 legacy 合同保留。新的受限写入口不得让普通 store 调用、结构相同的 literal、clone 或跨 tenant/revision 重放冒充可信 admission。已有受保护远端 target reference 与责任证据分别保留；责任状态不修改其 disposition。

## Store 原子边界

Memory 在既有 staged publication 中提交 source、0026 version/slot/target 与独立责任 sidecar；MySQL 沿原 tenant gate → tracking control → source/slot 锁序，在同一事务提交。CAS 竞争、delete/recreate、序列化或 SQL 失败不能留下孤儿责任行，也不能让失败写入取得来源。

T3a 在清除 live credential、退休版本和封存既有 inventory/receipt 的同一原子边界，新增独立责任 entries 与 aggregate receipt。它们必须精确覆盖 inventory 的全部版本；缺 sidecar 明确为 unknown，空集合必须显式封存。旧 receipt、target disposition 和已封存物理行不重签、不加列改形；旧 terminal 不补造新证据。正常权限下新证据 append-only；缺失证据始终不能解释成零项或完成。

新 schema 使用独立 family，不能追加到已发布 CP1 固定49族或重算其旧根。后续实际备份/恢复必须证明新表随真实 schema 制品保持，并由 startup/readiness 验真；旧 schema 原生制品跨迁移恢复不是本包已交付能力。

独立审计边界：generic整库dump按实际schema包含0059物理表，但固定49/27族本身不证明责任关系；物理收集不能替代业务审计。source factory、exact-run/artifact维护入口与checkpoint audit还须完整核对责任投影。非空责任的真实MySQL/MinIO import/cold及tamper拒绝已有具名范围，实际通过证据见[PROGRESS](../PROGRESS.md)；旧schema原生跨迁移恢复和生产灾备仍未验，不造CP3、不重算旧根、不提升unknown。

## Tenant 只读消费

新增 tenant-scoped readiness 在一个一致性视图中校验真实 T1、T3a inventory/责任 receipt 和 T3b configured-fleet receipt；不能复用 user-scope 的通用 completion 接口，也不能从空缓存推断 runtime 已撤销。

对外沿用 platform-operator tenant status GET 的鉴权、owner-hiding、`Cache-Control: no-store` 和 `gated` 边界，仅新增可选、versioned、content-free 的 `credentialResponsibility` 子字段。不新增 endpoint、常驻服务、JavaScript 入口或镜像，不改 POST/replay 响应。旧 runner 缺字段、旧 terminal 或缺来源时是 unknown，不是空集或成功；私有 tenant/version/material tuple、密文、key ID、header、URL、locator 和原始异常不能进入公开状态。

## 验收与回归合同

具名验收按“新BYOK API写入→原子source/version→T1/T3a→T3b→operator readiness”纵向核验；对应实现/回归合同包括：

- 新 secret 与已验继承、config-only legacy 不能升级、材料间不串权；
- literal/clone、跨 tenant/revision、CAS 重试、删除重建及失败原子回滚；
- T3a 精确版本集合、显式空集合、旧 terminal/缺证据 unknown、旧字节保持；
- T3b 消费真实 durable fleet receipt，不声称内存清零或外部撤销；
- 不调用厂商管理 API，不影响邻租户或共享平台 key，状态鉴权和 no-store 保持；
- 整合后的真实 MySQL、历史升级及备份恢复，以及对应源码的功能包验证与最终 CI。

实现入口为[ProviderService](../../packages/providers/src/service.ts)、[责任codec](../../packages/store/src/credential-responsibility.ts)和[MySQL store](../../packages/store/src/mysql/store.ts)；公开消费由[runner app](../../apps/agent-runner/src/app.ts)接入。当前工作与剩余范围统一见[PROGRESS](../PROGRESS.md)。
