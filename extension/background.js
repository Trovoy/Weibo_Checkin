import { workerOrigin } from './url.js';
import { NODESEEK_ORIGINS, nodeSeekDomain, cookieHeader, hasLoginCookie, readNodeSeekCookies, diagnosticText } from './cookies.js';
const api = '/api/platforms/nodeseek/';
const encode = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
const random = () => encode(crypto.getRandomValues(new Uint8Array(32)));
const hash = async value => encode(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));
const status = async value => chrome.storage.local.set({ status: { ...value, at: new Date().toISOString() } });
let syncing, pairing;
async function performSync(force) {
  const { settings, lastDigest, lastSyncedAt } = await chrome.storage.local.get(['settings', 'lastDigest', 'lastSyncedAt']);
  if (!settings?.enabled || settings.protocol !== 5) return { ok: false, message: '请先连接新的统一面板' };
  const origin = workerOrigin(settings.worker);
  if (!await chrome.permissions.contains({ origins: [origin + '/*'] })) return { ok: false, message: '请重新连接面板并允许访问该地址' };
  const { cookies, diagnostic } = await readNodeSeekCookies();
  await chrome.storage.local.set({ cookieDiagnostic: diagnosticText(diagnostic, chrome.runtime.getManifest().version) });
  if (diagnostic.permissions.some(granted => !granted) || !hasLoginCookie(cookies)) {
    const report = { ok: false, message: '未读取到登录凭据，请核对网站权限并在 NodeSeek 官网正常登录。' }; await status(report); return report;
  }
  const cookie = cookieHeader(cookies), digest = await hash(origin + cookie);
  if (!force && digest === lastDigest && Date.now() - Date.parse(lastSyncedAt || '') < 6 * 3600000) return { ok: true, message: '登录信息未变化，已跳过同步' };
  try {
    const response = await fetch(origin + api + 'sync', { method: 'POST', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { Authorization: 'Bearer ' + settings.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ cookie, userAgent: navigator.userAgent }) });
    const data = await response.json(); if (!response.ok || !data.ok) throw Error();
    await chrome.storage.local.set({ lastDigest: digest, lastSyncedAt: data.syncedAt });
    const report = { ok: true, message: '登录信息已同步到统一面板', syncedAt: data.syncedAt }; await status(report); return report;
  } catch { const report = { ok: false, message: '同步失败，请检查面板地址、网络或重新连接' }; await status(report); return report; }
}
export async function sync(force = false) { if (syncing) return syncing; syncing = performSync(force); try { return await syncing; } finally { syncing = null; } }
async function beginPair(origin) {
  origin = workerOrigin(origin);
  if (!await chrome.permissions.contains({ origins: [origin + '/*'] })) return { ok: false, message: '尚未授权访问此面板' };
  const flow = random(), verifier = random();
  await chrome.storage.local.set({ pendingPair: { flow, verifier, origin, expires: Date.now() + 600000 } });
  await chrome.alarms.create('pair-poll', { periodInMinutes: 0.5 });
  await chrome.tabs.create({ url: origin + '/?pair=' + flow + '.' + await hash(verifier) });
  const report = { ok: true, message: '请在统一面板解锁后确认连接，再回到扩展检查连接。' }; await status(report); return report;
}
async function performPoll() {
  const { pendingPair: pending } = await chrome.storage.local.get('pendingPair');
  if (!pending) return { ok: false, message: '暂无待确认的连接' };
  if (pending.expires <= Date.now()) { await chrome.storage.local.remove('pendingPair'); await chrome.alarms.clear('pair-poll'); return { ok: false, message: '连接请求已过期，请重新连接' }; }
  try {
    const origin = workerOrigin(pending.origin);
    const response = await fetch(origin + api + 'pairpoll', { method: 'POST', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(15000), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ flow: pending.flow, verifier: pending.verifier }) });
    if (response.status === 202) return { ok: true, message: '等待面板确认，扩展会自动检查' };
    const data = await response.json(); if (!response.ok || !data.ok || !/^[A-Za-z0-9_-]{43}$/.test(data.token || '')) throw Error();
    await chrome.storage.local.set({ settings: { enabled: true, worker: origin, token: data.token, protocol: 5 }, lastDigest: null });
    await chrome.storage.local.remove('pendingPair'); await chrome.alarms.clear('pair-poll'); return await sync(true);
  } catch { return { ok: false, message: '尚未连接，面板确认后点击“检查连接”' }; }
}
async function pollPair() { if (pairing) return pairing; pairing = performPoll(); try { return await pairing; } finally { pairing = null; } }
const schedule = () => chrome.alarms.create('periodic-sync', { periodInMinutes: 360 });
chrome.runtime.onInstalled.addListener(() => { chrome.storage.local.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' }); schedule(); });
chrome.runtime.onStartup.addListener(() => { schedule(); pollPair().catch(() => {}); });
chrome.cookies.onChanged.addListener(({ cookie }) => { if (nodeSeekDomain(cookie.domain)) chrome.alarms.create('cookie-changed', { delayInMinutes: 0.5 }); });
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'pair-poll') pollPair().catch(() => {}); if (['cookie-changed', 'periodic-sync'].includes(alarm.name)) sync().catch(() => {}); });
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  let origin; try { origin = new URL(sender.url || sender.tab?.url).origin; } catch {}
  if (message.type === 'visited') { if (sender.tab && NODESEEK_ORIGINS.some(pattern => pattern.replace('/*', '') === origin)) sync().catch(() => {}); return false; }
  if (sender.url !== chrome.runtime.getURL('popup.html')) return false;
  let task;
  if (message.type === 'begin-pair') task = beginPair(message.origin);
  if (message.type === 'poll-pair') task = pollPair();
  if (message.type === 'sync') task = sync(true);
  if (message.type === 'diagnose') task = readNodeSeekCookies().then(async ({ diagnostic }) => { await chrome.storage.local.set({ cookieDiagnostic: diagnosticText(diagnostic, chrome.runtime.getManifest().version) }); return { ok: true, message: '读取诊断已更新，不含 Cookie 内容' }; });
  if (task) { task.then(reply, () => reply({ ok: false, message: '操作失败，请检查地址或网络' })); return true; } return false;
});
