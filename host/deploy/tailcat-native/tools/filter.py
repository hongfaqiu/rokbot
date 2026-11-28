# 从 rokbot-tailcat 的 stdout JSON 行里抽出 link 写进文件，并在终端打印状态（不打印链接）。
# 用法: <serve 进程的输出> | python3 filter.py /path/to/state/link
# 文件会以当前 umask 创建；建议在 umask 077 下运行，链接等同于配对凭证。
import sys, json
for line in sys.stdin:
    v = json.loads(line); s = v.get("status", {})
    if v.get("ready") and s.get("link"): open(sys.argv[1], "w").write(s["link"] + "\n")
    print("container-test", s.get("state"), s.get("listening"), s.get("error", ""), flush=True)
