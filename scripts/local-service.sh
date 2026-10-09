#!/usr/bin/env bash
# Local operations entrypoint for the runner + router stack.
# Keeps application PIDs/logs under .local-run/ and delegates MySQL/Redis to deploy/local/infra.sh.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Load local defaults while keeping the explicitly snapshotted topology overrides authoritative.
caller_runner_port="${RUNNER_PORT-}"
caller_router_port="${ROUTER_PORT-}"
caller_runner_id="${RUNNER_ID-}"
caller_runner_addr="${RUNNER_ADDR-}"
caller_runners="${RUNNERS-}"
caller_redis_url="${REDIS_URL-}"
caller_session_tombstone_enabled="${SESSION_TOMBSTONE_ENABLED-}"
caller_data_erasure_requests_enabled="${DATA_ERASURE_REQUESTS_ENABLED-}"
caller_data_governance_management_enabled="${DATA_GOVERNANCE_MANAGEMENT_ENABLED-}"
caller_purge_policy_evaluator_enabled="${PURGE_POLICY_EVALUATOR_ENABLED-}"
caller_data_export_requests_enabled="${DATA_EXPORT_REQUESTS_ENABLED-}"
caller_data_export_worker_enabled="${DATA_EXPORT_WORKER_ENABLED-}"
caller_data_export_cleanup_enabled="${DATA_EXPORT_CLEANUP_ENABLED-}"
caller_erasure_worker_enabled="${ERASURE_WORKER_ENABLED-}"
caller_legacy_tombstone_compensation_enabled="${LEGACY_TOMBSTONE_COMPENSATION_ENABLED-}"
caller_erasure_router_url="${ERASURE_ROUTER_URL-}"
caller_blob_dir="${BLOB_DIR-}"
caller_blob_filesystem_single_runner="${BLOB_FILESYSTEM_SINGLE_RUNNER-}"
caller_blob_cleanup_enabled="${BLOB_CLEANUP_ENABLED-}"
caller_blob_attachments_enabled="${BLOB_ATTACHMENTS_ENABLED-}"
caller_blob_max_bytes="${BLOB_MAX_BYTES-}"
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi
[ -n "$caller_runner_port" ] && RUNNER_PORT="$caller_runner_port"
[ -n "$caller_router_port" ] && ROUTER_PORT="$caller_router_port"
[ -n "$caller_runner_id" ] && RUNNER_ID="$caller_runner_id"
[ -n "$caller_runner_addr" ] && RUNNER_ADDR="$caller_runner_addr"
[ -n "$caller_runners" ] && RUNNERS="$caller_runners"
[ -n "$caller_redis_url" ] && REDIS_URL="$caller_redis_url"
[ -n "$caller_session_tombstone_enabled" ] && SESSION_TOMBSTONE_ENABLED="$caller_session_tombstone_enabled"
[ -n "$caller_data_erasure_requests_enabled" ] && DATA_ERASURE_REQUESTS_ENABLED="$caller_data_erasure_requests_enabled"
[ -n "$caller_data_governance_management_enabled" ] && DATA_GOVERNANCE_MANAGEMENT_ENABLED="$caller_data_governance_management_enabled"
[ -n "$caller_purge_policy_evaluator_enabled" ] && PURGE_POLICY_EVALUATOR_ENABLED="$caller_purge_policy_evaluator_enabled"
[ -n "$caller_data_export_requests_enabled" ] && DATA_EXPORT_REQUESTS_ENABLED="$caller_data_export_requests_enabled"
[ -n "$caller_data_export_worker_enabled" ] && DATA_EXPORT_WORKER_ENABLED="$caller_data_export_worker_enabled"
[ -n "$caller_data_export_cleanup_enabled" ] && DATA_EXPORT_CLEANUP_ENABLED="$caller_data_export_cleanup_enabled"
[ -n "$caller_erasure_worker_enabled" ] && ERASURE_WORKER_ENABLED="$caller_erasure_worker_enabled"
[ -n "$caller_legacy_tombstone_compensation_enabled" ] && LEGACY_TOMBSTONE_COMPENSATION_ENABLED="$caller_legacy_tombstone_compensation_enabled"
[ -n "$caller_erasure_router_url" ] && ERASURE_ROUTER_URL="$caller_erasure_router_url"
[ -n "$caller_blob_dir" ] && BLOB_DIR="$caller_blob_dir"
[ -n "$caller_blob_filesystem_single_runner" ] && BLOB_FILESYSTEM_SINGLE_RUNNER="$caller_blob_filesystem_single_runner"
[ -n "$caller_blob_cleanup_enabled" ] && BLOB_CLEANUP_ENABLED="$caller_blob_cleanup_enabled"
[ -n "$caller_blob_attachments_enabled" ] && BLOB_ATTACHMENTS_ENABLED="$caller_blob_attachments_enabled"
[ -n "$caller_blob_max_bytes" ] && BLOB_MAX_BYTES="$caller_blob_max_bytes"

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
  mkdir -p "$STATE_DIR"
  deploy/local/infra.sh start

  if pid_alive "$RUNNER_PID_FILE"; then
    echo "runner: already running (pid $(sed -n '1p' "$RUNNER_PID_FILE"))"
  else
    nohup env STORE=mysql \
      RUNNER_PORT="$RUNNER_PORT" \
      RUNNER_ID="${RUNNER_ID:-runner-local-1}" \
      RUNNER_ADDR="${RUNNER_ADDR:-127.0.0.1:$RUNNER_PORT}" \
      BLOB_DIR="${BLOB_DIR:-$STATE_DIR/blobs}" \
      BLOB_FILESYSTEM_SINGLE_RUNNER="${BLOB_FILESYSTEM_SINGLE_RUNNER:-1}" \
      BLOB_CLEANUP_ENABLED="${BLOB_CLEANUP_ENABLED:-1}" \
      BLOB_ATTACHMENTS_ENABLED="${BLOB_ATTACHMENTS_ENABLED:-1}" \
      BLOB_MAX_BYTES="${BLOB_MAX_BYTES:-1000000}" \
      DATA_ERASURE_REQUESTS_ENABLED="${DATA_ERASURE_REQUESTS_ENABLED:-0}" \
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
    nohup env RUNNERS="${RUNNERS:-$RUNNER_URL}" \
      REDIS_URL="${REDIS_URL:-redis://127.0.0.1:6379}" \
      SESSION_TOMBSTONE_ENABLED="${SESSION_TOMBSTONE_ENABLED:-1}" \
      DATA_ERASURE_REQUESTS_ENABLED="${DATA_ERASURE_REQUESTS_ENABLED:-0}" \
      DATA_GOVERNANCE_MANAGEMENT_ENABLED="${DATA_GOVERNANCE_MANAGEMENT_ENABLED:-0}" \
      PURGE_POLICY_EVALUATOR_ENABLED="${PURGE_POLICY_EVALUATOR_ENABLED:-0}" \
      DATA_EXPORT_REQUESTS_ENABLED="${DATA_EXPORT_REQUESTS_ENABLED:-0}" \
      BLOB_FILESYSTEM_SINGLE_RUNNER="${BLOB_FILESYSTEM_SINGLE_RUNNER:-1}" \
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
  deploy/local/infra.sh status || true
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
  deploy/local/infra.sh start
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
    pnpm run test:usage-lifecycle-mysql
  MYSQL_TEST_URL="${MYSQL_TEST_URL:-mysql://root@127.0.0.1:3306/agent_service_test}" \
    pnpm run test:subject-lifecycle-mysql
  MYSQL_TEST_URL="${MYSQL_TEST_URL:-mysql://root@127.0.0.1:3306/agent_service_test}" \
    pnpm run test:tenant-credential-revocation-mysql
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
  pnpm run build:check
}

verify_real() {
  require_tools
  [ -f .env ] || die ".env is missing"
  [ -n "${API_KEY:-}" ] || die "API_KEY is empty in .env"
  AGENT_SERVICE_REAL_E2E=1 pnpm vitest run packages/providers/test/e2e-qwen.test.ts
}

cleanup_idempotency() {
  require_tools
  [ -n "${MYSQL_URL:-}" ] || die "MYSQL_URL is empty in .env/environment"
  node scripts/cleanup-idempotency.mjs "$@"
}

usage() {
  echo "usage: $0 start|stop|restart|status|logs|smoke|acceptance|verify|verify-real|cleanup-idempotency|down"
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
  verify-real) verify_real ;;
  cleanup-idempotency) shift; cleanup_idempotency "$@" ;;
  down) stop_apps; deploy/local/infra.sh stop ;;
  *) usage; exit 1 ;;
esac
