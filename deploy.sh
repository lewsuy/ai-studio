#!/usr/bin/env bash
# =============================================================================
#  AI Studio — 一键部署脚本
#  用法: sudo bash deploy.sh
#  部署目录: /opt/ai-studio
# =============================================================================
set -euo pipefail

# ── 颜色输出 ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
info()    { echo -e "${BLUE}[INFO]${NC}  $*"; }
success() { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error()   { echo -e "${RED}[ERR]${NC}   $*"; exit 1; }

# ── 参数 ──────────────────────────────────────────────────────────────────────
INSTALL_DIR="/opt/ai-studio"
SERVICE_NAME="ai-studio"
SERVICE_USER="ai-studio"
PORT=8000
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo ""
echo -e "${BLUE}╔══════════════════════════════════════╗${NC}"
echo -e "${BLUE}║       AI Studio  一键部署脚本        ║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════╝${NC}"
echo ""

# ── 检查 root ─────────────────────────────────────────────────────────────────
[[ $EUID -ne 0 ]] && error "请以 root 或 sudo 运行此脚本"

# ── 检测发行版 & 包管理器 ─────────────────────────────────────────────────────
if command -v apt-get &>/dev/null; then
    PKG_MGR="apt-get"
    PKG_UPDATE="apt-get update -qq"
    PKG_INSTALL="apt-get install -y -qq"
elif command -v yum &>/dev/null; then
    PKG_MGR="yum"
    PKG_UPDATE="yum makecache -q"
    PKG_INSTALL="yum install -y -q"
elif command -v dnf &>/dev/null; then
    PKG_MGR="dnf"
    PKG_UPDATE="dnf makecache -q"
    PKG_INSTALL="dnf install -y -q"
else
    error "未找到支持的包管理器 (apt/yum/dnf)"
fi

# ── 安装系统依赖 ──────────────────────────────────────────────────────────────
info "更新包索引..."
$PKG_UPDATE

info "安装系统依赖 (python3, pip, venv)..."
if [[ "$PKG_MGR" == "apt-get" ]]; then
    $PKG_INSTALL python3 python3-pip python3-venv curl
else
    $PKG_INSTALL python3 python3-pip curl
    # Rocky/CentOS 需要额外装 venv
    python3 -m ensurepip --upgrade 2>/dev/null || true
fi

# 检查 Python 版本 (需要 3.8+)
PY_VER=$(python3 -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
PY_MAJOR=$(echo "$PY_VER" | cut -d. -f1)
PY_MINOR=$(echo "$PY_VER" | cut -d. -f2)
if [[ $PY_MAJOR -lt 3 || ($PY_MAJOR -eq 3 && $PY_MINOR -lt 8) ]]; then
    error "需要 Python 3.8+，当前版本: $PY_VER"
fi
success "Python $PY_VER ✓"

# ── 创建系统用户 ──────────────────────────────────────────────────────────────
if ! id "$SERVICE_USER" &>/dev/null; then
    info "创建系统用户: $SERVICE_USER"
    useradd --system --no-create-home --shell /sbin/nologin "$SERVICE_USER"
    success "用户 $SERVICE_USER 已创建"
else
    success "用户 $SERVICE_USER 已存在，跳过"
fi

# ── 创建目录结构 ──────────────────────────────────────────────────────────────
info "创建安装目录: $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"/{static,logs,backups}
success "目录结构已创建"

# ── 复制项目文件 ──────────────────────────────────────────────────────────────
info "复制项目文件..."
cp "$SCRIPT_DIR/app.py"              "$INSTALL_DIR/"
cp "$SCRIPT_DIR/requirements.txt"    "$INSTALL_DIR/"
cp -r "$SCRIPT_DIR/static/."         "$INSTALL_DIR/static/"
success "项目文件已复制"

# ── 生成/保留 .env 文件 ───────────────────────────────────────────────────────
ENV_FILE="$INSTALL_DIR/.env"
if [[ -f "$ENV_FILE" ]]; then
    warn ".env 文件已存在，跳过生成（保留原配置）"
else
    info "生成 .env 配置文件..."
    SECRET=$(python3 -c "import secrets; print(secrets.token_hex(32))")
    cat > "$ENV_FILE" <<EOF
# AI Studio 环境配置
# 修改后需重启服务: systemctl restart $SERVICE_NAME

# 必填：随机密钥（已自动生成，请勿随意修改）
SECRET_KEY=$SECRET

# 服务端口
PORT=$PORT

# 是否允许公开注册 (true/false)
# false = 只有管理员能创建账户
ALLOW_REGISTER=true

# 调试模式 (生产环境请保持 false)
DEBUG=false
EOF
    chmod 600 "$ENV_FILE"
    success ".env 已生成（SECRET_KEY 已随机化）"
fi

# ── 创建 Python 虚拟环境 ──────────────────────────────────────────────────────
VENV_DIR="$INSTALL_DIR/venv"
if [[ -d "$VENV_DIR" ]]; then
    info "虚拟环境已存在，更新依赖..."
else
    info "创建 Python 虚拟环境..."
    python3 -m venv "$VENV_DIR"
    success "虚拟环境已创建"
fi

info "安装/更新 Python 依赖..."
"$VENV_DIR/bin/pip" install --upgrade pip -q
"$VENV_DIR/bin/pip" install -r "$INSTALL_DIR/requirements.txt" -q
success "Python 依赖安装完成"

# ── 初始化数据库 ──────────────────────────────────────────────────────────────
info "初始化数据库..."
cd "$INSTALL_DIR"
source "$ENV_FILE" 2>/dev/null || true
"$VENV_DIR/bin/python" -c "
import sys
sys.path.insert(0, '.')
from app import init_db
init_db()
print('[DB] SQLite 数据库初始化完成')
"
success "数据库初始化完成: $INSTALL_DIR/ai_chat.db"

# ── 设置文件权限 ──────────────────────────────────────────────────────────────
info "设置文件权限..."
chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"
chmod 750 "$INSTALL_DIR"
chmod 640 "$ENV_FILE"
chmod -R 755 "$INSTALL_DIR/static"
# 让 service 用户可写 logs 和 db
chmod 770 "$INSTALL_DIR/logs"
chmod 770 "$INSTALL_DIR/backups"
[[ -f "$INSTALL_DIR/ai_chat.db" ]] && chmod 660 "$INSTALL_DIR/ai_chat.db"
success "权限设置完成"

# ── 安装 systemd 服务 ─────────────────────────────────────────────────────────
SERVICE_FILE="/etc/systemd/system/$SERVICE_NAME.service"
info "安装 systemd 服务..."
cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=AI Studio Web Application
After=network.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$INSTALL_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$VENV_DIR/bin/gunicorn \\
    --workers 4 \\
    --bind 0.0.0.0:$PORT \\
    --timeout 120 \\
    --access-logfile $INSTALL_DIR/logs/access.log \\
    --error-logfile  $INSTALL_DIR/logs/error.log \\
    --log-level info \\
    app:app
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
success "systemd 服务已安装并设为开机自启"

# ── 启动/重启服务 ─────────────────────────────────────────────────────────────
info "启动服务..."
if systemctl is-active --quiet "$SERVICE_NAME"; then
    systemctl restart "$SERVICE_NAME"
    success "服务已重启"
else
    systemctl start "$SERVICE_NAME"
    success "服务已启动"
fi

sleep 2  # 等待服务就绪

# ── 验证服务状态 ──────────────────────────────────────────────────────────────
if systemctl is-active --quiet "$SERVICE_NAME"; then
    HEALTH=$(curl -sf "http://127.0.0.1:$PORT/api/health" 2>/dev/null || echo "")
    if [[ -n "$HEALTH" ]]; then
        success "健康检查通过 ✓"
    else
        warn "服务已启动，但健康检查未响应（可能仍在初始化）"
    fi
else
    error "服务启动失败！请检查日志: journalctl -u $SERVICE_NAME -n 30"
fi

# ── 检测并提示防火墙 ─────────────────────────────────────────────────────────
if command -v firewall-cmd &>/dev/null && firewall-cmd --state &>/dev/null 2>&1; then
    warn "检测到 firewalld，建议开放端口: firewall-cmd --permanent --add-port=${PORT}/tcp && firewall-cmd --reload"
elif command -v ufw &>/dev/null && ufw status | grep -q active; then
    warn "检测到 UFW，建议开放端口: ufw allow ${PORT}/tcp"
fi

# ── 打印部署摘要 ──────────────────────────────────────────────────────────────
LOCAL_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "YOUR_SERVER_IP")
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║            🎉  部署成功！                        ║${NC}"
echo -e "${GREEN}╠══════════════════════════════════════════════════╣${NC}"
echo -e "${GREEN}║${NC}  访问地址:  ${YELLOW}http://${LOCAL_IP}:${PORT}${NC}"
echo -e "${GREEN}║${NC}  安装目录:  ${INSTALL_DIR}"
echo -e "${GREEN}║${NC}  数据库:    ${INSTALL_DIR}/ai_chat.db"
echo -e "${GREEN}║${NC}  配置文件:  ${INSTALL_DIR}/.env"
echo -e "${GREEN}║${NC}  日志目录:  ${INSTALL_DIR}/logs/"
echo -e "${GREEN}╠══════════════════════════════════════════════════╣${NC}"
echo -e "${GREEN}║${NC}  常用命令:"
echo -e "${GREEN}║${NC}    查看状态: ${YELLOW}systemctl status $SERVICE_NAME${NC}"
echo -e "${GREEN}║${NC}    查看日志: ${YELLOW}journalctl -u $SERVICE_NAME -f${NC}"
echo -e "${GREEN}║${NC}    重启服务: ${YELLOW}systemctl restart $SERVICE_NAME${NC}"
echo -e "${GREEN}║${NC}    停止服务: ${YELLOW}systemctl stop $SERVICE_NAME${NC}"
echo -e "${GREEN}╠══════════════════════════════════════════════════╣${NC}"
echo -e "${GREEN}║${NC}  ${YELLOW}首次使用请在页面注册账号，然后在设置中${NC}"
echo -e "${GREEN}║${NC}  ${YELLOW}填写 API Base URL 和 API Key。${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════╝${NC}"
echo ""
