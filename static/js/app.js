// ══════════════════════════════════════════════════════════════════════════
//  CONFIG
// ══════════════════════════════════════════════════════════════════════════
const API = '';  // 同源部署，空字符串即可；如跨域填 'http://server:8000'

// ══════════════════════════════════════════════════════════════════════════
//  STATE
// ══════════════════════════════════════════════════════════════════════════
let token     = sessionStorage.getItem('token') || '';
let username  = sessionStorage.getItem('username') || '';
let convList  = [];          // [{id,title,model,preview}]
let currentId = null;        // current conversation id
let messages  = [];          // current conversation messages (cache)
let tempModels = [];
let editingModelIndex = null; // index of model being edited, null if not editing
let dropdownTargetId = null; // conv id for three-dot menu

// ══════════════════════════════════════════════════════════════════════════
//  HTTP HELPERS
// ══════════════════════════════════════════════════════════════════════════
async function http(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? {'Authorization': `Bearer ${token}`} : {}) }
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(API + path, opts);
  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data.data;
}
const GET    = (p)       => http('GET',    p);
const POST   = (p, b)    => http('POST',   p, b);
const PUT    = (p, b)    => http('PUT',    p, b);
const DELETE = (p)       => http('DELETE', p);

// ══════════════════════════════════════════════════════════════════════════
//  AUTH
// ══════════════════════════════════════════════════════════════════════════
let authMode = 'login';

function switchAuthTab(mode) {
  authMode = mode;
  document.getElementById('tabLogin').classList.toggle('active', mode === 'login');
  document.getElementById('tabReg').classList.toggle('active', mode === 'register');
  document.getElementById('authBtn').textContent = mode === 'login' ? '登 录' : '注 册';
  document.getElementById('authError').style.display = 'none';
}

async function doAuth() {
  const user = document.getElementById('authUser').value.trim();
  const pass = document.getElementById('authPass').value.trim();
  const btn  = document.getElementById('authBtn');
  const errEl = document.getElementById('authError');
  errEl.style.display = 'none';
  if (!user || !pass) { showAuthError('请填写用户名和密码'); return; }
  btn.disabled = true; btn.textContent = '请稍候...';
  try {
    const path = authMode === 'login' ? '/api/auth/login' : '/api/auth/register';
    const res  = await POST(path, { username: user, password: pass });
    token    = res.token;
    username = res.username;
    sessionStorage.setItem('token',    token);
    sessionStorage.setItem('username', username);
    bootApp();
  } catch(e) {
    showAuthError(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = authMode === 'login' ? '登 录' : '注 册';
  }
}

function showAuthError(msg) {
  const el = document.getElementById('authError');
  el.textContent = msg; el.style.display = 'block';
}

function logout() {
  token = username = ''; currentId = null; messages = []; convList = [];
  sessionStorage.removeItem('token'); sessionStorage.removeItem('username');
  document.getElementById('app').classList.remove('visible');
  document.getElementById('authScreen').classList.remove('hidden');
  document.getElementById('authUser').value = '';
  document.getElementById('authPass').value = '';
}

// ══════════════════════════════════════════════════════════════════════════
//  THEME
// ══════════════════════════════════════════════════════════════════════════
const THEME_KEY = 'ai_studio_theme';

function getPreferredTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === 'light' || saved === 'dark') return saved;
  return 'dark';
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  updateThemeIcon(theme);
}

function updateThemeIcon(theme) {
  const iconDark = document.getElementById('themeIconDark');
  const iconLight = document.getElementById('themeIconLight');
  iconDark.style.display = theme === 'dark' ? 'block' : 'none';
  iconLight.style.display = theme === 'light' ? 'block' : 'none';
}

function initTheme() {
  const theme = getPreferredTheme();
  applyTheme(theme);
}

const THEMES = ['dark', 'light'];
const THEME_LABELS = { dark: '暗色', light: '亮色' };

function cycleTheme() {
  const current = getPreferredTheme();
  const idx = THEMES.indexOf(current);
  const next = THEMES[(idx + 1) % THEMES.length];
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
  showToast('主题: ' + THEME_LABELS[next], '');
}

