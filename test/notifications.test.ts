import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NotificationCenter } from '../src/notifications.ts';
import worker from '../src/index.ts';
import { session } from '../src/crypto.ts';
const secret = btoa('notification-test'.padEnd(32, 'x'));
const token = '123456789:' + 'x'.repeat(35), chatId = '987654321';
class Store {
  value: any;
  async get() { return structuredClone(this.value); }
  async put(_key, value) { this.value = structuredClone(value); }
}
function fixture() {
  const storage = new Store(); let bad = false, reads = 0;
  const binding = (get) => ({ idFromName: name => name, get: () => ({ fetch: async url => { reads++; return Response.json(get(new URL(url).pathname)); } }) });
  const env = { ENCRYPTION_KEY: secret, ADMIN_TOKEN: 'a'.repeat(40),
    ACCOUNT: binding(() => ({ enabled: true, login: 'valid', today: '2026-12-31', topics: [{ id: 'test' }], completedToday: bad ? [] : ['test'], job: bad ? { day: '2026-12-31', status: 'stopped', pendingTopic: 'test' } : undefined, history: bad ? [{ day: '2026-12-31', result: 'failed', message: 'NEVER_COPY_UPSTREAM_SECRET' }] : [] })),
    NODESEEK: binding(path => path === '/config' ? { configured: true, enabled: true } : { record: { ok: true, gain: 6 } }),
    HUYA: binding(() => ({ enabled: true, date: '2026-12-31', history: [{ day: '2026-12-31', code: 'SUCCESS', count: 18 }], paused: false })) };
  const sent: any[] = []; let response = () => Response.json({ ok: true });
  const make = () => { const center = new NotificationCenter({ storage } as any, env as any); center.transport = async (url, init) => { assert.match(String(url), /^https:\/\/api\.telegram\.org\/bot\d+:[\w-]+\/sendMessage$/); sent.push(JSON.parse(String(init?.body))); return response(); }; return center; };
  const call = (center, path, body = {}) => center.fetch(new Request('https://notify/' + path, { method: path === 'status' ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, body: path === 'status' ? undefined : JSON.stringify(body) }));
  const config = (center, extra = {}) => call(center, 'config', { token, chatId, enabled: true, daily: true, alerts: true, time: '13:00', ...extra });
  return { storage, env, make, call, config, sent, fail: () => { bad = true; }, recover: () => { bad = false; }, reads: () => reads, response: fn => { response = fn; } };
}

test('Telegram credentials are encrypted and never returned; disabled notifications do no platform or remote I/O', async () => {
  const f = fixture(), center = f.make(); await f.call(center, 'tick'); assert.equal(f.reads(), 0);
  const saved = await (await f.config(center, { enabled: false })).text();
  assert.ok(!saved.includes(token) && !saved.includes(chatId));
  assert.ok(!JSON.stringify(f.storage.value).includes(token) && !JSON.stringify(f.storage.value).includes(chatId));
  await f.call(center, 'tick'); assert.equal(f.reads(), 0); assert.equal(f.sent.length, 0);
  await f.config(center, { token: '', chatId: '' });
  assert.equal((await (await f.call(center, 'status')).json()).configured, true);
  assert.equal((await f.config(center, { token: 'https://untrusted.invalid' })).status, 400);
  await f.call(center, 'disconnect'); assert.equal((await (await f.call(center, 'status')).json()).configured, false);
});

test('13:00 summary, anomaly and recovery are deduplicated across concurrent ticks and object restarts', async () => {
  const f = fixture(), originalNow = Date.now; let clock = Date.parse('2026-12-31T12:59:00+08:00');
  try {
    Date.now = () => clock; let center = f.make(); await f.config(center);
    await f.call(center, 'tick'); assert.equal(f.sent.length, 0);
    f.fail(); await f.call(center, 'tick'); assert.equal(f.sent.length, 1);
    assert.ok(f.sent[0].text.includes('本日结果需核对')); assert.ok(!f.sent[0].text.includes('NEVER_COPY'));
    clock += 60000; center = f.make(); await Promise.all([f.call(center, 'tick'), f.call(center, 'tick')]);
    assert.equal(f.sent.length, 2); assert.ok(f.sent[1].text.includes('每日汇报'));
    assert.ok(f.sent[1].text.includes('18 个免费虎粮')); assert.equal(f.sent[1].protect_content, true);
    f.recover(); await f.call(center, 'tick'); assert.equal(f.sent.length, 3); assert.ok(f.sent[2].text.includes('已恢复'));
    await f.call(f.make(), 'tick'); assert.equal(f.sent.length, 3);
    clock += 86400000; await f.call(f.make(), 'tick'); assert.equal(f.sent.length, 4);
  } finally { Date.now = originalNow; }
});

test('Telegram retries confirmed rate-limit rejections with a bound; uncertain delivery is not sent twice', async () => {
  const f = fixture(), originalNow = Date.now; let clock = Date.parse('2026-12-31T13:00:00+08:00');
  try {
    Date.now = () => clock; await f.config(f.make(), { alerts: false });
    f.response(() => Response.json({ ok: false, parameters: { retry_after: 1200 } }, { status: 429 }));
    await f.call(f.make(), 'tick'); assert.equal(f.sent.length, 1);
    clock += 15 * 60000; await f.call(f.make(), 'tick'); assert.equal(f.sent.length, 1);
    clock += 5 * 60000; await f.call(f.make(), 'tick'); assert.equal(f.sent.length, 2);
    clock += 20 * 60000; await f.call(f.make(), 'tick'); assert.equal(f.sent.length, 3);
    clock += 20 * 60000; await f.call(f.make(), 'tick'); assert.equal(f.sent.length, 3);
    clock += 86400000; f.response(() => { throw Error('lost response with token'); });
    await f.call(f.make(), 'tick'); assert.equal(f.sent.length, 4);
    clock += 3600000; await f.call(f.make(), 'tick'); assert.equal(f.sent.length, 4);
    const status = await (await f.call(f.make(), 'status')).json(); assert.equal(status.deliveries[0].status, 'unknown'); assert.ok(!JSON.stringify(status).includes(token));
  } finally { Date.now = originalNow; }
});

test('Telegram management routes require a session and same-origin JSON; internal tick is not public', async () => {
  const f = fixture(); let calls = 0;
  const env = { ...f.env, NOTIFICATIONS: { idFromName: x => x, get: () => ({ fetch: async () => { calls++; return Response.json({}); } }) } };
  const get = await worker.fetch(new Request('https://panel.invalid/api/notifications/status'), env as any); assert.equal(get.status, 401);
  const cross = await worker.fetch(new Request('https://panel.invalid/api/notifications/config', { method: 'POST', headers: { Origin: 'https://evil.invalid', 'Content-Type': 'application/json' }, body: '{}' }), env as any); assert.equal(cross.status, 403);
  assert.equal(calls, 0);
  const headers = { Cookie: 'wc_session=' + await session(env.ADMIN_TOKEN), Origin: 'https://panel.invalid', 'Content-Type': 'application/json' };
  await worker.fetch(new Request('https://panel.invalid/api/notifications/tick', { method: 'POST', headers, body: '{}' }), env as any);
  assert.equal(calls, 0);
  const own = await worker.fetch(new Request('https://panel.invalid/api/notifications/config', { method: 'POST', headers, body: '{}' }), env as any);
  assert.equal(own.status, 200); assert.equal(calls, 1);
});
