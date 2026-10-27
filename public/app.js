const $ = id => document.getElementById(id);
let state, statusTimer, qrTimer, toastTimer, qrExpires = 0, qrMobile = false, loginExpanded = false, profileAttemptAt = 0, avatarKey = '';
const labels = { missing: '未连接', valid: '已连接', expired: '需重新登录', blocked: '需安全验证' };
const busy = new Set();
const motion = window.gsap, reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const pages = {
  overview: ['签到概览', '一个工作台，查看各平台的签到状态与执行结果。'],
  topics: ['我的超话', '读取已关注的超话，管理签到列表与自动签到。'],
  account: ['微博账号', '查看当前账号，管理登录和个人等级连接。'],
  nodeseek: ['NodeSeek', '管理每日签到、Cookie 检测、随机时段与鸡腿记录。'],
  'nodeseek-settings': ['NodeSeek · 签到设置', '设置自动签到、随机时段与领取方式，按需更新凭证。'],
  'nodeseek-sync': ['NodeSeek · 扩展同步', '在本工作台连接浏览器，自动同步 NodeSeek 登录状态。'],
  huya: ['虎牙 · 免费虎粮', '读取背包中的普通虎粮，全部赠送到指定直播间。'],
  'huya-settings': ['虎牙 · 账号与设置', '连接虎牙账号，设置接收直播间与每日执行时间。'],
  history: ['签到记录', '按平台与月份查看签到结果。']
};
function enter(target, stagger = 0) {
  if (!motion || reduceMotion.matches) return;
  motion.fromTo(target, { opacity: 0, y: 6 }, { opacity: 1, y: 0, duration: .24, stagger, ease: 'power2.out', clearProps: 'opacity,transform', overwrite: true });
}
function showPage(animate = true) {
  const raw = location.hash.replace(/^#\/?/, ''), key = Object.hasOwn(pages, raw) ? raw : 'overview';
  if (location.hash !== '#/' + key) history.replaceState(null, '', '#/' + key);
  document.querySelectorAll('[data-page]').forEach(page => { page.hidden = page.dataset.page !== key; });
  document.querySelectorAll('nav a').forEach(link => {
    const active = link.hash === '#/' + key; link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  });
  const group = ['topics', 'account'].includes(key) ? 'weibo' : key.startsWith('nodeseek') ? 'nodeseek' : key.startsWith('huya') ? 'huya' : '';
  for (const name of ['weibo', 'nodeseek', 'huya']) {
    $('nav-' + name).classList.toggle('branch-active', name === group);
    if (name === group) toggleNav(name, true, animate);
  }
  $('page-heading').textContent = pages[key][0]; $('page-label').textContent = pages[key][0];
  $('overview-copy').textContent = pages[key][1]; $('date').hidden = key !== 'overview';
  document.title = pages[key][0] + ' · 每日';
  $('platform-home').href = key.startsWith('nodeseek') ? 'https://www.nodeseek.com' : 'https://weibo.com';
  $('platform-home').textContent = key.startsWith('nodeseek') ? '打开 NodeSeek ↗' : '打开微博 ↗';
  if (key.startsWith('huya')) { $('platform-home').href = 'https://www.huya.com'; $('platform-home').textContent = '打开虎牙 ↗'; }
  if (animate && !$('dashboard').hidden) { window.scrollTo(0, 0); enter(document.querySelectorAll('[data-page="' + key + '"]'), .04); $('page-heading').focus({ preventScroll: true }); }
  if (animate && state && ['nodeseek', 'history'].includes(key) && typeof loadPlatformHistory === 'function') loadPlatformHistory().catch(() => {});
}
function toggleNav(name, open, animate = true) {
  const button = $('nav-' + name), panel = $('nav-' + name + '-items'), arrow = button.querySelector('.nav-chevron');
  if (button.getAttribute('aria-expanded') === String(open)) return;
  button.setAttribute('aria-expanded', String(open));
  if (motion) { motion.killTweensOf([panel, arrow]); motion.set(arrow, { rotation: open ? 90 : 0 }); }
  if (!animate || !motion || reduceMotion.matches) { panel.hidden = !open; if (motion) motion.set(panel, { clearProps: 'height,opacity,overflow' }); return; }
  motion.fromTo(arrow, { rotation: open ? 0 : 90 }, { rotation: open ? 90 : 0, duration: .2, ease: 'power2.out' });
  if (open) { panel.hidden = false; motion.fromTo(panel, { height: 0, opacity: 0, overflow: 'hidden' }, { height: 'auto', opacity: 1, duration: .24, ease: 'power2.out', clearProps: 'height,opacity,overflow' }); }
  else motion.to(panel, { height: 0, opacity: 0, overflow: 'hidden', duration: .2, ease: 'power2.inOut', onComplete: () => { panel.hidden = true; motion.set(panel, { clearProps: 'height,opacity,overflow' }); } });
}
for (const name of ['weibo', 'nodeseek', 'huya']) $('nav-' + name).addEventListener('click', () => toggleNav(name, $('nav-' + name).getAttribute('aria-expanded') !== 'true'));
function navigate(hash) {
  const key = hash.replace(/^#\/?/, '');
  if (!Object.hasOwn(pages, key)) return;
  if (location.hash === '#/' + key) showPage(); else location.hash = '#/' + key;
}
function loginPanel(show, animate = false) {
  const panel = $('login-panel');
  const shouldShow = show || state?.login !== 'valid';
  $('hide-login').hidden = state?.login !== 'valid';
  if (panel.hidden === !shouldShow) return;
  if (motion) motion.killTweensOf(panel);
  if (!animate || !motion || reduceMotion.matches) { if (motion) motion.set(panel, { clearProps: 'height,opacity,overflow' }); panel.hidden = !shouldShow; return; }
  if (shouldShow) {
    panel.hidden = false;
    motion.fromTo(panel, { height: 0, opacity: 0, overflow: 'hidden' }, { height: 'auto', opacity: 1, duration: .25, ease: 'power2.out', clearProps: 'height,opacity,overflow' });
  } else motion.to(panel, { height: 0, opacity: 0, overflow: 'hidden', duration: .2, ease: 'power2.inOut', onComplete: () => { panel.hidden = true; motion.set(panel, { clearProps: 'height,opacity,overflow' }); } });
}
function renderAccount() {
  const connected = state.login === 'valid', profile = state.profile;
  $('account-profile').hidden = !connected && !profile;
  $('account-copy').textContent = connected ? '登录信息已加密保存。' : '扫码连接账号，失效后可在这里重新登录。';
  $('account-name').textContent = profile?.name || '已连接微博账号';
  $('account-uid').textContent = profile ? `UID ${profile.uid}` : '账号资料加载中…';
  if (profile) $('account-name').href = 'https://weibo.com/u/' + profile.uid;
  else $('account-name').removeAttribute('href');
  $('avatar-fallback').textContent = profile?.name?.slice(0, 1).toUpperCase() || '◎';
  if (profile?.avatar && avatarKey !== profile.uid + profile.avatar) {
    avatarKey = profile.uid + profile.avatar; $('account-avatar').src = '/api/avatar?v=' + Date.now();
  }
  if (!profile?.avatar) $('account-avatar').removeAttribute('src');
  const avatarLoaded = !!profile?.avatar && $('account-avatar').complete && $('account-avatar').naturalWidth > 0;
  $('account-avatar').hidden = !avatarLoaded; $('avatar-fallback').hidden = avatarLoaded;
  loginPanel(loginExpanded);
}
function toast(text, error = false) {
  $('toast').textContent = text; $('toast').classList.toggle('error', error); $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 6000);
  if (motion) {
    motion.set($('toast'), { xPercent: -50 });
    if (!reduceMotion.matches) motion.fromTo($('toast'), { opacity: 0, y: 6 }, { opacity: 1, y: 0, duration: .2, ease: 'power2.out', clearProps: 'opacity', overwrite: true });
  }
}
function lock() {
  clearTimeout(statusTimer); clearTimeout(qrTimer);
  $('unlock').hidden = false; $('dashboard').hidden = true; $('lock').hidden = true;
  $('cookie').value = ''; $('qr-image').hidden = true; $('qr-image').removeAttribute('src');
  $('followed-results').replaceChildren(); $('followed-feedback').textContent = ''; $('connect-levels').hidden = true;
  $('account-avatar').removeAttribute('src'); $('account-name').textContent = ''; $('account-uid').textContent = ''; avatarKey = '';
  $('qr-placeholder').hidden = false;
  if (typeof resetPlatforms === 'function') resetPlatforms();
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
  button.disabled = true; busy.add(button.id);
  try { await operation(); } catch (error) { toast(error.message || '网络连接失败，请稍后重试', true); }
  finally { busy.delete(button.id); button.disabled = false; if (state && !$('dashboard').hidden) syncControls(); }
}
function syncControls() {
  if (typeof syncHuyaControls === 'function') syncHuyaControls();
  const running = state.job?.status === 'running';
  $('run').disabled = running || state.login !== 'valid' || !state.topics.length;
  for (const id of ['create-qr', 'validate', 'disconnect']) $(id).disabled = running;
  $('load-followed').disabled = busy.has('load-followed') || running || state.login !== 'valid';
  $('connect-levels').disabled = busy.has('connect-levels') || running || state.login !== 'valid';
  $('show-login').disabled = running;
  if (typeof syncPlatformControls === 'function') syncPlatformControls();
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
  $('notice').hidden = !state.message; $('notice').textContent = state.message || '';
  const job = state.job, running = job?.status === 'running';
  $('run-title').textContent = running ? '正在签到' : job?.status === 'done' ? '本轮签到已完成' : job?.status === 'stopped' ? '签到任务已停止' : '准备开始签到';
  $('run-detail').textContent = running ? `已处理 ${job.index} / ${job.topics.length} 个超话` : job?.message || '每次签到前检测登录状态，今天已完成的超话会自动跳过。';
  $('run').hidden = running; $('stop').hidden = !running;
  syncControls();
  renderAccount();
  $('summary-account').textContent = state.profile?.name || labels[state.login];
  $('summary-topics').textContent = `${state.topics.length} 个`;
  const last = state.history[0];
  $('summary-last-topic').textContent = last?.topic.name || '暂无记录';
  $('summary-last-result').textContent = last ? `${{ success: '签到成功', already: '今日已签', failed: '未完成' }[last.result]} · ${time(last.at)}` : '添加超话后即可开始签到。';
  if (typeof renderPlatformHistory === 'function') { renderPlatformHistory(); renderPlatformCards(); }
  if (settings) {
    $('enabled').checked = state.enabled; $('topic-list').replaceChildren();
    if (motion) motion.set($('switch-knob'), { x: state.enabled ? 15 : 0 });
    else $('switch-knob').style.transform = `translateX(${state.enabled ? 15 : 0}px)`;
    $('empty-topics').hidden = state.topics.length > 0;
    state.topics.forEach(addTopic);
  }
  showPage(false);
}
function time(value) {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}
async function refresh(settings = false) {
  const entering = $('dashboard').hidden;
  state = await api('status');
  $('unlock').hidden = true; $('dashboard').hidden = false; $('lock').hidden = false;
  render(settings);
  if (entering) enter(document.querySelectorAll('[data-page]:not([hidden])'), .04);
  if (typeof refreshPlatforms === 'function') refreshPlatforms().catch(() => {});
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => refresh().catch(e => { toast(e.message, true); }), state.job?.status === 'running' ? 4000 : 60000);
  if (state.login === 'valid' && !state.profile && state.job?.status !== 'running' && Date.now() - profileAttemptAt > 60000) {
    profileAttemptAt = Date.now();
    try { const data = await api('profile', {}); state.profile = data.profile; renderAccount(); $('summary-account').textContent = data.profile.name; }
    catch { $('account-uid').textContent = '资料暂不可用，可重新检测'; }
  }
}
async function pollQR() {
  if (Date.now() > qrExpires) { clearQR('二维码已过期，请重新生成'); return; }
  try {
    const data = await api('qr/poll', {});
    if (data.status === 'ok') {
      qrMobile = false; loginExpanded = false; profileAttemptAt = 0;
      clearQR(data.mobile ? '个人等级账号已连接' : '账号已连接'); toast(data.mobile ? '手机网页登录成功，可重新读取等级' : '微博登录成功');
      await refresh(); if (data.mobile) { navigate('#/topics'); $('load-followed').click(); } return;
    }
    if (data.status === 'expired') { clearQR('二维码已过期或被取消，请重新生成'); return; }
    $('qr-status').textContent = data.status === 'scanned' ? '已扫码，请在微博 App 确认登录' : qrMobile ? '等级登录：请用当前账号扫码并确认' : '请用微博 App 扫码并确认登录';
    qrTimer = setTimeout(pollQR, 3500);
  } catch (error) { clearQR('扫码暂不可用，可使用 Cookie 备用登录'); toast(error.message, true); }
}
function clearQR(message) {
  clearTimeout(qrTimer); $('qr-image').hidden = true; $('qr-image').removeAttribute('src');
  $('qr-placeholder').hidden = false; $('qr-status').textContent = message; $('create-qr').textContent = '生成登录二维码';
}
$('show-login').addEventListener('click', () => { qrMobile = false; loginExpanded = true; loginPanel(true, true); });
$('hide-login').addEventListener('click', () => { clearQR('二维码已收起'); loginExpanded = false; loginPanel(false, true); });
$('account-avatar').addEventListener('error', () => { $('account-avatar').hidden = true; $('avatar-fallback').hidden = false; });
$('account-avatar').addEventListener('load', () => { $('account-avatar').hidden = false; $('avatar-fallback').hidden = true; });
$('enabled').addEventListener('change', () => {
  const x = $('enabled').checked ? 15 : 0;
  if (motion && !reduceMotion.matches) motion.to($('switch-knob'), { x, duration: .18, ease: 'power2.out', overwrite: true });
  else $('switch-knob').style.transform = `translateX(${x}px)`;
});
$('unlock-form').addEventListener('submit', event => {
  event.preventDefault(); action(event.submitter, async () => {
    const token = $('token').value; $('token').value = '';
    await api('session', { token }); await refresh(true);
  });
});
$('lock').addEventListener('click', () => action($('lock'), async () => { await api('session/logout', {}); lock(); }));
function topicResult(topic, followed = false) {
  const row = node('div', undefined, 'search-result');
  const info = node('div', undefined, 'followed-info');
  const name = node('a', topic.name); name.href = 'https://weibo.com/p/' + topic.id; name.target = '_blank'; name.rel = 'noreferrer';
  info.append(name);
  if (followed) info.append(node('p', topic.level === null ? '个人等级暂未提供' : `我的等级 LV.${topic.level}`, 'fine topic-level'));
  const button = node('button', '加入签到', 'result-add'); button.type = 'button';
  const exists = () => Array.from(document.querySelectorAll('.topic-id')).some(input => input.value === topic.id);
  if (exists()) { button.textContent = '已加入'; button.disabled = true; }
  button.addEventListener('click', () => {
    if (exists()) { button.textContent = '已加入'; button.disabled = true; return; }
    if ($('topic-list').children.length >= 30) { toast('最多配置 30 个超话', true); return; }
    addTopic(topic); button.textContent = '已加入'; button.disabled = true; toast('已加入列表，请保存设置');
  });
  row.append(info, button); return row;
}
$('load-followed').addEventListener('click', () => action($('load-followed'), async () => {
  $('followed-results').replaceChildren(); $('followed-feedback').textContent = '正在读取关注与个人等级…';
  const topics = new Map(); let maxPage = 1, levelMessage = '';
  $('connect-levels').hidden = true;
  try {
    for (let page = 1; page <= Math.min(maxPage, 100); page++) {
      const data = await api('topics/followed', { page }); maxPage = data.maxPage;
      for (const topic of data.topics) topics.set(topic.id, topic);
      $('followed-results').replaceChildren(...Array.from(topics.values(), topic => topicResult(topic, true)));
      $('followed-feedback').textContent = `已读取 ${topics.size} 个超话${page < maxPage ? '，继续加载…' : ''}`;
    }
    if (topics.size) {
      try {
        let cursor = ''; const seen = new Set();
        for (let page = 0; page < 100; page++) {
          const data = await api('topics/levels', { cursor });
          for (const topic of data.topics) if (topics.has(topic.id)) topics.get(topic.id).level = topic.level;
          $('followed-results').replaceChildren(...Array.from(topics.values(), topic => topicResult(topic, true)));
          if (!data.cursor || seen.has(data.cursor)) break;
          seen.add(data.cursor); cursor = data.cursor;
        }
      } catch (error) {
        levelMessage = error.message; $('connect-levels').hidden = false;
      }
    }
    $('followed-feedback').textContent = topics.size ? `已读取 ${topics.size} 个关注。${levelMessage || '等级为你在各超话的个人等级。'} 选择加入后请保存设置。` : '当前账号没有关注的超话。';
    enter($('followed-results').children, .018);
  } catch (error) { $('followed-feedback').textContent = `已读取 ${topics.size} 个超话。${error.message}`; throw error; }
}));
$('topic-search-form').addEventListener('submit', event => {
  event.preventDefault(); action(event.submitter, async () => {
    $('search-results').replaceChildren(); $('search-feedback').textContent = '正在搜索…';
    try {
      const data = await api('topics/search', { query: $('topic-query').value.trim() });
      $('search-feedback').textContent = data.topics.length ? `找到 ${data.topics.length} 个超话，选择后保存设置。` : '未找到匹配超话，试试完整名称，或通过链接添加。';
      for (const topic of data.topics) $('search-results').append(topicResult(topic));
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
    const data = await api('cookie', { cookie }); toast(data.message); clearQR('账号已连接'); loginExpanded = false; qrMobile = false; profileAttemptAt = 0; await refresh();
  });
});
async function startQR(mobile = false) {
  qrMobile = mobile;
  loginExpanded = true; loginPanel(true, true);
  $('login-purpose').textContent = mobile ? '连接个人等级 · 手机网页' : '重新连接微博账号';
  clearTimeout(qrTimer); const data = await api('qr/create', { mobile });
  qrExpires = data.expires; $('qr-image').src = data.image;
  $('qr-image').hidden = false; $('qr-placeholder').hidden = true;
  $('qr-status').textContent = mobile ? '请用当前账号扫码，连接个人超话等级' : '请用微博 App 扫码并确认登录'; $('create-qr').textContent = mobile ? '刷新等级二维码' : '刷新登录二维码';
  qrTimer = setTimeout(pollQR, 3500);
}
$('create-qr').addEventListener('click', () => action($('create-qr'), () => startQR(qrMobile)));
$('connect-levels').addEventListener('click', () => action($('connect-levels'), async () => { await startQR(true); navigate('#account'); }));
$('qr-image').addEventListener('error', () => { clearQR('二维码图片加载失败，可使用 Cookie 备用登录'); });
for (const [id, path] of [['validate', 'validate'], ['run', 'run'], ['stop', 'stop']]) {
  $(id).addEventListener('click', () => action($(id), async () => {
    try { const data = await api(path, {}); if (id === 'validate') { profileAttemptAt = 0; state.profile = undefined; await api('profile', {}).catch(() => {}); } toast(data.message); }
    finally { await refresh(); }
  }));
}
$('disconnect').addEventListener('click', () => action($('disconnect'), async () => {
  if (!confirm('删除已保存的微博登录信息，并关闭自动签到？')) return;
  await api('logout', {}); clearQR('无需提供账号密码'); avatarKey = ''; qrMobile = false; loginExpanded = false;
  $('followed-results').replaceChildren(); $('followed-feedback').textContent = ''; $('connect-levels').hidden = true;
  $('search-results').replaceChildren(); $('search-feedback').textContent = '';
  await refresh(true); toast('微博账号已断开');
}));
$('refresh').addEventListener('click', () => action($('refresh'), () => refresh()));
for (const link of document.querySelectorAll('a[href^="#/"]')) link.addEventListener('click', event => {
  event.preventDefault(); navigate(link.hash);
});
window.addEventListener('hashchange', () => showPage());
showPage(false);
refresh(true).catch(error => { if (error.message !== '请使用管理密钥解锁控制台') toast(error.message, true); });
