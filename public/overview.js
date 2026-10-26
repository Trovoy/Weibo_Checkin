let recentDate = '', recentRecords = [], recentMonths = new Set(), recentErrors = false, recentPending, recentChartKey = '';
function recentSeries(daily, records) {
  const signed = new Set(records.filter(entry => entry.ok).map(entry => entry.date));
  return daily.map(day => ({ date: day.date, weibo: day.count, nodeseek: signed.has(day.date) ? 1 : 0 }));
}
function resetOverview() {
  recentDate = ''; recentRecords = []; recentMonths = new Set(); recentErrors = false; recentPending = undefined; recentChartKey = '';
  if (motion) motion.killTweensOf(document.querySelectorAll('.recent-stack'));
  $('recent-bars').replaceChildren(); $('recent-total').textContent = '—';
  setStatsView('today', false);
}
function setStatsView(view, animate = true) {
  for (const name of ['today', 'recent']) {
    const active = view === name, tab = $('stats-' + name + '-tab');
    tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1; $('stats-' + name).hidden = !active;
  }
  $('progress-badge').hidden = view !== 'today'; $('recent-badge').hidden = view !== 'recent';
  if (animate) enter($('stats-' + view));
  if (view === 'recent') { renderRecentStats(); loadRecentStats().catch(() => {}); }
}
for (const name of ['today', 'recent']) {
  $('stats-' + name + '-tab').addEventListener('click', () => setStatsView(name));
  $('stats-' + name + '-tab').addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); const next = event.key === 'Home' ? 'today' : event.key === 'End' ? 'recent' : name === 'today' ? 'recent' : 'today';
    setStatsView(next); $('stats-' + next + '-tab').focus();
  });
}
function renderRecentStats() {
  if (!state || $('stats-recent').hidden) return;
  const daily = state.recentCompletions || [], months = new Set(daily.map(day => day.date.slice(0, 7)));
  const loaded = recentDate === state.today;
  const pending = !platformRegistry.length || daily.length !== 7 || (nsAvailable() && (!loaded || !!recentPending));
  const partial = nsAvailable() && loaded && recentErrors;
  const series = recentSeries(daily, loaded ? recentRecords : []);
  const total = series.reduce((n, day) => n + day.weibo + day.nodeseek, 0);
  $('recent-total').textContent = daily.length === 7 ? String(total) : '—';
  $('recent-badge').textContent = pending ? '读取中' : partial ? '部分数据' : '含今天';
  $('recent-retry').hidden = !partial || pending;
  const range = daily.length ? `${daily[0].date.slice(5).replace('-', '/')}–${state.today.slice(5).replace('-', '/')}` : '';
  $('recent-note').textContent = pending ? '正在读取记录，当前数量仅含已确认项目。' : partial ? '部分 NodeSeek 记录未读到，显示已确认数量。' : `${range} · 每日同一项目只计一次。`;
  const key = JSON.stringify([series, pending, partial, [...months].map(month => recentMonths.has(month))]);
  if (key === recentChartKey) return;
  recentChartKey = key;
  if (motion) motion.killTweensOf(document.querySelectorAll('.recent-stack'));
  $('recent-bars').replaceChildren();
  const max = Math.max(1, ...series.map(day => day.weibo + day.nodeseek));
  for (const day of series) {
    const count = day.weibo + day.nodeseek, column = node('div', undefined, 'recent-column' + (day.date === state.today ? ' today' : '') + (!count ? ' is-empty' : ''));
    column.setAttribute('role', 'listitem');
    const unknown = pending || (partial && !recentMonths.has(day.date.slice(0, 7)));
    column.setAttribute('aria-label', `${day.date}，微博 ${day.weibo} 项，NodeSeek ${unknown ? '待确认' : day.nodeseek + ' 项'}，已确认共 ${count} 项`);
    column.title = column.getAttribute('aria-label');
    const track = node('div', undefined, 'recent-track'), stack = node('div', undefined, 'recent-stack');
    for (const [value, cls] of [[day.weibo, ''], [day.nodeseek, ' ns']]) {
      const segment = node('span', undefined, 'recent-segment' + cls); segment.style.height = `${value / max * 86}px`; stack.append(segment);
    }
    const value = node('span', String(count), 'recent-value'); value.style.bottom = `${count / max * 86 + 7}px`;
    track.append(stack, value); column.append(track, node('span', day.date === state.today ? '今天' : day.date.slice(8), 'recent-date'));
    $('recent-bars').append(column);
  }
  if (motion && !reduceMotion.matches && !$('overview').hidden) motion.fromTo(document.querySelectorAll('.recent-stack'), { scaleY: 0 }, { scaleY: 1, duration: .45, stagger: .035, ease: 'power2.out', clearProps: 'transform' });
}
async function loadRecentStats(force = false) {
  if (!state || !nsAvailable()) { renderRecentStats(); return; }
  const today = state.today, epoch = platformEpoch;
  if (recentPending?.date === today) return recentPending.promise;
  if (!force && recentDate === today && !recentErrors) return;
  const months = [...new Set((state.recentCompletions || []).map(day => day.date.slice(0, 7)))];
  if (!months.length) return;
  const pending = (async () => {
    const results = await Promise.allSettled(months.map(month => api('platforms/nodeseek/history?month=' + month)));
    if (epoch !== platformEpoch || state?.today !== today) return;
    recentRecords = []; recentMonths = new Set(); recentErrors = false;
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') { recentMonths.add(months[index]); recentRecords.push(...result.value.records); }
      else recentErrors = true;
    });
    recentDate = today;
  })();
  recentPending = { date: today, promise: pending }; renderRecentStats();
  try { await pending; }
  finally { if (recentPending?.promise === pending) recentPending = undefined; if (epoch === platformEpoch) renderRecentStats(); }
}
$('recent-retry').addEventListener('click', () => loadRecentStats(true).catch(() => {}));
