import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NodeSeekAccount } from '../src/nodeseek/account.ts';
import { encryptCookie, decryptCookie, dailyPlan, checkIn, run } from '../src/nodeseek/engine.js';
import worker from '../src/index.ts';
import { session } from '../src/crypto.ts';
class Storage {
  values = new Map();
  async get(k) { return structuredClone(this.values.get(k)); }
  async put(k, v) { this.values.set(k, structuredClone(v)); }
  async delete(k) { return this.values.delete(k); }
  async list({ prefix = '', startAfter = '', limit = 1000 }) { return new Map([...this.values].sort(([a], [b]) => a.localeCompare(b)).filter(([k]) => k.startsWith(prefix) && k > startAfter).slice(0, limit)); }
  async transaction(fn) { const backup = structuredClone(this.values); try { return await fn(this); } catch (e) { this.values = backup; throw e; } }
}
async function setup(legacy = false) {
  const storage = new Storage(), key = 'native-credential-' + 'x'.repeat(32), values = new Map();
  if (legacy) {
    values.set('settings:v2', JSON.stringify({ random: true, encryptedCookie: await encryptCookie('pjwt=private-cookie', { CREDENTIAL_KEY: key }) }));
    values.set('daily:2026-10-26', JSON.stringify({ date: '2026-10-26', ok: true, code: 'SUCCESS', gain: 9, runCount: 1 }));
    values.set('schedule-settings:v1', JSON.stringify({ start: '09:00', end: '12:00' }));
    values.set('sync-client:v4', JSON.stringify({ tokenHash: 'old-browser-hash' }));
    values.set('pair:v4:abandoned', JSON.stringify({ secret: 'must-not-import' }));
  }
  const env = { NODESEEK_CREDENTIAL_KEY: key, NODESEEK_LEGACY_STATE: legacy ? {
    list: async () => ({ keys: [...values.keys()].map(name => ({ name })), list_complete: true }), get: async name => values.get(name)
  } : undefined };
  const make = () => new NodeSeekAccount({ storage } as any, env as any), account = make();
  const call = (path, body?, headers = {}) => account.fetch(new Request('https://native' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }));
  return { env, values, storage, make, account, call, key };
}
test('native migration atomically preserves credentials, history, schedule and pairing; reactivation never overwrites live data', async () => {
  const f = await setup(true), result = await (await f.call('/config')).json();
  assert.equal(result.enabled, true); assert.equal(result.browserPaired, true); assert.equal(result.schedule.start, '09:00');
  const migrated = await f.account.store.get('settings:v2', 'json');
  assert.equal(await decryptCookie(migrated.encryptedCookie, { CREDENTIAL_KEY: f.key }), 'pjwt=private-cookie');
  assert.equal(f.storage.values.has('data:pair:v4:abandoned'), false);
  await f.call('/config', { random: false, enabled: false });
  const recreated = f.make(); await recreated.fetch(new Request('https://native/config'));
  assert.equal((await recreated.store.get('settings:v2', 'json')).random, false);
  const history = await (await f.call('/history?month=2026-10')).json(); assert.equal(history.records[0].gain, 9);
  assert.ok(!JSON.stringify(result).includes('private-cookie'));
});
test('failed credential migration cannot mark initialized or partially import data', async () => {
  const f = await setup(true); f.env.NODESEEK_CREDENTIAL_KEY = 'wrong-key-' + 'z'.repeat(40);
  assert.equal((await f.call('/config')).status, 503); assert.equal(f.storage.values.size, 0);
  f.env.NODESEEK_CREDENTIAL_KEY = f.key; assert.equal((await f.call('/config')).status, 200);
});
test('fresh native installs default off and serialize all calls across await boundaries', async () => {
  const f = await setup(); assert.equal((await (await f.call('/config')).json()).enabled, false);
  let active = 0, peak = 0;
  f.account.execute = async () => { active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 3)); active--; return Response.json({}); };
  await Promise.all([f.call('/run', {}), f.call('/tick', {}), f.call('/health', {})]); assert.equal(peak, 1);
  assert.equal(f.storage.values.has('operation:v1'), false);
});
test('crash markers become uncertain records and are reconciled by GET before another attendance POST', async () => {
  const f = await setup(); await f.call('/config');
  await f.storage.put('operation:v1', { date: '2026-10-26' });
  const recreated = f.make(); await recreated.fetch(new Request('https://native/config'));
  assert.equal((await recreated.store.get('daily:2026-10-26', 'json')).code, 'NETWORK');
  let posts = 0;
  const env = { STATE: recreated.store, CREDENTIAL_KEY: f.key, NODESEEK_COOKIE: 'pjwt=fake', NS_RANDOM: 'true' };
  const report = await run(env, 'manual', { now: () => Date.parse('2026-10-26T10:00:00+08:00'), fetch: async (_url, init) => {
    if (init?.method === 'POST') posts++;
    return Response.json({ success: true, data: [[9, 0, '签到收益 9 个鸡腿', '2026-10-26T01:00:00Z']] });
  } });
  assert.equal(posts, 0); assert.equal(report.code, 'ALREADY'); assert.equal(report.gain, 9);
});
test('extension pairing requires panel authorization; verifier yields a token limited to sync and revocation works', async () => {
  const f = await setup(), admin = 'admin-' + 'a'.repeat(40), base = 'https://panel.example.com';
  const env = { ...f.env, ADMIN_TOKEN: admin, ENCRYPTION_KEY: btoa('k'.repeat(32)), NODESEEK: { idFromName: () => 'one', get: () => ({ fetch: (input, init) => f.account.fetch(new Request(input, init)) }) } };
  const cookie = 'wc_session=' + await session(admin);
  const call = (action, body, authenticated = false, token?) => worker.fetch(new Request(base + '/api/platforms/nodeseek/' + action, { method: 'POST', headers: {
    'Content-Type': 'application/json', Origin: base, ...(authenticated ? { Cookie: cookie } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {})
  }, body: JSON.stringify(body) }), env as any, {} as any);
  const flow = 'f'.repeat(43), verifier = 'v'.repeat(43), challenge = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))).toString('base64url');
  assert.equal((await call('pairapprove', { flow, challenge })).status, 401);
  assert.equal((await call('pairpoll', { flow, verifier })).status, 202);
  assert.equal((await call('pairapprove', { flow, challenge }, true)).status, 200);
  assert.equal((await call('pairpoll', { flow, verifier: 'x'.repeat(43) })).status, 403);
  const token = (await (await call('pairpoll', { flow, verifier })).json()).token; assert.equal(token.length, 43);
  assert.equal((await call('sync', { cookie: 'pjwt=new-private', userAgent: 'test' }, false, token)).status, 200);
  assert.equal((await call('run', {}, false, token)).status, 401);
  assert.equal((await call('pairrevoke', {}, true)).status, 200);
  assert.equal((await call('sync', { cookie: 'pjwt=new-private', userAgent: 'test' }, false, token)).status, 401);
});
test('uncertain network calls are not retried, and keyed daily plans remain stable inside the UTC+8 window', async () => {
  let posts = 0; const env = { NODESEEK_COOKIE: 'pjwt=fake', CREDENTIAL_KEY: 'key-' + 'k'.repeat(40) };
  const result = await checkIn(env, { fetch: async () => { posts++; throw new Error('network'); }, sleep: async () => {} });
  assert.equal(result.code, 'NETWORK'); assert.equal(posts, 1);
  const plan = await dailyPlan(env, '2026-10-27'); assert.deepEqual(plan, await dailyPlan(env, '2026-10-27'));
  assert.ok(plan.primaryAt >= '2026-10-27T01:00:00.000Z' && plan.primaryAt < '2026-10-27T04:00:00.000Z');
});
test('shared worker dispatches minute ticks only to NodeSeek and the daily trigger only to Weibo', async () => {
  const calls = [], pending = [];
  const namespace = name => ({ idFromName: () => 'one', get: () => ({ fetch: async () => { calls.push(name); return Response.json({}); } }) });
  const env = { ADMIN_TOKEN: 'a'.repeat(40), ENCRYPTION_KEY: btoa('k'.repeat(32)), NODESEEK_CREDENTIAL_KEY: 'n'.repeat(40), ACCOUNT: namespace('weibo'), NODESEEK: namespace('nodeseek') };
  const ctx = { waitUntil: p => pending.push(p) };
  await worker.scheduled({ cron: '* * * * *' } as any, env as any, ctx as any); await Promise.all(pending);
  assert.deepEqual(calls, ['nodeseek']);
  await worker.scheduled({ cron: '0 1 * * *' } as any, env as any, ctx as any); await Promise.all(pending);
  assert.deepEqual(calls, ['nodeseek', 'weibo']);
});
