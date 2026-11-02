#!/bin/bash
# install.sh — 启用统一订阅网关（生成 launchd 配置并立即启动）
#
# 用法: ./install.sh [端口]     # 缺省 8484
# 停用: ./uninstall.sh
#
# 目录设计（重要）:
#   本文件夹 = 项目源 personal_gateway，server.mjs / lib/ 在这里维护；
#   ~/.local/share/personal-gateway/ = 运行时安装目录（与 launchd label 一致），
#   install.sh 会把 server.mjs + lib/ + index.html + theme.css 拷贝过去供 launchd 运行——
#   因为 macOS 对桌面等目录有 TCC 保护，launchd 后台进程无权直接读取。
#   因此改动代码后需重跑 ./install.sh 才生效。
#   旧目录 ~/.local/share/cannbot-gateway-proxy/（2026-11 更名前）若存在会整体迁移
#   过来（providers.json/待办/统计等全部保留），迁移后旧目录不再使用。
#
# providers.json（上游订阅与网关 token 配置）:
#   首次安装自动从 providers.template.json 生成到运行时目录，含随机网关 token；
#   已存在则原样保留（升级不覆盖你的凭证）。编辑后无需重启，网关按 mtime 热加载。

set -euo pipefail

PORT="${1:-8484}"
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
LABEL="cn.hicann.personal-gateway"
# 2026-11 更名前的旧 label / 旧目录：升级时停掉旧实例、迁移旧目录数据、清掉旧 plist
OLD_LABEL="cn.hicann.cannbot-gateway-proxy"
OLD_RUNTIME_DIR="$HOME/.local/share/cannbot-gateway-proxy"
LAUNCH_DIR="$HOME/Library/LaunchAgents"
INSTALLED_PLIST="$LAUNCH_DIR/$LABEL.plist"
OLD_PLIST="$LAUNCH_DIR/$OLD_LABEL.plist"
RUNTIME_DIR="$HOME/.local/share/personal-gateway"
PROVIDERS_JSON="$RUNTIME_DIR/providers.json"
# 旧版「系统热键切显示器」功能（2026-10-28 已移除）的独立 LaunchAgent 与编译产物：
# 仅用于清理历史安装遗留（见第 2.5 步），本脚本不再安装它们
HOTKEY_LABEL="cn.hicann.cannbot-monitor-hotkeys"
HOTKEY_PLIST="$LAUNCH_DIR/$HOTKEY_LABEL.plist"
HOTKEY_BIN="$RUNTIME_DIR/monitor-hotkeys"

msg()  { printf '[install] %s\n' "$*"; }
die()  { printf '[install] 错误: %s\n' "$*" >&2; exit 1; }

# 0) 端口参数校验（放在 die 定义之后，否则报错路径自己就崩了）
#    只接受 1-65535 的整数：`./install.sh 80a` 这种会让后面 plist 与 port 文件都带上
#    非法值，直到 launchd 启动失败才发现。
case "$PORT" in
  ''|*[!0-9]*) die "端口必须是 1-65535 的整数，收到: $PORT" ;;
