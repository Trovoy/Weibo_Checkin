import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WeiboAccount, dayKey } from '../src/account.ts';
import worker from '../src/index.ts';
import { session, open, seal } from '../src/crypto.ts';
const key = btoa('a'.repeat(32));
const topic = { name: '示例', id: '100808' + 'a'.repeat(32) };
class MemoryStorage {
  values = new Map(); nextAlarm = null;
  async get(key) { return structuredClone(this.values.get(key)); }
  async put(key, value) { this.values.set(key, structuredClone(value)); }
  async delete(key) { return this.values.delete(key); }
  async setAlarm(time) { this.nextAlarm = time; }
  async deleteAlarm() { this.nextAlarm = null; }
  async transaction(fn) { return fn(this); }
}
function setup(transport) {
  const storage = new MemoryStorage();
  const env = { ENCRYPTION_KEY: key, ADMIN_TOKEN: 'x'.repeat(40) };
  const make = () => {
    const account = new WeiboAccount({ storage }, env);
    account.transport = transport ?? (async () => Response.json({ ok: 1, data: { privacy: {} } }));
    return account;
  };
  const account = make();
  const call = (path, body = {}) => account.fetch(new Request('https://local/api/' + path, {
    method: path === 'status' ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, body: path === 'status' ? undefined : JSON.stringify(body)
  }));
  return { storage, account, call, make };
}
async function prepare(call, topics = [topic]) {
  assert.equal((await call('cookie', { cookie: 'SUB=super-secret' })).status, 200);
  assert.equal((await call('settings', { topics, enabled: true })).status, 200);
}
test('concurrent starts schedule one job; alarm persists completion across object recreation', async () => {
  let posts = 0;
  const { account, storage, call, make } = setup(async (url, init) => {
    if (init.method === 'POST') { posts++; return Response.json({ code: '100000' }); }
    return Response.json({ ok: 1, data: { privacy: {} } });
  });
  await prepare(call);
  const starts = await Promise.all([call('run'), call('run')]);
  assert.deepEqual((await Promise.all(starts.map(r => r.json()))).map(r => r.started), [true, false]);
  assert.ok(storage.nextAlarm);
  await account.alarm();
  const recreated = make(); await recreated.alarm();
  assert.equal(posts, 1);
  const state = await (await call('status')).json();
  assert.equal(state.job.status, 'done'); assert.equal(state.completedToday.length, 1);
  assert.equal((await (await call('run')).json()).started, false);
  assert.ok(!JSON.stringify(state).includes('super-secret'));
  assert.ok(!JSON.stringify([...storage.values]).includes('super-secret'));
});
test('expired login stops before any check-in, later alarms cannot continue it', async () => {
  let expired = false, posts = 0;
  const { account, call } = setup(async (_url, init) => {
    if (init.method === 'POST') posts++;
    return Response.json(expired ? { ok: -100 } : { ok: 1, data: { privacy: {} } });
  });
  await prepare(call); await call('run'); expired = true;
  await account.alarm(); await account.alarm();
  const state = await (await call('status')).json();
  assert.equal(posts, 0); assert.equal(state.login, 'expired'); assert.equal(state.job.status, 'stopped');
  assert.equal(state.history[0].result, 'failed');
  assert.equal((await call('run')).status, 409);
});
test('network failure after an uncertain POST is recorded and never automatically retried', async () => {
  let posts = 0;
  const { account, call } = setup(async (_url, init) => {
    if (init.method === 'POST') { posts++; throw new Error('internal secret response'); }
    return Response.json({ ok: 1, data: { privacy: {} } });
  });
  await prepare(call); await call('run'); await account.alarm(); await account.alarm();
  const state = await (await call('status')).json();
  assert.equal(posts, 1); assert.equal(state.job.status, 'stopped');
  assert.ok(!JSON.stringify(state).includes('internal secret'));
});
test('one alarm handles one topic and manual stop prevents the next topic', async () => {
  let posts = 0;
  const { account, call, storage } = setup(async (_url, init) => {
    if (init.method === 'POST') { posts++; return Response.json({ code: 382004 }); }
    return Response.json({ ok: 1, data: { privacy: {} } });
  });
  await prepare(call, [topic, { name: '第二个', id: '100808' + 'b'.repeat(32) }]);
  await call('run'); await account.alarm();
  assert.equal(posts, 1); assert.equal((await (await call('status')).json()).job.index, 1);
  assert.equal((await call('logout')).status, 409);
  await call('stop'); await account.alarm();
  assert.equal(posts, 1); assert.equal(storage.nextAlarm, null);
});
test('rotated Cookie is encrypted even when validation fails', async () => {
  let failed = false;
  const { call, storage } = setup(async () => failed ? new Response('{"ok":-100}', { headers: { 'Set-Cookie': 'SUB=rotated-secret; Domain=.weibo.com; Path=/' } }) : Response.json({ ok: 1, data: { privacy: {} } }));
  await prepare(call); failed = true; await call('validate');
  const state = await storage.get('state');
  const cookies = await open(state.credentials, key);
  assert.equal(cookies.find(c => c.name === 'SUB').value, 'rotated-secret');
  assert.equal(state.login, 'expired');
});
test('a job from yesterday stops without signing on the wrong day', async () => {
  let posts = 0;
  const { call, account, storage } = setup(async (_url, init) => {
    if (init.method === 'POST') posts++;
    return Response.json({ ok: 1, data: { privacy: {} } });
  });
  await prepare(call); await call('run');
  const state = await storage.get('state'); state.job.day = '2000-01-01'; await storage.put('state', state);
  await account.alarm();
  assert.equal(posts, 0); assert.equal((await storage.get('state')).job.status, 'stopped');
  assert.notEqual(dayKey(), '2000-01-01');
});
test('partial QR login remains encrypted and can resume after a home-page failure', async () => {
  let qrChecks = 0;
  const { call, storage } = setup(async raw => {
    const url = new URL(raw);
    if (url.pathname === '/sso/qrcode/image') return Response.json({ retcode: 20000000, data: { qrid: 'one-ticket', image: 'https://v2.qr.weibo.cn/qr.png' } });
    if (url.pathname === '/sso/qrcode/check') { qrChecks++; return Response.json({ retcode: 20000000, data: { alt: 'ticket' } }); }
    if (url.pathname === '/sso/login.php') return Response.json({ retcode: 0, crossDomainUrlList: ['https://passport.weibo.com/wbsso/login'] });
    if (url.pathname === '/wbsso/login') return new Response('{}', { headers: { 'Set-Cookie': 'SUB=resumable-secret; Domain=.weibo.com; Path=/; Secure' } });
    if (url.pathname === '/') return new Response('', { status: 403 });
    return Response.json({ ok: 1, data: { privacy: {} } });
  });
  assert.equal((await call('qr/create')).status, 200);
  assert.equal((await call('qr/poll')).status, 502);
  assert.match((await (await call('status')).json()).message, /^初始化微博会话/);
  const qr = await open(await storage.get('qr'), key);
  assert.equal(qr.cookies.find(c => c.name === 'SUB').value, 'resumable-secret');
  assert.ok(!JSON.stringify([...storage.values]).includes('resumable-secret'));
  qr.lastPoll = 0; await storage.put('qr', await seal(qr, key));
  assert.equal((await (await call('qr/poll')).json()).status, 'ok');
  assert.equal(qrChecks, 1);
  assert.equal((await (await call('status')).json()).login, 'valid');
  assert.equal(await storage.get('qr'), undefined);
});
test('worker authentication blocks anonymous, forged, cross-origin and internal requests', async () => {
  let calls = 0;
  const env = { ADMIN_TOKEN: 'x'.repeat(40), ENCRYPTION_KEY: key,
    ACCOUNT: { idFromName: () => 'id', get: () => ({ fetch: async () => { calls++; return Response.json({ ok: true }); } }) },
    ASSETS: { fetch: async () => new Response('asset', { status: 404 }) } };
  const req = (path, options = {}) => new Request('https://example.com' + path, options);
  const ctx = {};
  assert.equal((await worker.fetch(req('/api/status'), env, ctx)).status, 401);
  const cookie = 'wc_session=' + await session(env.ADMIN_TOKEN);
  assert.equal((await worker.fetch(req('/api/run', { method: 'POST', headers: { Cookie: cookie, Origin: 'https://evil.com', 'Content-Type': 'application/json' }, body: '{}' }), env, ctx)).status, 403);
  assert.equal((await worker.fetch(req('/api/status', { headers: { Cookie: cookie } }), env, ctx)).status, 200);
  assert.equal(calls, 1);
  assert.equal((await worker.fetch(req('/internal/cron'), env, ctx)).status, 404);
  assert.equal(calls, 1);
  const logged = await worker.fetch(req('/api/session', { method: 'POST', headers: { Origin: 'https://example.com', 'Content-Type': 'application/json' }, body: JSON.stringify({ token: env.ADMIN_TOKEN }) }), env, ctx);
  assert.equal(logged.status, 200); assert.match(logged.headers.get('Set-Cookie'), /HttpOnly; SameSite=Strict/);
  assert.match(logged.headers.get('Set-Cookie'), /Secure/);
  assert.match(logged.headers.get('Cache-Control'), /no-store/);
});
