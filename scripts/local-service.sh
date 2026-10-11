#!/usr/bin/env bash
# Local operations entrypoint for the runner + router stack.
# Keeps application PIDs/logs under .local-run/ and delegates MySQL/Redis to deploy/local/infra.sh.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# The one-shot migration/restore/backup commands are operator-authority surfaces. Preserve every
# caller-provided setting, including an explicitly empty value, before loading local defaults. The
# AWS SDK may use any exported AWS_* setting through its default credential/endpoint provider
# chain, so preserve those caller values as well instead of letting .env silently retarget them.
caller_mover_env_names=(
  NODE_ENV
  MYSQL_URL
  MIGRATION_ID
  FLEET_DRAINED_EVIDENCE_SHA256
  ROLLBACK_WINDOW_MS
  SOURCE_CLEANUP_DELAY_MS
  MAX_OBJECT_BYTES
  BLOB_MIGRATION_COMMIT
  RESTORE_RUN_ID
  RESTORE_FLEET_STOPPED_ACK
  BACKUP_ID
  BACKUP_RUNTIME_EPOCH_ID
  SOURCE_SNAPSHOT_SHA256
  SOURCE_BACKUP_SHA256
  BACKUP_ARTIFACT_MANIFEST_SHA256
  BACKUP_PROVIDER_EVIDENCE_SHA256
  BACKUP_EVICTION_ID
  EXTERNAL_TOMBSTONE_SHA256
  BACKUP_PHYSICAL_ABSENCE_ACK
  RESTORE_REPLAY_PAGE_SIZE
  BLOB_STORE
  BLOB_DIR
  BLOB_NAMESPACE_ID
  BLOB_S3_ENDPOINT
  BLOB_S3_REGION
  BLOB_S3_BUCKET
  BLOB_S3_PREFIX
  BLOB_S3_FORCE_PATH_STYLE
  BLOB_S3_PRIVATE_BUCKET_ACK
  BLOB_S3_REQUEST_TIMEOUT_MS
  BLOB_S3_ACCESS_KEY_ID
  BLOB_S3_SECRET_ACCESS_KEY
  BLOB_S3_SESSION_TOKEN
)
while IFS= read -r caller_env_name; do
  case "$caller_env_name" in
    AWS_*|RESTORE_JOURNAL_*|TENANT_RESTORE_JOURNAL_*|BACKUP_CATALOG_*|TENANT_BACKUP_CATALOG_*)
      caller_mover_env_names+=("$caller_env_name")
      ;;
  esac
done < <(compgen -e)

caller_mover_env_was_set=()
caller_mover_env_values=()
for caller_env_name in "${caller_mover_env_names[@]}"; do
  if [ "${!caller_env_name+x}" = x ]; then
    caller_mover_env_was_set+=(1)
    caller_mover_env_values+=("${!caller_env_name}")
  else
    caller_mover_env_was_set+=(0)
    caller_mover_env_values+=("")
  fi
done