// ══════════════════════════════════════════════════════════════════════════
//  BOOT
// ══════════════════════════════════════════════════════════════════════════
async function bootApp() {
  document.getElementById('authScreen').classList.add('hidden');
  document.getElementById('app').classList.add('visible');
  document.getElementById('userNameLabel').textContent = username;
  document.getElementById('userAvatar').textContent    = username[0].toUpperCase();
  await Promise.all([loadConfig(), loadConversations()]);
  if (convList.length > 0) {
    switchConv(convList[0].id);
  } else {
    await createNewChat();
  }
}

// ══════════════════════════════════════════════════════════════════════════
//  CONFIG
// ══════════════════════════════════════════════════════════════════════════
let cfg = { api_base: '', api_key: '', models: [] };

async function loadConfig() {
  try { cfg = await GET('/api/config'); } catch(e) {}
  rebuildModelSelect();
}

function rebuildModelSelect(currentModel) {
  const sel = document.getElementById('modelSelect');
  sel.innerHTML = cfg.models.map(m => `<option value="${m.id}">${m.name}</option>`).join('');
  if (currentModel) sel.value = currentModel;
}

function onModelChange() {
  if (!currentId) return;
  const conv = convList.find(c => c.id === currentId);
  if (conv) {
    conv.model = document.getElementById('modelSelect').value;
    PUT(`/api/conversations/${currentId}`, { model: conv.model }).catch(() => {});
  }
}

// ══════════════════════════════════════════════════════════════════════════
//  CONVERSATIONS
// ══════════════════════════════════════════════════════════════════════════
async function loadConversations() {
  try { convList = await GET('/api/conversations'); } catch(e) { convList = []; }
  renderConvList();
}

function renderConvList() {
  const el = document.getElementById('convList');
  if (!convList.length) {
    el.innerHTML = '<div style="padding:14px;font-size:12px;color:var(--text-muted);text-align:center">暂无对话</div>';
    return;
  }
  el.innerHTML = convList.map(c => `
    <div class="conv-item ${c.id === currentId ? 'active' : ''}" id="conv-${c.id}" onclick="switchConv(${c.id})"><div class="conv-title">${esc(c.title)}</div><div class="conv-preview">${esc(c.preview || '无消息')}</div><button class="conv-menu-btn" onclick="openConvMenu(event,${c.id})">⋮</button></div>`).join('');
}

async function switchConv(id) {
  currentId = id;
  const conv = convList.find(c => c.id === id);
  if (conv) rebuildModelSelect(conv.model);
  renderConvList();
  await loadMessages(id);
}

async function loadMessages(id) {
  try {
    messages = await GET(`/api/conversations/${id}/messages`);
  } catch(e) { messages = []; }
  renderMessages();
}

async function createNewChat() {
  const model = document.getElementById('modelSelect').value || (cfg.models[0]?.id ?? 'gpt-4o');
  try {
    const c = await POST('/api/conversations', { title: '新对话', model });
    convList.unshift({ id: c.id, title: c.title, model: c.model, preview: '' });
    messages = [];
    currentId = c.id;
    renderConvList();
    renderMessages();
  } catch(e) { showToast('创建对话失败: ' + e.message, 'error'); }
}

// ══════════════════════════════════════════════════════════════════════════
//  THREE-DOT MENU
// ══════════════════════════════════════════════════════════════════════════
function openConvMenu(e, id) {
  e.stopPropagation();
  dropdownTargetId = id;
  const dd = document.getElementById('convDropdown');
  dd.classList.add('open');
  const rect = e.currentTarget.getBoundingClientRect();
  dd.style.top  = (rect.bottom + 4) + 'px';
  dd.style.left = Math.min(rect.left, window.innerWidth - 160) + 'px';
}

document.addEventListener('click', () => {
  document.getElementById('convDropdown').classList.remove('open');
});

function startRename() {
  const conv = convList.find(c => c.id === dropdownTargetId);
  if (!conv) return;
  document.getElementById('renameInput').value = conv.title;
  document.getElementById('renameModal').classList.add('open');
  setTimeout(() => document.getElementById('renameInput').focus(), 50);
}

function closeRenameModal() {
  document.getElementById('renameModal').classList.remove('open');
}