esac
if [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
  die "端口必须是 1-65535 的整数，收到: $PORT"
fi
# LaunchAgents 目录不一定存在（新机器/精简系统），写 plist 前先建
mkdir -p "$LAUNCH_DIR"

# 1) 找 node（≥18，需要内置 fetch）
NODE_BIN="$(command -v node || true)"
[ -z "$NODE_BIN" ] && [ -x "$HOME/.hermes/node/bin/node" ] && NODE_BIN="$HOME/.hermes/node/bin/node"
[ -n "$NODE_BIN" ] || die "未找到 node，请先安装 Node.js ≥ 18"
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || die "node 版本过低（$("$NODE_BIN" --version)），需要 ≥ 18"
msg "node: $NODE_BIN ($("$NODE_BIN" --version))"

# 2) 先停掉旧实例（幂等；放在端口检查前，保证升级时能覆盖运行中的旧版本）
#    演练守卫：PGW_SKIP_LAUNCHCTL=1（旧名 CGP_SKIP_LAUNCHCTL 也认）时跳过全部
#    launchctl 步骤（launchctl 作用于用户域、与 HOME 无关，沙箱 HOME 演练也会停掉
#    真实服务——r6 事故教训）
SKIP_LAUNCH="${PGW_SKIP_LAUNCHCTL:-${CGP_SKIP_LAUNCHCTL:-0}}"
if [ "$SKIP_LAUNCH" = "1" ]; then
  msg "PGW_SKIP_LAUNCHCTL=1：跳过 launchctl 步骤（演练模式，不停止/加载真实服务）"
else
  launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
  # 更名过渡：旧 label 下若还挂着实例（未用新版 install.sh 升级过），一并停掉
  launchctl bootout "gui/$(id -u)/$OLD_LABEL" >/dev/null 2>&1 || true
fi
sleep 1

# 2.5) 清理旧版热键守护遗留（功能已移除）：曾安装过热键 LaunchAgent 的机器升级时
#      停掉并删除，免得残留一个常驻进程反复调用已删除的 toggle 端点；连惰性日志
#      logs/hotkeys.log 一并清（不再有进程写它）。
#      文件清理不受演练守卫限制（沙箱 HOME 下删的是演练目录里的文件）。
if [ "$SKIP_LAUNCH" != "1" ]; then
  launchctl bootout "gui/$(id -u)/$HOTKEY_LABEL" >/dev/null 2>&1 || true
fi
rm -f "$HOTKEY_PLIST" "$HOTKEY_BIN" "$RUNTIME_DIR/logs/hotkeys.log"

# 2.7) 数据迁移：旧运行时目录整体挪到新目录（providers.json/待办/统计/日志全保留）。
#      两个目录都在时不动旧目录（以新目录为准），只提示人工处理。
if [ -d "$OLD_RUNTIME_DIR" ] && [ ! -d "$RUNTIME_DIR" ]; then
  mv "$OLD_RUNTIME_DIR" "$RUNTIME_DIR"
  msg "已迁移旧运行时目录: $OLD_RUNTIME_DIR → ${RUNTIME_DIR}（数据原样保留）"
elif [ -d "$OLD_RUNTIME_DIR" ] && [ -d "$RUNTIME_DIR" ]; then
  msg "警告: 新旧运行时目录同时存在，已按新目录 $RUNTIME_DIR 安装；"
  msg "      旧目录 $OLD_RUNTIME_DIR 未动，确认不要后可手动删除"
fi

# 3) 前置检查：端口。演练模式跳过（真实服务常驻 8484 时演练装默认端口会在此误伤终止——
#    演练本来就不 bootstrap，端口检查没有意义）
if [ "$SKIP_LAUNCH" != "1" ] && lsof -i ":$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  die "端口 $PORT 仍被非本服务进程占用（可传参换端口: ./install.sh 8485；lsof -i :$PORT 查占用者）"
fi

# 4) 拷贝运行时副本（server.mjs + lib/ + index.html + theme.css）+ 由模板生成本机 plist

mkdir -p "$RUNTIME_DIR/logs" "$RUNTIME_DIR/lib" "$LAUNCH_DIR"
echo "$PORT" > "$RUNTIME_DIR/port"   # 记录实际端口，供 uninstall.sh/status.sh 读取
cp "$PROJECT_DIR/server.mjs" "$RUNTIME_DIR/server.mjs"
[ -f "$PROJECT_DIR/index.html" ] && cp "$PROJECT_DIR/index.html" "$RUNTIME_DIR/index.html"
[ -f "$PROJECT_DIR/theme.css" ] && cp "$PROJECT_DIR/theme.css" "$RUNTIME_DIR/theme.css"
# 改名/合并前的旧副本：升级后残留在运行时目录里会让人误以为还有效，一律清掉
rm -f "$RUNTIME_DIR/admin.html" "$RUNTIME_DIR/workbench.html" "$RUNTIME_DIR/workbench.css"
if [ -d "$PROJECT_DIR/lib" ]; then
  rm -rf "$RUNTIME_DIR/lib"   # 先清空再拷：源里已删除的模块不在运行时目录残留（lib/ 全量由源派生，可整体重建）
  mkdir -p "$RUNTIME_DIR/lib"
  cp -R "$PROJECT_DIR/lib/." "$RUNTIME_DIR/lib/"
else
  die "源目录缺少 lib/（模块化后的服务端代码），请勿单独拷贝 server.mjs"
fi
sed -e "s|__NODE_BIN__|$NODE_BIN|g" \
    -e "s|__RUNTIME_DIR__|$RUNTIME_DIR|g" \
    "$PROJECT_DIR/plist.template" > "$INSTALLED_PLIST"
# 旧版 plist 曾把 stdout 指向 logs/proxy.out.log（与 proxy.log 双写、launchd 不轮转 → 无上界）；
# 现指向 /dev/null，升级时清掉历史存量（如改回 /dev/null 前有残留）
rm -f "$RUNTIME_DIR/logs/proxy.out.log"
# 更名过渡：旧 label 的 plist 一定清掉——label 变了它不会被 bootstrap，但 KeepAlive
# 会让它每次开机拉起一个已不存在的运行时目录路径，白报错
if [ -f "$OLD_PLIST" ]; then
  rm -f "$OLD_PLIST"
  msg "已移除旧 label 的 plist: $OLD_PLIST"
fi
if [ "$PORT" != "8484" ]; then
  # 非默认端口时注入环境变量
  python3 - "$INSTALLED_PLIST" "$PORT" <<'EOF'
import sys, plistlib
plist, port = sys.argv[1], int(sys.argv[2])
with open(plist, 'rb') as f: d = plistlib.load(f)
d['EnvironmentVariables'] = {'PGW_PROXY_PORT': str(port)}
with open(plist, 'wb') as f: plistlib.dump(d, f)
EOF
fi

# 5) providers.json 引导：首次安装从模板生成（含随机网关 token），绝不覆盖已有配置
if [ ! -f "$PROVIDERS_JSON" ]; then
  if [ -f "$PROJECT_DIR/providers.template.json" ]; then
    # od 直接读 24 字节定长熵 → 48 hex：末级 head 的 SIGPIPE 竞态（pipefail 下整条
    # 安装以晦涩错误中止）从根上消除——这条管道没有会被提前关掉的写端
    CLIENT_TOKEN="sk-gw-$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')"
    sed -e "s|__CLIENT_TOKEN__|$CLIENT_TOKEN|g" "$PROJECT_DIR/providers.template.json" > "$PROVIDERS_JSON"
    chmod 600 "$PROVIDERS_JSON"
    msg "已生成 ${PROVIDERS_JSON}（0600，含随机网关 token）—— 请编辑填入各订阅的凭证"
  else
    msg "警告: 未找到 providers.template.json，跳过配置生成（网关以内置默认配置运行，仅 cannbot 上游）"
  fi
else
  chmod 600 "$PROVIDERS_JSON" 2>/dev/null || true
  msg "保留已有 ${PROVIDERS_JSON}（升级不覆盖凭证；改动无需重启，网关热加载）"
fi

# 6) 加载并启动（bootout 后服务域偶有短暂未清干净 → bootstrap 报 5 I/O error，
#    实为竞态：等 2 秒重试一次即可成功）
if [ "$SKIP_LAUNCH" = "1" ]; then
  msg "演练模式：已跳过 bootstrap，不做健康检查（文件拷贝/配置引导已执行完毕）"
  exit 0
fi
if ! launchctl bootstrap "gui/$(id -u)" "$INSTALLED_PLIST" 2>/dev/null; then
  sleep 2
  launchctl bootstrap "gui/$(id -u)" "$INSTALLED_PLIST" || true
fi
sleep 2

# 7) 健康检查
if curl -fsS -m 10 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
  msg "✅ 服务已启动: http://127.0.0.1:$PORT/v1"
  HEALTH="$(curl -fsS -m 10 "http://127.0.0.1:$PORT/healthz")"
  echo "$HEALTH" | python3 -m json.tool
  # 逐上游凭证体检：启动即暴露缺 token / JWT 过期等问题
  python3 - "$HEALTH" <<'PYEOF'
import sys, json
h = json.loads(sys.argv[1])
for p in h.get("providers", []):
    a = p.get("auth") or {}
    jwt = a.get("jwt")
    if jwt is not None:
        state = "JWT 有效" if jwt.get("ok") else f"JWT 不可用: {jwt.get('error', '')}"
    else:
        state = "Token 有效" if a.get("ok") else f"Token 缺失: {a.get('error', '')}"
    mark = "✓" if (jwt.get("ok") if jwt is not None else a.get("ok")) else "✗"
    print(f"  {mark} {p['id']} ({p['protocol']}): {state}")
PYEOF
  # 打印客户端接入片段
  if [ -f "$PROVIDERS_JSON" ]; then
    TOKEN="$(python3 -c "import json;print(json.load(open('$PROVIDERS_JSON')).get('gateway',{}).get('clientToken') or '')" 2>/dev/null || true)"
    if [ -n "$TOKEN" ]; then
      msg "网关 token: $TOKEN"
      msg "OpenAI 客户端接入:    base_url = http://127.0.0.1:$PORT/v1   api_key = $TOKEN"
      msg "Anthropic 客户端接入: ANTHROPIC_BASE_URL = http://127.0.0.1:$PORT   ANTHROPIC_AUTH_TOKEN = $TOKEN"
    else
      msg "警告: providers.json 未配置 gateway.clientToken，/v1/* 不做客户端鉴权"
    fi
  fi
  msg "运行时目录: ${RUNTIME_DIR}（日志在其 logs/ 与 proxy.log）"
  msg "停用: ./uninstall.sh"
else
  die "服务启动后健康检查未通过，请查看 $RUNTIME_DIR/logs/proxy.err.log"
fi
