#!/bin/zsh
set -eu
TASK_PROJECT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$TASK_PROJECT_DIR"
echo '启动 B 站开播订阅；首次启用请在弹窗中确认。'
bin/monitor check-config
bin/monitor service start --side local
echo '服务已提交给 macOS。请在确认弹窗中选择启用，稍后查看状态。'
sleep 3
bin/monitor status
echo '如未看到弹窗，可以运行 bin/monitor confirm-start。'
echo '停止并禁用后台服务：bin/monitor service stop --side local'
read -r '?按回车关闭此窗口：'
