// Main-profile files previously enforced by the broad checker or equivalent named commands.
// S3, historical migration, cluster and actual artifact checks remain independent profiles.
export const REQUIRED_COVERAGE_TEST_FILES = Object.freeze([
  "apps/agent-router/test/app.test.ts",
  "apps/agent-router/test/config.test.ts",
  "apps/agent-router/test/ordinary-session-usage-retention.test.ts",
  "apps/agent-router/test/persisted-provider-capture.test.ts",
  "apps/agent-router/test/runtime-metrics-config.test.ts",
  "apps/agent-router/test/runtime-metrics.test.ts",
  "apps/agent-runner/test/backup-catalog-cli.test.ts",
  "apps/agent-runner/test/backup-catalog-wrapper.test.ts",
  "apps/agent-runner/test/cli-entrypoint.test.ts",
  "apps/agent-runner/test/config.test.ts",
  "apps/agent-runner/test/mysql-backup-artifact.unit.test.ts",
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
  "apps/agent-runner/test/tenant-redis-purge-gate.test.ts",
  "apps/agent-runner/test/tenant-telemetry-writer-config.test.ts",
  "packages/core/test/erasure-worker.mysql.test.ts",
  "packages/core/test/host-persisted-provider-failure.test.ts",
  "packages/core/test/host.test.ts",
  "packages/core/test/ordinary-session-delete-grace-recovery.test.ts",
  "packages/core/test/ordinary-session-usage-retention-worker.test.ts",
  "packages/core/test/persisted-provider-capture-worker.test.ts",
  "packages/core/test/persisted-provider-failure-capture.test.ts",
  "packages/core/test/pi-provider-failure.test.ts",
  "packages/core/test/tenant-redis-purge-worker.test.ts",
  "packages/core/test/tenant-telemetry-application-dual-write.test.ts",
  "packages/core/test/tenant-telemetry-writer-worker.test.ts",
  "packages/protocol/test/telemetry.test.ts",
  "packages/protocol/test/runtime-metrics.test.ts",
  "packages/providers/test/telemetry-dual-write.test.ts",
  "packages/store/test/backup-catalog-s3.unit.test.ts",
  "packages/store/test/backup-catalog.mysql.test.ts",
  "packages/store/test/blob-lifecycle.mysql.test.ts",
  "packages/store/test/blob-storage-control.memory.test.ts",
  "packages/store/test/blob-storage-control.mysql.test.ts",
  "packages/store/test/erasure-catalog.mysql.test.ts",
  "packages/store/test/erasure-job.mysql.test.ts",
  "packages/store/test/erasure-purge-policy.mysql.test.ts",
  "packages/store/test/erasure-session.mysql.test.ts",
  "packages/store/test/erasure-usage.mysql.test.ts",
  "packages/store/test/legacy-tombstone-compensation.mysql.test.ts",
  "packages/store/test/lifecycle-outbox.mysql.test.ts",
  "packages/store/test/memory-tenant-database-purge.test.ts",
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
  "test/required-coverage-manifest.test.ts",
  "test/required-suite-proof.test.ts",
  "test/vm-release-archive.test.ts",
  "test/vm-release-tool.test.ts",
  "test/vm-release.test.ts"
]);

// Preserve the removed named-command -> exact files mapping as visible proof groups.
// Overlapping groups never add duplicate cases to the unique-file execution total.
export const REQUIRED_COVERAGE_GROUPS = Object.freeze({
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
    "test/vm-release-tool.test.ts"
  ],
  "test:tenant-telemetry-artifact-observer": [
    "packages/store/test/tenant-telemetry-artifact-observer.unit.test.ts"
  ]
});