async function confirmRename() {
  const title = document.getElementById('renameInput').value.trim();
  if (!title) return;
  try {
    await PUT(`/api/conversations/${dropdownTargetId}`, { title });
    const conv = convList.find(c => c.id === dropdownTargetId);
    if (conv) conv.title = title;
    renderConvList();
    closeRenameModal();
    showToast('已重命名', 'success');
  } catch(e) { showToast('重命名失败: ' + e.message, 'error'); }
}

async function confirmDelete() {
  if (!confirm('确认删除这条对话？此操作不可撤销。')) return;
  try {
    await DELETE(`/api/conversations/${dropdownTargetId}`);
    convList = convList.filter(c => c.id !== dropdownTargetId);
    if (currentId === dropdownTargetId) {
      messages = []; currentId = null;
      if (convList.length > 0) await switchConv(convList[0].id);
      else { renderMessages(); currentId = null; }
    }
    renderConvList();
    showToast('已删除', 'success');
  } catch(e) { showToast('删除失败: ' + e.message, 'error'); }
}

// ══════════════════════════════════════════════════════════════════════════
//  MESSAGES RENDER
// ══════════════════════════════════════════════════════════════════════════
function renderMessages() {
  const el = document.getElementById('messages');
  if (!messages.length) {
    el.innerHTML = '<div class="empty-state"><div class="empty-icon">💭</div><div class="empty-text">开始一段新的对话</div></div>';
    return;
  }
  el.innerHTML = messages.map(m => {
    const text = m.display_text || (typeof m.content === 'string' ? m.content : '');
    const attachHtml = renderAttachHtml(m.attachments || []);

    let msgContent = '';
    if (m.role === 'assistant' && text.includes('<thinking>')) {
      const thinkRegex = /<thinking>([\s\S]*?)<\/thinking>/;
      const thinkMatch = text.match(thinkRegex);
      const thinking = thinkMatch ? thinkMatch[1].trim() : '';
      const afterReplace = text.replace(/<thinking>[\s\S]*?<\/thinking>/g, '[THINKING_REMOVED]');
      const mainText = afterReplace.replace('[THINKING_REMOVED]', '').replace(/^[\n\s]+/, '').replace(/[\n\s]+$/, '').trim();
      msgContent = thinking
        ? `<div class="thinking-box">💭 <span class="thinking-label">思考过程</span><pre>${esc(thinking)}</pre></div>${mainText ? md(mainText) : ''}`
        : md(text);
    } else {
      msgContent = text ? md(text) : '';
    }

    return `<div class="message ${m.role}-message"><div class="msg-header"><div class="msg-avatar ${m.role === 'user' ? 'user-avatar-msg' : 'ai-avatar-msg'}">${m.role === 'user' ? username[0].toUpperCase() : 'AI'}</div><div class="msg-sender">${m.role === 'user' ? username : 'AI 助手'}</div></div><div class="msg-body">${attachHtml}${msgContent}</div></div>`;
  }).join('');
  el.scrollTop = el.scrollHeight;
  hljs.highlightAll();
}

function renderAttachHtml(attachments) {
  if (!attachments.length) return '';
  return '<div class="msg-attachments">' + attachments.map(a => {
    if (a.fileType === 'image')
      return `<img class="msg-img" src="${a.dataUrl}" alt="${esc(a.name)}" onclick="openLightbox('${a.dataUrl}')">`;
    return `<div class="msg-file">${fileIcon(ext(a.name))} ${esc(a.name)}</div>`;
  }).join('') + '</div>';
}

