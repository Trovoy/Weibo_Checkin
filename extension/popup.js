import { workerOrigin } from './url.js';
import { NODESEEK_COOKIE_PERMISSIONS } from './cookies.js';
const $ = id => document.getElementById(id);
async function render() {
  const data = await chrome.storage.local.get(['settings', 'pendingPair', 'status', 'cookieDiagnostic']);
  if (!$('origin').value) $('origin').value = data.pendingPair?.origin || data.settings?.worker || '';
  $('status').textContent = data.status?.message || (data.settings?.protocol === 5 ? '浏览器已连接' : '填写新的统一面板地址，连接后在面板确认。');
  $('diagnostic-text').textContent = data.cookieDiagnostic || '只显示权限与 Cookie 数量，不显示 Cookie 内容。';
  $('grant').hidden = await chrome.permissions.contains({ origins: NODESEEK_COOKIE_PERMISSIONS });
}
async function send(type, extra = {}) {
  for (const button of document.querySelectorAll('button')) button.disabled = true;
  try { const result = await chrome.runtime.sendMessage({ type, ...extra }); await render(); $('status').textContent = result?.message || '已提交'; }
  catch { $('status').textContent = '操作失败，请重新打开扩展或检查地址。'; }
  finally { for (const button of document.querySelectorAll('button')) button.disabled = false; }
}
$('pair').onclick = async () => {
  try { const origin = workerOrigin($('origin').value.trim());
    if (!await chrome.permissions.request({ origins: [origin + '/*'] })) { $('status').textContent = '未授权访问面板'; return; }
    await send('begin-pair', { origin });
  } catch { $('status').textContent = '请填写 HTTPS 面板根地址，不带路径或参数。'; }
};
for (const [id, type] of [['poll', 'poll-pair'], ['sync', 'sync'], ['diagnose', 'diagnose']]) $(id).onclick = () => send(type);
$('grant').onclick = async () => { if (await chrome.permissions.request({ origins: NODESEEK_COOKIE_PERMISSIONS })) await send('sync'); };
chrome.storage.onChanged.addListener(render); render();
