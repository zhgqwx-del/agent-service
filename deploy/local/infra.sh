#!/usr/bin/env bash
# Local infra for agent-service dev on this Mac (no Docker):
#   redis-server built from source into ~/.local/bin, mysqld 8.0 (existing x86_64 binary under Rosetta)
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

start() {
  mkdir -p "$VAR/redis" "$VAR/mysql"
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
}
stop() {
  "$REDIS_CLI" -p 6379 shutdown nosave >/dev/null 2>&1 && echo "redis: stopped" || echo "redis: not running"
  if [ -f "$VAR/mysql/mysqld.pid" ]; then kill "$(cat "$VAR/mysql/mysqld.pid")" && echo "mysql: stopping"; else echo "mysql: not running"; fi
}
status() {
  "$REDIS_CLI" -p 6379 ping 2>/dev/null | sed 's/^/redis: /' || echo "redis: down"
  "$MYSQL" --socket="$MYSQL_SOCK" -uroot -e 'select version() as mysql' 2>/dev/null || echo "mysql: down"
}
reset_db() {
  "$MYSQL" --socket="$MYSQL_SOCK" -uroot -e "DROP DATABASE IF EXISTS \`$DB_NAME\`; CREATE DATABASE \`$DB_NAME\` CHARACTER SET utf8mb4; DROP DATABASE IF EXISTS \`${DB_NAME}_test\`; CREATE DATABASE \`${DB_NAME}_test\` CHARACTER SET utf8mb4;"
  "$REDIS_CLI" -p 6379 flushall >/dev/null; echo "reset done"
}
case "${1:-}" in start) start;; stop) stop;; status) status;; reset-db) reset_db;; *) echo "usage: $0 start|stop|status|reset-db"; exit 1;; esac