// ══════════════════════════════════════════════════════════════════════════
//  SEND MESSAGE
// ══════════════════════════════════════════════════════════════════════════
async function sendMessage() {
  const input = document.getElementById('msgInput');
  const text  = input.value.trim();
  if (!text && !attachments.length) return;
  if (!currentId) await createNewChat();

  const model = document.getElementById('modelSelect').value;

  const dispAttach = attachments.map(a => ({name:a.name,size:a.size,fileType:a.fileType,dataUrl:a.dataUrl}));
  messages.push({ role:'user', display_text:text, content:text, attachments:dispAttach });
  input.value = ''; input.style.height = 'auto';
  const sentAttach = [...attachments];
  attachments = []; renderAttachPreviews();
  renderMessages();

  const msgEl = document.getElementById('messages');
  const typingEl = document.createElement('div');
  typingEl.className = 'message ai-message';
  typingEl.innerHTML = `<div class="msg-header"><div class="msg-avatar ai-avatar-msg">AI</div><div class="msg-sender">AI 助手</div></div><div class="msg-body"><div class="typing-dots"><div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div></div></div>`;
  msgEl.appendChild(typingEl);
  msgEl.scrollTop = msgEl.scrollHeight;

  document.getElementById('sendBtn').disabled = true;

  try {
    const result = await POST('/api/chat', {
      conversation_id: currentId,
      text, model,
      attachments: sentAttach.map(a => ({name:a.name,size:a.size,fileType:a.fileType,dataUrl:a.dataUrl,textContent:a.textContent||''}))
    });

    msgEl.removeChild(typingEl);
    messages.push({ role:'assistant', display_text:result.reply, content:result.reply, attachments:[] });
    renderMessages();

    const conv = convList.find(c => c.id === currentId);
    if (conv) {
      if (conv.title === '新对话' && text) conv.title = text.substring(0,30);
      conv.preview = result.reply.substring(0,60);
      convList = [conv, ...convList.filter(c => c.id !== currentId)];
      renderConvList();
    }
  } catch(e) {
    msgEl.removeChild(typingEl);
    messages.pop();
    renderMessages();
    showToast('发送失败: ' + e.message, 'error');
  } finally {
    document.getElementById('sendBtn').disabled = false;
  }
}

// ══════════════════════════════════════════════════════════════════════════
//  SETTINGS
// ══════════════════════════════════════════════════════════════════════════
function openSettings() {
  document.getElementById('cfgBase').value = cfg.api_base || '';
  document.getElementById('cfgKey').value  = cfg.api_key  || '';
  tempModels = cfg.models.map(m => ({...m}));
  editingModelIndex = null;
  renderModelList();
  document.getElementById('pwOld').value = '';
  document.getElementById('pwNew').value = '';
  document.getElementById('settingsModal').classList.add('open');
}
function closeSettings() { document.getElementById('settingsModal').classList.remove('open'); }

function toggleEye() {
  const inp = document.getElementById('cfgKey');
  const btn = document.getElementById('eyeBtn');
  inp.type = inp.type === 'password' ? 'text' : 'password';
  btn.textContent = inp.type === 'password' ? '👁' : '🙈';
}

function renderModelList() {
  const el = document.getElementById('modelList');
  if (!tempModels.length) { el.innerHTML = '<div class="no-models">暂无模型</div>'; return; }
  el.innerHTML = tempModels.map((m,i) => {
    if (editingModelIndex === i) {
      return `<div class="model-item"><div class="model-edit-row"><input type="text" id="editMName" value="${esc(m.name)}" placeholder="模型名称"><input type="text" id="editMId" value="${esc(m.id)}" placeholder="模型 ID"></div><button class="model-edit-btn" onclick="saveEditModel(${i})" title="保存">✓</button><button class="model-del-btn" onclick="cancelEditModel()" title="取消">✕</button></div>`;
    }
    return `<div class="model-item"><div class="model-item-info"><div class="model-item-name">${esc(m.name)}</div><div class="model-item-id">${esc(m.id)}</div></div><button class="model-edit-btn" onclick="startEditModel(${i})" title="编辑">✎</button><button class="model-del-btn" onclick="delModel(${i})">✕</button></div>`;
  }).join('');
}

function addModel() {
  const name = document.getElementById('newMName').value.trim();
  const id   = document.getElementById('newMId').value.trim();
  if (!name || !id) { showToast('请填写名称和模型 ID', 'error'); return; }
  if (tempModels.find(m => m.id === id)) { showToast('模型 ID 已存在', 'error'); return; }
  tempModels.push({name, id});
  renderModelList();
  document.getElementById('newMName').value = '';
  document.getElementById('newMId').value   = '';
}

function delModel(i) { tempModels.splice(i, 1); renderModelList(); }

function startEditModel(i) {
  editingModelIndex = i;
  renderModelList();
  setTimeout(() => {
    document.getElementById('editMName')?.focus();
  }, 50);
}

