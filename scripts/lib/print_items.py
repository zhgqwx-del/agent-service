"""stdin: GET /v1/sessions/{id}/items 的响应体。打印可读的 item 列表。"""
import json
import sys

for i in json.load(sys.stdin)["data"]:
    t = i["type"]
    x = i.get("text") or i.get("name") or ""
    if t == "userMessage":
        x = i["content"][0].get("text", "")
    if t == "toolResult":
        x = i["content"][0]["text"][:60]
    seq, step, status = i["seq"], str(i.get("step")), i["status"]
    print(f"  seq={seq:>3} step={step:<4} {t:<14} {status:<10} {x[:70]}")
