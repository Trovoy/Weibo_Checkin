let platformRegistry = [], nsSnapshot, nsRecords = [], nsError = '', nsHistoryError = '', nsLoadedMonth = '', nsFormsReady = false;
let platformEpoch = 0, platformPending, nsHistoryPending, progressKey = '';
const nsAvailable = () => platformRegistry.some(p => p.id === 'nodeseek' && p.available);
const nsHealthLabels = { valid: '有效', invalid: '已失效', unknown: '待确认', unchecked: '待检测', stale: '需复检', missing: '未配置' };
function resetPlatforms() {
  platformEpoch++; platformPending = undefined; nsHistoryPending = undefined;
  platformRegistry = []; nsSnapshot = undefined; nsRecords = []; nsError = ''; nsHistoryError = ''; nsLoadedMonth = ''; nsFormsReady = false;
  progressKey = ''; if (motion) motion.killTweensOf($('progress-ring'));
  $('progress-ring').setAttribute('stroke-dashoffset', '100');
  if (typeof resetOverview === 'function') resetOverview();
  if (typeof resetHuya === 'function') resetHuya();
  for (const id of ['ns-cookie', 'ns-ua']) $(id).value = '';
  for (const id of ['platform-list', 'history-body', 'ns-history-body']) $(id).replaceChildren();
}
function chosenMonth() {
  const month = $('history-month').value || state?.today.slice(0, 7) || new Date().toISOString().slice(0, 7);
  $('history-month').value = month; $('ns-history-month').value = month; return month;
}
function renderPlatformCards() {
  renderOverviewProgress();
  if (typeof renderRecentStats === 'function') renderRecentStats();
  $('platform-list').replaceChildren(); $('platform-count').textContent = platformRegistry.length ? `${platformRegistry.filter(p => p.available).length} 个服务已接入` : nsError ? '平台状态待确认' : '正在读取';
  for (const platform of platformRegistry) {
    const card = node('section', undefined, 'card platform-card'), heading = node('div', undefined, 'section-heading');
    heading.append(node('h3', platform.name), node('span', platform.available ? '已接入' : '未连接', 'badge neutral')); card.append(heading);
    let status = '未连接服务', detail = platform.description;
    if (platform.id === 'weibo') {
      const done = state.topics.filter(t => state.completedToday.includes(t.id)).length;
      status = `${done} / ${state.topics.length} 超话`; detail = `${labels[state.login]} · ${state.enabled ? '08:00–12:00 随机首签' : '自动签到已关闭'}`;
    } else if (platform.id === 'nodeseek' && platform.available) {
      status = nsError ? '暂时无法读取' : !nsSnapshot ? '读取中…' : nsSnapshot.record?.ok ? '今日已签到' : nsSnapshot.record ? '今日未完成' : '等待签到';
      detail = nsError || (nsSnapshot?.record?.ok ? `今日鸡腿 ${nsSnapshot.record.gain ?? '未提供'} · ${nsHealthLabels[nsSnapshot.config.cookieHealth.status] || '待确认'}` : '上午随机首签 · 未完成随机补查');
    } else if (platform.id === 'huya' && platform.available && typeof hySnapshot !== 'undefined') {
      status = hyError ? '状态待确认' : hySnapshot?.record?.code === 'SUCCESS' ? '今日已赠送' : hySnapshot?.paused ? '已暂停 · 待核对' : hySnapshot?.configured ? '等待赠送' : '未连接账号';
      detail = hyError || (hySnapshot?.room ? `${hySnapshot.room.name} · ${hySnapshot.room.id} · ${hySnapshot.record?.code === 'SUCCESS' ? hySnapshot.record.count + ' 个免费虎粮' : '免费背包虎粮'}` : platform.description);
    }
    card.append(node('p', status, 'platform-status'), node('p', detail, 'fine'));
    const link = node('a', '管理 ' + platform.name, 'inline-link'); link.append(icon('arrow-right')); link.href = '#/' + platform.page; card.append(link); $('platform-list').append(card);
  }
}
function renderOverviewProgress() {
  if (!state) return;
  let total = state.topics.length, done = state.topics.filter(t => state.completedToday.includes(t.id)).length;
  let pending = !platformRegistry.length;
  for (const platform of platformRegistry) {
    if (!platform.available || platform.id === 'weibo') continue;
    if (platform.id === 'huya') {
      if (typeof hySnapshot === 'undefined' || !hySnapshot || hyError || hySnapshot.date !== state.today) { pending = true; continue; }
      if (hySnapshot.configured || hySnapshot.record) { total++; if (hySnapshot.record?.code === 'SUCCESS') done++; }
      continue;
    }
    if (platform.id !== 'nodeseek' || nsError || !nsSnapshot || nsSnapshot.date !== state.today) { pending = true; continue; }
    if (nsSnapshot.config.configured || nsSnapshot.record) {
      total++;
      if (nsSnapshot.record?.ok && nsSnapshot.record.date === state.today) done++;
    }
  }
  const percent = total ? Math.round(done / total * 100) : 0;
  const complete = !pending && total > 0 && done === total;
  $('progress-percent').textContent = pending || !total ? '—' : `${percent}%`;
  $('progress-badge').textContent = pending ? '待确认' : !total ? '待配置' : complete ? '全部完成' : `还有 ${total - done} 项`;
  $('progress-badge').className = 'badge' + (complete ? '' : ' neutral');
  $('progress-count').textContent = pending ? `已确认 ${done} / ${total} 项` : total ? `${done} / ${total} 项已完成` : '添加签到项目后查看进度';
  $('progress-note').textContent = pending ? '部分平台状态尚未确认，暂不计算总完成率。' : '微博每个超话计 1 项；NodeSeek 签到、虎牙成功赠送各计 1 项。';
  $('progress-chart').setAttribute('aria-label', pending ? `已确认完成 ${done} 项，部分平台状态待确认` : total ? `今日共 ${total} 项签到，已完成 ${done} 项，完成率 ${percent}%` : '尚未配置签到项目');
  const key = `${state.today}:${pending}:${done}:${total}`;
  if (key === progressKey) return;
  progressKey = key;
  const offset = pending || !total ? 100 : 100 - done / total * 100;
  if (motion) motion.killTweensOf($('progress-ring'));
  if (!motion || reduceMotion.matches || $('overview').hidden || $('stats-today').hidden) $('progress-ring').setAttribute('stroke-dashoffset', String(offset));
  else motion.to($('progress-ring'), { attr: { 'stroke-dashoffset': offset }, duration: .75, ease: 'power2.out' });
}
function renderNodeSeek() {
  const ready = nsAvailable() && !!nsSnapshot && !nsError, config = nsSnapshot?.config, entry = nsSnapshot?.record;
  $('ns-connection').textContent = nsError ? '连接异常' : nsAvailable() ? '服务已连接' : '未连接服务';
  $('ns-feedback').textContent = nsError || (!nsAvailable() ? '尚未连接 NodeSeek 服务，请按部署教程配置连接器。' : !nsSnapshot ? '正在读取签到服务…' : entry?.message || '今日尚无签到记录。');
  $('ns-today').textContent = !ready ? '—' : entry?.ok ? '已完成' : entry ? '未完成' : '待签到';
  $('ns-gain').textContent = !ready || !entry?.ok ? '—' : entry.gain === null ? '未提供' : String(entry.gain);
  $('ns-health').textContent = ready ? nsHealthLabels[config.cookieHealth.status] || '待确认' : '—';
  $('ns-health-time').textContent = ready && config.cookieHealth.checkedAt ? '上次检测 ' + time(config.cookieHealth.checkedAt) : '尚无有效检测记录';
  $('ns-run').textContent = entry?.ok ? '今日已签到' : '立即签到';
  syncPlatformControls();
  if (config) {
    const plan = config.schedule;
    $('ns-next').textContent = !config.enabled ? '自动签到已关闭。开启并保存后，将按所选时段执行。' : plan.paused ? '已暂停自动补查，请处理登录、验证或存储问题后手动执行。' : plan.nextAt ? `下次计划 ${time(plan.nextAt)}；临时失败后每 45–75 分钟补查，成功后当天停止。` : '暂无下次执行时间，请检查服务的调度配置。';
    const syncText = config.browserPaired ? config.browserProtocol === 5 ? `浏览器已连接${config.syncedAt ? '，最近同步 ' + time(config.syncedAt) : ''}。Cookie 变化时将自动同步。` : '旧版扩展配对已迁入。请更新扩展并连接新面板，云端已保存的 Cookie 可继续使用。' : '尚未配对；在“扩展同步”页面连接浏览器，也可手动更新 Cookie。';
    $('ns-sync').textContent = syncText; $('ns-pair-copy').textContent = syncText;
    $('ns-pair-state').textContent = config.browserPaired ? config.browserProtocol === 5 ? '已连接' : '需更新扩展' : '尚未配对';
    if (!nsFormsReady) { $('ns-start').value = plan.start || ''; $('ns-end').value = plan.end || ''; $('ns-random').value = String(config.random); $('ns-enabled').checked = config.enabled; nsFormsReady = true; }
  }
  renderNSRecords();
}
function syncPlatformControls() {
  const ready = nsAvailable() && !!nsSnapshot && !nsError;
  for (const id of ['ns-run', 'ns-check', 'ns-schedule-save', 'ns-config-save', 'ns-reconcile', 'ns-pair-approve', 'ns-pair-revoke']) $(id).disabled = !ready || busy.has(id) || (id === 'ns-run' && (nsSnapshot?.record?.ok || !nsSnapshot?.config.configured));
}
function renderNSRecords() {
  const loaded = nsLoadedMonth === chosenMonth(), records = loaded ? nsRecords : [];
  $('ns-history-body').replaceChildren(); $('ns-history-empty').hidden = records.length > 0;
  $('ns-history-empty').textContent = nsHistoryError || (!nsAvailable() ? '连接 NodeSeek 服务后可查看记录。' : loaded ? '这个月份还没有记录。' : '正在读取记录…');
  for (const entry of records) {
    const tr = node('tr'); tr.append(node('td', entry.date), node('td', entry.ok ? '已签到' : '未完成'), node('td', entry.gain === null ? '未知' : String(entry.gain)),
      node('td', entry.ledgerAt || entry.claimedAt ? time(entry.ledgerAt || entry.claimedAt) : '未提供')); $('ns-history-body').append(tr);
  }
  const complete = records.filter(r => r.ok), gains = complete.filter(r => r.gain !== null);
  $('ns-history-summary').textContent = nsHistoryError ? `${chosenMonth()} · ${nsHistoryError}${loaded ? '（显示上次读取的记录）' : ''}` :
    !loaded ? '记录尚未读取完成。' : `${chosenMonth()} · ${complete.length} 天已签到 · 已知鸡腿 ${gains.reduce((n, r) => n + r.gain, 0)}${complete.length > gains.length ? '（部分收益未知）' : ''}`;
}
function renderPlatformHistory() {
  if (!state) return;
  const month = chosenMonth(), filter = $('history-platform').value, rows = [];
  if (['all', 'weibo'].includes(filter)) for (const entry of state.history) {
    if (new Date(Date.parse(entry.at) + 8 * 3600000).toISOString().slice(0, 7) !== month) continue;
    rows.push({ platform: '微博 / ' + entry.topic.name, at: entry.at, label: time(entry.at), ok: entry.result !== 'failed',
      result: { success: '签到成功', already: '今日已签', failed: '未完成' }[entry.result], message: entry.message });
  }
  if (['all', 'nodeseek'].includes(filter) && nsLoadedMonth === month) for (const entry of nsRecords) {
    const at = entry.ledgerAt || entry.claimedAt || entry.checkedAt;
    rows.push({ platform: 'NodeSeek', at: at || entry.date, label: at ? time(at) : entry.date, ok: entry.ok,
      result: entry.ok ? '已签到' : '未完成', message: `${entry.message}${entry.ok ? ' · 鸡腿 ' + (entry.gain ?? '未知') : ''}` });
  }
  if (['all', 'huya'].includes(filter) && typeof hySnapshot !== 'undefined') for (const entry of hySnapshot?.history || []) {
    if (entry.day.slice(0, 7) !== month) continue;
    rows.push({ platform: '虎牙 / ' + entry.room.name, at: entry.at, label: time(entry.at), ok: entry.code === 'SUCCESS', result: hyLabels[entry.code], message: entry.message + (entry.code === 'SUCCESS' ? ` · ${entry.count} 个` : '') });
  }
  rows.sort((a, b) => b.at.localeCompare(a.at)); $('history-body').replaceChildren(); $('empty-history').hidden = rows.length > 0;
  for (const entry of rows) {
    const tr = node('tr'), result = node('td'); result.append(node('span', entry.result, 'badge ' + (entry.ok ? 'success' : 'failed')));
    tr.append(node('td', entry.platform), node('td', entry.label), result, node('td', entry.message)); $('history-body').append(tr);
  }
  $('history-feedback').textContent = [nsHistoryError && ['all', 'nodeseek'].includes(filter) ? 'NodeSeek：' + nsHistoryError : '', typeof hyError !== 'undefined' && hyError && ['all', 'huya'].includes(filter) ? '虎牙：' + hyError : ''].filter(Boolean).join('；');
}
async function loadPlatformHistory(force = false) {
  if (!nsAvailable()) { renderNodeSeek(); renderPlatformHistory(); return; }
  const month = chosenMonth(), epoch = platformEpoch;
  if (!force && nsLoadedMonth === month) { renderNSRecords(); renderPlatformHistory(); return; }
  if (nsHistoryPending?.month === month) return nsHistoryPending.promise;
  const pending = (async () => {
    try { const data = await api('platforms/nodeseek/history?month=' + month); if (epoch !== platformEpoch || chosenMonth() !== month) return;
      nsRecords = data.records; nsLoadedMonth = month; nsHistoryError = ''; }
    catch (error) { if (epoch !== platformEpoch || chosenMonth() !== month) return; nsHistoryError = error.message; }
    finally { if (nsHistoryPending?.promise === pending) nsHistoryPending = undefined; }
    if (epoch === platformEpoch) { renderNSRecords(); renderPlatformHistory(); }
  })(); nsHistoryPending = { month, promise: pending }; return pending;
}
async function refreshPlatforms(forceHistory = false) {
  if (platformPending) {
    const epoch = platformEpoch; await platformPending;
    if (forceHistory && epoch === platformEpoch) return refreshPlatforms(true);
    return;
  }
  const epoch = platformEpoch;
  const pending = (async () => {
    try {
      const list = await api('platforms'); if (epoch !== platformEpoch) return; platformRegistry = list.platforms; renderPlatformCards();
      if (nsAvailable()) { try { const data = await api('platforms/nodeseek/status'); if (epoch !== platformEpoch) return; nsSnapshot = data; nsError = ''; }
        catch (error) { if (epoch !== platformEpoch) return; nsError = error.message; } }
      else { nsSnapshot = undefined; nsRecords = []; nsLoadedMonth = ''; nsFormsReady = false; nsError = ''; nsHistoryError = ''; }
      if (typeof refreshHuya === 'function') await refreshHuya(epoch);
      if (epoch !== platformEpoch) return;
      renderPlatformCards(); renderNodeSeek(); renderPlatformHistory();
      if (typeof loadRecentStats === 'function' && !$('stats-recent').hidden) await loadRecentStats(true);
      if (['#/nodeseek', '#/history'].includes(location.hash)) await loadPlatformHistory(forceHistory);
    } catch (error) { if (epoch === platformEpoch) { nsError = error.message; renderPlatformCards(); renderNodeSeek(); } }
    finally { if (platformPending === pending) platformPending = undefined; }
  })(); platformPending = pending; return pending;
}
for (const id of ['history-month', 'ns-history-month']) $(id).addEventListener('change', () => {
  if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test($(id).value)) return;
  $('history-month').value = $(id).value; $('ns-history-month').value = $(id).value; renderPlatformHistory(); loadPlatformHistory().catch(() => {});
});
$('history-platform').addEventListener('change', renderPlatformHistory);
$('ns-refresh').addEventListener('click', () => action($('ns-refresh'), () => refreshPlatforms(true)));
for (const [id, operation] of [['ns-run', 'run'], ['ns-check', 'health'], ['ns-reconcile', 'reconcile']]) $(id).addEventListener('click', () => action($(id), async () => {
  try { const data = await api('platforms/nodeseek/' + operation, operation === 'reconcile' ? { month: chosenMonth() } : {}); toast(data.message); }
  finally { await refreshPlatforms(true); }
}));
$('ns-schedule-form').addEventListener('submit', event => {
  event.preventDefault(); action(event.submitter, async () => {
    const data = await api('platforms/nodeseek/schedule', { start: $('ns-start').value, end: $('ns-end').value }); nsFormsReady = false; toast(data.message); await refreshPlatforms();
  });
});
$('ns-config-form').addEventListener('submit', event => {
  event.preventDefault(); action(event.submitter, async () => {
    const body = { random: $('ns-random').value === 'true', enabled: $('ns-enabled').checked };
    if ($('ns-cookie').value.trim()) body.cookie = $('ns-cookie').value.trim();
    if ($('ns-ua').value.trim()) body.userAgent = $('ns-ua').value.trim();
    $('ns-cookie').value = ''; $('ns-ua').value = '';
    const data = await api('platforms/nodeseek/config', body); nsFormsReady = false; toast(data.message); await refreshPlatforms();
  });
});
$('refresh').addEventListener('click', () => refreshPlatforms(true).catch(() => {}));
let pendingExtensionPair;
const pairQuery = new URLSearchParams(location.search).get('pair');
if (pairQuery && /^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/.test(pairQuery)) {
  const [flow, challenge] = pairQuery.split('.'); pendingExtensionPair = { flow, challenge };
  history.replaceState(null, '', '/#/nodeseek-sync'); $('ns-pair-request').hidden = false; showPage();
}
$('ns-pair-cancel').addEventListener('click', () => { pendingExtensionPair = undefined; $('ns-pair-request').hidden = true; });
$('ns-pair-approve').addEventListener('click', () => action($('ns-pair-approve'), async () => {
  if (!pendingExtensionPair) return;
  await api('platforms/nodeseek/pairapprove', pendingExtensionPair);
  $('ns-pair-feedback').textContent = '已确认连接，返回扩展查看配对和同步结果。';
  pendingExtensionPair = undefined; $('ns-pair-request').hidden = true; await refreshPlatforms();
}));
$('ns-pair-revoke').addEventListener('click', () => action($('ns-pair-revoke'), async () => {
  await api('platforms/nodeseek/pairrevoke', {}); toast('扩展已断开，已保存的登录凭证仍保留。'); await refreshPlatforms();
}));
