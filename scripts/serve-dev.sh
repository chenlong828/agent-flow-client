#!/usr/bin/env bash
# 本机联调：在系统终端里托管 client（dev 模式）。
#
# 用法（在系统的 Terminal.app / iTerm 里执行）：
#   ./scripts/serve-dev.sh [command] [options]
#
#   start    默认。后台启动 dev 模式的 serve：进程被任何方式杀掉都会自动拉起
#   status   查看监督进程、serve pid、重启次数、最近日志
#   logs     看 serve.out，加 --follow 持续跟踪
#   reload   立即重启 serve（等价于杀掉后自动拉起，但走信号，更干净）
#   stop     收工：监督进程退出，不再拉起
#   restart  先 stop 再 start（会重建监督进程，日常重启请用 reload 或直接 kill）
#
# 配置来源（优先级从高到低）：
#   命令行 --config > 环境变量 AF_CLIENT_CONFIG > <repo>/.config >
#   <repo>/.agent-flow-client/orchaster-stub/client.toml
#
# 必须在系统终端里执行：DSH 会话内启动的进程会继承 DSH 文件沙箱，写容器目录
# 时报 EPERM（permission_denied：容器不可写）。serve-bg 检测到 DSH_SESSION_ID
# 会拒绝；status/logs/reload/stop 只收发信号，在任何环境都能执行。
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

# bun 不一定在当前 shell 的 PATH 里（Terminal 里常见）：按 BUN_BIN > PATH >
# BUN_INSTALL > ~/.bun/bin > Homebrew 安装位置 依次找，找到就用绝对路径。
find_bun() {
  if [ -n "${BUN_BIN:-}" ] && [ -x "${BUN_BIN}" ]; then
    printf '%s' "${BUN_BIN}"
    return 0
  fi
  if command -v bun >/dev/null 2>&1; then
    command -v bun
    return 0
  fi
  for candidate in "${BUN_INSTALL:+${BUN_INSTALL}/bin/bun}" "$HOME/.bun/bin/bun" /opt/homebrew/bin/bun /usr/local/bin/bun; do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

if ! BUN_BIN_PATH="$(find_bun)"; then
  echo "找不到 bun：先 export PATH=\"\$HOME/.bun/bin:\$PATH\"，或用 BUN_BIN=<bun 绝对路径> 指定" >&2
  exit 1
fi

# DSH 会话会把 DSH_HOME 导出成 ~/.dsh，它会覆盖配置里的 [acp].dsh_home，client
# 会直接拒绝。本脚本以配置为准；指向别处的自定义 DSH_HOME 保留不动。
if [ "${DSH_HOME:-}" = "$HOME/.dsh" ]; then
  unset DSH_HOME
fi

command_name="start"
if [ $# -gt 0 ] && [ "${1#-}" = "$1" ]; then
  command_name="$1"
  shift
fi

case "$command_name" in
  start | stop | status | logs | reload | restart | help) ;;
  *)
    echo "未知命令：${command_name}（可用：start stop status logs reload restart）" >&2
    exit 2
    ;;
esac

# 用户显式给了 --config 就不再注入默认值，避免覆盖。
has_config=0
for arg in "$@"; do
  case "$arg" in
    --config | --config=*) has_config=1 ;;
  esac
done

if [ "$has_config" -eq 0 ]; then
  if [ -n "${AF_CLIENT_CONFIG:-}" ]; then
    set -- "$@" --config "$AF_CLIENT_CONFIG"
  elif [ -f "$repo_root/.config" ]; then
    set -- "$@" --config "$repo_root/.config"
  elif [ -f "$repo_root/.agent-flow-client/orchaster-stub/client.toml" ]; then
    set -- "$@" --config "$repo_root/.agent-flow-client/orchaster-stub/client.toml"
  else
    echo "找不到 client 配置：用 --config <path> 或 AF_CLIENT_CONFIG=<path> 指定" >&2
    exit 2
  fi
fi

if [ "$command_name" = "start" ] || [ "$command_name" = "restart" ]; then
  set -- "$@" --dev
fi

exec "$BUN_BIN_PATH" run scripts/serve-bg.ts "$command_name" "$@"
