let tgReady = false, tgEpoch = 0, tgPending;
function resetNotifications() {
  tgEpoch++; tgReady = false; tgPending = undefined;
  for (const id of ['tg-token', 'tg-chat']) $(id).value = '';
  $('tg-target').textContent = '尚未设置接收会话'; $('tg-history').replaceChildren(); $('tg-feedback').textContent = '';
}
function renderNotifications(s, settings = false) {
  $('tg-badge').textContent = s.configured ? s.enabled ? '已开启' : '已连接 · 通知关闭' : '未连接';
  $('tg-badge').className = 'badge ' + (s.enabled ? 'success' : 'neutral');
  $('tg-target').textContent = s.configured ? '已保存接收会话 ' + s.chatHint + '；留空保留。' : '尚未设置接收会话';
  if (!tgReady || settings) {
    for (const key of ['enabled', 'daily', 'alerts']) $('tg-' + key).checked = s[key];
    $('tg-time').value = s.time; tgReady = true;
  }
  for (const id of ['tg-verify', 'tg-test', 'tg-report', 'tg-disconnect']) $(id).disabled = !s.configured || busy.has(id);
  $('tg-history').replaceChildren(); $('tg-empty').hidden = s.deliveries.length > 0;
  const kinds = { test: '连接测试', manual: '当前汇报', daily: '每日汇报', alert: '异常提醒', recovery: '恢复通知' };
  const labels = { sent: '已发送', failed: '发送失败', unknown: '结果待确认', sending: '结果待确认' };
  for (const delivery of s.deliveries) {
    const row = node('tr'), result = node('td');
    result.append(node('span', labels[delivery.status] || '待确认', 'badge ' + (delivery.status === 'sent' ? 'success' : 'warning')));
    if (delivery.reason) result.append(node('span', ' · ' + delivery.reason, 'fine'));
    if (delivery.retryAt && delivery.tries < 3) result.append(node('span', ' · 下次 ' + time(delivery.retryAt), 'fine'));
    row.append(node('td', time(delivery.at)), node('td', kinds[delivery.key.split(':')[0]] || '通知'), result); $('tg-history').append(row);
  }
}
async function refreshNotifications(settings = false) {
  if (tgPending) return tgPending;
  const epoch = tgEpoch;
  const pending = (async () => { const s = await api('notifications/status'); if (epoch === tgEpoch) renderNotifications(s, settings); })();
  tgPending = pending; try { await pending; } finally { if (tgPending === pending) tgPending = undefined; }
}
$('tg-form').addEventListener('submit', event => {
  event.preventDefault(); action(event.submitter, async () => {
    const epoch = tgEpoch, body = { token: $('tg-token').value.trim(), chatId: $('tg-chat').value.trim(), time: $('tg-time').value, enabled: $('tg-enabled').checked, daily: $('tg-daily').checked, alerts: $('tg-alerts').checked };
    $('tg-token').value = ''; $('tg-chat').value = '';
    const s = await api('notifications/config', body); if (epoch !== tgEpoch) return;
    renderNotifications(s, true); toast('通知设置已加密保存');
  });
});
for (const operation of ['verify', 'test', 'report', 'disconnect']) $('tg-' + operation).addEventListener('click', () => action($('tg-' + operation), async () => {
  const epoch = tgEpoch;
  try {
    const s = await api('notifications/' + operation, {}); if (epoch !== tgEpoch) return;
    if (operation === 'verify') $('tg-feedback').textContent = s.message;
    else { renderNotifications(s, true); $('tg-feedback').textContent = operation === 'disconnect' ? 'Bot 已断开，自动通知已关闭。' : '已发送，请在 Telegram 查看。'; }
  } finally { if (epoch === tgEpoch) await refreshNotifications(); }
}));
if (state && location.hash === '#/notifications') refreshNotifications().catch(e => toast(e.message, true));
