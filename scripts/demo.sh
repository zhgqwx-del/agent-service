#!/usr/bin/env bash
# 手动验收脚本：通过 runner 或 router 把主要能力跑一遍并打印可读结果。
#
#   deploy/local/infra.sh start          # 先起 redis + mysql
#   scripts/demo.sh                      # 全流程
#   scripts/demo.sh approval             # 只跑审批流（需要人工在提示后回车）
#
# 环境变量：BASE(默认 http://127.0.0.1:8787) KEY(dev-key) DEMO_USER(u_demo) MODEL(取 .env DEFAULT_MODEL)
set -uo pipefail
cd "$(dirname "$0")/.."

FAILURES=0

BASE=${BASE:-http://127.0.0.1:8787}
KEY=${KEY:-dev-key}
USER_ID=${DEMO_USER:-u_demo}
[ -f .env ] && set -a && . ./.env && set +a
MODEL=${MODEL:-${DEFAULT_MODEL:-qwen3.8-max}}
H=(-H "Authorization: Bearer $KEY" -H "X-User-Id: $USER_ID" -H "Content-Type: application/json")
PY=${PY:-python3}

say() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
ok()  { printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad() { printf '  \033[31m✗\033[0m %s\n' "$*"; FAILURES=$((FAILURES + 1)); }
jqp() { "$PY" -c "import sys,json; d=json.load(sys.stdin); print($1)"; }

# ---------- 0. 前置检查 ----------
say "0. 前置检查"
if ! curl -fsS "$BASE/readyz" >/dev/null 2>&1; then
  bad "服务未在 $BASE ready。请在另一个终端执行："
  echo "      STORE=mysql REDIS_URL=redis://127.0.0.1:6379 pnpm dev:runner"
  echo "   （纯内存模式：pnpm dev:runner）"
  exit 1
fi
ok "服务就绪：$(curl -fsS "$BASE/readyz")"
CAPS=$(curl -fsS "$BASE/v1/capabilities")
ok "协议版本 $(echo "$CAPS" | jqp 'd["protocolVersion"]')，BYOK=$(echo "$CAPS" | jqp 'd["features"]["byok"]')"

# ---------- 1. 鉴权 ----------
say "1. 鉴权（应当拒绝）"
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/v1/agents")
[ "$code" = 401 ] && ok "无 key → 401" || bad "无 key 返回 ${code}，预期 401"
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/v1/agents" -H "Authorization: Bearer wrong-key")
[ "$code" = 401 ] && ok "错误 key → 401" || bad "错误 key 返回 ${code}，预期 401"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/sessions" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d '{"agentId":"agt_00000000-0000-7000-8000-000000000000"}')
[ "$code" = 400 ] && ok "缺 X-User-Id → 400" || bad "缺 X-User-Id 返回 ${code}，预期 400"

# ---------- 2. agent + session ----------
say "2. 创建 agent 与 session"
AGENT=$(curl -fsS -X POST "$BASE/v1/agents" "${H[@]}" -d "{
  \"name\":\"demo\",
  \"instructions\":\"你是一个简洁的助手。需要时间就调用 current_time，需要网页内容就调用 web_fetch。用中文回答。\",
  \"model\":{\"provider\":\"dashscope\",\"model\":\"$MODEL\"},
  \"tools\":[\"current_time\",\"web_fetch\"],
  \"limits\":{\"maxSteps\":6,\"maxCostCNY\":1}
}") || { bad "创建 agent 失败"; exit 1; }
AID=$(echo "$AGENT" | jqp 'd["id"]')
ok "agent $AID v$(echo "$AGENT" | jqp 'd["version"]')"
SESS=$(curl -fsS -X POST "$BASE/v1/sessions" "${H[@]}" -d "{\"agentId\":\"$AID\",\"title\":\"demo\"}")
SID=$(echo "$SESS" | jqp 'd["id"]')
ok "session ${SID}，contextEpoch=$(echo "$SESS" | jqp 'd["contextEpoch"]')"

if [ "${1:-}" = "approval" ]; then
  say "审批流：把 agent 改成 untrusted（所有非只读工具都要批）"
  echo "  （current_time / web_fetch 都是只读工具，untrusted 下不会触发审批；"
  echo "   审批流的自动化验证见 packages/core/test/host.test.ts 的 approvals 用例）"
  exit 0
fi

# ---------- 3. 流式 turn ----------
say "3. 流式 turn（SSE）"
STREAM=$(mktemp)
curl -fsSN -X POST "$BASE/v1/sessions/$SID/turns?exclude=item/agentMessage/delta" "${H[@]}" \
  -H "Idempotency-Key: demo-$SID-1" \
  -d '{"input":[{"type":"text","text":"现在几点了？用一句话告诉我，并说明今天星期几。"}]}' > "$STREAM"
"$PY" scripts/lib/print_stream.py "$STREAM"
LAST_SEQ=$(grep -oE '^id: [0-9]+' "$STREAM" | tail -1 | grep -oE '[0-9]+')

# ---------- 4. 落库的消息历史 ----------
say "4. 消息历史（GET /items）"
curl -fsS "$BASE/v1/sessions/$SID/items" "${H[@]}" | "$PY" scripts/lib/print_items.py

# ---------- 5. 断线重放 ----------
say "5. 断线重放（?after=<seq>，应当只收到更大的 seq 且不含 delta）"
MID=$((LAST_SEQ / 2))
curl -fsSN --max-time 2 "$BASE/v1/sessions/$SID/events?after=$MID" "${H[@]}" 2>/dev/null \
  | grep -E '^(id|event):' | paste - - | sed 's/^/  /' | head -20
ok "以上 id 均应 > $MID"

# ---------- 6. 幂等 ----------
say "6. 幂等重放（同一 Idempotency-Key）"
RESP=$(curl -fsS -i -X POST "$BASE/v1/sessions/$SID/turns" "${H[@]}" -H "Idempotency-Key: demo-$SID-1" -d '{"input":[{"type":"text","text":"现在几点了？用一句话告诉我，并说明今天星期几。"}],"stream":false}')
echo "$RESP" | grep -iE '^(HTTP|idempotency-replayed)' | sed 's/^/  /'
echo "$RESP" | grep -qi 'idempotency-replayed: true' && ok "命中幂等，未重复执行" || bad "未命中幂等"

# ---------- 7. 上下文延续 ----------
say "7. 第二轮（验证模型能看到第一轮历史）"
curl -fsSN -X POST "$BASE/v1/sessions/$SID/turns?exclude=item/agentMessage/delta,usage/updated" "${H[@]}" \
  -d '{"input":[{"type":"text","text":"我上一个问题问了什么？一句话复述。"}]}' \
  | grep '^data:' | grep '"item/completed"' | tail -1 \
  | "$PY" scripts/lib/print_event_field.py text

# ---------- 8. 安全阀 ----------
say "8. 安全阀（maxSteps=1，应当在一步后停）"
S2=$(curl -fsS -X POST "$BASE/v1/sessions" "${H[@]}" -d "{\"agentId\":\"$AID\"}" | jqp 'd["id"]')
curl -fsSN -X POST "$BASE/v1/sessions/$S2/turns?exclude=item/agentMessage/delta,usage/updated" "${H[@]}" \
  -d '{"input":[{"type":"text","text":"现在几点了？"}],"limits":{"maxSteps":1}}' \
  | grep '^data:' | grep '"turn/completed"' \
  | "$PY" scripts/lib/print_event_field.py turn

# ---------- 9. 隔离与错误语义 ----------
say "9. 隔离与错误语义（都应当被拒绝）"
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/v1/sessions/$SID" -H "Authorization: Bearer $KEY" -H "X-User-Id: someone-else")
[ "$code" = 404 ] && ok "跨用户读会话 → 404（不泄漏存在性）" || bad "跨用户读会话返回 ${code}，预期 404"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/sessions/$SID/turns?exclude=session/status/changed" "${H[@]}" -d '{"input":[{"type":"text","text":"x"}]}')
[ "$code" = 400 ] && ok "排除终止类事件 → 400（否则流永不结束）" || bad "非法 exclude 返回 ${code}，预期 400"
code=$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$BASE/v1/providers/evil" "${H[@]}" -d '{"baseUrl":"http://169.254.169.254/latest","models":[{"id":"m"}],"apiKey":"k"}')
[ "$code" = 400 ] && ok "BYOK 指向云元数据地址 → 400（阻断 SSRF）" || bad "内网 baseUrl 返回 ${code}，预期 400"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/sessions/$SID/turns" "${H[@]}" -d '{"input":[{"type":"text","text":"x"}],"model":"deepseek/deepseek-v4"}')
[ "$code" = 400 ] && ok "model 写成字符串 → 400（必须是对象）" || bad "字符串 model 返回 ${code}，预期 400"
"$PY" -c "print('{\"input\":[{\"type\":\"text\",\"text\":\"' + 'A'*1500000 + '\"}]}')" > /tmp/agent-demo-big.json
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/sessions/$SID/turns" "${H[@]}" --data-binary @/tmp/agent-demo-big.json)
[ "$code" = 400 ] && ok "1.5MB 请求体 → 400（body 上限）" || bad "超大 body 返回 ${code}，预期 400"
rm -f /tmp/agent-demo-big.json

# ---------- 10. BYOK ----------
say "10. BYOK（写入后 key 不可读回）"
curl -fsS -X PUT "$BASE/v1/providers/demo-byok" "${H[@]}" \
  -d '{"baseUrl":"https://example.com/v1","apiKey":"fake-byok-secret-value","models":[{"id":"m1"}]}' \
  | "$PY" -c 'import sys,json; d=json.load(sys.stdin); s=json.dumps(d); print("  apiKeyRef:", d.get("apiKeyRef")); assert "fake-byok-secret-value" not in s, "泄漏！"; print("  \033[32m✓\033[0m 响应体不含明文 key")'
curl -fsS "$BASE/v1/providers" "${H[@]}" | "$PY" -c 'import sys,json; print("  可见 provider:", [p["id"] for p in json.load(sys.stdin)["data"]])'
curl -fsS -X DELETE "$BASE/v1/providers/demo-byok" "${H[@]}" -o /dev/null -w '  删除返回 %{http_code}\n'

rm -f "$STREAM"
if [ "$FAILURES" -gt 0 ]; then
  say "验收失败：$FAILURES 项未通过"
  exit 1
fi

say "完成。session=$SID"
echo "可继续手动探索："
echo "  curl -sN \"$BASE/v1/sessions/$SID/events?after=0\" -H \"Authorization: Bearer $KEY\" -H \"X-User-Id: $USER_ID\""
