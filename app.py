"""
AI Studio - Flask Backend
依赖: pip install flask flask-cors PyJWT bcrypt requests
启动: python app.py
生产: gunicorn -w 4 -b 0.0.0.0:8000 app:app
"""

import os, json, sqlite3, datetime, requests, bcrypt, jwt, secrets
from functools import wraps
from flask import Flask, request, jsonify, send_from_directory, g
from flask_cors import CORS

# ─── 配置 ─────────────────────────────────────────────────────────────────────
BASE_DIR   = os.path.dirname(os.path.abspath(__file__))
DB_PATH    = os.path.join(BASE_DIR, 'ai_chat.db')
STATIC_DIR = os.path.join(BASE_DIR, 'static')
SECRET_KEY_FILE = os.path.join(BASE_DIR, '.secret_key')

# 持久化 SECRET_KEY，确保重启后 Token 仍然有效
if os.environ.get('SECRET_KEY'):
    SECRET_KEY = os.environ.get('SECRET_KEY')
elif os.path.exists(SECRET_KEY_FILE):
    try:
        with open(SECRET_KEY_FILE, 'r') as f:
            SECRET_KEY = f.read().strip()
        if not SECRET_KEY:
            raise ValueError("Empty secret key")
    except (IOError, ValueError) as e:
        print(f"[WARN] 读取 SECRET_KEY 失败: {e}，重新生成...")
        SECRET_KEY = secrets.token_hex(32)
        try:
            with open(SECRET_KEY_FILE, 'w') as f:
                f.write(SECRET_KEY)
            print(f"[INFO] 新的 SECRET_KEY 已保存到 {SECRET_KEY_FILE}")
        except IOError as e2:
            print(f"[ERROR] 无法写入 SECRET_KEY 文件: {e2}")
else:
    # 首次启动，生成并保存
    SECRET_KEY = secrets.token_hex(32)
    try:
        with open(SECRET_KEY_FILE, 'w') as f:
            f.write(SECRET_KEY)
        print(f"[INFO] SECRET_KEY 已生成并保存到 {SECRET_KEY_FILE}")
    except IOError as e:
        print(f"[ERROR] 无法创建 SECRET_KEY 文件: {e}")

TOKEN_DAYS = 30
ALLOW_REGISTER = os.environ.get('ALLOW_REGISTER', 'true').lower() == 'true'

DEFAULT_MODELS = [
    {"name": "GPT-4o",            "id": "gpt-4o"},
    {"name": "GPT-4o Mini",       "id": "gpt-4o-mini"},
    {"name": "Claude Sonnet 4",   "id": "claude-sonnet-4-20250514"},
    {"name": "Claude Sonnet 3.5", "id": "claude-sonnet-3.5-20241022"},
    {"name": "Gemini 2.0 Flash",  "id": "gemini-2.0-flash-exp"},
    {"name": "DeepSeek Chat",     "id": "deepseek-chat"},
    {"name": "DeepSeek Reasoner", "id": "deepseek-reasoner"},
]

app = Flask(__name__, static_folder=STATIC_DIR)
CORS(app, resources={r"/api/*": {"origins": "*"}})

