# 端到端探测：临时 forward 客户端 -> tailcat 链接 -> /health。只打印路径，从不打印链接本身。
# 用法: python3 probe.py <rokbot-tailcat 二进制> <link 文件> [秒数，默认 20]
import json, subprocess, sys, time, urllib.request, threading
if len(sys.argv) < 3:
    print("usage: probe.py <rokbot-tailcat binary> <link file> [seconds]", file=sys.stderr); sys.exit(2)
binary, link = sys.argv[1], open(sys.argv[2]).read().strip()
secs = int(sys.argv[3] if len(sys.argv) > 3 else 20)
p = subprocess.Popen([binary], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
p.stdin.write(json.dumps({"mode": "forward", "link": link}) + "\n"); p.stdin.flush()
state = {"url": None, "path": "unknown"}; t0 = time.time(); ok = 0
def reader():
    for line in p.stdout:
        s = json.loads(line).get("status", {})
        state["url"] = s.get("localURL") or state["url"]; state["path"] = s.get("path", state["path"])
threading.Thread(target=reader, daemon=True).start()
while time.time() - t0 < secs:
    time.sleep(5)
    if state["url"]:
        try:
            a = time.time(); body = json.loads(urllib.request.urlopen(state["url"] + "/health", timeout=10).read())
            ok += bool(body.get("ok")); print(f"  probe t={time.time()-t0:4.0f}s health ok={body.get('ok')} rtt={1000*(time.time()-a):.0f}ms path={state['path']}", flush=True)
        except Exception as e: print("  probe health error:", e, flush=True)
p.stdin.close(); p.terminate(); sys.exit(0 if ok else 1)