function saveEditModel(i) {
  const name = document.getElementById('editMName').value.trim();
  const id   = document.getElementById('editMId').value.trim();
  if (!name || !id) { showToast('请填写名称和模型 ID', 'error'); return; }
  if (tempModels.find((m, idx) => m.id === id && idx !== i)) {
    showToast('模型 ID 已存在', 'error'); return;
  }
  tempModels[i] = {name, id};
  editingModelIndex = null;
  renderModelList();
  showToast('✓ 模型已更新', 'success');
}

function cancelEditModel() {
  editingModelIndex = null;
  renderModelList();
}

async function saveSettings() {
  const api_base = document.getElementById('cfgBase').value.trim();
  const api_key  = document.getElementById('cfgKey').value.trim();
  if (!api_base) { showToast('API Base URL 不能为空', 'error'); return; }
  if (!api_key)  { showToast('API Key 不能为空', 'error'); return; }
  if (!tempModels.length) { showToast('至少需要一个模型', 'error'); return; }
  try {
    await PUT('/api/config', { api_base, api_key, models: tempModels });
    cfg = { api_base, api_key, models: tempModels };
    const cur = document.getElementById('modelSelect').value;
    rebuildModelSelect(cur);
    closeSettings();
    showToast('✓ 设置已保存', 'success');
  } catch(e) { showToast('保存失败: ' + e.message, 'error'); }
}

async function changePassword() {
  const old_pw = document.getElementById('pwOld').value.trim();
  const new_pw = document.getElementById('pwNew').value.trim();
  if (!old_pw || !new_pw) { showToast('请填写原密码和新密码', 'error'); return; }
  try {
    await POST('/api/auth/change-password', { old_password: old_pw, new_password: new_pw });
    document.getElementById('pwOld').value = '';
    document.getElementById('pwNew').value = '';
    showToast('✓ 密码已修改', 'success');
  } catch(e) { showToast('修改失败: ' + e.message, 'error'); }
}

// ══════════════════════════════════════════════════════════════════════════
//  ATTACHMENTS
// ══════════════════════════════════════════════════════════════════════════
let attachments = [];
const IMG_EXTS  = ['bmp','jpg','jpeg','png','gif','webp','svg'];
const TXT_EXTS  = ['txt','md','csv','html','js','css','json','conf','lua','py','java','go','php','xml','yaml','yml','sql','sh','bat'];
const ICONS = {zip:'🗜️','7z':'🗜️',rar:'🗜️',tar:'🗜️',gz:'🗜️',doc:'📝',docx:'📝',xls:'📊',xlsx:'📊',ppt:'📑',pptx:'📑',pdf:'📄',txt:'📃',md:'📃',csv:'📊',html:'🌐',js:'🟨',css:'🎨',json:'🧩',conf:'⚙️',lua:'🌙',py:'🐍',java:'☕',go:'🐹',php:'🐘',xml:'🧾',yaml:'📘',yml:'📘',sql:'🗄️',sh:'🖥️',bat:'🖥️',svg:'🖼️'};

function ext(name) { return name.split('.').pop().toLowerCase(); }
function fileIcon(e) { return ICONS[e] || '📎'; }
function fmtSize(b) { return b<1024?b+'B':b<1048576?(b/1024).toFixed(1)+'KB':(b/1048576).toFixed(1)+'MB'; }
function classifyFile(name) { const e=ext(name); return IMG_EXTS.includes(e)?'image':TXT_EXTS.includes(e)?'text':'binary'; }
const readDataUrl = f => new Promise((r,j) => { const x=new FileReader(); x.onload=e=>r(e.target.result); x.onerror=j; x.readAsDataURL(f); });
const readText    = f => new Promise((r,j) => { const x=new FileReader(); x.onload=e=>r(e.target.result); x.onerror=j; x.readAsText(f,'UTF-8'); });

async function addFiles(files) {
  for (const f of files) {
    if (attachments.length >= 10) { showToast('最多 10 个附件', 'error'); break; }
    const ft = classifyFile(f.name);
    const dataUrl = await readDataUrl(f);
    const textContent = ft === 'text' ? await readText(f) : null;
    attachments.push({id:Date.now()+Math.random(), name:f.name, size:f.size, fileType:ft, dataUrl, textContent});
  }
  renderAttachPreviews();
}

