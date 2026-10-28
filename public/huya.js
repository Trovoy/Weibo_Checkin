let hySnapshot, hyError = '', hyFormsReady = false, hyRefreshPending, hyReading = false;
let hyQRTimer, hyQRExpires = 0;
const hyLabels = { SUCCESS: '已赠送', EMPTY: '无可用虎粮', ERROR: '检测失败', REJECTED: '赠送被拒绝', REVIEW: '待核对' };
function resetHuya() {
  hySnapshot = undefined; hyError = ''; hyFormsReady = false; hyRefreshPending = undefined; hyReading = false;
  stopHuyaQR();
  $('hy-cookie').value = ''; $('hy-room').value = ''; $('hy-confirmed').checked = false; $('hy-history').replaceChildren();
}
function renderHuya() {
  const s = hySnapshot, ready = !!s?.configured && !hyError;
  const replenished = ready && s.inventory?.count > 0 && s.record?.code === 'EMPTY';
  $('hy-state').textContent = hyError ? '读取失败' : s?.paused ? '已暂停 · 待核对' : replenished ? '有虎粮待赠送' : s?.record ? hyLabels[s.record.code] : ready ? '已配置' : '未连接';
  $('hy-state').className = 'badge ' + (hyError ? 'failed' : s?.paused ? 'warning' : s?.record?.code === 'SUCCESS' ? 'success' : ['ERROR', 'REJECTED'].includes(s?.record?.code) ? 'failed' : 'neutral');
  $('hy-count').textContent = hyReading ? '检测中…' : hyError ? '—' : s?.inventory ? `${s.inventory.count} 个` : '—';
  $('hy-checked').textContent = hyError ? '本次检测失败，请重新检测；未将失败结果计为 0' : s?.inventory ? '库存快照 · ' + time(s.inventory.checkedAt) : '点击检测背包读取当前数量';
  $('hy-room-label').textContent = s?.room ? `${s.room.name} · ${s.room.id}` : '未设置';
  $('hy-schedule-label').textContent = s?.enabled ? s.schedule?.nextAt ? `下次 ${time(s.schedule.nextAt)} · 08:00–12:00 随机首送` : '自动执行已暂停，请核对账号与结果' : '自动赠送未开启';
  const entry = s?.record;
  $('hy-result').textContent = hyError || (entry ? `上次任务（${time(entry.at)}）：${hyLabels[entry.code]}${entry.code === 'SUCCESS' ? ` ${entry.count} 个免费虎粮` : ''} · ${s.history.find(x => x.at === entry.at)?.message || ''}${replenished ? '。当前已检测到虎粮，可等待补查或手动赠送。' : ''}` : '尚未执行。请先检测背包并核对接收房间。');
  $('hy-review').hidden = !s?.paused;
  syncHuyaControls();
  $('hy-history').replaceChildren(); $('hy-empty').hidden = !!s?.history.length;
  for (const entry of s?.history || []) {
    const row = node('tr'), result = node('td'); result.append(node('span', hyLabels[entry.code], 'badge ' + (entry.code === 'SUCCESS' ? 'success' : entry.code === 'REVIEW' ? 'warning' : ['ERROR', 'REJECTED'].includes(entry.code) ? 'failed' : 'neutral')));
    row.append(node('td', time(entry.at)), node('td', `${entry.room.name} · ${entry.room.id}`), node('td', entry.code === 'SUCCESS' ? `${entry.count} 个` : '—'), result); row.title = entry.message; $('hy-history').append(row);
  }
  $('hy-credential').textContent = s?.configured ? '已保存凭证，留空保留。检测背包可确认当前连接。' : '尚未连接账号';
  if (s && !hyFormsReady) { $('hy-room').value = s.room?.id || ''; $('hy-enabled').checked = s.enabled; hyFormsReady = true; }
}
function syncHuyaControls() {
  const s = hySnapshot, ready = !!s?.configured && !hyError;
  for (const id of ['hy-probe', 'hy-run']) $(id).disabled = busy.has(id) || hyReading || !s?.configured || (id === 'hy-run' && (!ready || s.paused || s.record?.code === 'SUCCESS'));
}
function refreshHuya(epoch = platformEpoch, forceInventory = false) {
  if (hyRefreshPending?.epoch === epoch) return forceInventory ? hyRefreshPending.promise.then(() => refreshHuya(epoch, true)) : hyRefreshPending.promise;
  const pending = { epoch, promise: (async () => {
    if (!platformRegistry.some(x => x.id === 'huya' && x.available)) { hySnapshot = undefined; return; }
    try {
      let data = await api('platforms/huya/status'); if (epoch !== platformEpoch) return;
      hySnapshot = data; hyError = '';
      if (data.qr && !hyQRExpires) resumeHuyaQR(data.qr, epoch);
      const age = Date.now() - Date.parse(data.inventory?.checkedAt || '');
      if (data.configured && (forceInventory || (location.hash === '#/huya' && (!Number.isFinite(age) || age >= 60000)))) {
        hyReading = true; renderHuya();
        data = await api('platforms/huya/probe', {}); if (epoch !== platformEpoch) return;
        hySnapshot = data;
      }
    } catch (error) { if (epoch === platformEpoch) hyError = error.message; }
    finally { if (epoch === platformEpoch) { hyReading = false; renderHuya(); } }
  })().finally(() => { if (hyRefreshPending === pending) hyRefreshPending = undefined; }) };
  hyRefreshPending = pending; return pending.promise;
}
$('hy-config').addEventListener('submit', event => {
  event.preventDefault(); action(event.submitter, async () => {
    const epoch = platformEpoch;
    const body = { room: $('hy-room').value.trim(), enabled: $('hy-enabled').checked };
    if ($('hy-cookie').value.trim()) body.cookie = $('hy-cookie').value.trim();
    const data = await api('platforms/huya/config', body); $('hy-cookie').value = '';
    if (epoch !== platformEpoch) return;
    hySnapshot = data; hyError = ''; hyFormsReady = false; renderHuya(); renderPlatformCards(); toast('虎牙设置已保存，接收房间已核对');
  });
});
for (const [id, operation] of [['hy-run', 'run'], ['hy-disconnect', 'disconnect'], ['hy-reconcile', 'reconcile']]) {
  $(id).addEventListener('click', () => action($(id), async () => {
    if (operation === 'reconcile' && !$('hy-confirmed').checked) throw new Error('请先在虎牙核对上一笔赠送，再勾选确认');
    const epoch = platformEpoch;
    try { const data = await api('platforms/huya/' + operation, operation === 'reconcile' ? { confirmed: true } : {});
      if (epoch !== platformEpoch) return;
      hySnapshot = data; hyError = ''; hyFormsReady = false; $('hy-confirmed').checked = false;
      toast(operation === 'run' ? data.skipped ? '今天已成功赠送，已跳过重复执行' : hyLabels[data.record?.code] || '任务已返回，请查看记录' : '虎牙状态已更新', operation === 'run' && data.record?.code === 'REVIEW');
    } finally { if (epoch === platformEpoch) { await refreshHuya(epoch); renderPlatformCards(); renderPlatformHistory(); } }
  }));
}
for (const id of ['hy-probe', 'hy-refresh']) $(id).addEventListener('click', () => action($(id), async () => { await refreshHuya(platformEpoch, true); renderPlatformCards(); renderPlatformHistory(); if (hyError) throw new Error(hyError); }));
function stopHuyaQR(message = '') {
  clearTimeout(hyQRTimer); hyQRExpires = 0;
  $('hy-qr-image').hidden = true; $('hy-qr-image').removeAttribute('src'); $('hy-qr-panel').hidden = !message;
  $('hy-qr-cancel').hidden = true; $('hy-qr-status').textContent = message;
}
function resumeHuyaQR(data, epoch) {
  hyQRExpires = data.expiresAt; $('hy-qr-image').src = data.image + '?v=' + Date.now(); $('hy-qr-image').hidden = false;
  $('hy-qr-panel').hidden = false; $('hy-qr-cancel').hidden = false; $('hy-qr-start').textContent = '刷新登录二维码';
  $('hy-qr-status').textContent = '请用虎牙 App 扫码并确认';
  clearTimeout(hyQRTimer); hyQRTimer = setTimeout(() => pollHuyaQR(epoch), 4000);
}
async function pollHuyaQR(epoch) {
  if (epoch !== platformEpoch || !hyQRExpires) return;
  if (Date.now() >= hyQRExpires) { stopHuyaQR('二维码已过期，请重新生成。'); return; }
  try {
    const data = await api('platforms/huya/qrpoll', {});
    if (epoch !== platformEpoch) return;
    if (data.status === 'connected') {
      stopHuyaQR('虎牙登录成功，凭证已加密保存。'); hySnapshot = data; hyError = '';
      renderHuya(); renderPlatformCards(); toast('虎牙扫码登录成功');
      try { hySnapshot = await api('platforms/huya/probe', {}); if (epoch === platformEpoch) { renderHuya(); renderPlatformCards(); } } catch { if (epoch === platformEpoch) toast('登录已保存，背包暂时无法读取，请稍后检测', true); }
      return;
    }
    if (data.status === 'expired') { stopHuyaQR('二维码已过期，请重新生成。'); return; }
    $('hy-qr-status').textContent = '请用虎牙 App 扫码并确认 · 剩余约 ' + Math.max(0, Math.ceil((hyQRExpires - Date.now()) / 1000)) + ' 秒';
    $('hy-qr-image').src = '/api/platforms/huya/qrimage?v=' + Date.now();
    hyQRTimer = setTimeout(() => pollHuyaQR(epoch), 4000);
  } catch (error) { if (epoch === platformEpoch) stopHuyaQR(error.message); }
}
$('hy-qr-start').addEventListener('click', () => action($('hy-qr-start'), async () => {
  const epoch = platformEpoch; stopHuyaQR('正在打开虎牙官方扫码页，请稍候…');
  let data;
  try { data = await api('platforms/huya/qrstart', {}); }
  catch (error) { if (epoch === platformEpoch) stopHuyaQR(error.message); throw error; }
  if (epoch !== platformEpoch) return;
  resumeHuyaQR(data, epoch); enter($('hy-qr-panel'));
}));
$('hy-qr-cancel').addEventListener('click', () => action($('hy-qr-cancel'), async () => { stopHuyaQR('扫码已取消'); await api('platforms/huya/qrcancel', {}); }));
