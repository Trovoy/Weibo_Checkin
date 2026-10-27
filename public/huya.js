let hySnapshot, hyError = '', hyFormsReady = false;
let hyQRTimer, hyQRExpires = 0;
const hyLabels = { SUCCESS: '已赠送', EMPTY: '无可用虎粮', ERROR: '检测失败', REJECTED: '赠送被拒绝', REVIEW: '待核对' };
function resetHuya() {
  hySnapshot = undefined; hyError = ''; hyFormsReady = false;
  stopHuyaQR();
  $('hy-cookie').value = ''; $('hy-room').value = ''; $('hy-confirmed').checked = false; $('hy-history').replaceChildren();
}
function renderHuya() {
  const s = hySnapshot, ready = !!s?.configured && !hyError;
  $('hy-state').textContent = hyError ? '读取失败' : s?.paused ? '已暂停 · 待核对' : s?.record ? hyLabels[s.record.code] : ready ? '已配置' : '未连接';
  $('hy-count').textContent = s?.inventory ? `${s.inventory.count} 个` : '—';
  $('hy-checked').textContent = s?.inventory ? '检测于 ' + time(s.inventory.checkedAt) : '点击检测背包读取当前数量';
  $('hy-room-label').textContent = s?.room ? `${s.room.name} · ${s.room.id}` : '未设置';
  $('hy-schedule-label').textContent = s?.enabled ? `每日 ${s.time} 自动执行 · UTC+8` : '自动赠送未开启';
  const entry = s?.record;
  $('hy-result').textContent = hyError || (entry ? `${hyLabels[entry.code]}${entry.code === 'SUCCESS' ? ` ${entry.count} 个免费虎粮` : ''} · ${s.history.find(x => x.at === entry.at)?.message || ''}` : '尚未执行。请先检测背包并核对接收房间。');
  $('hy-review').hidden = !s?.paused;
  syncHuyaControls();
  $('hy-history').replaceChildren(); $('hy-empty').hidden = !!s?.history.length;
  for (const entry of s?.history || []) {
    const row = node('tr'), result = node('td'); result.append(node('span', hyLabels[entry.code], 'badge ' + (entry.code === 'SUCCESS' ? 'success' : 'neutral')));
    row.append(node('td', time(entry.at)), node('td', `${entry.room.name} · ${entry.room.id}`), node('td', entry.code === 'SUCCESS' ? `${entry.count} 个` : '—'), result); row.title = entry.message; $('hy-history').append(row);
  }
  $('hy-credential').textContent = s?.configured ? '已保存凭证，留空保留。检测背包可确认当前连接。' : '尚未连接账号';
  if (s && !hyFormsReady) { $('hy-room').value = s.room?.id || ''; $('hy-time').value = s.time; $('hy-enabled').checked = s.enabled; hyFormsReady = true; }
}
function syncHuyaControls() {
  const s = hySnapshot, ready = !!s?.configured && !hyError;
  for (const id of ['hy-probe', 'hy-run']) $(id).disabled = busy.has(id) || !ready || (id === 'hy-run' && (s.paused || s.record?.code === 'SUCCESS'));
}
async function refreshHuya(epoch = platformEpoch) {
  if (!platformRegistry.some(x => x.id === 'huya' && x.available)) { hySnapshot = undefined; return; }
  try { const data = await api('platforms/huya/status'); if (epoch !== platformEpoch) return; hySnapshot = data; hyError = ''; if (data.qr && !hyQRExpires) resumeHuyaQR(data.qr, epoch); }
  catch (error) { if (epoch !== platformEpoch) return; hyError = error.message; }
  if (epoch === platformEpoch) renderHuya();
}
$('hy-config').addEventListener('submit', event => {
  event.preventDefault(); action(event.submitter, async () => {
    const epoch = platformEpoch;
    const body = { room: $('hy-room').value.trim(), time: $('hy-time').value, enabled: $('hy-enabled').checked };
    if ($('hy-cookie').value.trim()) body.cookie = $('hy-cookie').value.trim();
    const data = await api('platforms/huya/config', body); $('hy-cookie').value = '';
    if (epoch !== platformEpoch) return;
    hySnapshot = data; hyError = ''; hyFormsReady = false; renderHuya(); renderPlatformCards(); toast('虎牙设置已保存，接收房间已核对');
  });
});
for (const [id, operation] of [['hy-probe', 'probe'], ['hy-run', 'run'], ['hy-disconnect', 'disconnect'], ['hy-reconcile', 'reconcile']]) {
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
$('hy-refresh').addEventListener('click', () => action($('hy-refresh'), async () => { await refreshHuya(); renderPlatformCards(); renderPlatformHistory(); }));
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