function renderAttachPreviews() {
  const bar = document.getElementById('attachBar');
  if (!attachments.length) { bar.innerHTML=''; bar.classList.remove('has-items'); return; }
  bar.classList.add('has-items');
  bar.innerHTML = attachments.map(a => `<div class="attach-chip">${a.fileType==='image'?`<img class="attach-thumb" src="${a.dataUrl}">`:`<div class="attach-icon">${fileIcon(ext(a.name))}</div>`}<div><div class="attach-name">${esc(a.name)}</div><div class="attach-size">${fmtSize(a.size)}</div></div><button class="attach-rm" onclick="rmAttach(${a.id})">✕</button></div>`).join('');
}

function rmAttach(id) { attachments=attachments.filter(a=>a.id!==id); renderAttachPreviews(); }
function onFileSelect(e) { addFiles([...e.target.files]); e.target.value=''; }
function onPaste(e) {
  const imgs=[]; for(const item of (e.clipboardData?.items||[])) {
    if(item.type.startsWith('image/')){ const f=item.getAsFile(); if(f){ Object.defineProperty(f,'name',{value:`paste_${Date.now()}.${item.type.split('/')[1]||'png'}`}); imgs.push(f); } }
  }
  if(imgs.length){ e.preventDefault(); addFiles(imgs); }
}
function onDragOver(e) { e.preventDefault(); document.getElementById('inputBox').classList.add('drag-over'); document.getElementById('dropOverlay').classList.add('show'); }
function onDragLeave(e) { if(!document.getElementById('inputBox').contains(e.relatedTarget)){ document.getElementById('inputBox').classList.remove('drag-over'); document.getElementById('dropOverlay').classList.remove('show'); } }
function onDrop(e) { e.preventDefault(); document.getElementById('inputBox').classList.remove('drag-over'); document.getElementById('dropOverlay').classList.remove('show'); addFiles([...e.dataTransfer.files]); }

// ══════════════════════════════════════════════════════════════════════════
//  LIGHTBOX
// ══════════════════════════════════════════════════════════════════════════
function openLightbox(src) { document.getElementById('lightboxImg').src=src; document.getElementById('lightbox').classList.add('open'); }
function closeLightbox()   { document.getElementById('lightbox').classList.remove('open'); }

// ══════════════════════════════════════════════════════════════════════════
//  INPUT HELPERS
// ══════════════════════════════════════════════════════════════════════════
function onInputKey(e) { if(e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); sendMessage(); } }
function autoResize(el) { el.style.height='auto'; el.style.height=Math.min(el.scrollHeight,150)+'px'; }

