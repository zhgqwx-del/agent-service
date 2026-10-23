// Main-profile files previously enforced by the broad checker or equivalent named commands.
// S3, historical migration, cluster and actual artifact checks remain independent profiles.
export const REQUIRED_COVERAGE_TEST_FILES = Object.freeze([
  "apps/agent-runner/test/main.test.ts",
  "apps/agent-router/test/main.test.ts",
  "apps/agent-router/test/session-authority-observation.test.ts",
  "apps/agent-runner/test/process-owner.test.ts",
  "apps/agent-runner/test/restore-ledger-authority-budget.test.ts",
  "apps/agent-runner/test/restore-ledger-reconcile-native-stop.test.ts",
  "apps/agent-runner/test/session-authority-operator.test.ts",
  "packages/core/test/host-shutdown.test.ts",
  "packages/core/test/session-authority-runtime.test.ts",
  "packages/store/test/mysql-stopped-maintenance-profile.test.ts",
  "packages/store/test/redis-event-bus-unknown.test.ts",
  "packages/store/test/restore-journal-owned-native.test.ts",
  "packages/store/test/session-authority-boundaries.test.ts",
  "packages/store/test/session-authority-operator-admission.test.ts",
  "packages/store/test/session-authority-retirement.mysql.test.ts",
  "packages/store/test/session-authority-schema.test.ts",
  "packages/store/test/session-authority-subagents.mysql.test.ts",
  "packages/store/test/session-authority.memory.test.ts",
  "packages/store/test/session-authority.mysql.test.ts",
  "test/mysql-authority-cli-executor.test.ts",
  "packages/core/test/tools.test.ts",
  "packages/core/test/web-fetch-native.test.ts",
  "packages/sdk/test/record-assistant-reference.test.ts",
  "apps/agent-runner/test/record-assistant-reference.mysql.test.ts",
  "test/http-experience.test.ts",
  "test/http-experience-fixture.test.ts",
  "packages/core/test/host-observation.test.ts",
  "apps/agent-runner/test/sse-bounds.test.ts",
  "apps/agent-runner/test/provider-compaction.mysql.test.ts",
  "packages/providers/test/fake-vendor-load.test.ts",
  "packages/providers/test/provider-gateway-chaos.redis.test.ts",
  "packages/core/test/pi-provider-fallback.test.ts",
  "packages/core/test/host-provider-fallback.test.ts",
  "packages/providers/test/provider-fallback-service.test.ts",
  "apps/agent-runner/test/provider-key-pools.test.ts",
  "apps/agent-runner/test/provider-platform-fallback-config.test.ts",
  "apps/agent-runner/test/provider-platform-fallback-startup.test.ts",
  "packages/protocol/test/provider-gateway-metrics.test.ts",
  "packages/providers/test/gateway-metrics-service.test.ts",
  "packages/providers/test/byok-breaker-service.test.ts",
  "packages/providers/test/byok-breaker-service.redis.test.ts",
  "apps/agent-runner/test/provider-byok-breaker-config.test.ts",
  "packages/protocol/test/provider-fallback-policy.test.ts",
  "packages/store/test/provider-pool.test.ts",
  "packages/store/test/provider-pool.redis.test.ts",
  "packages/providers/test/pool-service.test.ts",
  "packages/providers/test/pool-service.redis.test.ts",
  "apps/agent-runner/test/provider-key-pool-runtime-config.test.ts",
  "packages/core/test/pi-provider-request.test.ts",
  "apps/agent-runner/test/provider-key-pool.test.ts",
  "packages/store/test/provider-quota.test.ts",
  "packages/store/test/provider-quota.redis.test.ts",
  "packages/providers/test/quota-service.test.ts",
  "packages/core/test/pi-provider-admission.test.ts",
  "packages/core/test/host-provider-admission.test.ts",
  "packages/providers/test/quota-service.redis.test.ts",
  "apps/agent-runner/test/provider-gateway-config.test.ts",
  "apps/agent-runner/test/provider-gateway-gate.test.ts",
  "apps/agent-runner/test/provider-gateway-startup.test.ts",
  "apps/agent-router/test/provider-gateway-config.test.ts",
  "apps/agent-router/test/provider-gateway.test.ts",
  "apps/agent-router/test/provider-gateway-fleet-isolation.test.ts",
  "test/harness-startup-ownership.test.ts",
  "test/mysql-runtime-fixture.test.ts",
  "test/mysql-schema-cli-executor.test.ts",
  "test/ci-owned-mysql-authority.test.ts",
  "test/ci-image-runtime.test.ts",
  "apps/agent-runner/test/schema-cli.test.ts",
  "apps/agent-runner/test/mysql-schema-config.test.ts",
  "apps/agent-runner/test/main-schema-runtime.test.ts",
  "packages/store/test/mysql-schema-operation.test.ts",
  "packages/store/test/mysql-schema-operation.mysql.test.ts",
  "packages/store/test/schema-metadata-codec.test.ts",
  "packages/store/test/mysql-schema-metadata.test.ts",
  "packages/store/test/mysql-schema-metadata-verifier.test.ts",
  "packages/store/test/mysql-schema-metadata-install.test.ts",
  "packages/store/test/schema-runtime-privileges.test.ts",
  "packages/store/test/mysql-schema-authority.mysql.test.ts",
  "packages/store/test/mysql-schema-metadata.mysql.test.ts",
  "packages/protocol/test/lifecycle-hooks-contract.test.ts",
  "packages/protocol/test/subagents.test.ts",
  "packages/sdk/test/subagents.test.ts",
  "packages/core/test/lifecycle-hooks.test.ts",
  "packages/core/test/host-lifecycle-hooks.test.ts",
  "packages/core/test/subagent-policy.test.ts",
  "packages/core/test/host-subagents.test.ts",
  "packages/store/test/subagents.test.ts",
  "packages/store/test/subagents.mysql.test.ts",
  "apps/agent-runner/test/subagents-vertical.test.ts",
  "apps/agent-runner/test/subagents-vertical.mysql.test.ts",
  "apps/agent-runner/test/lifecycle-hooks-config.test.ts",
  "apps/agent-runner/test/subagents-config.test.ts",
  "apps/agent-runner/test/runtime-extensions-gate.test.ts",
  "apps/agent-runner/test/runtime-extensions-http.test.ts",
  "apps/agent-runner/test/subagent-routes.test.ts",
  "apps/agent-runner/test/subagent-control-guard.test.ts",
  "apps/agent-router/test/runtime-extensions-config.test.ts",
  "apps/agent-router/test/runtime-extensions.test.ts",
  "test/build-dependency-policy.test.ts",
  "test/openapi-contract.test.ts",
  "test/local-service-tool-authority.test.ts",
  "test/local-service-external-infra.test.ts",
  "packages/protocol/test/redis-selection.test.ts",
  "packages/protocol/test/tenant-hooks-contract.test.ts",
  "packages/store/test/tenant-webhooks.test.ts",
  "packages/store/test/tenant-webhooks.memory.test.ts",
  "packages/store/test/tenant-webhooks.mysql.test.ts",
  "packages/sdk/test/tenant-hooks.test.ts",
  "packages/core/test/tenant-webhook-cipher.test.ts",
  "packages/core/test/tenant-webhook-v2.test.ts",
  "packages/core/test/host-tenant-webhooks.test.ts",
  "apps/agent-runner/test/tenant-hooks-config.test.ts",
  "apps/agent-runner/test/tenant-hooks-gate.test.ts",
  "apps/agent-runner/test/tenant-hooks-http.test.ts",
  "apps/agent-runner/test/tenant-hooks-vertical.mysql.test.ts",
  "apps/agent-router/test/tenant-hooks-config.test.ts",
  "apps/agent-router/test/tenant-hooks.test.ts",
  "apps/agent-router/test/app.test.ts",
  "apps/agent-router/test/registry.test.ts",
  "apps/agent-router/test/config.test.ts",
  "apps/agent-router/test/mcp-registry-config.test.ts",
  "apps/agent-router/test/mcp-registry.test.ts",
  "apps/agent-router/test/skills-registry-config.test.ts",
  "apps/agent-router/test/skills-registry.test.ts",
  "apps/agent-router/test/ordinary-session-usage-retention.test.ts",
  "apps/agent-router/test/persisted-provider-capture.test.ts",
  "apps/agent-router/test/runtime-metrics-config.test.ts",
  "apps/agent-router/test/runtime-metrics.test.ts",
  "apps/agent-runner/test/backup-catalog-cli.test.ts",
  "apps/agent-runner/test/backup-catalog-wrapper.test.ts",
  "apps/agent-runner/test/cli-entrypoint.test.ts",
  "apps/agent-runner/test/config.test.ts",
  "apps/agent-runner/test/credential-responsibility-http.test.ts",
  "apps/agent-runner/test/hooks-config.test.ts",
  "apps/agent-runner/test/hooks-runtime.test.ts",
  "apps/agent-runner/test/hooks-vertical.test.ts",
  "apps/agent-runner/test/hooks-vertical.mysql.test.ts",
  "apps/agent-runner/test/mcp-config.test.ts",
  "apps/agent-runner/test/mcp-registry-config.test.ts",
  "apps/agent-runner/test/mcp-registry-gate.test.ts",
  "apps/agent-runner/test/mcp-registry-http.test.ts",
  "apps/agent-runner/test/mcp-vertical.test.ts",
  "apps/agent-runner/test/mcp-vertical.mysql.test.ts",
  "apps/agent-runner/test/mcp-progress-sse.test.ts",
  "apps/agent-runner/test/mcp-progress-vertical.test.ts",
  "apps/agent-runner/test/mcp-progress-vertical.mysql.test.ts",
  "apps/agent-runner/test/mcp-registry-vertical.mysql.test.ts",
  "apps/agent-runner/test/mcp-registry-oauth.mysql.test.ts",
  "apps/agent-runner/test/skills-config.test.ts",
  "apps/agent-runner/test/skills-registry-config.test.ts",
  "apps/agent-runner/test/skills-registry-http.test.ts",
  "apps/agent-runner/test/skills-registry-vertical.mysql.test.ts",
  "apps/agent-runner/test/skills-runner-contract.test.ts",
  "apps/agent-runner/test/skills-vertical.test.ts",
  "apps/agent-runner/test/skills-vertical.mysql.test.ts",
  "apps/agent-runner/test/mysql-backup-artifact.unit.test.ts",
  "apps/agent-runner/test/mysql-backup-artifact-source-observer.test.ts",
  "apps/agent-runner/test/ordinary-session-delete-grace-recovery.mysql.test.ts",
  "apps/agent-runner/test/ordinary-session-usage-retention-gate.test.ts",
  "apps/agent-runner/test/ordinary-session-usage-retention.mysql.test.ts",
  "apps/agent-runner/test/persisted-provider-capture-gate.test.ts",
  "apps/agent-runner/test/persisted-provider-capture-ready.test.ts",
  "apps/agent-runner/test/restore-ledger-reconcile-cli.test.ts",
  "apps/agent-runner/test/restore-ledger-reconcile-wrapper.test.ts",
  "apps/agent-runner/test/runtime-metrics-config.test.ts",
  "apps/agent-runner/test/runtime-metrics.test.ts",
  "apps/agent-runner/test/telemetry-capture-cli.test.ts",
  "apps/agent-runner/test/telemetry-capture-ref-key.test.ts",
  "apps/agent-runner/test/telemetry-capture-wrapper.test.ts",
  "apps/agent-runner/test/tenant-restore-journal-config.test.ts",
  "apps/agent-runner/test/tenant-redis-purge-gate.test.ts",
  "apps/agent-runner/test/tenant-telemetry-writer-config.test.ts",
  "packages/core/test/erasure-worker.mysql.test.ts",
  "packages/core/test/host-persisted-provider-failure.test.ts",
  "packages/core/test/host.test.ts",
  "packages/core/test/host-mcp.test.ts",
  "packages/core/test/host-mcp-progress.test.ts",
  "packages/core/test/pi-mcp-progress.test.ts",
  "packages/core/test/host-mcp-grant-recovery.test.ts",
  "packages/core/test/mcp-http.test.ts",
  "packages/core/test/mcp-service.test.ts",
  "packages/core/test/mcp-sdk-compat.test.ts",
  "packages/core/test/mcp-cipher.test.ts",
  "packages/core/test/mcp-network.test.ts",
  "packages/core/test/mcp-pool.test.ts",
  "packages/core/test/mcp-registered.test.ts",
  "packages/core/test/mcp-dcr.test.ts",
  "packages/core/test/mcp-dcr-crash.mysql.test.ts",
  "apps/agent-runner/test/mcp-dcr.mysql.test.ts",
  "packages/core/test/host-registered-mcp.test.ts",
  "packages/protocol/test/mcp-registry-contract.test.ts",
  "packages/protocol/test/mcp-dcr.test.ts",
  "packages/protocol/test/mcp-progress-contract.test.ts",
  "packages/sdk/test/mcp.test.ts",
  "packages/sdk/test/sse.test.ts",
  "packages/core/test/skills-static.test.ts",
  "packages/core/test/skills-registry-export.test.ts",
  "packages/core/test/skills-document-guard.test.ts",
  "packages/core/test/skills-registered.test.ts",
  "packages/core/test/skills-registered-io-settlement.test.ts",
  "packages/core/test/host-registered-skills.test.ts",
  "packages/core/test/host-skills.test.ts",
  "packages/core/test/assemble-skills.test.ts",
  "packages/core/test/tool-hooks.test.ts",
  "packages/core/test/host-hooks.test.ts",
  "packages/protocol/test/hooks-contract.test.ts",
  "packages/protocol/test/skills-contract.test.ts",
  "packages/protocol/test/skills-registry-contract.test.ts",
  "packages/sdk/test/skills.test.ts",
  "packages/core/test/ordinary-session-delete-grace-recovery.test.ts",
  "packages/core/test/ordinary-session-usage-retention-worker.test.ts",
  "packages/core/test/persisted-provider-capture-worker.test.ts",
  "packages/core/test/persisted-provider-failure-capture.test.ts",
  "packages/core/test/pi-provider-failure.test.ts",
  "packages/core/test/tenant-redis-purge-worker.test.ts",
  "packages/core/test/tenant-telemetry-application-dual-write.test.ts",
  "packages/core/test/tenant-telemetry-writer-worker.test.ts",
  "packages/protocol/test/telemetry.test.ts",
  "packages/protocol/test/credential-responsibility-status.test.ts",
  "packages/protocol/test/runtime-metrics.test.ts",
  "packages/providers/test/telemetry-dual-write.test.ts",
  "packages/providers/test/credential-responsibility-service.test.ts",
  "packages/store/test/backup-catalog-s3.unit.test.ts",
  "packages/store/test/backup-catalog.mysql.test.ts",
  "packages/store/test/blob-lifecycle.mysql.test.ts",
  "packages/store/test/blob-storage-control.memory.test.ts",
  "packages/store/test/blob-storage-control.mysql.test.ts",
  "packages/store/test/commit-concurrency.mysql.test.ts",
  "packages/store/test/credential-responsibility.test.ts",
  "packages/store/test/skills.test.ts",
  "packages/store/test/skills.memory.test.ts",
  "packages/store/test/skills.mysql.test.ts",
  "packages/store/test/mcp-registry.test.ts",
  "packages/store/test/mcp-registry.mysql.test.ts",
  "packages/store/test/mcp-dcr.test.ts",
  "packages/store/test/mcp-dcr.mysql.test.ts",
  "packages/store/test/mcp-coordination.redis.test.ts",
  "packages/store/test/mcp-progress-publisher.redis.test.ts",
  "packages/store/test/redis-selection.redis.test.ts",
  "packages/store/test/frozen-dependencies.test.ts",
  "packages/store/test/credential-responsibility.memory.test.ts",
  "packages/store/test/tenant-credential-responsibility.mysql.test.ts",
  "packages/store/test/erasure-catalog.mysql.test.ts",
  "packages/store/test/erasure-job.mysql.test.ts",
  "packages/store/test/erasure-purge-policy.mysql.test.ts",
  "packages/store/test/erasure-session.mysql.test.ts",
  "packages/store/test/erasure-usage.mysql.test.ts",
  "packages/store/test/legacy-tombstone-compensation.mysql.test.ts",
  "packages/store/test/lifecycle-outbox.mysql.test.ts",
  "packages/store/test/memory-tenant-database-purge.test.ts",
  "packages/store/test/mysql-backup-schema-difference.test.ts",
  "packages/store/test/mysql-tenant-database-purge.test.ts",
  "packages/store/test/mysql-tenant-redis-purge.test.ts",
  "packages/store/test/operation-abort.test.ts",
  "packages/store/test/ordinary-session-usage-retention.memory.test.ts",
  "packages/store/test/ordinary-session-usage-retention.mysql.test.ts",
  "packages/store/test/ordinary-usage-retention-proof.test.ts",
  "packages/store/test/persisted-provider-capture.memory.test.ts",
  "packages/store/test/persisted-provider-capture.mysql.test.ts",
  "packages/store/test/redis-tenant-purge.test.ts",
  "packages/store/test/restore-journal-s3.unit.test.ts",
  "packages/store/test/retention-policy.mysql.test.ts",
  "packages/store/test/session-delete-grace.memory.test.ts",
  "packages/store/test/session-delete-grace.mysql.test.ts",
  "packages/store/test/subject-lifecycle.mysql.test.ts",
  "packages/store/test/tenant-content-inventory.mysql.test.ts",
  "packages/store/test/tenant-credential-lifecycle.mysql.test.ts",
  "packages/store/test/tenant-credential-physical-revocation.mysql.test.ts",
  "packages/store/test/tenant-credential-revocation-races.mysql.test.ts",
  "packages/store/test/tenant-credential-revocation.mysql.test.ts",
  "packages/store/test/tenant-credential-target-execution.mysql.test.ts",
  "packages/store/test/tenant-purge-execution.mysql.test.ts",
  "packages/store/test/tenant-purge-plan.memory.test.ts",
  "packages/store/test/tenant-purge-plan.mysql.test.ts",
  "packages/store/test/tenant-redis-purge.test.ts",
  "packages/store/test/tenant-restore-journal.memory.test.ts",
  "packages/store/test/tenant-restore-journal.mysql.test.ts",
  "packages/store/test/tenant-runtime-revocation.mysql.test.ts",
  "packages/store/test/tenant-telemetry-adapter-filesystem.test.ts",
  "packages/store/test/tenant-telemetry-adapter-http.test.ts",
  "packages/store/test/tenant-telemetry-adapter-memory.test.ts",
  "packages/store/test/tenant-telemetry-adapter-s3.unit.test.ts",
  "packages/store/test/tenant-telemetry-application-capture.memory.test.ts",
  "packages/store/test/tenant-telemetry-application-capture.mysql.test.ts",
  "packages/store/test/tenant-telemetry-application-capture.test.ts",
  "packages/store/test/tenant-telemetry-artifact-observer.unit.test.ts",
  "packages/store/test/tenant-telemetry-capture-restore.test.ts",
  "packages/store/test/tenant-telemetry-capture-checkpoint.memory.test.ts",
  "packages/store/test/tenant-telemetry-capture-checkpoint.mysql.test.ts",
  "packages/store/test/tenant-telemetry-capture-restore-maintenance.memory.test.ts",
  "packages/store/test/tenant-telemetry-capture-readonly-scope.test.ts",
  "packages/store/test/tenant-telemetry-capture-restore-maintenance.mysql.test.ts",
  "packages/store/test/tenant-telemetry-capture-epoch-cutover.mysql.test.ts",
  "packages/store/test/tenant-telemetry-capture-repeat-restore.mysql.test.ts",
  "packages/store/test/tenant-telemetry-disposition-adapter-memory.test.ts",
  "packages/store/test/tenant-telemetry-disposition-grant-v2-memory-fixture.test.ts",
  "packages/store/test/tenant-telemetry-disposition-grant.mysql.test.ts",
  "packages/store/test/tenant-telemetry-disposition-journal-v3-observer.unit.test.ts",
  "packages/store/test/tenant-telemetry-disposition-journal-v3.unit.test.ts",
  "packages/store/test/tenant-telemetry-disposition-s3.unit.test.ts",
  "packages/store/test/tenant-telemetry-disposition.memory.test.ts",
  "packages/store/test/tenant-telemetry-disposition.mysql.test.ts",
  "packages/store/test/tenant-telemetry-disposition.test.ts",
  "packages/store/test/tenant-telemetry-grant-v2-s3-observer.unit.test.ts",
  "packages/store/test/tenant-telemetry-lifecycle.memory.test.ts",
  "packages/store/test/tenant-telemetry-lifecycle.mysql.test.ts",
  "packages/store/test/tenant-telemetry-lifecycle.test.ts",
  "packages/store/test/tenant-telemetry-retained-source-budget.mysql.test.ts",
  "packages/store/test/tenant-telemetry-retained-source-derive.test.ts",
  "packages/store/test/tenant-telemetry-retained-source-json.mysql.test.ts",
  "packages/store/test/tenant-telemetry-retained-source-preflight.test.ts",
  "packages/store/test/tenant-telemetry-retained-source-projection.test.ts",
  "packages/store/test/tenant-telemetry-retained-source-t1.memory.test.ts",
  "packages/store/test/tenant-telemetry-retained-source-t3d.memory.test.ts",
  "packages/store/test/tenant-telemetry-retained-source-vertical.memory.test.ts",
  "packages/store/test/tenant-telemetry-retained-source.mysql.test.ts",
  "packages/store/test/tenant-telemetry-retained-source.test.ts",
  "packages/store/test/tenant-telemetry-writer.memory.test.ts",
  "packages/store/test/tenant-telemetry-writer.mysql.test.ts",
  "packages/store/test/tenant-telemetry-writer.test.ts",
  "packages/store/test/usage-lifecycle.mysql.test.ts",
  "packages/store/test/user-data-export.mysql.test.ts",
  "test/ci-required-jobs.test.ts",
  "test/main-coverage-shards.test.ts",
  "test/ci/migration-shards.test.ts",
  "test/required-coverage-manifest.test.ts",
  "test/required-suite-proof.test.ts",
  "test/runner-load-cli.test.ts",
  "test/runner-load.test.ts",
  "test/vm-release-archive.test.ts",
  "test/vm-release-sign-cli.test.ts",
  "test/vm-release-signature.test.ts",
  "test/vm-release-signed.test.ts",
  "test/vm-release-tool.test.ts",
  "test/vm-release.test.ts"
]);

