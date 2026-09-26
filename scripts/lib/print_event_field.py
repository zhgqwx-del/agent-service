"""stdin: 单行 `data: {...}` 的 SSE 事件。argv[1]: 打印模式。"""
import json
import sys

raw = sys.stdin.read().strip()
d = json.loads(raw[raw.index("{"):])
mode = sys.argv[1] if len(sys.argv) > 1 else "text"
if mode == "text":
    print("  模型回答:", d["item"].get("text"))
elif mode == "turn":
    t = d["turn"]
    print(f'  stopReason={d["stopReason"]} steps={t["steps"]} partialText={t.get("partialText")!r}')
