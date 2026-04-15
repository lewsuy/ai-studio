#!/bin/bash
# =================================================================
#  AI Studio 自动重启脚本
#  用途: 监控 AI Studio 进程，进程停止时自动重启
#  使用: ./ai-studio-watchdog.sh
# =================================================================

INSTALL_DIR="/opt/ai-studio"
SERVICE_NAME="ai-studio"
LOG_FILE="$INSTALL_DIR/logs/watchdog.log"
CHECK_INTERVAL=10
MAX_RESTARTS=5
RESTART_COOLDOWN=60

restart_count=0

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

is_running() {
    if pgrep -f "gunicorn.*app:app" > /dev/null 2>&1; then
        return 0
    else
        return 1
    fi
}

start_service() {
    log "正在启动 $SERVICE_NAME..."
    cd "$INSTALL_DIR"
    nohup .venv/bin/gunicorn -w 4 -b 0.0.0.0:8000 app:app > /dev/null 2>&1 &

    sleep 3

    if is_running; then
        log "$SERVICE_NAME 启动成功！"
        restart_count=0
        return 0
    else
        log "$SERVICE_NAME 启动失败！"
        return 1
    fi
}

mkdir -p "$INSTALL_DIR/logs"

log "========== AI Studio 看门狗已启动 =========="
log "安装目录: $INSTALL_DIR"
log "检测间隔: ${CHECK_INTERVAL}秒"
log "============================================"

while true; do
    if is_running; then
        :
    else
        log "检测到 $SERVICE_NAME 未运行，准备重启..."

        if [ $restart_count -ge $MAX_RESTARTS ]; then
            log "已达到最大重启次数 ($MAX_RESTARTS)，进入冷却等待 (${RESTART_COOLDOWN}秒)..."
            sleep $RESTART_COOLDOWN
            restart_count=0
            continue
        fi

        if start_service; then
            restart_count=0
        else
            ((restart_count++))
            log "重启失败，当前重启计数: $restart_count/$MAX_RESTARTS"
        fi
    fi

    sleep $CHECK_INTERVAL
done