// Preserve the removed named-command -> exact files mapping as visible proof groups.
// Overlapping groups never add duplicate cases to the unique-file execution total.
export const REQUIRED_COVERAGE_GROUPS = Object.freeze({
  "test:session-authority": [
    "packages/store/test/session-authority-boundaries.test.ts",
    "packages/store/test/session-authority-schema.test.ts",
    "packages/store/test/session-authority-operator-admission.test.ts",
    "packages/store/test/session-authority.memory.test.ts",
    "packages/store/test/mysql-stopped-maintenance-profile.test.ts",
    "packages/core/test/session-authority-runtime.test.ts",
    "apps/agent-router/test/session-authority-observation.test.ts",
    "apps/agent-runner/test/session-authority-operator.test.ts",
    "test/mysql-authority-cli-executor.test.ts"
  ],
  "test:session-authority-mysql": [
    "packages/store/test/session-authority.mysql.test.ts",
    "packages/store/test/session-authority-retirement.mysql.test.ts",
    "packages/store/test/session-authority-subagents.mysql.test.ts"
  ],
  "test:runtime-shutdown": [
    "packages/core/test/host-shutdown.test.ts",
    "apps/agent-runner/test/process-owner.test.ts",
    "apps/agent-runner/test/main.test.ts",
    "apps/agent-router/test/main.test.ts"
  ],
  "test:runtime-shutdown-redis": [
    "packages/store/test/redis-event-bus-unknown.test.ts"
  ],
  "test:restore-native-stop": [
    "apps/agent-runner/test/restore-ledger-authority-budget.test.ts",
    "apps/agent-runner/test/restore-ledger-reconcile-native-stop.test.ts",
    "packages/store/test/restore-journal-owned-native.test.ts",
    "apps/agent-runner/test/restore-ledger-reconcile-cli.test.ts"
  ],
  "test:sse-observation": [
    "packages/core/test/host-observation.test.ts",
    "apps/agent-runner/test/sse-bounds.test.ts",
    "apps/agent-runner/test/mcp-progress-sse.test.ts",
  ],
  "test:http-experience": [
    "test/http-experience.test.ts",
    "test/http-experience-fixture.test.ts",
  ],
  "test:web-fetch": [
    "packages/core/test/tools.test.ts",
    "packages/core/test/web-fetch-native.test.ts",
  ],
  "test:record-assistant-reference": [
    "packages/sdk/test/record-assistant-reference.test.ts",
  ],
  "test:record-assistant-reference-mysql": [
    "apps/agent-runner/test/record-assistant-reference.mysql.test.ts",
  ],
  "test:provider-compaction-mysql": [
    "apps/agent-runner/test/provider-compaction.mysql.test.ts",
  ],
  "test:cluster-harness-startup": [
    "test/harness-startup-ownership.test.ts",
  ],
  "test:schema-fixtures": [
    "test/mysql-runtime-fixture.test.ts",
    "test/mysql-schema-cli-executor.test.ts",
    "test/ci-owned-mysql-authority.test.ts",
    "test/ci-image-runtime.test.ts",
  ],
  "test:schema-operations": [
    "apps/agent-runner/test/schema-cli.test.ts",
    "packages/store/test/mysql-schema-operation.test.ts",
  ],
  "test:schema-operations-mysql": [
    "packages/store/test/mysql-schema-operation.mysql.test.ts",
  ],
  "test:schema-metadata": [
    "packages/store/test/schema-metadata-codec.test.ts",
    "packages/store/test/mysql-schema-metadata.test.ts",
    "packages/store/test/mysql-schema-metadata-verifier.test.ts",
    "packages/store/test/mysql-schema-metadata-install.test.ts",
  ],
  "test:schema-metadata-mysql": [
    "packages/store/test/mysql-schema-metadata.mysql.test.ts",
  ],
  "test:schema-authority": [
    "packages/store/test/schema-runtime-privileges.test.ts",
  ],
  "test:schema-authority-mysql": [
    "packages/store/test/mysql-schema-authority.mysql.test.ts",
  ],
  "test:schema-runtime-config": [
    "apps/agent-runner/test/mysql-schema-config.test.ts",
    "apps/agent-runner/test/main-schema-runtime.test.ts",
  ],
  "test:provider-gateway": [
    "packages/store/test/provider-quota.test.ts",
    "packages/providers/test/quota-service.test.ts",
    "packages/core/test/pi-provider-admission.test.ts",
    "packages/core/test/host-provider-admission.test.ts",
    "apps/agent-runner/test/provider-gateway-config.test.ts",
    "apps/agent-runner/test/provider-gateway-gate.test.ts",
    "apps/agent-router/test/provider-gateway-config.test.ts",
    "apps/agent-router/test/provider-gateway.test.ts",
    "apps/agent-router/test/provider-gateway-fleet-isolation.test.ts",
  ],
  "test:provider-key-pool": [
    "apps/agent-runner/test/provider-key-pool.test.ts",
  ],
  "test:provider-request-lifetime": [
    "packages/core/test/pi-provider-request.test.ts",
  ],
  "test:provider-pool": [
    "packages/store/test/provider-pool.test.ts",
    "packages/providers/test/pool-service.test.ts",
    "apps/agent-runner/test/provider-key-pool-runtime-config.test.ts",
  ],
  "test:provider-byok-breaker": [
    "packages/providers/test/byok-breaker-service.test.ts",
    "apps/agent-runner/test/provider-byok-breaker-config.test.ts",
  ],
  "test:provider-byok-breaker-redis": [
    "packages/providers/test/byok-breaker-service.redis.test.ts",
    "apps/agent-runner/test/provider-gateway-startup.test.ts",
  ],
  "test:provider-fallback-policy": [
    "packages/protocol/test/provider-fallback-policy.test.ts",
  ],
  "test:provider-fallback": [
    "packages/core/test/pi-provider-fallback.test.ts",
    "packages/core/test/host-provider-fallback.test.ts",
    "packages/providers/test/provider-fallback-service.test.ts",
    "apps/agent-runner/test/provider-key-pools.test.ts",
    "apps/agent-runner/test/provider-platform-fallback-config.test.ts",
    "apps/agent-runner/test/provider-platform-fallback-startup.test.ts",
  ],
  "test:provider-gateway-chaos": [
    "packages/providers/test/provider-gateway-chaos.redis.test.ts",
  ],
  "test:runner-load-native": [
    "packages/providers/test/fake-vendor-load.test.ts",
  ],
  "test:provider-gateway-metrics": [
    "packages/protocol/test/provider-gateway-metrics.test.ts",
    "packages/providers/test/gateway-metrics-service.test.ts",
  ],
  "test:provider-pool-redis": [
    "packages/store/test/provider-pool.redis.test.ts",
    "packages/providers/test/pool-service.redis.test.ts",
    "apps/agent-runner/test/provider-gateway-startup.test.ts",
  ],
  "test:provider-gateway-redis": [
    "packages/store/test/provider-quota.redis.test.ts",
    "packages/providers/test/quota-service.redis.test.ts",
    "apps/agent-runner/test/provider-gateway-startup.test.ts",
  ],
  "test:lifecycle-hooks": [
    "packages/protocol/test/lifecycle-hooks-contract.test.ts",
    "packages/core/test/lifecycle-hooks.test.ts",
    "packages/core/test/host-lifecycle-hooks.test.ts",
    "apps/agent-runner/test/lifecycle-hooks-config.test.ts",
  ],
  "test:runtime-extensions": [
    "apps/agent-runner/test/runtime-extensions-gate.test.ts",
    "apps/agent-runner/test/runtime-extensions-http.test.ts",
    "apps/agent-router/test/runtime-extensions-config.test.ts",
    "apps/agent-router/test/runtime-extensions.test.ts",
  ],
  "test:subagents": [
    "packages/protocol/test/subagents.test.ts",
    "packages/sdk/test/subagents.test.ts",
    "packages/core/test/subagent-policy.test.ts",
    "packages/core/test/host-subagents.test.ts",
    "packages/store/test/subagents.test.ts",
    "apps/agent-runner/test/subagents-vertical.test.ts",
    "apps/agent-runner/test/subagents-config.test.ts",
    "apps/agent-runner/test/subagent-routes.test.ts",
    "apps/agent-runner/test/subagent-control-guard.test.ts",
  ],
  "test:subagents-mysql": [
    "packages/store/test/subagents.mysql.test.ts",
    "apps/agent-runner/test/subagents-vertical.mysql.test.ts",
  ],
  "test:tenant-hooks-store": ["packages/store/test/tenant-webhooks.test.ts", "packages/store/test/tenant-webhooks.memory.test.ts"],
  "test:tenant-hooks-store-mysql": ["packages/store/test/tenant-webhooks.mysql.test.ts"],
  "test:tenant-hooks": [
    "test/openapi-contract.test.ts",
    "packages/protocol/test/tenant-hooks-contract.test.ts",
    "packages/sdk/test/tenant-hooks.test.ts",
    "packages/core/test/tenant-webhook-cipher.test.ts",
    "packages/core/test/tenant-webhook-v2.test.ts",
    "packages/core/test/host-tenant-webhooks.test.ts",
    "apps/agent-runner/test/tenant-hooks-config.test.ts",
    "apps/agent-runner/test/tenant-hooks-gate.test.ts",
    "apps/agent-runner/test/tenant-hooks-http.test.ts",
    "apps/agent-router/test/tenant-hooks-config.test.ts",
    "apps/agent-router/test/tenant-hooks.test.ts"
  ],
  "test:tenant-hooks-mysql": ["apps/agent-runner/test/tenant-hooks-vertical.mysql.test.ts"],
  "test:ci-shards": [
    "test/main-coverage-shards.test.ts",
    "test/ci/migration-shards.test.ts",
    "test/ci-required-jobs.test.ts",
    "test/required-coverage-manifest.test.ts",
    "test/required-suite-proof.test.ts"
  ],
  "test:hooks": [
    "test/openapi-contract.test.ts",
    "packages/core/test/tool-hooks.test.ts",
    "packages/core/test/host-hooks.test.ts",
    "packages/protocol/test/hooks-contract.test.ts",
    "apps/agent-runner/test/hooks-config.test.ts",
    "apps/agent-runner/test/hooks-runtime.test.ts",
    "apps/agent-runner/test/hooks-vertical.test.ts"
  ],
  "test:hooks-mysql": ["apps/agent-runner/test/hooks-vertical.mysql.test.ts"],
  "test:mcp": [
    "test/openapi-contract.test.ts",
    "packages/core/test/mcp-http.test.ts",
    "packages/core/test/mcp-service.test.ts",
    "packages/core/test/mcp-sdk-compat.test.ts",
    "packages/core/test/host-mcp.test.ts",
    "packages/core/test/host-mcp-grant-recovery.test.ts",
    "apps/agent-runner/test/mcp-config.test.ts",
    "apps/agent-runner/test/mcp-vertical.test.ts"
  ],
  "test:mcp-mysql": ["apps/agent-runner/test/mcp-vertical.mysql.test.ts"],
  "test:mcp-progress": [
    "test/openapi-contract.test.ts",
    "packages/protocol/test/mcp-progress-contract.test.ts",
    "packages/sdk/test/sse.test.ts",
    "apps/agent-runner/test/mcp-progress-sse.test.ts",
    "packages/core/test/host-mcp-progress.test.ts",
    "packages/core/test/pi-mcp-progress.test.ts",
    "apps/agent-runner/test/mcp-progress-vertical.test.ts"
  ],
  "test:mcp-progress-mysql": ["apps/agent-runner/test/mcp-progress-vertical.mysql.test.ts"],
  "test:mcp-progress-redis": ["packages/store/test/mcp-progress-publisher.redis.test.ts"],
  "test:mcp-registry": [
    "test/openapi-contract.test.ts",
    "packages/protocol/test/mcp-registry-contract.test.ts",
    "packages/core/test/mcp-cipher.test.ts",
    "packages/core/test/mcp-network.test.ts",
    "packages/core/test/mcp-pool.test.ts",
    "packages/core/test/mcp-registered.test.ts",
    "packages/core/test/host-registered-mcp.test.ts",
    "apps/agent-runner/test/mcp-registry-config.test.ts",
    "apps/agent-runner/test/mcp-registry-gate.test.ts",
    "apps/agent-runner/test/mcp-registry-http.test.ts",
    "apps/agent-router/test/mcp-registry-config.test.ts",
    "apps/agent-router/test/mcp-registry.test.ts",
    "packages/sdk/test/mcp.test.ts"
  ],
  "test:mcp-registry-store": ["packages/store/test/mcp-registry.test.ts"],
  "test:mcp-registry-mysql": [
    "packages/store/test/mcp-registry.mysql.test.ts",
    "apps/agent-runner/test/mcp-registry-vertical.mysql.test.ts",
    "apps/agent-runner/test/mcp-registry-oauth.mysql.test.ts"
  ],
  "test:mcp-registry-redis": ["packages/store/test/mcp-coordination.redis.test.ts"],
  "test:mcp-dcr": [
    "test/openapi-contract.test.ts",
    "packages/protocol/test/mcp-dcr.test.ts",
    "packages/core/test/mcp-cipher.test.ts",
    "packages/core/test/mcp-network.test.ts",
    "packages/core/test/mcp-dcr.test.ts",
    "packages/store/test/mcp-dcr.test.ts",
    "apps/agent-runner/test/mcp-registry-gate.test.ts",
    "apps/agent-runner/test/mcp-registry-http.test.ts",
    "apps/agent-router/test/mcp-registry.test.ts",
    "packages/sdk/test/mcp.test.ts"
  ],
  "test:mcp-dcr-mysql": ["packages/store/test/mcp-dcr.mysql.test.ts", "apps/agent-runner/test/mcp-dcr.mysql.test.ts", "packages/core/test/mcp-dcr-crash.mysql.test.ts"],
  "test:redis-selection": ["packages/protocol/test/redis-selection.test.ts"],
  "test:redis-selection-redis": ["packages/store/test/redis-selection.redis.test.ts"],
  "test:skills": [
    "test/openapi-contract.test.ts",
    "packages/core/test/skills-static.test.ts",
    "packages/core/test/host-skills.test.ts",
    "packages/core/test/assemble-skills.test.ts",
    "apps/agent-runner/test/skills-config.test.ts",
    "packages/protocol/test/skills-contract.test.ts",
    "apps/agent-runner/test/skills-runner-contract.test.ts",
    "apps/agent-runner/test/skills-vertical.test.ts",
    "packages/store/test/skills.test.ts",
    "packages/store/test/skills.memory.test.ts",
    "packages/core/test/skills-document-guard.test.ts",
    "packages/core/test/skills-registered.test.ts",
    "packages/core/test/skills-registered-io-settlement.test.ts",
    "packages/core/test/host-registered-skills.test.ts",
    "packages/core/test/skills-registry-export.test.ts",
    "packages/protocol/test/skills-registry-contract.test.ts",
    "packages/sdk/test/skills.test.ts",
    "apps/agent-runner/test/skills-registry-config.test.ts",
    "apps/agent-runner/test/skills-registry-http.test.ts",
    "apps/agent-router/test/skills-registry-config.test.ts",
    "apps/agent-router/test/skills-registry.test.ts"
  ],
  "test:skills-mysql": ["apps/agent-runner/test/skills-vertical.mysql.test.ts", "packages/store/test/skills.mysql.test.ts", "apps/agent-runner/test/skills-registry-vertical.mysql.test.ts"],
  "test:frozen-dependencies": ["packages/store/test/frozen-dependencies.test.ts"],
  "test:mysql-backup-source-observer": [
    "apps/agent-runner/test/mysql-backup-artifact-source-observer.test.ts",
    "apps/agent-runner/test/tenant-restore-journal-config.test.ts"
  ],
  "test:tenant-telemetry-capture-repeat-restore-mysql": [
    "packages/store/test/tenant-telemetry-capture-repeat-restore.mysql.test.ts"
  ],
  "test:tenant-telemetry-capture-restore": [
    "packages/store/test/tenant-telemetry-capture-restore.test.ts",
    "packages/store/test/tenant-telemetry-capture-checkpoint.memory.test.ts",
    "packages/store/test/tenant-telemetry-capture-restore-maintenance.memory.test.ts",
    "packages/store/test/tenant-telemetry-capture-readonly-scope.test.ts"
  ],
  "test:tenant-telemetry-capture-restore-mysql": [
    "packages/store/test/tenant-telemetry-capture-checkpoint.mysql.test.ts",
    "packages/store/test/tenant-telemetry-capture-restore-maintenance.mysql.test.ts",
    "packages/store/test/tenant-telemetry-capture-epoch-cutover.mysql.test.ts"
  ],
  "test:tenant-telemetry-lifecycle": [
    "packages/store/test/tenant-telemetry-lifecycle.test.ts"
  ],
  "test:tenant-telemetry-lifecycle-memory": [
    "packages/store/test/tenant-telemetry-lifecycle.memory.test.ts"
  ],
  "test:tenant-telemetry-lifecycle-mysql": [
    "packages/store/test/tenant-telemetry-lifecycle.mysql.test.ts"
  ],
  "test:tenant-telemetry-application-capture": [
    "packages/store/test/tenant-telemetry-application-capture.test.ts",
    "packages/store/test/tenant-telemetry-application-capture.memory.test.ts"
  ],
  "test:telemetry-capture-operator": [
    "apps/agent-runner/test/telemetry-capture-ref-key.test.ts",
    "apps/agent-runner/test/telemetry-capture-cli.test.ts",
    "apps/agent-runner/test/telemetry-capture-wrapper.test.ts"
  ],
  "test:telemetry-operator-key-compatibility": [
    "apps/agent-runner/test/telemetry-capture-ref-key.test.ts",
    "apps/agent-runner/test/backup-catalog-cli.test.ts",
    "apps/agent-runner/test/restore-ledger-reconcile-cli.test.ts",
    "apps/agent-runner/test/backup-catalog-wrapper.test.ts",
    "apps/agent-runner/test/restore-ledger-reconcile-wrapper.test.ts",
    "apps/agent-runner/test/telemetry-capture-wrapper.test.ts"
  ],
  "test:persisted-provider-failure-capture": [
    "packages/core/test/pi-provider-failure.test.ts",
    "packages/core/test/host-persisted-provider-failure.test.ts",
    "packages/core/test/persisted-provider-failure-capture.test.ts",
    "packages/core/test/persisted-provider-capture-worker.test.ts",
    "apps/agent-runner/test/persisted-provider-capture-gate.test.ts",
    "apps/agent-runner/test/persisted-provider-capture-ready.test.ts",
    "apps/agent-router/test/persisted-provider-capture.test.ts"
  ],
  "test:persisted-provider-capture-mysql": [
    "packages/store/test/persisted-provider-capture.mysql.test.ts"
  ],
  "test:tenant-telemetry-retained-source": [
    "packages/store/test/tenant-telemetry-retained-source.test.ts",
    "packages/store/test/tenant-telemetry-retained-source-projection.test.ts",
    "packages/store/test/tenant-telemetry-retained-source-preflight.test.ts",
    "packages/store/test/tenant-telemetry-retained-source-derive.test.ts",
    "packages/store/test/tenant-telemetry-retained-source-t1.memory.test.ts",
    "packages/store/test/tenant-telemetry-retained-source-t3d.memory.test.ts",
    "packages/store/test/tenant-telemetry-retained-source-vertical.memory.test.ts"
  ],
  "test:tenant-telemetry-retained-source-json-mysql": [
    "packages/store/test/tenant-telemetry-retained-source-json.mysql.test.ts"
  ],
  "test:tenant-telemetry-retained-source-budget-mysql": [
    "packages/store/test/tenant-telemetry-retained-source-budget.mysql.test.ts"
  ],
  "test:tenant-telemetry-retained-source-mysql": [
    "packages/store/test/tenant-telemetry-retained-source.mysql.test.ts"
  ],
  "test:tenant-telemetry-application-capture-mysql": [
    "packages/store/test/tenant-telemetry-application-capture.mysql.test.ts"
  ],
  "test:tenant-telemetry-writer": [
    "packages/store/test/tenant-telemetry-writer.test.ts",
    "packages/store/test/tenant-telemetry-writer.memory.test.ts",
    "packages/store/test/tenant-telemetry-adapter-memory.test.ts",
    "packages/store/test/tenant-telemetry-adapter-http.test.ts",
    "packages/store/test/tenant-telemetry-adapter-filesystem.test.ts",
    "packages/store/test/tenant-telemetry-adapter-s3.unit.test.ts",
    "packages/core/test/tenant-telemetry-writer-worker.test.ts",
    "packages/core/test/tenant-telemetry-application-dual-write.test.ts",
    "packages/providers/test/telemetry-dual-write.test.ts",
    "apps/agent-runner/test/tenant-telemetry-writer-config.test.ts",
    "apps/agent-runner/test/config.test.ts",
    "apps/agent-router/test/config.test.ts"
  ],
  "test:tenant-telemetry-writer-mysql": [
    "packages/store/test/tenant-telemetry-writer.mysql.test.ts"
  ],
  "test:tenant-telemetry-disposition": [
    "packages/store/test/tenant-telemetry-disposition.test.ts",
    "packages/store/test/tenant-telemetry-disposition-adapter-memory.test.ts",
    "packages/store/test/tenant-telemetry-disposition-s3.unit.test.ts",
    "packages/store/test/tenant-telemetry-disposition.memory.test.ts"
  ],
  "test:tenant-telemetry-disposition-mysql": [
    "packages/store/test/tenant-telemetry-disposition.mysql.test.ts"
  ],
  "test:tenant-telemetry-disposition-grant": [
    "packages/store/test/tenant-telemetry-disposition-grant-v2-memory-fixture.test.ts",
    "packages/store/test/tenant-telemetry-grant-v2-s3-observer.unit.test.ts"
  ],
  "test:tenant-telemetry-disposition-journal-v3": [
    "packages/store/test/tenant-telemetry-disposition-journal-v3.unit.test.ts"
  ],
  "test:tenant-telemetry-disposition-journal-v3-observer": [
    "packages/store/test/tenant-telemetry-disposition-journal-v3-observer.unit.test.ts"
  ],
  "test:tenant-telemetry-disposition-grant-mysql": [
    "packages/store/test/tenant-telemetry-disposition-grant.mysql.test.ts"
  ],
  "test:session-delete-grace-mysql": [
    "packages/store/test/session-delete-grace.mysql.test.ts"
  ],
  "test:session-delete-grace-recovery-memory": [
    "packages/core/test/ordinary-session-delete-grace-recovery.test.ts"
  ],
  "test:session-delete-grace-recovery-mysql": [
    "apps/agent-runner/test/ordinary-session-delete-grace-recovery.mysql.test.ts"
  ],
  "test:session-usage-retention-memory": [
    "packages/store/test/ordinary-usage-retention-proof.test.ts",
    "packages/store/test/ordinary-session-usage-retention.memory.test.ts"
  ],
  "test:session-usage-retention-worker": [
    "packages/core/test/ordinary-session-usage-retention-worker.test.ts",
    "apps/agent-runner/test/ordinary-session-usage-retention-gate.test.ts",
    "apps/agent-router/test/ordinary-session-usage-retention.test.ts"
  ],
  "test:session-usage-retention-mysql": [
    "packages/store/test/ordinary-session-usage-retention.mysql.test.ts"
  ],
  "test:session-usage-retention-worker-mysql": [
    "apps/agent-runner/test/ordinary-session-usage-retention.mysql.test.ts"
  ],
  "test:blob-mysql": [
    "packages/store/test/blob-lifecycle.mysql.test.ts"
  ],
  "test:blob-storage-control-memory": [
    "packages/store/test/blob-storage-control.memory.test.ts"
  ],
  "test:blob-storage-control-mysql": [
    "packages/store/test/blob-storage-control.mysql.test.ts"
  ],
  "test:tenant-restore-journal-memory": [
    "packages/store/test/tenant-restore-journal.memory.test.ts"
  ],
  "test:tenant-restore-journal-mysql": [
    "packages/store/test/tenant-restore-journal.mysql.test.ts"
  ],
  "test:tenant-backup-catalog-mysql": [
    "packages/store/test/backup-catalog.mysql.test.ts"
  ],
  "test:outbox-mysql": [
    "packages/store/test/lifecycle-outbox.mysql.test.ts"
  ],
  "test:usage-lifecycle-mysql": [
    "packages/store/test/usage-lifecycle.mysql.test.ts"
  ],
  "test:subject-lifecycle-mysql": [
    "packages/store/test/subject-lifecycle.mysql.test.ts"
  ],
  "test:tenant-credential-revocation-mysql": [
    "packages/store/test/tenant-credential-revocation.mysql.test.ts",
    "packages/store/test/tenant-credential-revocation-races.mysql.test.ts"
  ],
  "test:tenant-credential-physical-revocation-mysql": [
    "packages/store/test/tenant-credential-physical-revocation.mysql.test.ts"
  ],
  "test:tenant-credential-lifecycle-mysql": [
    "packages/store/test/tenant-credential-lifecycle.mysql.test.ts"
  ],
  "test:credential-responsibility-memory": [
    "packages/store/test/credential-responsibility.test.ts",
    "packages/store/test/credential-responsibility.memory.test.ts",
    "packages/providers/test/credential-responsibility-service.test.ts",
    "apps/agent-runner/test/credential-responsibility-http.test.ts"
  ],
  "test:credential-responsibility-mysql": [
    "packages/store/test/tenant-credential-responsibility.mysql.test.ts"
  ],
  "test:tenant-credential-target-execution-mysql": [
    "packages/store/test/tenant-credential-target-execution.mysql.test.ts"
  ],
  "test:tenant-runtime-revocation-mysql": [
    "packages/store/test/tenant-runtime-revocation.mysql.test.ts"
  ],
  "test:tenant-content-inventory-mysql": [
    "packages/store/test/tenant-content-inventory.mysql.test.ts"
  ],
  "test:tenant-purge-plan-memory": [
    "packages/store/test/tenant-purge-plan.memory.test.ts"
  ],
  "test:tenant-purge-plan-mysql": [
    "packages/store/test/tenant-purge-plan.mysql.test.ts"
  ],
  "test:tenant-purge-execution-mysql": [
    "packages/store/test/tenant-purge-execution.mysql.test.ts"
  ],
  "test:tenant-database-purge-memory": [
    "packages/store/test/memory-tenant-database-purge.test.ts"
  ],
  "test:session-delete-grace-memory": [
    "packages/store/test/session-delete-grace.memory.test.ts"
  ],
  "test:tenant-database-purge-mysql": [
    "packages/store/test/mysql-tenant-database-purge.test.ts"
  ],
  "test:tenant-redis-purge-memory": [
    "packages/store/test/tenant-redis-purge.test.ts"
  ],
  "test:tenant-redis-purge-mysql": [
    "packages/store/test/mysql-tenant-redis-purge.test.ts"
  ],
  "test:tenant-redis-purge-redis": [
    "packages/store/test/redis-tenant-purge.test.ts"
  ],
  "test:retention-policy-mysql": [
    "packages/store/test/retention-policy.mysql.test.ts"
  ],
  "test:erasure-purge-policy-mysql": [
    "packages/store/test/erasure-purge-policy.mysql.test.ts"
  ],
  "test:erasure-job-mysql": [
    "packages/store/test/erasure-job.mysql.test.ts"
  ],
  "test:erasure-session-mysql": [
    "packages/store/test/erasure-session.mysql.test.ts"
  ],
  "test:erasure-catalog-mysql": [
    "packages/store/test/erasure-catalog.mysql.test.ts"
  ],
  "test:erasure-usage-mysql": [
    "packages/store/test/erasure-usage.mysql.test.ts"
  ],
  "test:legacy-tombstone-mysql": [
    "packages/store/test/legacy-tombstone-compensation.mysql.test.ts"
  ],
  "test:user-data-export-mysql": [
    "packages/store/test/user-data-export.mysql.test.ts"
  ],
  "test:vm-release": [
    "test/vm-release.test.ts",
    "apps/agent-runner/test/cli-entrypoint.test.ts",
    "test/vm-release-archive.test.ts",
    "test/vm-release-tool.test.ts",
    "test/vm-release-signature.test.ts",
    "test/vm-release-signed.test.ts",
    "test/vm-release-sign-cli.test.ts"
  ],
  "test:local-service-tools": [
    "test/local-service-tool-authority.test.ts"
  ],
  "test:local-service-external": [
    "test/local-service-external-infra.test.ts"
  ],
  "test:tenant-telemetry-artifact-observer": [
    "packages/store/test/tenant-telemetry-artifact-observer.unit.test.ts"
  ]
});
