#!/usr/bin/env bash
# Local infra for agent-service dev on this Mac (no Docker):
#   redis-server built from source into ~/.local/bin, mysqld 8.0 (existing x86_64 binary under
#   Rosetta), and a MinIO server built from the repository-pinned official commit.
# Usage: deploy/local/infra.sh start|stop|status|reset-db
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
VAR="$HOME/.local/var"
REDIS_BIN="${REDIS_BIN:-$HOME/.local/bin/redis-server}"
REDIS_CLI="${REDIS_CLI:-$HOME/.local/bin/redis-cli}"
MYSQLD="${MYSQLD:-/usr/local/bin/mysqld}"
MYSQL="${MYSQL:-/usr/local/bin/mysql}"
MYSQL_DATA="$VAR/mysql/data"
MYSQL_SOCK="$VAR/mysql/mysql.sock"
DB_NAME="${DB_NAME:-agent_service}"
MINIO_ENABLED="${MINIO_ENABLED:-0}"
MINIO_BIN="${MINIO_BIN:-$HERE/../../.local-run/tooling/minio}"
MINIO_DIR="$VAR/minio"
MINIO_DATA="$MINIO_DIR/data"
MINIO_PID="$MINIO_DIR/minio.pid"
MINIO_LOG="$MINIO_DIR/minio.log"
MINIO_ENDPOINT="${MINIO_ENDPOINT:-http://127.0.0.1:9000}"
MINIO_ADDRESS="${MINIO_ADDRESS:-127.0.0.1:9000}"
MINIO_CONSOLE_ADDRESS="${MINIO_CONSOLE_ADDRESS:-127.0.0.1:9001}"
MINIO_REGION="${MINIO_REGION:-us-east-1}"
MINIO_ROOT_USER="${MINIO_ROOT_USER:-agentservice-local}"
MINIO_ROOT_PASSWORD="${MINIO_ROOT_PASSWORD:-agent-service-local-minio-only-0001}"
MINIO_BUCKET="${MINIO_BUCKET:-agent-service-local}"
S3_BOOTSTRAP="$HERE/../../packages/store/scripts/bootstrap-s3.mjs"

case "$MINIO_ENABLED" in
  0|1) ;;
  *) echo "MINIO_ENABLED must be 0 or 1" >&2; exit 1 ;;
esac

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing required command: $1" >&2
    return 1
  fi
}

minio_ready() {
  curl -fsS "$MINIO_ENDPOINT/minio/health/ready" >/dev/null 2>&1
}

bootstrap_minio() {
  require_command node
  umask 077
  env \
    S3_TEST_ENDPOINT="$MINIO_ENDPOINT" \
    S3_TEST_REGION="$MINIO_REGION" \
    S3_TEST_BUCKET="$MINIO_BUCKET" \
    S3_TEST_ACCESS_KEY_ID="$MINIO_ROOT_USER" \
    S3_TEST_SECRET_ACCESS_KEY="$MINIO_ROOT_PASSWORD" \
    S3_TEST_FORCE_PATH_STYLE=1 \
    node "$S3_BOOTSTRAP" >/dev/null
}

start_minio() {
  require_command curl
  mkdir -p "$MINIO_DATA"
  chmod 700 "$MINIO_DIR" "$MINIO_DATA"

  if minio_ready; then
    echo "minio: already running"
  else
    require_command "$MINIO_BIN"
    nohup env MINIO_ROOT_USER="$MINIO_ROOT_USER" MINIO_ROOT_PASSWORD="$MINIO_ROOT_PASSWORD" \
      "$MINIO_BIN" --quiet --anonymous server "$MINIO_DATA" --address "$MINIO_ADDRESS" \
      --console-address "$MINIO_CONSOLE_ADDRESS" >"$MINIO_LOG" 2>&1 &
    printf '%s\n' "$!" >"$MINIO_PID"
    for _ in $(seq 1 60); do
      minio_ready && break
      sleep 0.5
    done
    if ! minio_ready; then
      echo "minio: failed to become ready; inspect $MINIO_LOG" >&2
      return 1
    fi
    echo "minio: started ($MINIO_ENDPOINT)"
  fi

  bootstrap_minio
  echo "minio: private un-versioned bucket ready ($MINIO_BUCKET)"
}

stop_minio() {
  if [ ! -f "$MINIO_PID" ]; then
    if minio_ready; then
      echo "minio: running but not owned by this script"
    else
      echo "minio: not running"
    fi
    return
  fi

  local pid
  pid="$(cat "$MINIO_PID")"
  local command_line=""
  case "$pid" in
    ""|*[!0-9]*) ;;
    *) command_line="$(ps -p "$pid" -o command= 2>/dev/null || true)" ;;
  esac
  if [ -n "$command_line" ] && [[ "$command_line" == *"$MINIO_DATA"* ]]; then
    kill "$pid"
    for _ in $(seq 1 20); do
      kill -0 "$pid" >/dev/null 2>&1 || break
      sleep 0.25
    done
    echo "minio: stopping"
  else
    echo "minio: stale pid file removed"
  fi
  rm -f "$MINIO_PID"
}

