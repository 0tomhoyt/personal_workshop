#!/bin/bash
# 打开管理界面.command — 双击即可：确保网关已启动，并在浏览器打开网页管理台
DIR="$(cd "$(dirname "$0")" && pwd)"
# 端口优先级：环境变量（新前缀 PGW_，旧 CANNBOT_ 兜底）> 安装时记录的端口（新目录
# 优先、更名前旧目录兜底）> 默认 8484
RECORDED_PORT="$(cat "$HOME/.local/share/personal-gateway/port" 2>/dev/null || cat "$HOME/.local/share/cannbot-gateway-proxy/port" 2>/dev/null || true)"
PORT="${PGW_PROXY_PORT:-${CANNBOT_PROXY_PORT:-${RECORDED_PORT:-8484}}}"

echo "正在检查个人网关…"
if curl -fsS -m 3 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
  echo "网关已在运行。"
else
  echo "网关未启动，正在启动（首次会请求终端访问桌面目录的权限，请允许）…"
  # 安装失败（端口被异物占用等）就别再打开一个死地址
  if ! "$DIR/install.sh" "$PORT"; then
    echo "网关启动失败，请查看上方 install.sh 的报错。"
    exit 1
  fi
fi

echo "打开个人网关管理台：http://127.0.0.1:$PORT/"
open "http://127.0.0.1:$PORT/"
sleep 2
