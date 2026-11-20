# Redis ACL/AOF 冷启 CI 门禁验收计划

| 场景 | 定向验证 | 最终门禁 |
| --- | --- | --- |
| `AC-CIAOF-001` | 回放从工作流解包的入口和驱动，以实际 Git 对象和隔离样本核路径、模式、字节及同一冻结清单。 | 最终 SHA 干净 checkout 与完整输入，运行前后通过。 |
| `AC-CIAOF-002` | 以上次 Linux 原生配置 ZIP 回放导出边界，验证身份、命令、结清、流摘要及精确集合。运行 `node scripts/run-required-suite.mjs test/ci-required-jobs.test.ts` 与 `pnpm typecheck`。 | 正常 `image (agent-runner)` 实测官方 Redis 8.4.7、两次冷启、五份 AOF 制品和后续门禁。 |

复用 [原生配置制品](https://github.com/zhgqwx-del/agent-service/actions/runs/44649511798/artifacts/14590246095) 和 [工作流](../../.github/workflows/ci.yml)。本机回放单独记录环境及缺证项。