status_minio() {
  if ! minio_ready; then
    echo "minio: down"
    return
  fi

  if command -v node >/dev/null 2>&1 \
    && env S3_TEST_ENDPOINT="$MINIO_ENDPOINT" S3_TEST_REGION="$MINIO_REGION" \
      S3_TEST_BUCKET="$MINIO_BUCKET" S3_TEST_ACCESS_KEY_ID="$MINIO_ROOT_USER" \
      S3_TEST_SECRET_ACCESS_KEY="$MINIO_ROOT_PASSWORD" S3_TEST_FORCE_PATH_STYLE=1 \
      node "$S3_BOOTSTRAP" --check >/dev/null 2>&1; then
    echo "minio: ready (bucket=$MINIO_BUCKET)"
  else
    echo "minio: ready (bucket bootstrap missing or invalid)"
  fi
}

start() {
  mkdir -p "$VAR/redis" "$VAR/mysql" "$MINIO_DIR"
  if "$REDIS_CLI" -p 6379 ping >/dev/null 2>&1; then echo "redis: already running"; else
    (cd "$VAR/redis" && nohup "$REDIS_BIN" "$HERE/redis.conf" > "$VAR/redis/redis.log" 2>&1 &)
    sleep 0.5; "$REDIS_CLI" -p 6379 ping | sed 's/^/redis: /'
  fi
  if "$MYSQL" --socket="$MYSQL_SOCK" -uroot -e 'select 1' >/dev/null 2>&1; then echo "mysql: already running"; else
    [ -d "$MYSQL_DATA" ] || "$MYSQLD" --initialize-insecure --datadir="$MYSQL_DATA" --user="$(whoami)"
    nohup "$MYSQLD" --defaults-file="$HERE/my.cnf" --datadir="$MYSQL_DATA" --socket="$MYSQL_SOCK" \
      --pid-file="$VAR/mysql/mysqld.pid" --log-error="$VAR/mysql/mysqld.log" > /dev/null 2>&1 &
    for i in $(seq 1 30); do "$MYSQL" --socket="$MYSQL_SOCK" -uroot -e 'select 1' >/dev/null 2>&1 && break; sleep 0.5; done
    "$MYSQL" --socket="$MYSQL_SOCK" -uroot -e "CREATE DATABASE IF NOT EXISTS \`$DB_NAME\` CHARACTER SET utf8mb4; CREATE DATABASE IF NOT EXISTS \`${DB_NAME}_test\` CHARACTER SET utf8mb4; CREATE DATABASE IF NOT EXISTS \`${DB_NAME}_cluster\` CHARACTER SET utf8mb4;"
    echo "mysql: started (db=$DB_NAME, ${DB_NAME}_test, ${DB_NAME}_cluster; root, empty password, 127.0.0.1:3306)"
  fi
  if [ "$MINIO_ENABLED" = "1" ]; then
    start_minio
  else
    echo "minio: disabled (set MINIO_ENABLED=1 for the S3 backend)"
  fi
}
stop() {
  # MINIO_ENABLED controls admission/startup only. Always inspect the owned PID so a
  # one-shot `verify-s3` process remains visible to, and stoppable by, the normal lifecycle.
  stop_minio
  "$REDIS_CLI" -p 6379 shutdown nosave >/dev/null 2>&1 && echo "redis: stopped" || echo "redis: not running"
  if [ -f "$VAR/mysql/mysqld.pid" ]; then kill "$(cat "$VAR/mysql/mysqld.pid")" && echo "mysql: stopping"; else echo "mysql: not running"; fi
}
status() {
  "$REDIS_CLI" -p 6379 ping 2>/dev/null | sed 's/^/redis: /' || echo "redis: down"
  "$MYSQL" --socket="$MYSQL_SOCK" -uroot -e 'select version() as mysql' 2>/dev/null || echo "mysql: down"
  status_minio
}
reset_db() {
  "$MYSQL" --socket="$MYSQL_SOCK" -uroot -e "DROP DATABASE IF EXISTS \`$DB_NAME\`; CREATE DATABASE \`$DB_NAME\` CHARACTER SET utf8mb4; DROP DATABASE IF EXISTS \`${DB_NAME}_test\`; CREATE DATABASE \`${DB_NAME}_test\` CHARACTER SET utf8mb4;"
  "$REDIS_CLI" -p 6379 flushall >/dev/null
  echo "reset done (MinIO objects intentionally preserved)"
}
case "${1:-}" in start) start;; stop) stop;; status) status;; reset-db) reset_db;; *) echo "usage: $0 start|stop|status|reset-db"; exit 1;; esac
