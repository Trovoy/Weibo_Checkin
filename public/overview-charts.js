const overviewView = (() => {
  const root = $('overview-insights'), ring = $('insight-ring'), plot = $('insight-plot'), range = $('insight-date');
  const platforms = $('insight-platforms'), selection = $('insight-selection'), details = $('insight-details');
  const NS = 'http://www.w3.org/2000/svg', ui = { platform: 'all', date: '', followToday: true };
  let width = 0, plotRefs, ringView, ringKey = '', plotKey = '', detailKey = '', data, chartTween, selectTween, cursorTo, dragging = false, initialized = false;
  const graph = { ys: [] }, cursor = { index: 6 }, ringMotions = new Set();
  const active = () => !!motion && !reduceMotion.matches && !$('overview').hidden && !$('dashboard').hidden;
  const svg = (tag, attrs = {}) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };
  const attr = (e, attrs) => { for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); };
  const text = (x, y, value, attrs = {}) => { const e = svg('text', { x, y, fill: 'var(--ins-muted)', 'font-size': 11, ...attrs }); e.textContent = value; return e; };
  const values = () => (data?.history.series || []).map(day => ui.platform === 'all' ? overviewPlatforms.reduce((n, p) => n + (day[p.id] ?? 0), 0) : day[ui.platform]);
  const dayLabel = date => date?.slice(5).replace('-', '/') || '—';
  function counter(element, places, suffix) {
    element.className = 'insight-counter';
    const proxy = { n: 0 }, columns = []; let tween, known = false;
    for (let k = places - 1; k >= 0; k--) {
      const cell = node('span', undefined, 'insight-digit'), strip = node('span', undefined, 'insight-strip'); cell.setAttribute('aria-hidden', 'true');
      for (let d = 0; d <= 10; d++) strip.append(node('span', String(d % 10), 'insight-glyph'));
      cell.append(strip); element.append(cell);
      motion?.set(strip, { force3D: true }); columns.push({ cell, strip, power: 10 ** k, setY: motion?.quickSetter(strip, 'yPercent') });
    }
    const empty = node('span', '—'); empty.setAttribute('aria-hidden', 'true'); element.append(empty);
    function paint() {
      const n = Math.max(0, proxy.n);
      for (const { cell, strip, power, setY } of columns) {
        const v = n / power, digit = Math.floor(v) % 10, fraction = v - Math.floor(v), roll = power === 1 ? fraction : Math.max(0, (fraction - .9) / .1);
        cell.style.width = (power === 1 ? 1 : Math.max(0, Math.min(1, n - power + 1))) * .60 + 'em';
        cell.style.opacity = power === 1 ? '1' : String(Math.max(0, Math.min(1, (n - power + .35) / .35)));
        if (setY) setY(-(digit + roll) * 100 / 11); else strip.style.transform = `translateY(${-(digit + roll) * 100 / 11}%)`;
      }
    }
    return { set(target, animate) {
      tween?.kill(); const wasKnown = known; known = target !== null;
      element.setAttribute('aria-label', known ? target + suffix : '待确认'); empty.hidden = known;
      columns.forEach(c => { c.cell.hidden = !known; });
      if (!known) return;
      if (active() && animate && wasKnown && proxy.n !== target) tween = motion.to(proxy, { n: target, duration: .85, ease: 'power2.inOut', onUpdate: paint });
      else { proxy.n = target; paint(); }
    }, stop() { tween?.kill(); } };
  }
  const percent = counter($('insight-percent'), 3, '%'), week = counter($('insight-total'), 5, '项');
  const buttons = overviewPlatforms.map(p => {
    const button = node('button', undefined, 'insight-platform'); button.type = 'button'; button.dataset.platform = p.id;
    button.style.setProperty('--ins-series', `var(--ins-${p.key})`); button.setAttribute('aria-pressed', 'false');
    const dot = node('i', undefined, 'insight-dot'), label = node('span', p.name), value = node('b'), status = node('span', undefined, 'insight-platform-status'), track = node('span', undefined, 'insight-mini');
    dot.setAttribute('aria-hidden', 'true'); track.setAttribute('aria-hidden', 'true'); button.append(dot, label, value, track, status); platforms.append(button);
    button.addEventListener('click', () => { ui.platform = ui.platform === p.id ? 'all' : p.id; render(true); });
    const detail = node('div'), detailLabel = node('label'), detailValue = node('b', '—'); detail.style.setProperty('--ins-series', `var(--ins-${p.key})`);
    detailLabel.append(dot.cloneNode(), document.createTextNode(p.name)); detail.append(detailLabel, detailValue); details.append(detail);
    return { button, value, status, track, detailValue, count: -1, fills: [] };
  });
  function arc(a, b) {
    const p = t => [110 + 94 * Math.cos(t * Math.PI / 180), 110 + 94 * Math.sin(t * Math.PI / 180)], start = p(a), end = p(b);
    return `M${start[0]},${start[1]}A94,94 0 ${b - a > 180 ? 1 : 0} 1 ${end[0]},${end[1]}`;
  }
  function paintPiece(piece) { attr(piece.path, { 'stroke-dashoffset': piece.length * (1 - piece.p), opacity: piece.p > .001 ? 1 : 0 }); }
  function drawRing(summary, animate) {
    const key = JSON.stringify(summary.items.map(p => [p.id, p.total, p.unknown]));
    const pieces = summary.items.flatMap(p => Array.from({ length: p.total || (p.unknown ? 1 : 0) }, (_, i) => ({ platform: p, done: !p.unknown && i < p.done })));
    if (key !== ringKey || !ringView) {
      const old = ringView, group = svg('g'); ringView = { group, pieces: [] }; ringKey = key;
      if (!pieces.length) group.append(svg('circle', { cx: 110, cy: 110, r: 94, fill: 'none', stroke: 'var(--ins-track)', 'stroke-width': 8 }));
      pieces.forEach((piece, i) => {
        const gap = Math.min(3.5, 90 / pieces.length), a = -90 + i * 360 / pieces.length + gap, b = -90 + (i + 1) * 360 / pieces.length - gap;
        const length = (b - a) * Math.PI / 180 * 94, path = svg('path', { d: arc(a, b), fill: 'none', stroke: `var(--ins-${piece.platform.key})`, 'stroke-width': 8, 'stroke-linecap': 'round', 'stroke-dasharray': length });
        group.append(svg('path', { d: arc(a, b), fill: 'none', stroke: 'var(--ins-track)', 'stroke-width': 8, 'stroke-linecap': 'round' }), path);
        const value = { path, length, p: piece.done ? 1 : 0 }; paintPiece(value); ringView.pieces.push(value);
      });
      ring.append(group);
      if (old) {
        old.pieces.forEach(p => motion?.killTweensOf(p)); motion?.killTweensOf(old.group);
        if (animate && active()) {
          const outgoing = motion.to(old.group, { opacity: 0, rotation: -5, scale: .985, svgOrigin: '110 110', duration: .24, onComplete: () => { old.group.remove(); ringMotions.delete(outgoing); } }); ringMotions.add(outgoing);
          motion.fromTo(group, { opacity: 0, rotation: 5, scale: .985, svgOrigin: '110 110' }, { opacity: 1, rotation: 0, scale: 1, duration: .6, ease: 'power3.out' });
        } else old.group.remove();
      }
    } else {
      let order = 0;
      ringView.pieces.forEach((piece, i) => {
        const target = pieces[i].done ? 1 : 0; motion?.killTweensOf(piece);
        if (animate && active() && Math.abs(piece.p - target) > .001) motion.to(piece, { p: target, delay: order++ * .035, duration: .58, ease: 'power2.inOut', onUpdate: () => paintPiece(piece) });
        else { piece.p = target; paintPiece(piece); }
      });
    }
  }
  function moveSelection(animate) {
    selectTween?.kill(); const button = buttons.find(p => p.button.dataset.platform === ui.platform)?.button;
    if (!button) { if (animate && active()) selectTween = motion.to(selection, { opacity: 0, duration: .18 }); else selection.style.opacity = '0'; return; }
    const rect = button.getBoundingClientRect(), parent = platforms.getBoundingClientRect(), vars = { x: rect.left - parent.left, y: rect.top - parent.top, width: rect.width, height: rect.height, opacity: 1 };
    if (animate && active()) selectTween = motion.to(selection, { ...vars, duration: .36, ease: 'power3.out', overwrite: true });
    else if (motion) motion.set(selection, vars);
    else Object.assign(selection.style, { transform: `translate(${vars.x}px,${vars.y}px)`, width: vars.width + 'px', height: vars.height + 'px', opacity: '1' });
  }
  function updatePlatforms(items, animate) {
    items.forEach((p, i) => {
      const view = buttons[i]; view.button.setAttribute('aria-pressed', String(p.id === ui.platform));
      view.value.replaceChildren(node('strong', p.unknown || !p.total ? '—' : String(p.done)));
      if (p.total && !p.unknown) view.value.append(document.createTextNode(' / ' + p.total));
      view.status.textContent = p.unknown ? '状态待确认' : !p.available ? '未连接服务' : !p.total ? '尚未配置' : p.done === p.total ? '已完成' : !p.done ? '等待执行' : `还差 ${p.total - p.done} 项`;
      view.button.setAttribute('aria-label', `${p.name}，${view.status.textContent}${p.total ? `，完成 ${p.done}/${p.total} 项` : ''}，点击筛选统计`);
      const count = p.total || 1;
      if (view.count !== count) { view.fills.forEach(fill => motion?.killTweensOf(fill)); view.track.replaceChildren(); view.fills = []; view.count = count; view.track.style.gridTemplateColumns = `repeat(${count},minmax(0,1fr))`; for (let j = 0; j < count; j++) { const cell = node('em'), fill = node('i'); cell.append(fill); view.track.append(cell); view.fills.push(fill); } }
      view.fills.forEach((fill, j) => {
        const scaleX = !p.unknown && j < p.done ? 1 : 0, moving = animate && active();
        if (moving && fill.dataset.value === String(scaleX)) return;
        fill.dataset.value = String(scaleX);
        if (moving) motion.to(fill, { scaleX, duration: .55, delay: j * .018, ease: 'power3.out', overwrite: true });
        else if (motion) { motion.killTweensOf(fill); motion.set(fill, { scaleX }); }
        else fill.style.transform = `scaleX(${scaleX})`;
      });
    });
    moveSelection(animate);
  }
  const pointX = index => 32 + (width - 46) * index / 6;
  function buildPlot() {
    const next = Math.round(plot.getBoundingClientRect().width); if (!next || (next === width && plotRefs)) return false;
    width = next; plot.setAttribute('viewBox', `0 0 ${width} 252`); plot.replaceChildren();
    const defs = svg('defs'), gradient = svg('linearGradient', { id: 'insight-area-gradient', x1: 0, y1: 0, x2: 0, y2: 1 });
    gradient.append(svg('stop', { offset: '0%', 'stop-color': 'var(--ins-main)', 'stop-opacity': .19 }), svg('stop', { offset: '100%', 'stop-color': 'var(--ins-main)', 'stop-opacity': .015 })); defs.append(gradient); plot.append(defs, text(0, 14, '项'));
    const grids = [], ticks = [], points = [], dates = [];
    for (let i = 0; i < 4; i++) { const line = svg('line', { x1: 32, x2: width - 14, stroke: 'var(--ins-line)', 'stroke-width': 1 }), label = text(23, 0, '', { 'text-anchor': 'end' }); grids.push(line); ticks.push(label); plot.append(line, label); }
    const area = svg('path', { fill: 'url(#insight-area-gradient)' }), guide = svg('line', { y1: 26, y2: 212, stroke: 'var(--ins-main)', 'stroke-opacity': .18 }), line = svg('path', { fill: 'none', stroke: 'var(--ins-main)', 'stroke-width': 2.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }); plot.append(area, guide, line);
    for (let i = 0; i < 7; i++) {
      const point = svg('circle', { r: 3, fill: 'var(--ins-bg)', stroke: 'var(--ins-main)', 'stroke-width': 1.5 }); points.push(point); plot.append(point);
      const label = width > 340 || i % 2 === 0 ? text(pointX(i), 240, '', { 'text-anchor': i === 0 ? 'start' : i === 6 ? 'end' : 'middle' }) : null; dates.push(label); if (label) plot.append(label);
    }
    const halo = svg('circle', { r: 12, fill: 'var(--ins-main)', 'fill-opacity': .09 }), focus = svg('circle', { r: 5, fill: 'var(--ins-bg)', stroke: 'var(--ins-main)', 'stroke-width': 2.5 }); plot.append(halo, focus);
    plotRefs = { area, guide, line, halo, focus, grids, ticks, points, dates }; return true;
  }
  function followCursor() {
    if (!plotRefs || graph.ys.length !== 7) return;
    const i = Math.max(0, Math.min(6, cursor.index)), left = Math.min(5, Math.floor(i)), t = i - left, a = graph.ys[left], b = graph.ys[left + 1];
    const atPoint = Math.abs(i - Math.round(i)) < .0001, known = atPoint ? graph.ys[Math.round(i)] !== null : a !== null && b !== null;
    const y = known ? atPoint ? graph.ys[Math.round(i)] : a + (b - a) * t * t * (3 - 2 * t) : null, x = pointX(i);
    attr(plotRefs.guide, { x1: x, x2: x, visibility: known ? 'visible' : 'hidden' });
    for (const mark of [plotRefs.halo, plotRefs.focus]) attr(mark, { cx: x, cy: y ?? 212, visibility: known ? 'visible' : 'hidden' });
  }
  function paintPlot() {
    if (!plotRefs || graph.ys.length !== 7) return;
    let line = '', area = '', start = -1, previous = -1;
    for (let i = 0; i <= 7; i++) {
      const y = graph.ys[i];
      if (i === 7 || y === null) { if (start >= 0) area += `L${pointX(previous)},212L${pointX(start)},212Z`; start = -1; previous = -1; if (i === 7) break; continue; }
      if (start < 0) { start = i; const move = `M${pointX(i)},${y}`; line += move; area += move; }
      else { const ax = pointX(previous), bx = pointX(i), dx = (bx - ax) / 3, segment = `C${ax + dx},${graph.ys[previous]} ${bx - dx},${y} ${bx},${y}`; line += segment; area += segment; }
      previous = i;
    }
    attr(plotRefs.line, { d: line }); attr(plotRefs.area, { d: area });
    graph.ys.forEach((y, i) => attr(plotRefs.points[i], { cx: pointX(i), cy: y ?? 212, visibility: y === null ? 'hidden' : 'visible' })); followCursor();
  }
  function updatePlot(animate) {
    const resized = buildPlot(); if (!plotRefs) return;
    const series = values(), maxValue = Math.max(0, ...series.filter(v => v !== null)), max = maxValue <= 1 ? 1 : maxValue <= 3 ? 3 : Math.ceil(maxValue / 3) * 3;
    const ticks = max === 1 ? [0, 1] : [0, max / 3, max * 2 / 3, max];
    plotRefs.grids.forEach((line, i) => { const value = ticks[i], label = plotRefs.ticks[i]; line.style.display = label.style.display = value === undefined ? 'none' : ''; if (value !== undefined) { const y = 212 - 175 * value / max; attr(line, { y1: y, y2: y }); attr(label, { y: y + 4 }); label.textContent = value; } });
    plotRefs.dates.forEach((label, i) => { if (label) label.textContent = data.history.series[i]?.date === state.today ? '今天' : dayLabel(data.history.series[i]?.date); });
    const target = series.length === 7 ? series.map(n => n === null ? null : 212 - 175 * n / max) : Array(7).fill(null), key = JSON.stringify([ui.platform, target, data.history.series.map(d => d.date)]);
    if (key === plotKey && !resized) return; plotKey = key; chartTween?.kill();
    if (!resized && animate && active() && !target.includes(null) && graph.ys.length === 7 && !graph.ys.includes(null)) chartTween = motion.to(graph.ys, { endArray: target, duration: .9, ease: 'power2.inOut', onUpdate: paintPlot });
    else { graph.ys = target; paintPlot(); }
    const summary = data.history.series.map((d, i) => `${dayLabel(d.date)} ${series[i] === null ? '待确认' : series[i] + '项'}`).join('，');
    plot.setAttribute('aria-label', (ui.platform === 'all' ? '全部平台' : overviewPlatforms.find(p => p.id === ui.platform).name) + '近七天：' + summary);
    $('insight-history-summary').textContent = summary;
  }
  function selectedIndex() { const i = data.history.series.findIndex(d => d.date === ui.date); return i < 0 ? 6 : i; }
  function updateDetails() {
    const index = selectedIndex(), day = data.history.series[index], value = values()[index], key = JSON.stringify([day, ui.platform, data.history.pending, data.history.partial]); if (key === detailKey) return; detailKey = key;
    range.disabled = !day; range.value = String(index);
    $('insight-date-label').textContent = day ? (day.date === state.today ? '今天 · ' : '') + dayLabel(day.date) : '记录读取中';
    const total = $('insight-day-total'); total.replaceChildren();
    if (value === undefined || value === null) total.textContent = '待确认';
    else total.append(node('b', String(value)), document.createTextNode(' 项' + (data.history.pending || data.history.partial ? '已确认' : '完成')));
    range.setAttribute('aria-valuetext', day ? `${day.date}，${value === null ? '待确认' : value + ' 项'}` : '记录读取中');
    buttons.forEach((view, i) => { const p = overviewPlatforms[i], number = day?.[p.id]; view.detailValue.textContent = number == null ? (platformRegistry.some(x => x.id === p.id && x.available) || p.id === 'weibo' ? '待确认' : '未接入') : number + ' 项'; });
  }
  function seek(index, animate = true) {
    const target = Math.max(0, Math.min(6, index));
    if (animate && active()) { if (!cursorTo) cursorTo = motion.quickTo(cursor, 'index', { duration: .24, ease: 'power3.out', onUpdate: followCursor }); cursorTo(target); }
    else { cursorTo?.tween.pause(); cursor.index = target; followCursor(); }
  }
  function render(animate = initialized) {
    if (!state) return;
    data = { today: overviewToday(state, platformRegistry, nsSnapshot, nsError, typeof hySnapshot === 'undefined' ? undefined : hySnapshot, typeof hyError === 'undefined' ? '' : hyError), history: getOverviewHistory() };
    const summary = overviewSummary(data.today, ui.platform), vals = values(), known = vals.filter(v => v !== null), count = known.reduce((a, b) => a + b, 0), platform = overviewPlatforms.find(p => p.id === ui.platform);
    const accent = getComputedStyle(root).getPropertyValue('--ins-' + (platform?.key || 'wb')).trim();
    if (animate && active()) motion.to(root, { '--ins-main': accent, duration: .4, ease: 'power2.out', overwrite: 'auto' }); else root.style.setProperty('--ins-main', accent);
    percent.set(summary.percent, animate); $('insight-percent-unit').hidden = summary.percent === null;
    $('insight-today-heading').textContent = platform ? platform.name + ' · 今日' : '今日进度';
    $('insight-count').textContent = summary.unknown ? `已确认完成 ${summary.done} 项` : summary.total ? `${summary.done} / ${summary.total} 项已完成` : '尚未配置签到项目';
    $('insight-remaining').textContent = summary.unknown ? '部分状态待确认' : !summary.total ? '连接平台后查看进度' : summary.done === summary.total ? '今日目标已达成' : `还有 ${summary.total - summary.done} 项待完成`;
    ring.setAttribute('aria-label', `${platform?.name || '全部平台'}今日${summary.unknown ? '部分状态待确认，已确认完成' + summary.done + '项' : !summary.total ? '尚未配置签到项目' : '完成' + summary.done + '/' + summary.total + '项'}`);
    week.set(vals.length === 7 && known.length ? count : null, animate);
    $('insight-week-heading').textContent = platform ? platform.name + ' · 近 7 天' : '近 7 天完成';
    $('insight-average').textContent = data.history.pending || data.history.partial ? '当前仅统计已确认记录' : !known.length ? '暂无可读取记录' : `平均每天 ${(count / known.length).toFixed(1)} 项`;
    $('insight-all').setAttribute('aria-pressed', String(ui.platform === 'all'));
    const days = data.history.series; if (ui.followToday || !days.some(d => d.date === ui.date)) ui.date = days.at(-1)?.date || '';
    $('insight-period').textContent = days.length ? `${dayLabel(days[0].date)}—${dayLabel(days.at(-1).date)} · UTC+8` : '最近 7 天 · UTC+8';
    $('insight-status').textContent = data.history.pending ? '记录读取中 · 显示已确认数量' : data.history.partial ? '部分记录未读到 · 显示已确认数量' : '同一项目每日计一次 · 虎牙计成功赠送';
    $('recent-retry').hidden = !data.history.partial || data.history.pending;
    drawRing(summary, animate); updatePlatforms(data.today, animate); updatePlot(animate); updateDetails(); seek(selectedIndex(), animate); initialized = true;
  }
  function reset() {
    chartTween?.kill(); selectTween?.kill(); cursorTo?.tween.kill(); cursorTo = null; percent.stop(); week.stop();
    ringMotions.forEach(t => t.kill()); ringMotions.clear();
    if (motion) { ringView?.pieces.forEach(p => motion.killTweensOf(p)); motion.killTweensOf([root, ...ring.children, ...buttons.flatMap(b => b.fills)]); }
    ring.replaceChildren(); plot.replaceChildren(); ringView = undefined; plotRefs = undefined; graph.ys = []; width = 0; ringKey = plotKey = detailKey = ''; initialized = false; data = undefined;
    ui.platform = 'all'; ui.date = ''; ui.followToday = true; percent.set(null, false); week.set(null, false); selection.style.opacity = '0';
    buttons.forEach(view => { view.value.textContent = '—'; view.status.textContent = ''; view.track.replaceChildren(); view.fills = []; view.count = -1; view.detailValue.textContent = '—'; view.button.setAttribute('aria-pressed', 'false'); });
    $('insight-count').textContent = '正在读取各平台状态'; $('insight-remaining').textContent = '稍候片刻'; $('insight-day-total').textContent = '—'; $('insight-date-label').textContent = '今天'; $('insight-average').textContent = '读取历史记录中'; $('insight-history-summary').textContent = ''; $('insight-period').textContent = '最近 7 天 · UTC+8'; $('insight-status').textContent = '正在读取记录'; range.disabled = true; $('recent-retry').hidden = true;
    ring.setAttribute('aria-label', '正在读取今日进度'); plot.setAttribute('aria-label', '正在读取近七天记录'); $('insight-all').setAttribute('aria-pressed', 'true');
  }
  function settle() {
    chartTween?.kill(); ringMotions.forEach(t => t.kill()); ringMotions.clear();
    for (const group of [...ring.children]) {
      motion?.killTweensOf(group);
      if (group !== ringView?.group) group.remove();
      else motion?.set(group, { opacity: 1, rotation: 0, scale: 1, svgOrigin: '110 110' });
    }
    plotKey = ''; if (state) render(false);
  }
  $('insight-all').addEventListener('click', () => { ui.platform = 'all'; render(true); });
  range.addEventListener('input', () => { if (!data) return; const i = Number(range.value); ui.date = data.history.series[i]?.date || ''; ui.followToday = i === 6; updateDetails(); seek(i); });
  function scrub(event) {
    if (!data || !width || data.history.series.length !== 7) return;
    const rect = plot.getBoundingClientRect(), index = Math.max(0, Math.min(6, ((event.clientX - rect.left) / rect.width * width - 32) / (width - 46) * 6));
    const i = Math.round(index); ui.date = data.history.series[i].date; ui.followToday = i === 6; updateDetails(); seek(index);
  }
  plot.addEventListener('pointerdown', event => { dragging = true; plot.setPointerCapture(event.pointerId); scrub(event); });
  plot.addEventListener('pointermove', event => { if (dragging || event.pointerType === 'mouse') scrub(event); });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) plot.addEventListener(type, () => { dragging = false; if (data) seek(selectedIndex()); });
  plot.addEventListener('pointerleave', () => { if (!dragging && data) seek(selectedIndex()); });
  new ResizeObserver(() => { if (data) { updatePlot(false); moveSelection(false); } }).observe(root);
  reduceMotion.addEventListener('change', settle);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) settle(); });
  $('recent-retry').addEventListener('click', () => action($('recent-retry'), async () => { await Promise.allSettled([refreshHuya().then(renderRecentStats), loadRecentStats(true)]); }));
  percent.set(null, false); week.set(null, false);
  return { render, reset };
})();
