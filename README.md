# AI Studio

多用户 AI 对话助手，支持 OpenAI 兼容 API，基于 Flask + SQLite。

## 快速部署

```bash
tar -xzf ai-studio.tar.gz
cd ai-studio
sudo bash deploy.sh
```

部署完成后访问 `http://YOUR_IP:8000`，注册账号并在 ⚙ 设置中填写 API 配置即可。

## 目录结构

```
/opt/ai-studio/
├── app.py              # Flask 后端
├── ai_chat.db          # SQLite 数据库（自动创建）
├── .env                # 环境配置（SECRET_KEY 等）
├── venv/               # Python 虚拟环境
├── static/
│   └── index.html      # 前端页面
├── logs/
│   ├── access.log
│   └── error.log
└── backups/            # 数据库备份目录
```

## 常用命令

```bash
systemctl status  ai-studio   # 查看状态
systemctl restart ai-studio   # 重启
journalctl -u ai-studio -f    # 实时日志
```

## 数据库备份

```bash
# 手动备份
cp /opt/ai-studio/ai_chat.db /opt/ai-studio/backups/ai_chat_$(date +%Y%m%d).db

# 定时备份（crontab）
0 3 * * * cp /opt/ai-studio/ai_chat.db /opt/ai-studio/backups/ai_chat_$(date +\%Y\%m\%d).db
```

## 环境变量（/opt/ai-studio/.env）

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `SECRET_KEY` | JWT 签名密钥（部署时自动生成） | 随机 |
| `PORT` | 监听端口 | 8000 |
| `ALLOW_REGISTER` | 是否允许公开注册 | true |
| `DEBUG` | 调试模式 | false |

## 反向代理（Nginx）

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass         http://127.0.0.1:8000;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_read_timeout 120s;
    }
}
```

## 技术栈

- **后端**: Python 3.8+ / Flask / Gunicorn
- **数据库**: SQLite（WAL 模式）
- **认证**: JWT（30 天有效期）
- **密码**: bcrypt 哈希存储
- **前端**: 原生 HTML/CSS/JS（无框架依赖）