# ─── 数据库 ───────────────────────────────────────────────────────────────────
def get_db():
    if 'db' not in g:
        conn = sqlite3.connect(DB_PATH, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        g.db = conn
    return g.db

@app.teardown_appcontext
def close_db(e=None):
    db = g.pop('db', None)
    if db: db.close()

def init_db():
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS users (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            username     TEXT    UNIQUE NOT NULL,
            password_hash TEXT   NOT NULL,
            is_admin     INTEGER DEFAULT 0,
            created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS user_config (
            user_id     INTEGER PRIMARY KEY,
            api_base    TEXT DEFAULT '',
            api_key     TEXT DEFAULT '',
            models_json TEXT DEFAULT '[]',
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS conversations (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id    INTEGER NOT NULL,
            title      TEXT    DEFAULT '新对话',
            model      TEXT    DEFAULT 'gpt-4o',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS messages (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            conversation_id INTEGER NOT NULL,
            role            TEXT    NOT NULL,
            content_json    TEXT    NOT NULL,
            display_text    TEXT    DEFAULT '',
            attachments_json TEXT   DEFAULT '[]',
            created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_conv_user   ON conversations(user_id);
        CREATE INDEX IF NOT EXISTS idx_msg_conv    ON messages(conversation_id);
    """)
    conn.commit()
    conn.close()
    print(f"[DB] 初始化完成: {DB_PATH}")

# ─── JWT 认证 ─────────────────────────────────────────────────────────────────
def make_token(user_id, username):
    payload = {
        'sub': str(user_id),  # PyJWT 2.x 要求 sub 必须是字符串
        'username': username,
        'exp': datetime.datetime.utcnow() + datetime.timedelta(days=TOKEN_DAYS)
    }
    return jwt.encode(payload, SECRET_KEY, algorithm='HS256')

def require_auth(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        auth = request.headers.get('Authorization', '')
        if not auth.startswith('Bearer '):
            return jsonify({'error': '未授权'}), 401
        token = auth[7:]
        try:
            payload = jwt.decode(token, SECRET_KEY, algorithms=['HS256'])
            g.user_id  = int(payload['sub'])  # 转换回整数
            g.username = payload['username']
        except jwt.ExpiredSignatureError:
            return jsonify({'error': 'Token 已过期，请重新登录'}), 401
        except jwt.InvalidTokenError:
            return jsonify({'error': '无效 Token'}), 401
        return f(*args, **kwargs)
    return decorated

def ok(data=None, **kw):
    r = {'ok': True}
    if data is not None: r['data'] = data
    r.update(kw)
    return jsonify(r)

def err(msg, code=400):
    return jsonify({'ok': False, 'error': msg}), code

# ─── 静态文件 ─────────────────────────────────────────────────────────────────
@app.route('/')
def index():
    return send_from_directory(STATIC_DIR, 'index.html')

@app.route('/<path:path>')
def static_files(path):
    return send_from_directory(STATIC_DIR, path)

# ─── 认证接口 ─────────────────────────────────────────────────────────────────
@app.route('/api/auth/register', methods=['POST'])
def register():
    if not ALLOW_REGISTER:
        return err('注册已关闭，请联系管理员', 403)
    data = request.json or {}
    username = (data.get('username') or '').strip()
    password = (data.get('password') or '').strip()
    if not username or not password:
        return err('用户名和密码不能为空')
    if len(username) < 3 or len(username) > 32:
        return err('用户名长度须在 3-32 字符之间')
    if len(password) < 6:
        return err('密码至少 6 位')
    db = get_db()
    if db.execute('SELECT id FROM users WHERE username=?', (username,)).fetchone():
        return err('用户名已存在')
    pw_hash = bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()
    cur = db.execute('INSERT INTO users (username, password_hash) VALUES (?,?)', (username, pw_hash))
    db.execute('INSERT INTO user_config (user_id, models_json) VALUES (?,?)',
               (cur.lastrowid, json.dumps(DEFAULT_MODELS)))
    db.commit()
    token = make_token(cur.lastrowid, username)
    return ok({'token': token, 'username': username})

@app.route('/api/auth/login', methods=['POST'])
def login():
    data = request.json or {}
    username = (data.get('username') or '').strip()
    password = (data.get('password') or '').strip()
    if not username or not password:
        return err('用户名和密码不能为空')
    db = get_db()
    user = db.execute('SELECT * FROM users WHERE username=?', (username,)).fetchone()
    if not user or not bcrypt.checkpw(password.encode(), user['password_hash'].encode()):
        return err('用户名或密码错误')
    token = make_token(user['id'], user['username'])
    return ok({'token': token, 'username': user['username']})

@app.route('/api/auth/me', methods=['GET'])
@require_auth
def me():
    return ok({'user_id': g.user_id, 'username': g.username})

# ─── 用户配置 ─────────────────────────────────────────────────────────────────
@app.route('/api/config', methods=['GET'])
@require_auth
def get_config():
    db = get_db()
    row = db.execute('SELECT * FROM user_config WHERE user_id=?', (g.user_id,)).fetchone()
    if not row:
        # 补建（历史数据容错）
        db.execute('INSERT OR IGNORE INTO user_config (user_id, models_json) VALUES (?,?)',
                   (g.user_id, json.dumps(DEFAULT_MODELS)))
        db.commit()
        row = db.execute('SELECT * FROM user_config WHERE user_id=?', (g.user_id,)).fetchone()
    models = json.loads(row['models_json'] or '[]') or DEFAULT_MODELS
    return ok({
        'api_base': row['api_base'] or '',
        'api_key':  row['api_key']  or '',
        'models':   models
    })

@app.route('/api/config', methods=['PUT'])
@require_auth
def save_config():
    data = request.json or {}
    api_base = (data.get('api_base') or '').strip()
    api_key  = (data.get('api_key')  or '').strip()
    models   = data.get('models', DEFAULT_MODELS)
    if not api_base: return err('API Base URL 不能为空')
    if not api_key:  return err('API Key 不能为空')
    if not models:   return err('至少需要一个模型')
    db = get_db()
    db.execute("""
        INSERT INTO user_config (user_id, api_base, api_key, models_json)
        VALUES (?,?,?,?)
        ON CONFLICT(user_id) DO UPDATE SET
            api_base=excluded.api_base,
            api_key=excluded.api_key,
            models_json=excluded.models_json
    """, (g.user_id, api_base, api_key, json.dumps(models)))
    db.commit()
    return ok()

# ─── 对话管理 ─────────────────────────────────────────────────────────────────
@app.route('/api/conversations', methods=['GET'])
@require_auth
def list_conversations():
    db = get_db()
    rows = db.execute(
        'SELECT id, title, model, created_at, updated_at FROM conversations '
        'WHERE user_id=? ORDER BY updated_at DESC', (g.user_id,)
    ).fetchall()
    # 附带最后一条消息预览
    convs = []
    for r in rows:
        last = db.execute(
            'SELECT display_text, role FROM messages WHERE conversation_id=? ORDER BY id DESC LIMIT 1',
            (r['id'],)
        ).fetchone()
        convs.append({
            'id': r['id'], 'title': r['title'], 'model': r['model'],
            'created_at': r['created_at'], 'updated_at': r['updated_at'],
            'preview': last['display_text'][:60] if last else '',
            'preview_role': last['role'] if last else ''
        })
    return ok(convs)

@app.route('/api/conversations', methods=['POST'])
@require_auth
def create_conversation():
    data  = request.json or {}
    title = (data.get('title') or '新对话').strip()
    model = (data.get('model') or 'gpt-4o').strip()
    db = get_db()
    cur = db.execute(
        'INSERT INTO conversations (user_id, title, model) VALUES (?,?,?)',
        (g.user_id, title, model)
    )
    db.commit()
    return ok({'id': cur.lastrowid, 'title': title, 'model': model})

@app.route('/api/conversations/<int:cid>', methods=['PUT'])
@require_auth
def update_conversation(cid):
    db  = get_db()
    row = db.execute('SELECT id FROM conversations WHERE id=? AND user_id=?', (cid, g.user_id)).fetchone()
    if not row: return err('对话不存在', 404)
    data  = request.json or {}
    title = (data.get('title') or '').strip()
    model = (data.get('model') or '').strip()
    if title:
        db.execute('UPDATE conversations SET title=?, updated_at=CURRENT_TIMESTAMP WHERE id=?', (title, cid))
    if model:
        db.execute('UPDATE conversations SET model=?, updated_at=CURRENT_TIMESTAMP WHERE id=?', (model, cid))
    db.commit()
    return ok()

@app.route('/api/conversations/<int:cid>', methods=['DELETE'])
@require_auth
def delete_conversation(cid):
    db = get_db()
    row = db.execute('SELECT id FROM conversations WHERE id=? AND user_id=?', (cid, g.user_id)).fetchone()
    if not row: return err('对话不存在', 404)
    db.execute('DELETE FROM conversations WHERE id=?', (cid,))
    db.commit()
    return ok()

@app.route('/api/conversations/<int:cid>/messages', methods=['GET'])
@require_auth
def get_messages(cid):
    db = get_db()
    row = db.execute('SELECT id FROM conversations WHERE id=? AND user_id=?', (cid, g.user_id)).fetchone()
    if not row: return err('对话不存在', 404)
    msgs = db.execute(
        'SELECT id, role, content_json, display_text, attachments_json FROM messages '
        'WHERE conversation_id=? ORDER BY id ASC', (cid,)
    ).fetchall()
    result = []
    for m in msgs:
        result.append({
            'id':          m['id'],
            'role':        m['role'],
            'content':     json.loads(m['content_json']),
            'display_text': m['display_text'] or '',
            'attachments': json.loads(m['attachments_json'] or '[]')
        })
    return ok(result)

# ─── 聊天（代理 AI API）─────────────────────────────────────────────────────────
@app.route('/api/chat', methods=['POST'])
@require_auth
def chat():
    data    = request.json or {}
    cid     = data.get('conversation_id')
    text    = (data.get('text') or '').strip()
    attachments = data.get('attachments', [])
    model   = (data.get('model') or 'gpt-4o').strip()

    if not cid: return err('缺少 conversation_id')
    if not text and not attachments: return err('消息不能为空')

    db  = get_db()
    row = db.execute('SELECT id FROM conversations WHERE id=? AND user_id=?', (cid, g.user_id)).fetchone()
    if not row: return err('对话不存在', 404)

    # 获取用户 API 配置
    cfg = db.execute('SELECT api_base, api_key FROM user_config WHERE user_id=?', (g.user_id,)).fetchone()
    if not cfg or not cfg['api_base'] or not cfg['api_key']:
        return err('请先在设置中配置 API Base 和 API Key', 400)

    # 构造当前消息的 content
    has_images  = any(a.get('fileType') == 'image' for a in attachments)
    text_files  = [a for a in attachments if a.get('fileType') == 'text']
    other_files = [a for a in attachments if a.get('fileType') == 'binary']

    full_text = text
    for tf in text_files:
        full_text += f"\n\n【附件：{tf['name']}】\n```\n{tf.get('textContent','')}\n```"
    if other_files:
        full_text += '\n\n【附件文件：' + '、'.join(f['name'] for f in other_files) + '】'

    if has_images:
        api_content = []
        if full_text:
            api_content.append({'type': 'text', 'text': full_text})
        for img in [a for a in attachments if a.get('fileType') == 'image']:
            api_content.append({'type': 'image_url', 'image_url': {'url': img['dataUrl']}})
    else:
        api_content = full_text or '(空消息)'

    # 存储附件元数据（不存 dataUrl，节省空间，只存 name/size/fileType）
    attach_meta = [{'name': a['name'], 'size': a.get('size',0),
                    'fileType': a.get('fileType','binary'),
                    'dataUrl': a.get('dataUrl','')} for a in attachments]

    # 保存用户消息
    db.execute(
        'INSERT INTO messages (conversation_id, role, content_json, display_text, attachments_json) VALUES (?,?,?,?,?)',
        (cid, 'user', json.dumps(api_content), text, json.dumps(attach_meta))
    )

    # 更新对话标题（第一条消息）
    msg_count = db.execute('SELECT COUNT(*) as c FROM messages WHERE conversation_id=?', (cid,)).fetchone()['c']
    if msg_count == 1:
        title = (text or (attachments[0]['name'] if attachments else '附件'))[:30]
        db.execute('UPDATE conversations SET title=? WHERE id=?', (title, cid))

    db.execute('UPDATE conversations SET updated_at=CURRENT_TIMESTAMP, model=? WHERE id=?', (model, cid))
    db.commit()

    # 加载完整历史（用于多轮对话）
    history = db.execute(
        'SELECT role, content_json FROM messages WHERE conversation_id=? ORDER BY id ASC',
        (cid,)
    ).fetchall()
    api_messages = [{'role': h['role'], 'content': json.loads(h['content_json'])} for h in history]

    # 调用 AI API
    try:
        resp = requests.post(
            f"{cfg['api_base'].rstrip('/')}/chat/completions",
            headers={'Content-Type': 'application/json',
                     'Authorization': f"Bearer {cfg['api_key']}"},
            json={'model': model, 'messages': api_messages, 'stream': False},
            timeout=120
        )
        resp.raise_for_status()
        result = resp.json()['choices'][0]['message']

        # 提取回复内容（DeepSeek Reasoner 有 reasoning_content）
        ai_reasoning = result.get('reasoning_content', '')
        ai_text = result.get('content', '')

        # 如果有思考过程，用 XML 标签包裹
        if ai_reasoning:
            ai_text = f"<thinking>\n{ai_reasoning}\n</thinking>\n\n{ai_text}"
    except requests.exceptions.Timeout:
        # 回滚用户消息
        db.execute('DELETE FROM messages WHERE conversation_id=? AND role=? ORDER BY id DESC LIMIT 1', (cid, 'user'))
        db.commit()
        return err('AI 接口超时，请重试', 504)
    except Exception as e:
        db.execute('DELETE FROM messages WHERE conversation_id=? ORDER BY id DESC LIMIT 1', (cid,))
        db.commit()
        return err(f'AI 接口错误: {str(e)}', 502)

    # 保存 AI 回复
    db.execute(
        'INSERT INTO messages (conversation_id, role, content_json, display_text) VALUES (?,?,?,?)',
        (cid, 'assistant', json.dumps(ai_text), ai_text)
    )
    db.execute('UPDATE conversations SET updated_at=CURRENT_TIMESTAMP WHERE id=?', (cid,))
    db.commit()

    return ok({'reply': ai_text})

# ─── 账户管理（修改密码）─────────────────────────────────────────────────────────
@app.route('/api/auth/change-password', methods=['POST'])
@require_auth
def change_password():
    data     = request.json or {}
    old_pw   = (data.get('old_password') or '').strip()
    new_pw   = (data.get('new_password') or '').strip()
    if not old_pw or not new_pw: return err('参数不完整')
    if len(new_pw) < 6: return err('新密码至少 6 位')
    db   = get_db()
    user = db.execute('SELECT password_hash FROM users WHERE id=?', (g.user_id,)).fetchone()
    if not bcrypt.checkpw(old_pw.encode(), user['password_hash'].encode()):
        return err('原密码不正确')
    new_hash = bcrypt.hashpw(new_pw.encode(), bcrypt.gensalt()).decode()
    db.execute('UPDATE users SET password_hash=? WHERE id=?', (new_hash, g.user_id))
    db.commit()
    return ok()

# ─── 健康检查 ─────────────────────────────────────────────────────────────────
@app.route('/api/health')
def health():
    return ok({'status': 'running', 'version': '1.0.0'})

# ─── 启动 ─────────────────────────────────────────────────────────────────────
if __name__ == '__main__':
    init_db()
    port = int(os.environ.get('PORT', 8000))
    debug = os.environ.get('DEBUG', 'false').lower() == 'true'
    print(f"[AI Studio] 启动于 http://0.0.0.0:{port}  (debug={debug})")
    app.run(host='0.0.0.0', port=port, debug=debug)