// ══════════════════════════════════════════════════════════════════════════
//  MARKDOWN RENDERER
// ══════════════════════════════════════════════════════════════════════════
function md(raw) {
  const blocks=[]; let s=raw.replace(/```(\w*)\n?([\s\S]*?)```/g,(_,l,c)=>{const i=blocks.length;blocks.push(`<pre><code class="${l?'language-'+l:''}">${esc(c.replace(/\n$/,''))}</code></pre>`);return`\x00B${i}\x00`;});

  s=s.replace(/^(?: {4}|\t|)#!\/bin\/bash[\s\S]*?(?:^$|(?=^\s*$))/gm, (_, c) => {
    const i = blocks.length;
    blocks.push(`<pre><code class="language-bash">${esc(c.replace(/\n$/,''))}</code></pre>`);
    return `\x00B${i}\x00`;
  });

  s=s.replace(/^(?: {4}|\t)([\s\S]*?)(?:^$|(?=^[^ \t]))/gm, (_, c) => {
    const i = blocks.length;
    blocks.push(`<pre><code>${esc(c.replace(/\n$/,''))}</code></pre>`);
    return `\x00B${i}\x00`;
  });

  const inlines=[]; s=s.replace(/`([^`]+)`/g,(_,c)=>{const i=inlines.length;inlines.push(`<code>${esc(c)}</code>`);return`\x00I${i}\x00`;});
  const lines=s.split('\n'); const out=[]; let i=0;
  while(i<lines.length){
    const l=lines[i];
    const m4=l.match(/^####\s+(.*)/),m3=l.match(/^###\s+(.*)/),m2=l.match(/^##\s+(.*)/),m1=l.match(/^#\s+(.*)/);
    if(m4){out.push(`<h4>${inl(m4[1])}</h4>`);i++;continue}
    if(m3){out.push(`<h3>${inl(m3[1])}</h3>`);i++;continue}
    if(m2){out.push(`<h2>${inl(m2[1])}</h2>`);i++;continue}
    if(m1){out.push(`<h1>${inl(m1[1])}</h1>`);i++;continue}
    if(/^[-*_]{3,}$/.test(l.trim())){out.push('<hr>');i++;continue}
    if(l.startsWith('> ')){out.push(`<blockquote>${inl(l.slice(2))}</blockquote>`);i++;continue}
    if(l.includes('|')&&i+1<lines.length&&/^\|?[-| :]+\|?$/.test(lines[i+1])){const t=[];while(i<lines.length&&lines[i].includes('|')){t.push(lines[i]);i++;}out.push(tbl(t));continue}
    if(/^[-*+]\s/.test(l)){const it=[];while(i<lines.length&&/^[-*+]\s/.test(lines[i])){it.push(`<li>${inl(lines[i].replace(/^[-*+]\s/,''))}</li>`);i++;}out.push(`<ul>${it.join('')}</ul>`);continue}
    if(/^\d+\.\s/.test(l)){const it=[];while(i<lines.length&&/^\d+\.\s/.test(lines[i])){it.push(`<li>${inl(lines[i].replace(/^\d+\.\s/,''))}</li>`);i++;}out.push(`<ol>${it.join('')}</ol>`);continue}
    if(/^\x00B\d+\x00$/.test(l.trim())){out.push(l.trim());i++;continue}
    if(l.trim()===''){out.push('');i++;continue}
    out.push(`<p>${inl(l)}</p>`);i++;
  }
  let html=out.join('\n');
  blocks.forEach((b,i)=>html=html.replace(`\x00B${i}\x00`,b));
  inlines.forEach((b,i)=>html=html.replace(`\x00I${i}\x00`,b));
  return html;
}

function inl(t){
  t=t.replace(/\*\*\*(.+?)\*\*\*/g,'<strong><em>$1</em></strong>');
  t=t.replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>');
  t=t.replace(/__(.+?)__/g,'<strong>$1</strong>');
  t=t.replace(/\*(.+?)\*/g,'<em>$1</em>');
  t=t.replace(/_(.+?)_/g,'<em>$1</em>');
  t=t.replace(/~~(.+?)~~/g,'<del>$1</del>');
  t=t.replace(/\[([^\]]+)\]\(([^)]+)\)/g,'<a href="$2" target="_blank" style="color:var(--accent)">$1</a>');
  return t;
}
function tbl(lines){
  const pr=l=>l.replace(/^\||\|$/g,'').split('|').map(c=>c.trim());
  const rows=lines.filter((_,i)=>!/^[\|: -]+$/.test(lines[i]));
  if(!rows.length)return'';
  const h=pr(rows[0]),body=rows.slice(1);
  return`<table><thead><tr>${h.map(c=>`<th>${inl(c)}</th>`).join('')}</tr></thead><tbody>${body.map(r=>`<tr>${pr(r).map(c=>`<td>${inl(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

// ══════════════════════════════════════════════════════════════════════════
//  UTILITY
// ══════════════════════════════════════════════════════════════════════════
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}

let toastT;
function showToast(msg,type=''){
  const el=document.getElementById('toast');
  el.textContent=msg; el.className='toast show'+(type?' '+type:'');
  clearTimeout(toastT); toastT=setTimeout(()=>el.classList.remove('show'),2800);
}

// ══════════════════════════════════════════════════════════════════════════
//  INIT — auto-login if token exists
// ══════════════════════════════════════════════════════════════════════════
(async () => {
  initTheme();
  if (token) {
    try {
      await GET('/api/auth/me');
      await bootApp();
    } catch(e) {
      sessionStorage.removeItem('token'); sessionStorage.removeItem('username');
      token = username = '';
    }
  }
})();