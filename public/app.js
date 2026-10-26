const $ = id => document.getElementById(id);
let state, statusTimer, qrTimer, toastTimer, qrExpires = 0;
const labels = { missing: '未连接', valid: '已连接', expired: '需重新登录', blocked: '需安全验证' };
function toast(text, error = false) {
  $('toast').textContent = text; $('toast').classList.toggle('error', error); $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 6000);
}
function lock() {
  clearTimeout(statusTimer); clearTimeout(qrTimer);
  $('unlock').hidden = false; $('dashboard').hidden = true; $('lock').hidden = true;
  $('cookie').value = ''; $('qr-image').hidden = true; $('qr-image').removeAttribute('src');
  $('qr-placeholder').hidden = false;
}
async function api(path, body) {
  const response = await fetch('/api/' + path, { method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401) lock();
    throw new Error(data.error || '服务暂不可用');
  }
  return data;
}
async function action(button, operation) {
  if (button.disabled) return;
  button.disabled = true;
  try { await operation(); } catch (error) { toast(error.message || '网络连接失败，请稍后重试', true); }
  finally { button.disabled = false; if (state && !$('dashboard').hidden) syncControls(); }
}
function syncControls() {
  const running = state.job?.status === 'running';
  $('run').disabled = running || state.login !== 'valid' || !state.topics.length;
  for (const id of ['create-qr', 'validate', 'disconnect']) $(id).disabled = running;
}
function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}
function addTopic(topic = { id: '', name: '' }) {
  const row = node('div', undefined, 'topic-row');
  const fields = node('div');
  const name = node('input'); name.value = topic.name; name.placeholder = '超话名称'; name.maxLength = 60;
  name.setAttribute('aria-label', '超话名称'); name.required = true; name.className = 'topic-name';
  const id = node('input'); id.value = topic.id; id.placeholder = '粘贴超话链接或 100808… ID'; id.required = true;
  id.setAttribute('aria-label', '超话链接或 ID'); id.className = 'topic-id';
  if (topic.id) id.type = 'hidden';
  fields.append(name, id);
  if (topic.id) {
    const link = node('a', '在微博查看 ↗', 'topic-link'); link.href = 'https://weibo.com/p/' + topic.id;
    link.target = '_blank'; link.rel = 'noreferrer'; fields.append(link);
  }
  const remove = node('button', '×', 'remove'); remove.type = 'button'; remove.setAttribute('aria-label', '移除此超话');
  remove.addEventListener('click', () => { row.remove(); $('empty-topics').hidden = $('topic-list').children.length > 0; });
  row.append(fields, remove); $('topic-list').append(row); $('empty-topics').hidden = true;
}
function render(settings = false) {
  $('completed-count').textContent = state.topics.filter(t => state.completedToday.includes(t.id)).length;
  $('topic-count').textContent = state.topics.length;
  $('date').textContent = state.today.replaceAll('-', ' / ');
  $('login-stat').textContent = labels[state.login]; $('account-badge').textContent = labels[state.login];
  $('last-check').textContent = state.lastChecked ? '上次检测 ' + time(state.lastChecked) : '等待首次登录';
  $('schedule-stat').textContent = state.enabled ? '已开启' : '已关闭';
  $('overview-copy').textContent = state.login === 'valid' ? '账号已连接，今天也为喜欢的超话留个脚印。' : '连接账号，开始你的超话签到。';
  $('notice').hidden = !state.message; $('notice').textContent = state.message || '';
  const job = state.job, running = job?.status === 'running';
  $('run-title').textContent = running ? '正在签到，稍等片刻' : job?.status === 'done' ? '这一轮签到已完成' : job?.status === 'stopped' ? '签到任务已停止' : '让热爱成为日常';
  $('run-detail').textContent = running ? `已处理 ${job.index} / ${job.topics.length} 个超话` : job?.message || '每次签到前检测登录状态，今天已完成的超话会自动跳过。';
  $('run').hidden = running; $('stop').hidden = !running;
  syncControls();
  $('history-body').replaceChildren(); $('empty-history').hidden = state.history.length > 0;
  for (const entry of state.history) {
    const tr = node('tr'); tr.append(node('td', entry.topic.name), node('td', time(entry.at)));
    const result = node('td'); result.append(node('span', { success: '签到成功', already: '今日已签', failed: '未完成' }[entry.result], 'badge ' + entry.result));
    tr.append(result, node('td', entry.message)); $('history-body').append(tr);
  }
  if (settings) {
    $('enabled').checked = state.enabled; $('topic-list').replaceChildren();
    $('empty-topics').hidden = state.topics.length > 0;
    state.topics.forEach(addTopic);
  }
}
function time(value) {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}
async function refresh(settings = false) {
  state = await api('status');
  $('unlock').hidden = true; $('dashboard').hidden = false; $('lock').hidden = false;
  render(settings);
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => refresh().catch(e => { toast(e.message, true); }), state.job?.status === 'running' ? 4000 : 60000);
}
async function pollQR() {
  if (Date.now() > qrExpires) { clearQR('二维码已过期，请重新生成'); return; }
  try {
    const data = await api('qr/poll', {});
    if (data.status === 'ok') { clearQR('账号已连接'); toast('微博登录成功'); await refresh(); return; }
    if (data.status === 'expired') { clearQR('二维码已过期或被取消，请重新生成'); return; }
    $('qr-status').textContent = data.status === 'scanned' ? '已扫码，请在微博 App 确认登录' : '请用微博 App 扫码并确认登录';
    qrTimer = setTimeout(pollQR, 3500);
  } catch (error) { clearQR('扫码暂不可用，可使用 Cookie 备用登录'); toast(error.message, true); }
}
function clearQR(message) {
  clearTimeout(qrTimer); $('qr-image').hidden = true; $('qr-image').removeAttribute('src');
  $('qr-placeholder').hidden = false; $('qr-status').textContent = message; $('create-qr').textContent = '生成登录二维码';
}
$('unlock-form').addEventListener('submit', event => {
  event.preventDefault(); action(event.submitter, async () => {
    const token = $('token').value; $('token').value = '';
    await api('session', { token }); await refresh(true);
  });
});
$('lock').addEventListener('click', () => action($('lock'), async () => { await api('session/logout', {}); lock(); }));
$('topic-search-form').addEventListener('submit', event => {
  event.preventDefault(); action(event.submitter, async () => {
    $('search-results').replaceChildren(); $('search-feedback').textContent = '正在搜索…';
    try {
      const data = await api('topics/search', { query: $('topic-query').value.trim() });
      $('search-feedback').textContent = data.topics.length ? `找到 ${data.topics.length} 个超话，选择后保存设置。` : '未找到匹配超话，试试完整名称，或通过链接添加。';
      for (const topic of data.topics) {
        const row = node('div', undefined, 'search-result');
        const name = node('a', topic.name); name.href = 'https://weibo.com/p/' + topic.id; name.target = '_blank'; name.rel = 'noreferrer';
        const button = node('button', '加入', 'result-add'); button.type = 'button';
        const exists = () => Array.from(document.querySelectorAll('.topic-id')).some(input => input.value === topic.id);
        if (exists()) { button.textContent = '已加入'; button.disabled = true; }
        button.addEventListener('click', () => {
          if (exists()) return;
          if ($('topic-list').children.length >= 30) { toast('最多配置 30 个超话', true); return; }
          addTopic(topic); button.textContent = '已加入'; button.disabled = true; toast('已加入列表，请保存设置');
        });
        row.append(name, button); $('search-results').append(row);
      }
    } catch (error) { $('search-feedback').textContent = error.message; throw error; }
  });
});
$('add-topic').textContent = '＋ 通过链接或 ID 添加';
$('add-topic').addEventListener('click', () => {
  if ($('topic-list').children.length >= 30) { toast('最多配置 30 个超话', true); return; }
  addTopic();
});
$('settings-form').addEventListener('submit', event => {
  event.preventDefault(); action(event.submitter, async () => {
    const topics = Array.from($('topic-list').children).map(row => {
      const name = row.querySelector('.topic-name').value.trim();
      const raw = row.querySelector('.topic-id').value.trim();
      const match = raw.match(/100808[a-f0-9]{32}/i);
      if (!match) throw new Error(`「${name}」的超话 ID 不正确`);
      return { name, id: match[0] };
    });
    await api('settings', { topics, enabled: $('enabled').checked });
    await refresh(true); toast('设置已保存');
  });
});
$('cookie-form').addEventListener('submit', event => {
  event.preventDefault(); action(event.submitter, async () => {
    const cookie = $('cookie').value; $('cookie').value = '';
    const data = await api('cookie', { cookie }); toast(data.message); clearQR('账号已连接'); await refresh();
  });
});
$('create-qr').addEventListener('click', () => action($('create-qr'), async () => {
  clearTimeout(qrTimer); const data = await api('qr/create', {});
  qrExpires = data.expires; $('qr-image').src = data.image;
  $('qr-image').hidden = false; $('qr-placeholder').hidden = true;
  $('qr-status').textContent = '请用微博 App 扫码并确认登录'; $('create-qr').textContent = '刷新登录二维码';
  qrTimer = setTimeout(pollQR, 3500);
}));
$('qr-image').addEventListener('error', () => { clearQR('二维码图片加载失败，可使用 Cookie 备用登录'); });
for (const [id, path] of [['validate', 'validate'], ['run', 'run'], ['stop', 'stop']]) {
  $(id).addEventListener('click', () => action($(id), async () => {
    try { const data = await api(path, {}); toast(data.message); }
    finally { await refresh(); }
  }));
}
$('disconnect').addEventListener('click', () => action($('disconnect'), async () => {
  if (!confirm('删除已保存的微博登录信息，并关闭自动签到？')) return;
  await api('logout', {}); clearQR('无需提供账号密码'); await refresh(true); toast('微博账号已断开');
}));
$('refresh').addEventListener('click', () => action($('refresh'), () => refresh()));
for (const link of document.querySelectorAll('nav a')) link.addEventListener('click', () => {
  document.querySelector('nav .active')?.classList.remove('active'); link.classList.add('active');
});
refresh(true).catch(error => { if (error.message !== '请使用管理密钥解锁控制台') toast(error.message, true); });
