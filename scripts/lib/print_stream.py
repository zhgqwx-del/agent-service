"""argv[1]: 保存的 SSE 响应文件。打印事件序列并断言 seq 单调。"""
import json
import re
import sys

blocks = open(sys.argv[1]).read().split("\n\n")
seqs = []
for b in blocks:
    if "data:" not in b:
        continue
    ev = re.search(r"^event: (.*)$", b, re.M)
    idm = re.search(r"^id: (.*)$", b, re.M)
    d = json.loads(re.search(r"^data: (.*)$", b, re.M).group(1))
    t = ev.group(1) if ev else d.get("type")
    if idm:
        seqs.append(int(idm.group(1)))
    detail = ""
    if t == "item/completed":
        it = d["item"]
        detail = it["type"]
        if it["type"] in ("toolCall", "toolResult"):
            detail += " " + it.get("name", "")
        if it["type"] == "agentMessage":
            detail += ' "' + it["text"][:40] + '"'
    if t == "turn/completed":
        turn, cost = d["turn"], d["turn"]["usage"].get("costCNY") or 0
        detail = f'{turn["status"]} stop={d["stopReason"]} steps={turn["steps"]} tools={turn["toolCalls"]} cost=CNY{cost:.5f}'
    sid = idm.group(1) if idm else "-"
    print(f"  {sid:>3}  {t:<26} {detail}")
assert seqs == sorted(seqs), f"seq 乱序: {seqs}"
print(f"  \033[32m+\033[0m seq 单调: {seqs[0]}..{seqs[-1]}")
