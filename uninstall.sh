#!/bin/bash
# uninstall.sh — 停用个人网关（personal_gateway）
#
# 用法:
#   ./uninstall.sh                 停止服务、移除 launchd 配置与运行时副本（保留 zcode 配置指向）
#   ./uninstall.sh --revert-configs  同上，并把 zcode 相关配置回滚到接入前备份
#
# 回滚涉及的备份文件（--revert-configs 时还原）:
#   ~/.zcode/v2/provider_config.json.bak-cannbot（若存在；v2 接入是手动改的，见 README）
#   ~/.zcode/cli/config.json.bak-cannbot（cannbot-creds.sh --sync-zcode 创建）

set -euo pipefail

LABEL="cn.hicann.personal-gateway"
OLD_LABEL="cn.hicann.cannbot-gateway-proxy"   # 2026-11 更名前的旧 label：卸载时一并清理
INSTALLED_PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
OLD_PLIST="$HOME/Library/LaunchAgents/$OLD_LABEL.plist"
RUNTIME_DIR="$HOME/.local/share/personal-gateway"
OLD_RUNTIME_DIR="$HOME/.local/share/cannbot-gateway-proxy"
# 旧版「系统热键切显示器」功能（2026-10-28 已移除）的独立 LaunchAgent：仅用于清理
# 历史安装遗留，本脚本不再安装它
HOTKEY_LABEL="cn.hicann.cannbot-monitor-hotkeys"
HOTKEY_PLIST="$HOME/Library/LaunchAgents/$HOTKEY_LABEL.plist"
# 安装时记录的端口（install.sh 写入）；缺失则按默认 8484 检查。新旧目录都看一眼
# （更名过渡期可能存在任一）
PORT="$(cat "$RUNTIME_DIR/port" 2>/dev/null || cat "$OLD_RUNTIME_DIR/port" 2>/dev/null || echo 8484)"
[[ "$PORT" =~ ^[0-9]+$ ]] || PORT=8484

msg() { printf '[uninstall] %s\n' "$*"; }

# 演练/测试守卫：launchctl 作用于用户域（与 HOME 无关），沙箱 HOME 下跑也会停掉真实服务。
# 设 PGW_SKIP_LAUNCHCTL=1（旧名 CGP_SKIP_LAUNCHCTL 也认）跳过 launchctl 步骤
# （2026-10 r6 验证本脚本时曾因此误停正式 8484）。
SKIP_LAUNCH="${PGW_SKIP_LAUNCHCTL:-${CGP_SKIP_LAUNCHCTL:-0}}"
if [ "$SKIP_LAUNCH" = "1" ]; then
  msg "PGW_SKIP_LAUNCHCTL=1：跳过 launchctl 步骤（演练模式，不停止/注销真实服务）"
else
  launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 && msg "服务已停止" || msg "服务本就未在运行"
  # 更名过渡与旧版热键守护的遗留清理：未装过则静默跳过
  launchctl bootout "gui/$(id -u)/$OLD_LABEL" >/dev/null 2>&1 || true
  launchctl bootout "gui/$(id -u)/$HOTKEY_LABEL" >/dev/null 2>&1 || true
fi
# rm -f 对不存在的文件返回 0：分「真的删了」和「本来就没有」两种情况如实报告
if [ -f "$INSTALLED_PLIST" ]; then
  rm -f "$INSTALLED_PLIST" && msg "已移除 ${INSTALLED_PLIST}（开机自启一并取消）"
else
  msg "未发现 ${INSTALLED_PLIST}（本就未安装新 label）"
fi
if [ -f "$OLD_PLIST" ]; then
  rm -f "$OLD_PLIST" && msg "已移除旧 label 的 ${OLD_PLIST}（更名前的遗留）"
fi
rm -f "$HOTKEY_PLIST" 2>/dev/null || true   # 旧版热键守护 LaunchAgent（功能已移除）的遗留清理

# 用户创作数据不随卸载销毁：待办与报告存档先抢救到备份目录，再清理运行时副本。
# （proxy.log/stats.json 等可再生产物不抢救；重装后想恢复：把备份文件拷回运行时目录即可）
# 备份目录名带 $$ ：同秒二次卸载不会撞进同一目录互相覆盖（providers.json 只剩后拷的那份）
DATA_BACKUP="$HOME/.local/share/personal-gateway.data-backup-$(date +%Y%m%d-%H%M%S)-$$"
for dir in "$RUNTIME_DIR" "$OLD_RUNTIME_DIR"; do
  [ -d "$dir" ] || continue
  for f in todos.json reports.json providers.json; do
    if [ -f "$dir/$f" ]; then
      mkdir -p "$DATA_BACKUP"
      cp "$dir/$f" "$DATA_BACKUP/$f"
    fi
  done
  # 坏文件自愈的 .bad 现场备份可能含真实待办/报告内容（todos/reports/stats.json.bad[.时间戳]），
  # 同属用户数据，一并抢救再清理
  for f in "$dir"/*.bad "$dir"/*.bad.*; do
    [ -f "$f" ] || continue
    mkdir -p "$DATA_BACKUP"
    cp "$f" "$DATA_BACKUP/"
  done
done
if [ -d "$DATA_BACKUP" ]; then
  # 注意 ${DATA_BACKUP} 必须花括号：后跟全角（时 macOS bash 3.2 会把括号字节并入
  # 变量名，set -u 下报 unbound variable、脚本崩在 rm -rf 之前
  msg "用户数据已备份: ${DATA_BACKUP}（providers.json 凭证 / todos.json 待办 / reports.json 报告存档）"
fi
for dir in "$RUNTIME_DIR" "$OLD_RUNTIME_DIR"; do
  if [ -d "$dir" ]; then
    rm -rf "$dir" && msg "已清理运行时副本 $dir"
  fi
done

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
    elif [ "$target" = "$HOME/.zcode/v2/provider_config.json" ]; then
      # v2 的 .bak 没有任何脚本会创建（v2 接入是手动改的）：备份缺失不是可以
      # 一行「跳过」带过的——不回滚它，海思 provider 仍指向已卸载的 127.0.0.1:8484，
      # glm 链路直接死。这里显著警告并给出手工修复动作。
      msg "⚠️  无备份可回滚: $target"
      msg "    v2 接入是手动改的、没有自动备份。请手工把 $target 里个人 provider 的"
      msg "    baseUrl 改回官方端点（apiKey 同步换回对应订阅的 key），否则该链路不可用。"
    else
      msg "跳过 ${target}（无备份 ${backup}）"
    fi
  done
  msg "注意: 回滚后 zcode CLI 回到接入前状态（glm provider → bigmodel 按量 key，无余额会报 429）"
fi

msg "完成。重新启用: ./install.sh"
