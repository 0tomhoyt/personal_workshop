#!/bin/bash
# status.sh — 查看统一订阅网关状态（服务 / 各上游凭证 / 最近请求）
#
# 用法: ./status.sh [端口]     # 缺省 8484

set -euo pipefail

LABEL="cn.hicann.cannbot-gateway-proxy"
RUNTIME_DIR="$HOME/.local/share/cannbot-gateway-proxy"
# 缺省用安装时记录的端口（install.sh 写入），未安装则退回 8484
DEFAULT_PORT="$(cat "$RUNTIME_DIR/port" 2>/dev/null || echo 8484)"
[[ "$DEFAULT_PORT" =~ ^[0-9]+$ ]] || DEFAULT_PORT=8484
PORT="${1:-$DEFAULT_PORT}"

# launchd 原始信息（可能为空 = 未安装）
LAUNCH_INFO="$(launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null || true)"
# healthz 原始 JSON（可能为空 = 服务无响应）
HEALTH_JSON="$(curl -fsS -m 5 "http://127.0.0.1:$PORT/healthz" 2>/dev/null || true)"

LOG_FILE="$RUNTIME_DIR/proxy.log"
ERR_LOG="$RUNTIME_DIR/logs/proxy.err.log"

python3 - "$PORT" "$LAUNCH_INFO" "$HEALTH_JSON" "$LOG_FILE" "$ERR_LOG" <<'PYEOF'
import sys, json, re, datetime, os

port, launch_info, health_raw, log_file, err_log = sys.argv[1:6]
color = sys.stdout.isatty()
C = lambda code: f"\033[{code}m" if color else ""
GREEN, RED, YELLOW, DIM, BOLD, RESET = C("32"), C("31"), C("33"), C("2"), C("1"), C("0")

W = 46
print(f"{BOLD}统一订阅网关{RESET}  " + DIM + "─" * W + RESET)

# ---- 服务 ----
pid = None
m = re.search(r"^\s*pid = (\d+)", launch_info, re.M)
if m:
    pid = m.group(1)
if pid:
    svc = f"{GREEN}● 运行中{RESET} (pid {pid})"
elif launch_info:
    svc = f"{YELLOW}● 已安装但未运行{RESET}"
else:
    svc = f"{RED}● 未安装{RESET}  {DIM}启用: ./install.sh{RESET}"
print(f"  服务    {svc}")

if not health_raw:
    print(f"  接口    {RED}http://127.0.0.1:{port} 无响应{RESET}")
    if os.path.exists(err_log):
        tail = [l for l in open(err_log, encoding="utf-8", errors="replace").read().splitlines()[-3:]]
        for l in tail:
            print(f"          {RED}{l[:100]}{RESET}")
    print(f"{RED}✗ 服务不可用{RESET}")
    sys.exit(1)

h = json.loads(health_raw)
print(f"  接口    http://127.0.0.1:{port}/v1  {DIM}→ {len(h.get('providers', []))} 个订阅上游{RESET}")
up = h.get("uptimeSec", 0)
up_h = f"{up//3600}小时{up%3600//60}分" if up >= 3600 else (f"{up//60}分{up%60}秒" if up >= 60 else f"{up}秒")
print(f"  运行    {DIM}已运行 {up_h}{RESET}")
auth = h.get("authRequired")
print(f"  鉴权    {GREEN}● 已启用（Bearer token）{RESET}" if auth else f"  鉴权    {YELLOW}未配置 clientToken{RESET}")

# ---- 各订阅上游 ----
all_ok = True
for p in h.get("providers", []):
    a = p.get("auth") or {}
    jwt = a.get("jwt")
    label = f"{p['id']} ({p.get('protocol', '?')})"
    models = p.get("modelsKnown")
    models_s = f"· 模型 {models}" if models else ("· 模型目录异常" if p.get("catalogError") else "")
    if jwt is not None:  # cannwork 凭证链
        if jwt.get("ok"):
            exp = datetime.datetime.fromisoformat(jwt["expiresAt"].replace("Z", "+00:00")).astimezone()
            remain = exp - datetime.datetime.now().astimezone()
            mins = int(remain.total_seconds() // 60)
            left = f"剩余 {mins//60} 小时 {mins%60} 分" if mins >= 60 else f"仅剩 {mins} 分"
            mark = GREEN if mins > 60 else YELLOW
            print(f"  上游    {mark}● {label}{RESET} · JWT {exp:%m-%d %H:%M} 过期（{left}）{DIM} {models_s}{RESET}")
        else:
            all_ok = False
            print(f"  上游    {RED}✗ {label}{RESET} · JWT 不可用 {models_s}")
            err = jwt.get("error") or "未知原因"
            print(f"          {RED}{err}{RESET}")
            print(f"          {YELLOW}→ 处理：打开 VSCode 的 CANNWork 扩展重新登录，无需重启网关{RESET}")
    else:  # 静态 token
        if a.get("ok"):
            print(f"  上游    {GREEN}● {label}{RESET} · Token 有效（{a.get('tokenSource', '-')}）{DIM} {models_s}{RESET}")
        else:
            all_ok = False
            print(f"  上游    {RED}✗ {label}{RESET} · Token 缺失 {models_s}")
            err = a.get("error") or "未知原因"
            print(f"          {RED}{err[:110]}{RESET}")
            print(f"          {YELLOW}→ 处理：在 providers.json 里补 auth 配置（token/tokenEnv/tokenFile）{RESET}")

# ---- 最近请求 ----
print(f"{BOLD}最近请求{RESET}  " + DIM + "─" * W + RESET)
if os.path.exists(log_file):
    lines = open(log_file, encoding="utf-8", errors="replace").read().splitlines()[-6:]
    shown = 0
    for line in reversed(lines):  # 最新在上
        m = re.match(r"^\[(.+?)\] (.*)$", line)
        if not m:
            continue
        ts, rest = m.groups()
        try:
            t = datetime.datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone().strftime("%H:%M:%S")
        except ValueError:
            t = ts[11:19]
        rm = re.match(r"(\S+) (\S+) (\S+) → (\d+) (\d+)ms(.*)", rest)
        if rm:
            method, path, prov_model, status, ms, extra = rm.groups()
            sc = GREEN if status.startswith("2") else RED
            mark = f"{sc}{status}{RESET}"
            dur = f"{int(ms)/1000:.1f}s" if int(ms) >= 1000 else f"{ms}ms"
            print(f"  {DIM}{t}{RESET}  {method} {path}  {prov_model}  → {mark}  {dur}{DIM}{extra}{RESET}")
            shown += 1
        elif rest.startswith("ERROR") or "重取凭证" in rest:
            print(f"  {DIM}{t}{RESET}  {RED}{rest[:90]}{RESET}")
            shown += 1
    if not shown:
        print(f"  {DIM}（暂无请求）{RESET}")
else:
    print(f"  {DIM}（暂无日志）{RESET}")

ok = bool(h.get("ok"))
print(f"{GREEN}✓ 一切正常{RESET}" if ok else f"{RED}✗ 部分上游凭证异常，相关请求会被拒绝{RESET}")
sys.exit(0 if ok else 1)
PYEOF