# Load local defaults while keeping the explicitly snapshotted topology overrides authoritative.
caller_runner_port="${RUNNER_PORT-}"
caller_router_port="${ROUTER_PORT-}"
caller_runner_id="${RUNNER_ID-}"
caller_runner_addr="${RUNNER_ADDR-}"
caller_runners="${RUNNERS-}"
caller_redis_url="${REDIS_URL-}"
caller_redis_prefix="${REDIS_PREFIX-}"
caller_redis_namespace_id="${REDIS_NAMESPACE_ID-}"
caller_session_tombstone_enabled="${SESSION_TOMBSTONE_ENABLED-}"
caller_data_erasure_requests_enabled="${DATA_ERASURE_REQUESTS_ENABLED-}"
caller_tenant_erasure_requests_enabled="${TENANT_ERASURE_REQUESTS_ENABLED-}"
caller_tenant_erasure_operator_token="${TENANT_ERASURE_OPERATOR_TOKEN-}"
caller_tenant_erasure_operator_id="${TENANT_ERASURE_OPERATOR_ID-}"
caller_tenant_erasure_barrier_timeout_ms="${TENANT_ERASURE_BARRIER_TIMEOUT_MS-}"
caller_tenant_credential_revocation_worker_enabled="${TENANT_CREDENTIAL_REVOCATION_WORKER_ENABLED-}"
caller_tenant_credential_revocation_execution_enabled="${TENANT_CREDENTIAL_REVOCATION_EXECUTION_ENABLED-}"
caller_credential_lifecycle_tracking_enabled="${CREDENTIAL_LIFECYCLE_TRACKING_ENABLED-}"
caller_credential_target_execution_adapter="${CREDENTIAL_TARGET_EXECUTION_ADAPTER-}"
caller_tenant_credential_target_execution_worker_enabled="${TENANT_CREDENTIAL_TARGET_EXECUTION_WORKER_ENABLED-}"
caller_tenant_credential_target_execution_enabled="${TENANT_CREDENTIAL_TARGET_EXECUTION_ENABLED-}"
caller_tenant_runtime_drain_enabled="${TENANT_RUNTIME_DRAIN_ENABLED-}"
caller_tenant_runtime_revocation_worker_enabled="${TENANT_RUNTIME_REVOCATION_WORKER_ENABLED-}"
caller_tenant_runtime_drain_execution_enabled="${TENANT_RUNTIME_DRAIN_EXECUTION_ENABLED-}"
caller_tenant_content_inventory_worker_enabled="${TENANT_CONTENT_INVENTORY_WORKER_ENABLED-}"
caller_tenant_purge_plan_worker_enabled="${TENANT_PURGE_PLAN_WORKER_ENABLED-}"
caller_tenant_purge_execution_worker_enabled="${TENANT_PURGE_EXECUTION_WORKER_ENABLED-}"
caller_tenant_purge_execution_enabled="${TENANT_PURGE_EXECUTION_ENABLED-}"
caller_tenant_database_purge_worker_enabled="${TENANT_DATABASE_PURGE_WORKER_ENABLED-}"
caller_tenant_database_purge_enabled="${TENANT_DATABASE_PURGE_ENABLED-}"
caller_tenant_redis_purge_worker_enabled="${TENANT_REDIS_PURGE_WORKER_ENABLED-}"
caller_tenant_redis_purge_enabled="${TENANT_REDIS_PURGE_ENABLED-}"
caller_data_governance_management_enabled="${DATA_GOVERNANCE_MANAGEMENT_ENABLED-}"
caller_purge_policy_evaluator_enabled="${PURGE_POLICY_EVALUATOR_ENABLED-}"
caller_data_export_requests_enabled="${DATA_EXPORT_REQUESTS_ENABLED-}"
caller_data_export_worker_enabled="${DATA_EXPORT_WORKER_ENABLED-}"
caller_data_export_cleanup_enabled="${DATA_EXPORT_CLEANUP_ENABLED-}"
caller_erasure_worker_enabled="${ERASURE_WORKER_ENABLED-}"
caller_legacy_tombstone_compensation_enabled="${LEGACY_TOMBSTONE_COMPENSATION_ENABLED-}"
caller_erasure_router_url="${ERASURE_ROUTER_URL-}"
caller_blob_store="${BLOB_STORE-}"
caller_blob_namespace_id="${BLOB_NAMESPACE_ID-}"
caller_blob_dir="${BLOB_DIR-}"
caller_blob_filesystem_single_runner="${BLOB_FILESYSTEM_SINGLE_RUNNER-}"
caller_blob_storage_control_enabled="${BLOB_STORAGE_CONTROL_ENABLED-}"
caller_blob_s3_endpoint="${BLOB_S3_ENDPOINT-}"
caller_blob_s3_region="${BLOB_S3_REGION-}"
caller_blob_s3_bucket="${BLOB_S3_BUCKET-}"
caller_blob_s3_prefix="${BLOB_S3_PREFIX-}"
caller_blob_s3_force_path_style="${BLOB_S3_FORCE_PATH_STYLE-}"
caller_blob_s3_private_bucket_ack="${BLOB_S3_PRIVATE_BUCKET_ACK-}"
caller_blob_s3_request_timeout_ms="${BLOB_S3_REQUEST_TIMEOUT_MS-}"
caller_blob_s3_access_key_id="${BLOB_S3_ACCESS_KEY_ID-}"
caller_blob_s3_secret_access_key="${BLOB_S3_SECRET_ACCESS_KEY-}"
caller_blob_s3_session_token="${BLOB_S3_SESSION_TOKEN-}"
caller_blob_cleanup_enabled="${BLOB_CLEANUP_ENABLED-}"
caller_blob_attachments_enabled="${BLOB_ATTACHMENTS_ENABLED-}"
caller_blob_max_bytes="${BLOB_MAX_BYTES-}"
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi
for ((caller_env_index = 0; caller_env_index < ${#caller_mover_env_names[@]}; caller_env_index++)); do
  if [ "${caller_mover_env_was_set[$caller_env_index]}" = 1 ]; then
    export "${caller_mover_env_names[$caller_env_index]}=${caller_mover_env_values[$caller_env_index]}"
  fi
done
unset caller_env_index caller_env_name caller_mover_env_names caller_mover_env_was_set caller_mover_env_values
[ -n "$caller_runner_port" ] && RUNNER_PORT="$caller_runner_port"
[ -n "$caller_router_port" ] && ROUTER_PORT="$caller_router_port"
[ -n "$caller_runner_id" ] && RUNNER_ID="$caller_runner_id"
[ -n "$caller_runner_addr" ] && RUNNER_ADDR="$caller_runner_addr"
[ -n "$caller_runners" ] && RUNNERS="$caller_runners"
[ -n "$caller_redis_url" ] && REDIS_URL="$caller_redis_url"
[ -n "$caller_redis_prefix" ] && REDIS_PREFIX="$caller_redis_prefix"
[ -n "$caller_redis_namespace_id" ] && REDIS_NAMESPACE_ID="$caller_redis_namespace_id"
[ -n "$caller_session_tombstone_enabled" ] && SESSION_TOMBSTONE_ENABLED="$caller_session_tombstone_enabled"
[ -n "$caller_data_erasure_requests_enabled" ] && DATA_ERASURE_REQUESTS_ENABLED="$caller_data_erasure_requests_enabled"
[ -n "$caller_tenant_erasure_requests_enabled" ] && TENANT_ERASURE_REQUESTS_ENABLED="$caller_tenant_erasure_requests_enabled"
[ -n "$caller_tenant_erasure_operator_token" ] && TENANT_ERASURE_OPERATOR_TOKEN="$caller_tenant_erasure_operator_token"
[ -n "$caller_tenant_erasure_operator_id" ] && TENANT_ERASURE_OPERATOR_ID="$caller_tenant_erasure_operator_id"
[ -n "$caller_tenant_erasure_barrier_timeout_ms" ] && TENANT_ERASURE_BARRIER_TIMEOUT_MS="$caller_tenant_erasure_barrier_timeout_ms"
[ -n "$caller_tenant_credential_revocation_worker_enabled" ] && TENANT_CREDENTIAL_REVOCATION_WORKER_ENABLED="$caller_tenant_credential_revocation_worker_enabled"
[ -n "$caller_tenant_credential_revocation_execution_enabled" ] && TENANT_CREDENTIAL_REVOCATION_EXECUTION_ENABLED="$caller_tenant_credential_revocation_execution_enabled"
[ -n "$caller_credential_lifecycle_tracking_enabled" ] && CREDENTIAL_LIFECYCLE_TRACKING_ENABLED="$caller_credential_lifecycle_tracking_enabled"
[ -n "$caller_credential_target_execution_adapter" ] && CREDENTIAL_TARGET_EXECUTION_ADAPTER="$caller_credential_target_execution_adapter"
[ -n "$caller_tenant_credential_target_execution_worker_enabled" ] && TENANT_CREDENTIAL_TARGET_EXECUTION_WORKER_ENABLED="$caller_tenant_credential_target_execution_worker_enabled"
[ -n "$caller_tenant_credential_target_execution_enabled" ] && TENANT_CREDENTIAL_TARGET_EXECUTION_ENABLED="$caller_tenant_credential_target_execution_enabled"
[ -n "$caller_tenant_runtime_drain_enabled" ] && TENANT_RUNTIME_DRAIN_ENABLED="$caller_tenant_runtime_drain_enabled"
[ -n "$caller_tenant_runtime_revocation_worker_enabled" ] && TENANT_RUNTIME_REVOCATION_WORKER_ENABLED="$caller_tenant_runtime_revocation_worker_enabled"
[ -n "$caller_tenant_runtime_drain_execution_enabled" ] && TENANT_RUNTIME_DRAIN_EXECUTION_ENABLED="$caller_tenant_runtime_drain_execution_enabled"
[ -n "$caller_tenant_content_inventory_worker_enabled" ] && TENANT_CONTENT_INVENTORY_WORKER_ENABLED="$caller_tenant_content_inventory_worker_enabled"
[ -n "$caller_tenant_purge_plan_worker_enabled" ] && TENANT_PURGE_PLAN_WORKER_ENABLED="$caller_tenant_purge_plan_worker_enabled"
[ -n "$caller_tenant_purge_execution_worker_enabled" ] && TENANT_PURGE_EXECUTION_WORKER_ENABLED="$caller_tenant_purge_execution_worker_enabled"
[ -n "$caller_tenant_purge_execution_enabled" ] && TENANT_PURGE_EXECUTION_ENABLED="$caller_tenant_purge_execution_enabled"
[ -n "$caller_tenant_database_purge_worker_enabled" ] && TENANT_DATABASE_PURGE_WORKER_ENABLED="$caller_tenant_database_purge_worker_enabled"
[ -n "$caller_tenant_database_purge_enabled" ] && TENANT_DATABASE_PURGE_ENABLED="$caller_tenant_database_purge_enabled"
[ -n "$caller_tenant_redis_purge_worker_enabled" ] && TENANT_REDIS_PURGE_WORKER_ENABLED="$caller_tenant_redis_purge_worker_enabled"
[ -n "$caller_tenant_redis_purge_enabled" ] && TENANT_REDIS_PURGE_ENABLED="$caller_tenant_redis_purge_enabled"
[ -n "$caller_data_governance_management_enabled" ] && DATA_GOVERNANCE_MANAGEMENT_ENABLED="$caller_data_governance_management_enabled"
[ -n "$caller_purge_policy_evaluator_enabled" ] && PURGE_POLICY_EVALUATOR_ENABLED="$caller_purge_policy_evaluator_enabled"
[ -n "$caller_data_export_requests_enabled" ] && DATA_EXPORT_REQUESTS_ENABLED="$caller_data_export_requests_enabled"
[ -n "$caller_data_export_worker_enabled" ] && DATA_EXPORT_WORKER_ENABLED="$caller_data_export_worker_enabled"
[ -n "$caller_data_export_cleanup_enabled" ] && DATA_EXPORT_CLEANUP_ENABLED="$caller_data_export_cleanup_enabled"
[ -n "$caller_erasure_worker_enabled" ] && ERASURE_WORKER_ENABLED="$caller_erasure_worker_enabled"
[ -n "$caller_legacy_tombstone_compensation_enabled" ] && LEGACY_TOMBSTONE_COMPENSATION_ENABLED="$caller_legacy_tombstone_compensation_enabled"
[ -n "$caller_erasure_router_url" ] && ERASURE_ROUTER_URL="$caller_erasure_router_url"
[ -n "$caller_blob_store" ] && BLOB_STORE="$caller_blob_store"
[ -n "$caller_blob_namespace_id" ] && BLOB_NAMESPACE_ID="$caller_blob_namespace_id"
[ -n "$caller_blob_dir" ] && BLOB_DIR="$caller_blob_dir"
[ -n "$caller_blob_filesystem_single_runner" ] && BLOB_FILESYSTEM_SINGLE_RUNNER="$caller_blob_filesystem_single_runner"
[ -n "$caller_blob_storage_control_enabled" ] && BLOB_STORAGE_CONTROL_ENABLED="$caller_blob_storage_control_enabled"
[ -n "$caller_blob_s3_endpoint" ] && BLOB_S3_ENDPOINT="$caller_blob_s3_endpoint"
[ -n "$caller_blob_s3_region" ] && BLOB_S3_REGION="$caller_blob_s3_region"
[ -n "$caller_blob_s3_bucket" ] && BLOB_S3_BUCKET="$caller_blob_s3_bucket"
[ -n "$caller_blob_s3_prefix" ] && BLOB_S3_PREFIX="$caller_blob_s3_prefix"
[ -n "$caller_blob_s3_force_path_style" ] && BLOB_S3_FORCE_PATH_STYLE="$caller_blob_s3_force_path_style"
[ -n "$caller_blob_s3_private_bucket_ack" ] && BLOB_S3_PRIVATE_BUCKET_ACK="$caller_blob_s3_private_bucket_ack"
[ -n "$caller_blob_s3_request_timeout_ms" ] && BLOB_S3_REQUEST_TIMEOUT_MS="$caller_blob_s3_request_timeout_ms"
[ -n "$caller_blob_s3_access_key_id" ] && BLOB_S3_ACCESS_KEY_ID="$caller_blob_s3_access_key_id"
[ -n "$caller_blob_s3_secret_access_key" ] && BLOB_S3_SECRET_ACCESS_KEY="$caller_blob_s3_secret_access_key"
[ -n "$caller_blob_s3_session_token" ] && BLOB_S3_SESSION_TOKEN="$caller_blob_s3_session_token"
[ -n "$caller_blob_cleanup_enabled" ] && BLOB_CLEANUP_ENABLED="$caller_blob_cleanup_enabled"
[ -n "$caller_blob_attachments_enabled" ] && BLOB_ATTACHMENTS_ENABLED="$caller_blob_attachments_enabled"
[ -n "$caller_blob_max_bytes" ] && BLOB_MAX_BYTES="$caller_blob_max_bytes"

# Catalog configuration is one-shot operator authority. It may be loaded from `.env` for the
# foreground command below, but no BACKUP_CATALOG_* or TENANT_BACKUP_CATALOG_* value may enter a
# long-running router or runner. Build an env(1) unset list from the post-.env exported namespace.
# Keep one harmless unset pair so macOS Bash 3.2 + `set -u` can expand the array even when no
# catalog variable is configured. (That shell treats an otherwise empty array as unbound.)
backup_catalog_process_scrub=(-u AGENT_SERVICE_UNUSED_BACKUP_CATALOG_ENV)
while IFS= read -r backup_catalog_env_name; do
  case "$backup_catalog_env_name" in
    BACKUP_CATALOG_*|TENANT_BACKUP_CATALOG_*)
      backup_catalog_process_scrub+=(-u "$backup_catalog_env_name")
      ;;
  esac
done < <(compgen -e)
unset backup_catalog_env_name

STATE_DIR="${AGENT_SERVICE_STATE_DIR:-$ROOT/.local-run}"
RUNNER_PID_FILE="$STATE_DIR/runner.pid"
ROUTER_PID_FILE="$STATE_DIR/router.pid"
RUNNER_LOG="$STATE_DIR/runner.log"
ROUTER_LOG="$STATE_DIR/router.log"
RUNNER_PORT="${RUNNER_PORT:-8787}"
ROUTER_PORT="${ROUTER_PORT:-8080}"
RUNNER_URL="http://127.0.0.1:$RUNNER_PORT"
ROUTER_URL="http://127.0.0.1:$ROUTER_PORT"

die() { echo "error: $*" >&2; exit 1; }
pid_alive() { [ -f "$1" ] && kill -0 "$(sed -n '1p' "$1")" 2>/dev/null; }

require_tools() {
  command -v node >/dev/null || die "node is required"
  command -v pnpm >/dev/null || die "pnpm is required"
  command -v curl >/dev/null || die "curl is required"
  local major
  major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$major" -ge 24 ] || die "Node 24+ is required (current: $(node -v))"
}

require_mysql_credential_target_execution_dormant() {
  if [ -n "${CREDENTIAL_TARGET_EXECUTION_ADAPTER:-}" ] \
    || [ "${TENANT_CREDENTIAL_TARGET_EXECUTION_WORKER_ENABLED:-0}" != "0" ] \
    || [ "${TENANT_CREDENTIAL_TARGET_EXECUTION_ENABLED:-0}" != "0" ]; then
    die "the standard local-service stack uses MySQL and cannot enable the memory-only credential target fake; keep the 0029 adapter unset and both execution gates at 0"
  fi
}

infra() {
  if { [ "${BLOB_STORE:-filesystem}" = "s3" ] && [ -z "${BLOB_S3_ENDPOINT:-}" ]; } \
    || { [ "${RESTORE_JOURNAL_ADAPTER:-}" = "s3" ] \
      && [ -z "${RESTORE_JOURNAL_S3_ENDPOINT:-}" ]; }; then
    MINIO_ENABLED="${MINIO_ENABLED:-1}" deploy/local/infra.sh "$@"
  else
    deploy/local/infra.sh "$@"
  fi
}

wait_http() {
  local url="$1" name="$2" i
  for i in $(seq 1 100); do
    curl -fsS "$url" >/dev/null 2>&1 && return 0
    sleep 0.2
  done
  die "$name did not become ready at $url"
}

start_apps() {
  require_tools
  [ -f .env ] || die ".env is missing; copy .env.example and fill the required values"
  require_mysql_credential_target_execution_dormant
  mkdir -p "$STATE_DIR"
  local blob_store="${BLOB_STORE:-filesystem}"
  local restore_journal_uses_local_minio=0
  if [ "${RESTORE_JOURNAL_ADAPTER:-}" = "s3" ] \
    && [ -z "${RESTORE_JOURNAL_S3_ENDPOINT:-}" ]; then
    restore_journal_uses_local_minio=1
  fi
  infra start

  local -a runner_blob_env router_blob_env runner_restore_journal_env cloud_credential_scrub
  local -a router_runner_secret_scrub
  # `.env` is exported for local orchestration, but these provider-chain credentials must not leak
  # into either application process. The local S3 runner receives only its explicit BLOB_S3_*
  # credentials below; the router never receives storage credentials.
  cloud_credential_scrub=(
    -u MINIO_ROOT_USER -u MINIO_ROOT_PASSWORD
    -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY -u AWS_SESSION_TOKEN -u AWS_SECURITY_TOKEN
    -u AWS_PROFILE -u AWS_DEFAULT_PROFILE
    -u AWS_SHARED_CREDENTIALS_FILE -u AWS_CONFIG_FILE -u AWS_CREDENTIAL_FILE
    -u AWS_WEB_IDENTITY_TOKEN_FILE -u AWS_ROLE_ARN -u AWS_ROLE_SESSION_NAME
    -u AWS_CONTAINER_CREDENTIALS_RELATIVE_URI -u AWS_CONTAINER_CREDENTIALS_FULL_URI
    -u AWS_CONTAINER_AUTHORIZATION_TOKEN -u AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE
  )
  # The router needs Redis and its own narrowly scoped tokens, but never the runner database,
  # provider, bootstrap or envelope-encryption authorities loaded from `.env`.
  router_runner_secret_scrub=(
    -u API_KEY -u API_BASE_URL -u DEFAULT_MODEL -u PLATFORM_PROVIDER
    -u MYSQL_URL -u MYSQL_TEST_URL -u MYSQL_MIGRATION_TEST_URL -u MYSQL_PWD
    -u SECRETS_MASTER_KEY -u BOOTSTRAP_API_KEY -u BOOTSTRAP_TENANT_ID
    -u ADMIN_BOOTSTRAP_TENANT
    -u S3_TEST_ENDPOINT -u S3_TEST_REGION -u S3_TEST_BUCKET
    -u S3_TEST_ACCESS_KEY_ID -u S3_TEST_SECRET_ACCESS_KEY -u S3_TEST_SESSION_TOKEN
    -u S3_TEST_FORCE_PATH_STYLE
  )
  if [ "$blob_store" = "s3" ]; then
    runner_blob_env=(
      BLOB_STORE=s3
      BLOB_NAMESPACE_ID="${BLOB_NAMESPACE_ID:-agent-service-local-minio-v1}"
      BLOB_STORAGE_CONTROL_ENABLED="${BLOB_STORAGE_CONTROL_ENABLED:-1}"
      BLOB_FILESYSTEM_SINGLE_RUNNER=0
      BLOB_S3_ENDPOINT="${BLOB_S3_ENDPOINT:-${MINIO_ENDPOINT:-http://127.0.0.1:9000}}"
      BLOB_S3_REGION="${BLOB_S3_REGION:-${MINIO_REGION:-us-east-1}}"
      BLOB_S3_BUCKET="${BLOB_S3_BUCKET:-${MINIO_BUCKET:-agent-service-local}}"
      BLOB_S3_PREFIX="${BLOB_S3_PREFIX:-agent-service-v1}"
      BLOB_S3_FORCE_PATH_STYLE="${BLOB_S3_FORCE_PATH_STYLE:-1}"
      BLOB_S3_PRIVATE_BUCKET_ACK="${BLOB_S3_PRIVATE_BUCKET_ACK:-0}"
      BLOB_S3_REQUEST_TIMEOUT_MS="${BLOB_S3_REQUEST_TIMEOUT_MS:-5000}"
      BLOB_S3_ACCESS_KEY_ID="${BLOB_S3_ACCESS_KEY_ID:-${MINIO_ROOT_USER:-agentservice-local}}"
      BLOB_S3_SECRET_ACCESS_KEY="${BLOB_S3_SECRET_ACCESS_KEY:-${MINIO_ROOT_PASSWORD:-agent-service-local-minio-only-0001}}"
    )
    [ -n "${BLOB_S3_SESSION_TOKEN:-}" ] \
      && runner_blob_env+=(BLOB_S3_SESSION_TOKEN="$BLOB_S3_SESSION_TOKEN")
    router_blob_env=(
      BLOB_STORE=s3
      BLOB_NAMESPACE_ID="${BLOB_NAMESPACE_ID:-agent-service-local-minio-v1}"
      BLOB_STORAGE_CONTROL_ENABLED="${BLOB_STORAGE_CONTROL_ENABLED:-1}"
      BLOB_FILESYSTEM_SINGLE_RUNNER=0
      BLOB_S3_BUCKET="${BLOB_S3_BUCKET:-${MINIO_BUCKET:-agent-service-local}}"
      BLOB_S3_PREFIX="${BLOB_S3_PREFIX:-agent-service-v1}"
    )
  else
    runner_blob_env=(
      BLOB_STORE=filesystem
      BLOB_STORAGE_CONTROL_ENABLED=0
      BLOB_DIR="${BLOB_DIR:-$STATE_DIR/blobs}"
      BLOB_FILESYSTEM_SINGLE_RUNNER="${BLOB_FILESYSTEM_SINGLE_RUNNER:-1}"
    )
    router_blob_env=(
      BLOB_STORE=filesystem
      BLOB_STORAGE_CONTROL_ENABLED=0
      BLOB_FILESYSTEM_SINGLE_RUNNER="${BLOB_FILESYSTEM_SINGLE_RUNNER:-1}"
    )
  fi

  # Same Bash 3.2 empty-array guard as the catalog scrub list above.
  runner_restore_journal_env=(-u AGENT_SERVICE_UNUSED_RESTORE_JOURNAL_ENV)
  if [ "$restore_journal_uses_local_minio" = 1 ]; then
    local restore_journal_bucket="${RESTORE_JOURNAL_S3_BUCKET:-agent-service-local-restore-journal}"
    if [ "$blob_store" = "s3" ] \
      && [ "$restore_journal_bucket" = "${BLOB_S3_BUCKET:-${MINIO_BUCKET:-agent-service-local}}" ]; then
      die "RESTORE_JOURNAL_S3_BUCKET must differ from the Blob bucket"
    fi
    env \
      S3_TEST_ENDPOINT="${MINIO_ENDPOINT:-http://127.0.0.1:9000}" \
      S3_TEST_REGION="${MINIO_REGION:-us-east-1}" \
      S3_TEST_BUCKET="$restore_journal_bucket" \
      S3_TEST_ACCESS_KEY_ID="${MINIO_ROOT_USER:-agentservice-local}" \
      S3_TEST_SECRET_ACCESS_KEY="${MINIO_ROOT_PASSWORD:-agent-service-local-minio-only-0001}" \
      S3_TEST_FORCE_PATH_STYLE=1 \
      node packages/store/scripts/bootstrap-s3.mjs >/dev/null
    runner_restore_journal_env=(
      RESTORE_JOURNAL_S3_ENDPOINT="${MINIO_ENDPOINT:-http://127.0.0.1:9000}"
      RESTORE_JOURNAL_S3_REGION="${RESTORE_JOURNAL_S3_REGION:-${MINIO_REGION:-us-east-1}}"
      RESTORE_JOURNAL_S3_BUCKET="$restore_journal_bucket"
      RESTORE_JOURNAL_S3_PREFIX="${RESTORE_JOURNAL_S3_PREFIX:-tenant-restore-journal}"
      RESTORE_JOURNAL_S3_FORCE_PATH_STYLE="${RESTORE_JOURNAL_S3_FORCE_PATH_STYLE:-1}"
      RESTORE_JOURNAL_S3_PRIVATE_BUCKET_ACK="${RESTORE_JOURNAL_S3_PRIVATE_BUCKET_ACK:-0}"
      RESTORE_JOURNAL_S3_REQUEST_TIMEOUT_MS="${RESTORE_JOURNAL_S3_REQUEST_TIMEOUT_MS:-5000}"
      RESTORE_JOURNAL_S3_ACCESS_KEY_ID="${RESTORE_JOURNAL_S3_ACCESS_KEY_ID:-${MINIO_ROOT_USER:-agentservice-local}}"
      RESTORE_JOURNAL_S3_SECRET_ACCESS_KEY="${RESTORE_JOURNAL_S3_SECRET_ACCESS_KEY:-${MINIO_ROOT_PASSWORD:-agent-service-local-minio-only-0001}}"
    )
    [ -n "${RESTORE_JOURNAL_S3_SESSION_TOKEN:-}" ] \
      && runner_restore_journal_env+=(
        RESTORE_JOURNAL_S3_SESSION_TOKEN="$RESTORE_JOURNAL_S3_SESSION_TOKEN"
      )
  fi

  if pid_alive "$RUNNER_PID_FILE"; then
    echo "runner: already running (pid $(sed -n '1p' "$RUNNER_PID_FILE"))"
  else
    # The platform operator credential terminates at the router. `.env` is exported above for the
    # local stack, so explicitly scrub it from the runner process rather than relying on app config
    # to ignore an authority it must never possess.
    nohup env -u TENANT_ERASURE_OPERATOR_TOKEN -u TENANT_ERASURE_OPERATOR_ID \
      -u TENANT_CREDENTIAL_REVOCATION_EXECUTION_ENABLED \
      -u CREDENTIAL_TARGET_EXECUTION_ADAPTER \
      -u TENANT_CREDENTIAL_TARGET_EXECUTION_ENABLED \
      -u TENANT_RUNTIME_DRAIN_EXECUTION_ENABLED \
      -u TENANT_PURGE_EXECUTION_ENABLED \
      -u TENANT_DATABASE_PURGE_ENABLED \
      -u TENANT_REDIS_PURGE_ENABLED \
      -u TENANT_RESTORE_JOURNAL_EXECUTION_ENABLED \
      -u RESTORE_JOURNAL_NAMESPACE_SHA256 \
      -u RESTORE_JOURNAL_TARGET_ROOT_SHA256 \
      -u RESTORE_JOURNAL_RUNTIME_EPOCH_SHA256 \
      -u RESTORE_JOURNAL_PRIMARY_ACTIVATION_ACK \
      -u RESTORE_RUN_ID -u RESTORE_FLEET_STOPPED_ACK \
      -u BACKUP_ID -u BACKUP_RUNTIME_EPOCH_ID -u SOURCE_SNAPSHOT_SHA256 \
      -u SOURCE_BACKUP_SHA256 -u BACKUP_ARTIFACT_MANIFEST_SHA256 \
      -u BACKUP_PROVIDER_EVIDENCE_SHA256 -u BACKUP_EVICTION_ID \
      -u EXTERNAL_TOMBSTONE_SHA256 -u BACKUP_PHYSICAL_ABSENCE_ACK \
      -u RESTORE_REPLAY_PAGE_SIZE \
      "${backup_catalog_process_scrub[@]}" \
      "${cloud_credential_scrub[@]}" \
      "${runner_restore_journal_env[@]}" \
      "${runner_blob_env[@]}" \
      STORE=mysql \
      RUNNER_PORT="$RUNNER_PORT" \
      RUNNER_ID="${RUNNER_ID:-runner-local-1}" \
      RUNNER_ADDR="${RUNNER_ADDR:-127.0.0.1:$RUNNER_PORT}" \
      BLOB_CLEANUP_ENABLED="${BLOB_CLEANUP_ENABLED:-1}" \
      BLOB_ATTACHMENTS_ENABLED="${BLOB_ATTACHMENTS_ENABLED:-1}" \
      BLOB_MAX_BYTES="${BLOB_MAX_BYTES:-1000000}" \
      DATA_ERASURE_REQUESTS_ENABLED="${DATA_ERASURE_REQUESTS_ENABLED:-0}" \
      TENANT_ERASURE_REQUESTS_ENABLED="${TENANT_ERASURE_REQUESTS_ENABLED:-0}" \
      TENANT_ERASURE_BARRIER_TIMEOUT_MS="${TENANT_ERASURE_BARRIER_TIMEOUT_MS:-2000}" \
      TENANT_CREDENTIAL_REVOCATION_WORKER_ENABLED="${TENANT_CREDENTIAL_REVOCATION_WORKER_ENABLED:-0}" \
      CREDENTIAL_LIFECYCLE_TRACKING_ENABLED="${CREDENTIAL_LIFECYCLE_TRACKING_ENABLED:-1}" \
      TENANT_CREDENTIAL_TARGET_EXECUTION_WORKER_ENABLED=0 \
      TENANT_RUNTIME_DRAIN_ENABLED="${TENANT_RUNTIME_DRAIN_ENABLED:-0}" \
      TENANT_RUNTIME_REVOCATION_WORKER_ENABLED="${TENANT_RUNTIME_REVOCATION_WORKER_ENABLED:-0}" \
      TENANT_CONTENT_INVENTORY_WORKER_ENABLED="${TENANT_CONTENT_INVENTORY_WORKER_ENABLED:-0}" \
      TENANT_PURGE_PLAN_WORKER_ENABLED="${TENANT_PURGE_PLAN_WORKER_ENABLED:-0}" \
      TENANT_PURGE_EXECUTION_WORKER_ENABLED="${TENANT_PURGE_EXECUTION_WORKER_ENABLED:-0}" \
      TENANT_DATABASE_PURGE_WORKER_ENABLED="${TENANT_DATABASE_PURGE_WORKER_ENABLED:-0}" \
      TENANT_REDIS_PURGE_WORKER_ENABLED="${TENANT_REDIS_PURGE_WORKER_ENABLED:-0}" \
      REDIS_PREFIX="${REDIS_PREFIX:-as}" \
      REDIS_NAMESPACE_ID="${REDIS_NAMESPACE_ID:-agent-service-local-db0}" \
      DATA_GOVERNANCE_MANAGEMENT_ENABLED="${DATA_GOVERNANCE_MANAGEMENT_ENABLED:-0}" \
      PURGE_POLICY_EVALUATOR_ENABLED="${PURGE_POLICY_EVALUATOR_ENABLED:-0}" \
      DATA_EXPORT_REQUESTS_ENABLED="${DATA_EXPORT_REQUESTS_ENABLED:-0}" \
      DATA_EXPORT_WORKER_ENABLED="${DATA_EXPORT_WORKER_ENABLED:-1}" \
      DATA_EXPORT_CLEANUP_ENABLED="${DATA_EXPORT_CLEANUP_ENABLED:-1}" \
      ERASURE_WORKER_ENABLED="${ERASURE_WORKER_ENABLED:-1}" \
      LEGACY_TOMBSTONE_COMPENSATION_ENABLED="${LEGACY_TOMBSTONE_COMPENSATION_ENABLED:-1}" \
      ERASURE_ROUTER_URL="${ERASURE_ROUTER_URL:-$ROUTER_URL}" \
      node --import tsx apps/agent-runner/src/main.ts </dev/null >"$RUNNER_LOG" 2>&1 &
    echo "$!" >"$RUNNER_PID_FILE"
    wait_http "$RUNNER_URL/readyz" runner
    echo "runner: started (pid $(sed -n '1p' "$RUNNER_PID_FILE"), $RUNNER_URL)"
  fi

  if pid_alive "$ROUTER_PID_FILE"; then
    echo "router: already running (pid $(sed -n '1p' "$ROUTER_PID_FILE"))"
  else
    nohup env -u TENANT_CREDENTIAL_REVOCATION_WORKER_ENABLED \
      -u CREDENTIAL_TARGET_EXECUTION_ADAPTER \
      -u TENANT_CREDENTIAL_TARGET_EXECUTION_WORKER_ENABLED \
      -u TENANT_RUNTIME_DRAIN_ENABLED -u TENANT_RUNTIME_REVOCATION_WORKER_ENABLED \
      -u TENANT_CONTENT_INVENTORY_WORKER_ENABLED \
      -u TENANT_PURGE_PLAN_WORKER_ENABLED \
      -u TENANT_PURGE_EXECUTION_WORKER_ENABLED \
      -u TENANT_DATABASE_PURGE_WORKER_ENABLED \
      -u TENANT_REDIS_PURGE_WORKER_ENABLED \
      -u RESTORE_JOURNAL_ADAPTER \
      -u RESTORE_JOURNAL_DATABASE_NAMESPACE_ID \
      -u RESTORE_JOURNAL_RUNTIME_EPOCH_ID \
      -u RESTORE_JOURNAL_NAMESPACE_ID \
      -u RESTORE_JOURNAL_FAILURE_DOMAIN_ID \
      -u RESTORE_JOURNAL_INDEPENDENT_FAILURE_DOMAIN_ACK \
      -u RESTORE_JOURNAL_S3_ENDPOINT -u RESTORE_JOURNAL_S3_REGION \
      -u RESTORE_JOURNAL_S3_BUCKET -u RESTORE_JOURNAL_S3_PREFIX \
      -u RESTORE_JOURNAL_S3_FORCE_PATH_STYLE \
      -u RESTORE_JOURNAL_S3_PRIVATE_BUCKET_ACK \
      -u RESTORE_JOURNAL_S3_REQUEST_TIMEOUT_MS \
      -u RESTORE_JOURNAL_S3_ACCESS_KEY_ID \
      -u RESTORE_JOURNAL_S3_SECRET_ACCESS_KEY \
      -u RESTORE_JOURNAL_S3_SESSION_TOKEN \
      -u RESTORE_JOURNAL_PRIMARY_ACTIVATION_ACK \
      -u RESTORE_RUN_ID -u RESTORE_FLEET_STOPPED_ACK \
      -u BACKUP_ID -u BACKUP_RUNTIME_EPOCH_ID -u SOURCE_SNAPSHOT_SHA256 \
      -u SOURCE_BACKUP_SHA256 -u BACKUP_ARTIFACT_MANIFEST_SHA256 \
      -u BACKUP_PROVIDER_EVIDENCE_SHA256 -u BACKUP_EVICTION_ID \
      -u EXTERNAL_TOMBSTONE_SHA256 -u BACKUP_PHYSICAL_ABSENCE_ACK \
      -u RESTORE_REPLAY_PAGE_SIZE \
      -u TENANT_RESTORE_JOURNAL_WORKER_ENABLED \
      -u TENANT_RESTORE_JOURNAL_WORKER_POLL_MS \
      -u TENANT_RESTORE_JOURNAL_WORKER_LEASE_MS \
      -u TENANT_RESTORE_JOURNAL_WORKER_BATCH_SIZE \
      -u TENANT_RESTORE_JOURNAL_MATERIALIZE_BATCH_SIZE \
      -u TENANT_RESTORE_JOURNAL_RETRY_BASE_MS \
      -u TENANT_RESTORE_JOURNAL_RETRY_MAX_MS \
      "${backup_catalog_process_scrub[@]}" \
      -u BLOB_S3_ENDPOINT -u BLOB_S3_REGION -u BLOB_S3_FORCE_PATH_STYLE \
      -u BLOB_S3_PRIVATE_BUCKET_ACK -u BLOB_S3_REQUEST_TIMEOUT_MS \
      -u BLOB_S3_ACCESS_KEY_ID -u BLOB_S3_SECRET_ACCESS_KEY -u BLOB_S3_SESSION_TOKEN \
      "${cloud_credential_scrub[@]}" \
      "${router_runner_secret_scrub[@]}" \
      "${router_blob_env[@]}" \
      RUNNERS="${RUNNERS:-$RUNNER_URL}" \
      REDIS_URL="${REDIS_URL:-redis://127.0.0.1:6379}" \
      REDIS_PREFIX="${REDIS_PREFIX:-as}" \
      REDIS_NAMESPACE_ID="${REDIS_NAMESPACE_ID:-agent-service-local-db0}" \
      SESSION_TOMBSTONE_ENABLED="${SESSION_TOMBSTONE_ENABLED:-1}" \
      DATA_ERASURE_REQUESTS_ENABLED="${DATA_ERASURE_REQUESTS_ENABLED:-0}" \
      TENANT_ERASURE_REQUESTS_ENABLED="${TENANT_ERASURE_REQUESTS_ENABLED:-0}" \
      TENANT_CREDENTIAL_REVOCATION_EXECUTION_ENABLED="${TENANT_CREDENTIAL_REVOCATION_EXECUTION_ENABLED:-0}" \
      CREDENTIAL_LIFECYCLE_TRACKING_ENABLED="${CREDENTIAL_LIFECYCLE_TRACKING_ENABLED:-1}" \
      TENANT_CREDENTIAL_TARGET_EXECUTION_ENABLED=0 \
      TENANT_RUNTIME_DRAIN_EXECUTION_ENABLED="${TENANT_RUNTIME_DRAIN_EXECUTION_ENABLED:-0}" \
      TENANT_PURGE_EXECUTION_ENABLED="${TENANT_PURGE_EXECUTION_ENABLED:-0}" \
      TENANT_DATABASE_PURGE_ENABLED="${TENANT_DATABASE_PURGE_ENABLED:-0}" \
      TENANT_REDIS_PURGE_ENABLED="${TENANT_REDIS_PURGE_ENABLED:-0}" \
      DATA_GOVERNANCE_MANAGEMENT_ENABLED="${DATA_GOVERNANCE_MANAGEMENT_ENABLED:-0}" \
      PURGE_POLICY_EVALUATOR_ENABLED="${PURGE_POLICY_EVALUATOR_ENABLED:-0}" \
      DATA_EXPORT_REQUESTS_ENABLED="${DATA_EXPORT_REQUESTS_ENABLED:-0}" \
      BLOB_ATTACHMENTS_ENABLED="${BLOB_ATTACHMENTS_ENABLED:-1}" \
      BLOB_MAX_BYTES="${BLOB_MAX_BYTES:-1000000}" \
      ROUTER_PORT="$ROUTER_PORT" \
      node --import tsx apps/agent-router/src/main.ts </dev/null >"$ROUTER_LOG" 2>&1 &
    echo "$!" >"$ROUTER_PID_FILE"
    wait_http "$ROUTER_URL/readyz" router
    echo "router: started (pid $(sed -n '1p' "$ROUTER_PID_FILE"), $ROUTER_URL)"
  fi
}

stop_one() {
  local name="$1" pid_file="$2" i pid
  if ! pid_alive "$pid_file"; then
    echo "$name: not running"
    rm -f "$pid_file"
    return
  fi
  pid="$(sed -n '1p' "$pid_file")"
  kill -TERM "$pid"
  for i in $(seq 1 150); do
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$pid_file"
      echo "$name: stopped"
      return
    fi
    sleep 0.2
  done
  die "$name did not stop within 30s (pid $pid); inspect $STATE_DIR before forcing termination"
}

stop_apps() {
  stop_one router "$ROUTER_PID_FILE"
  stop_one runner "$RUNNER_PID_FILE"
}

show_status() {
  infra status || true
  if pid_alive "$RUNNER_PID_FILE"; then
    echo "runner: up pid=$(sed -n '1p' "$RUNNER_PID_FILE") health=$(curl -fsS "$RUNNER_URL/healthz" 2>/dev/null || echo unreachable)"
  else
    echo "runner: down"
  fi
  if pid_alive "$ROUTER_PID_FILE"; then
    echo "router: up pid=$(sed -n '1p' "$ROUTER_PID_FILE") health=$(curl -fsS "$ROUTER_URL/healthz" 2>/dev/null || echo unreachable)"
  else
    echo "router: down"
  fi
}

smoke() {
  require_tools
  curl -fsS "$RUNNER_URL/readyz" >/dev/null
  curl -fsS "$ROUTER_URL/readyz" >/dev/null
  curl -fsS "$ROUTER_URL/v1/capabilities" >/dev/null
  curl -fsS "$RUNNER_URL/openapi.json" >/dev/null
  curl -fsS "$ROUTER_URL/openapi.json" >/dev/null
  local code
  code="$(curl -sS -o /dev/null -w '%{http_code}' "$ROUTER_URL/v1/agents")"
  [ "$code" = "401" ] || die "unauthenticated request returned $code, expected 401"
  echo "smoke: health, readiness, OpenAPI, router forwarding and auth rejection passed"
}

verify() {
  require_tools
  # `.env` is loaded for the local workflow, but platform authority must never be inherited by a
  # runner spawned from a test harness. Tests use their own fixed, non-production router credential.
  unset TENANT_ERASURE_OPERATOR_TOKEN TENANT_ERASURE_OPERATOR_ID
  # The standard verification stack is MySQL. Keep the memory-only 0029 fake out of application
  # subprocesses; the dedicated Memory tests construct it explicitly in-process.
  unset CREDENTIAL_TARGET_EXECUTION_ADAPTER
  unset TENANT_CREDENTIAL_TARGET_EXECUTION_WORKER_ENABLED TENANT_CREDENTIAL_TARGET_EXECUTION_ENABLED
  infra start
  mkdir -p "$STATE_DIR"
  pnpm run check:secrets
  pnpm run check:api
  pnpm typecheck
  AGENT_SERVICE_INTEGRATION=1 \
    MYSQL_TEST_URL="${MYSQL_TEST_URL:-mysql://root@127.0.0.1:3306/agent_service_test}" \
    REDIS_TEST_URL="${REDIS_TEST_URL:-redis://127.0.0.1:6379/1}" \
    pnpm vitest run --coverage --exclude 'test/cluster/**' \
      --reporter=default --reporter=json --outputFile.json="$STATE_DIR/verify-tests.json"
  AGENT_SERVICE_TEST_REPORT="$STATE_DIR/verify-tests.json" node scripts/assert-suites-ran.mjs
  MYSQL_MIGRATION_TEST_URL="${MYSQL_MIGRATION_TEST_URL:-${MYSQL_TEST_URL:-mysql://root@127.0.0.1:3306/agent_service_test}}" \
    pnpm run test:migrations
  MYSQL_TEST_URL="${MYSQL_TEST_URL:-mysql://root@127.0.0.1:3306/agent_service_test}" \
    pnpm run test:blob-mysql
  pnpm run test:blob-storage-control-memory
  MYSQL_TEST_URL="${MYSQL_TEST_URL:-mysql://root@127.0.0.1:3306/agent_service_test}" \
    pnpm run test:blob-storage-control-mysql
  pnpm run test:tenant-restore-journal-memory
  MYSQL_TEST_URL="${MYSQL_TEST_URL:-mysql://root@127.0.0.1:3306/agent_service_test}" \
    pnpm run test:tenant-restore-journal-mysql
  MYSQL_TEST_URL="${MYSQL_TEST_URL:-mysql://root@127.0.0.1:3306/agent_service_test}" \
    pnpm run test:tenant-backup-catalog-mysql
  MYSQL_TEST_URL="${MYSQL_TEST_URL:-mysql://root@127.0.0.1:3306/agent_service_test}" \
    pnpm run test:outbox-mysql
  MYSQL_TEST_URL="${MYSQL_TEST_URL:-mysql://root@127.0.0.1:3306/agent_service_test}" \
    pnpm run test:usage-lifecycle-mysql
  MYSQL_TEST_URL="${MYSQL_TEST_URL:-mysql://root@127.0.0.1:3306/agent_service_test}" \
    pnpm run test:subject-lifecycle-mysql
  MYSQL_TEST_URL="${MYSQL_TEST_URL:-mysql://root@127.0.0.1:3306/agent_service_test}" \
    pnpm run test:tenant-credential-revocation-mysql
  MYSQL_TEST_URL="${MYSQL_TEST_URL:-mysql://root@127.0.0.1:3306/agent_service_test}" \
    pnpm run test:tenant-credential-physical-revocation-mysql
  MYSQL_TEST_URL="${MYSQL_TEST_URL:-mysql://root@127.0.0.1:3306/agent_service_test}" \
    pnpm run test:tenant-credential-lifecycle-mysql
  MYSQL_TEST_URL="${MYSQL_TEST_URL:-mysql://root@127.0.0.1:3306/agent_service_test}" \
    pnpm run test:tenant-credential-target-execution-mysql
  MYSQL_TEST_URL="${MYSQL_TEST_URL:-mysql://root@127.0.0.1:3306/agent_service_test}" \
    pnpm run test:tenant-runtime-revocation-mysql
  MYSQL_TEST_URL="${MYSQL_TEST_URL:-mysql://root@127.0.0.1:3306/agent_service_test}" \
    pnpm run test:tenant-content-inventory-mysql
  MYSQL_TEST_URL="${MYSQL_TEST_URL:-mysql://root@127.0.0.1:3306/agent_service_test}" \
    pnpm run test:tenant-purge-plan-mysql
  MYSQL_TEST_URL="${MYSQL_TEST_URL:-mysql://root@127.0.0.1:3306/agent_service_test}" \
    pnpm run test:tenant-purge-execution-mysql
  pnpm run test:tenant-database-purge-memory
  MYSQL_TEST_URL="${MYSQL_TEST_URL:-mysql://root@127.0.0.1:3306/agent_service_test}" \
    pnpm run test:tenant-database-purge-mysql
  pnpm run test:tenant-redis-purge-memory
  MYSQL_TEST_URL="${MYSQL_TEST_URL:-mysql://root@127.0.0.1:3306/agent_service_test}" \
    REDIS_TEST_URL="${REDIS_TEST_URL:-redis://127.0.0.1:6379/1}" \
    pnpm run test:tenant-redis-purge-mysql
  REDIS_TEST_URL="${REDIS_TEST_URL:-redis://127.0.0.1:6379/1}" \
    pnpm run test:tenant-redis-purge-redis
  MYSQL_TEST_URL="${MYSQL_TEST_URL:-mysql://root@127.0.0.1:3306/agent_service_test}" \
    pnpm run test:retention-policy-mysql
  MYSQL_TEST_URL="${MYSQL_TEST_URL:-mysql://root@127.0.0.1:3306/agent_service_test}" \
    pnpm run test:erasure-purge-policy-mysql
  MYSQL_TEST_URL="${MYSQL_TEST_URL:-mysql://root@127.0.0.1:3306/agent_service_test}" \
    pnpm run test:erasure-job-mysql
  MYSQL_TEST_URL="${MYSQL_TEST_URL:-mysql://root@127.0.0.1:3306/agent_service_test}" \
    pnpm run test:erasure-session-mysql
  MYSQL_TEST_URL="${MYSQL_TEST_URL:-mysql://root@127.0.0.1:3306/agent_service_test}" \
    pnpm run test:erasure-catalog-mysql
  MYSQL_TEST_URL="${MYSQL_TEST_URL:-mysql://root@127.0.0.1:3306/agent_service_test}" \
    pnpm run test:erasure-usage-mysql
  MYSQL_TEST_URL="${MYSQL_TEST_URL:-mysql://root@127.0.0.1:3306/agent_service_test}" \
    pnpm run test:legacy-tombstone-mysql
  MYSQL_TEST_URL="${MYSQL_TEST_URL:-mysql://root@127.0.0.1:3306/agent_service_test}" \
    pnpm run test:user-data-export-mysql
  AGENT_SERVICE_CLUSTER=1 \
    CLUSTER_MYSQL_URL="${CLUSTER_MYSQL_URL:-mysql://root@127.0.0.1:3306/agent_service_cluster}" \
    CLUSTER_REDIS_URL="${CLUSTER_REDIS_URL:-redis://127.0.0.1:6379/3}" \
    pnpm vitest run test/cluster
  CLUSTER_MYSQL_URL="${CLUSTER_MYSQL_URL:-mysql://root@127.0.0.1:3306/agent_service_cluster}" \
    CLUSTER_REDIS_URL="${CLUSTER_REDIS_URL:-redis://127.0.0.1:6379/3}" \
    pnpm run test:tenant-redis-purge-cluster
  pnpm run build:check
}

verify_real() {
  require_tools
  [ -f .env ] || die ".env is missing"
  [ -n "${API_KEY:-}" ] || die "API_KEY is empty in .env"
  AGENT_SERVICE_REAL_E2E=1 pnpm vitest run packages/providers/test/e2e-qwen.test.ts
}

verify_s3() {
  require_tools
  MINIO_ENABLED=1 deploy/local/infra.sh start
  local -a s3_test_env=(
    S3_TEST_ENDPOINT="${MINIO_ENDPOINT:-http://127.0.0.1:9000}"
    S3_TEST_REGION="${MINIO_REGION:-us-east-1}"
    S3_TEST_BUCKET="${MINIO_BUCKET:-agent-service-local}"
    S3_TEST_ACCESS_KEY_ID="${MINIO_ROOT_USER:-agentservice-local}"
    S3_TEST_SECRET_ACCESS_KEY="${MINIO_ROOT_PASSWORD:-agent-service-local-minio-only-0001}"
    S3_TEST_FORCE_PATH_STYLE=1
  )
  env "${s3_test_env[@]}" pnpm run test:blob-s3
  local restore_journal_bucket="${RESTORE_JOURNAL_S3_BUCKET:-agent-service-local-restore-journal}"
  [ "$restore_journal_bucket" != "${MINIO_BUCKET:-agent-service-local}" ] \
    || die "RESTORE_JOURNAL_S3_BUCKET must differ from the Blob bucket"
  env "${s3_test_env[@]}" S3_TEST_BUCKET="$restore_journal_bucket" \
    node packages/store/scripts/bootstrap-s3.mjs
  env "${s3_test_env[@]}" S3_RESTORE_JOURNAL_TEST_BUCKET="$restore_journal_bucket" \
    pnpm run test:restore-journal-s3
  local backup_catalog_bucket="${BACKUP_CATALOG_S3_BUCKET:-agent-service-local-backup-catalog}"
  [ "$backup_catalog_bucket" != "${MINIO_BUCKET:-agent-service-local}" ] \
    || die "BACKUP_CATALOG_S3_BUCKET must differ from the Blob bucket"
  [ "$backup_catalog_bucket" != "$restore_journal_bucket" ] \
    || die "BACKUP_CATALOG_S3_BUCKET must differ from the restore-journal bucket"
  env "${s3_test_env[@]}" S3_TEST_BUCKET="$backup_catalog_bucket" \
    node packages/store/scripts/bootstrap-s3.mjs
  env "${s3_test_env[@]}" S3_BACKUP_CATALOG_TEST_BUCKET="$backup_catalog_bucket" \
    pnpm run test:backup-catalog-s3
  env "${s3_test_env[@]}" S3_BACKUP_CATALOG_TEST_BUCKET="$backup_catalog_bucket" \
    MYSQL_TEST_URL="${MYSQL_TEST_URL:-mysql://root@127.0.0.1:3306/agent_service_test}" \
    pnpm run test:backup-catalog-reconcile-mysql-s3
  env "${s3_test_env[@]}" \
    S3_BACKUP_CATALOG_TEST_BUCKET="$backup_catalog_bucket" \
    S3_RESTORE_JOURNAL_TEST_BUCKET="$restore_journal_bucket" \
    MYSQL_TEST_URL="${MYSQL_TEST_URL:-mysql://root@127.0.0.1:3306/agent_service_test}" \
    pnpm run test:backup-catalog-restore-roundtrip-mysql-s3
  env "${s3_test_env[@]}" \
    MYSQL_TEST_URL="${MYSQL_TEST_URL:-mysql://root@127.0.0.1:3306/agent_service_test}" \
    pnpm run test:blob-storage-migration-mysql-s3
  env "${s3_test_env[@]}" \
    AGENT_SERVICE_APP_SMOKE_MODE=source \
    MYSQL_APP_SMOKE_URL="${MYSQL_APP_SMOKE_URL:-${MYSQL_TEST_URL:-mysql://root@127.0.0.1:3306/agent_service_test}}" \
    pnpm run test:app-s3-smoke
}

cleanup_idempotency() {
  require_tools
  [ -n "${MYSQL_URL:-}" ] || die "MYSQL_URL is empty in .env/environment"
  node scripts/cleanup-idempotency.mjs "$@"
}

blob_storage_migrate() {
  require_tools
  # This is a foreground, one-shot runner entrypoint. The command implementation validates every
  # required source/target setting and fails closed; the wrapper never prints environment values.
  node --import tsx apps/agent-runner/src/blob-storage-migrate.ts "$@"
}

restore_ledger_reconcile() {
  require_tools
  # Foreground, one-shot recovery entrypoint. All database/object-store authority stays in the
  # environment; the wrapper never interpolates or prints those values.
  node --import tsx apps/agent-runner/src/restore-ledger-reconcile.ts "$@"
}

backup_catalog() {
  require_tools
  # Foreground, one-shot backup authority. Configuration may come from the explicitly preserved
  # caller environment or `.env`; the wrapper never interpolates or prints any of those values.
  node --import tsx apps/agent-runner/src/backup-catalog.ts "$@"
}

usage() {
  echo "usage: $0 start|stop|restart|status|logs|smoke|acceptance|verify|verify-s3|verify-real|cleanup-idempotency|blob-storage-migrate|restore-ledger-reconcile|backup-catalog|down"
}

case "${1:-}" in
  start) start_apps ;;
  stop) stop_apps ;;
  restart) stop_apps; start_apps ;;
  status) show_status ;;
  logs) mkdir -p "$STATE_DIR"; touch "$RUNNER_LOG" "$ROUTER_LOG"; tail -n 100 -f "$RUNNER_LOG" "$ROUTER_LOG" ;;
  smoke) smoke ;;
  acceptance) BASE="$ROUTER_URL" scripts/demo.sh ;;
  verify) verify ;;
  verify-s3) verify_s3 ;;
  verify-real) verify_real ;;
  cleanup-idempotency) shift; cleanup_idempotency "$@" ;;
  blob-storage-migrate) shift; blob_storage_migrate "$@" ;;
  restore-ledger-reconcile) shift; restore_ledger_reconcile "$@" ;;
  backup-catalog) shift; backup_catalog "$@" ;;
  down) stop_apps; infra stop ;;
  *) usage; exit 1 ;;
esac
