#!/bin/bash
# uninstall.sh — 停用 cannbot-gateway-proxy
#
# 用法:
#   ./uninstall.sh                 停止服务、移除 launchd 配置与运行时副本（保留 zcode 配置指向）
#   ./uninstall.sh --revert-configs  同上，并把 zcode 相关配置回滚到接入前备份
#
# 回滚涉及的备份文件（--revert-configs 时还原）:
#   ~/.zcode/v2/provider_config.json.bak-cannbot
#   ~/.zcode/cli/config.json.bak-cannbot

set -euo pipefail

LABEL="cn.hicann.cannbot-gateway-proxy"
INSTALLED_PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
RUNTIME_DIR="$HOME/.local/share/cannbot-gateway-proxy"
# 安装时记录的端口（install.sh 写入）；缺失则按默认 8484 检查
PORT="$(cat "$RUNTIME_DIR/port" 2>/dev/null || echo 8484)"
[[ "$PORT" =~ ^[0-9]+$ ]] || PORT=8484

msg() { printf '[uninstall] %s\n' "$*"; }

# 演练/测试守卫：launchctl 作用于用户域（与 HOME 无关），沙箱 HOME 下跑也会停掉真实服务。
# 设 CGP_SKIP_LAUNCHCTL=1 跳过 launchctl 步骤（2026-10 r6 验证本脚本时曾因此误停正式 8484）。
if [ "${CGP_SKIP_LAUNCHCTL:-0}" = "1" ]; then
  msg "CGP_SKIP_LAUNCHCTL=1：跳过 launchctl 步骤（演练模式，不停止/注销真实服务）"
else
  launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 && msg "服务已停止" || msg "服务本就未在运行"
fi
rm -f "$INSTALLED_PLIST" && msg "已移除 ${INSTALLED_PLIST}（开机自启一并取消）"

# 用户创作数据不随卸载销毁：待办与报告存档先抢救到备份目录，再清理运行时副本。
# （proxy.log/stats.json 等可再生产物不抢救；重装后想恢复：把备份文件拷回运行时目录即可）
DATA_BACKUP="$HOME/.local/share/cannbot-gateway-proxy.data-backup-$(date +%Y%m%d-%H%M%S)"
for f in todos.json reports.json providers.json; do
  if [ -f "$RUNTIME_DIR/$f" ]; then
    mkdir -p "$DATA_BACKUP"
    cp "$RUNTIME_DIR/$f" "$DATA_BACKUP/$f"
  fi
done
# 坏文件自愈的 .bad 现场备份可能含真实待办/报告内容（todos/reports/stats.json.bad[.时间戳]），
# 同属用户数据，一并抢救再清理
for f in "$RUNTIME_DIR"/*.bad "$RUNTIME_DIR"/*.bad.*; do
  [ -f "$f" ] || continue
  mkdir -p "$DATA_BACKUP"
  cp "$f" "$DATA_BACKUP/"
done
if [ -d "$DATA_BACKUP" ]; then
  # 注意 ${DATA_BACKUP} 必须花括号：后跟全角（时 macOS bash 3.2 会把括号字节并入
  # 变量名，set -u 下报 unbound variable、脚本崩在 rm -rf 之前
  msg "用户数据已备份: ${DATA_BACKUP}（providers.json 凭证 / todos.json 待办 / reports.json 报告存档）"
fi
rm -rf "$RUNTIME_DIR" && msg "已清理运行时副本 $RUNTIME_DIR"

sleep 1
if lsof -i ":$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  msg "警告: $PORT 端口仍被占用，请手动检查: lsof -i :$PORT"
fi

if [ "${1:-}" = "--revert-configs" ]; then
  for pair in \
    "$HOME/.zcode/v2/provider_config.json:$HOME/.zcode/v2/provider_config.json.bak-cannbot" \
    "$HOME/.zcode/cli/config.json:$HOME/.zcode/cli/config.json.bak-cannbot"
  do
    target="${pair%%:*}"; backup="${pair##*:}"
    if [ -f "$backup" ]; then
      cp "$backup" "$target"
      msg "已回滚 $target ← $(basename "$backup")"
    else
      msg "跳过 ${target}（无备份 ${backup}）"
    fi
  done
  msg "注意: 回滚后 zcode CLI 回到接入前状态（glm provider → bigmodel 按量 key，无余额会报 429）"
fi

msg "完成。重新启用: ./install.sh"
