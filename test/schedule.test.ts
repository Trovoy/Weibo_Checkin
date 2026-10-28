import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firstAt, planFor, claimAttempt, scheduleView, localDay } from '../src/schedule.ts';
import { WeiboAccount, dayKey } from '../src/account.ts';
import { HuyaAccount } from '../src/huya/account.ts';
import { scheduledTick, dailyPlan } from '../src/nodeseek/engine.js';
import { seal } from '../src/crypto.ts';
import { encode, decode } from '../src/huya/tars.ts';
const secret = btoa('schedule-test'.padEnd(32, 'x'));
class Store {
  values = new Map();
  async get(k, type?) { const x = structuredClone(this.values.get(k)); return type === 'json' && typeof x === 'string' ? JSON.parse(x) : x; }
  async put(k, v, _options?) { this.values.set(k, structuredClone(v)); }
  async delete(k) { return this.values.delete(k); }
  async setAlarm(_time) {}
  async deleteAlarm() {}
  async transaction(fn) { return fn(this); }
}

test('each platform draws a stable morning slot, persists jittered retries and resets at UTC+8 midnight', async () => {
  const day = '2026-12-31', now = Date.parse(day + 'T09:00:00+08:00');
  const slots = [];
  for (const platform of ['weibo', 'nodeseek', 'huya']) {
    const slot = await firstAt(secret, platform, day); slots.push(slot);
    assert.equal(slot, await firstAt(secret, platform, day));
    assert.ok(slot >= '2026-12-31T00:00:00.000Z' && slot < '2026-12-31T04:00:00.000Z');
    const original = await planFor(undefined, secret, platform, now);
    const claimed = await claimAttempt(original, secret, platform, now);
    const delay = Date.parse(claimed.nextAt!) - now;
    assert.ok(delay >= 45 * 60000 && delay <= 75 * 60000);
    assert.deepEqual(await planFor(claimed, secret, platform, now + 60000), claimed);
    const end = await claimAttempt(claimed, secret, platform, Date.parse(day + 'T23:40:00+08:00'));
    assert.equal(end.nextAt, undefined);
    const tomorrow = await planFor({ ...end, paused: true }, secret, platform, Date.parse('2027-01-01T00:00:00+08:00'));
    assert.equal(tomorrow.day, '2027-01-01'); assert.equal(tomorrow.attempts, 0); assert.equal(tomorrow.paused, undefined);
    const done = await scheduleView(claimed, secret, platform, true, now);
    assert.equal(localDay(Date.parse(done.nextAt!)), '2027-01-01');
  }
  assert.ok(new Set(slots).size > 1);
});

test('Weibo retries a failed validation read after its durable delay, skips completed topics and pauses an uncertain POST', async () => {
  const storage = new Store(), env = { ENCRYPTION_KEY: secret }, topic = { id: '100808' + 'c'.repeat(32), name: 'Test' };
  const today = dayKey(); let failRead = true, posts = 0;
  await storage.put('state', { enabled: true, topics: [topic], login: 'valid', history: [], completed: {},
    credentials: await seal([{ name: 'SUB', value: 'test', domain: 'weibo.com', path: '/', hostOnly: true, secure: true }], secret),
    schedule: { day: today, attempts: 0, nextAt: new Date(Date.now() - 1000).toISOString() } });
  const make = () => {
    const account = new WeiboAccount({ storage } as any, env as any);
    account.transport = async (_url, init) => { if (init?.method === 'POST') { posts++; throw Error('lost POST response'); } if (failRead) throw Error('temporary GET failure'); return Response.json({ ok: 1, data: { privacy: {} } }); };
    return account;
  };
  const tick = account => account.fetch(new Request('https://internal/internal/cron', { method: 'POST' }));
  let account = make(); await tick(account); await account.alarm();
  let saved = await storage.get('state'); assert.equal(posts, 0); assert.equal(saved.schedule.paused, undefined);
  const attempts = saved.schedule.attempts; account = make(); await tick(account);
  assert.equal((await storage.get('state')).schedule.attempts, attempts);
  saved.schedule.nextAt = new Date(Date.now() - 1).toISOString(); await storage.put('state', saved);
  failRead = false; await tick(account); await account.alarm();
  saved = await storage.get('state'); assert.equal(posts, 1); assert.equal(saved.schedule.paused, true);
  saved.schedule.nextAt = new Date(Date.now() - 1).toISOString(); await storage.put('state', saved);
  await tick(make()); assert.equal(posts, 1);
  // A previous day's uncertain check-in must not block a fresh daily check-in.
  saved.job.day = '2000-01-01'; saved.schedule.paused = false; await storage.put('state', saved);
  const resumed = await tick(make()); assert.equal((await resumed.json()).started, true);
  assert.equal((await storage.get('state')).job.pendingTopic, undefined);
  saved.completed[today] = [topic.id]; saved.schedule.paused = false; saved.job = undefined; await storage.put('state', saved);
  await tick(make()); assert.equal((await storage.get('state')).job, undefined);
});

test('Huya empty stock retries after restart, then sends once and never repeats a successful day', async () => {
  const storage = new Store(), room = { id: '42', uid: 123456789, name: 'Test' }, today = dayKey();
  await storage.put('state', { enabled: true, time: '09:30', room, history: [],
    credentials: await seal({ platform: 'huya', cookie: 'udb_uid=123456;username=test;udb_biztoken=test' }, secret),
    schedule: { day: today, attempts: 0, nextAt: new Date(Date.now() - 1000).toISOString() } });
  const originalFetch = globalThis.fetch, originalNow = Date.now;
  let clock = originalNow(), reads = 0, sends = 0;
  const response = (servant, func, fields) => {
    const body = encode({ 1: 3, 2: 0, 3: 0, 4: 1, 5: servant, 6: func, 7: encode({ 0: { map: [['', encode({ 0: 0 })], ['tRsp', encode({ 0: { struct: fields } })]] } }), 8: 0, 9: { map: [] }, 10: { map: [] } });
    const bytes = new Uint8Array(body.length + 4); new DataView(bytes.buffer).setUint32(0, bytes.length); bytes.set(body, 4); return new Response(bytes);
  };
  try {
    Date.now = () => clock;
    globalThis.fetch = async (url, init) => {
      if (String(url).endsWith('/42')) return new Response('<title>测试_虎牙直播</title><body data-lp="123456789">');
      const envelope = decode(new Uint8Array(init!.body as Uint8Array).subarray(4)), func = envelope[6];
      if (func === 'getPackageGift') return response('wupui', func, { 0: { list: reads++ === 1 ? [{ struct: { 0: { struct: { 0: 4, 3: '虎粮' } }, 5: 18 } }] : [] }, 1: 1790000000 });
      if (func === 'getSequence') return response('sequenceui', func, { 0: 0, 1: 'test-order' });
      if (func === 'consumeGiftSafe') { sends++; return response('PropsUIServer', func, { 0: 0, 1: 4, 2: 18, 3: 'test-order', 6: room.uid, 12: 0 }); }
      throw Error('unexpected RPC');
    };
    const tick = () => new HuyaAccount({ storage } as any, { ENCRYPTION_KEY: secret } as any).fetch(new Request('https://huya/tick', { method: 'POST' }));
    await tick(); assert.equal((await storage.get('state')).history[0].code, 'EMPTY');
    await tick(); assert.equal(reads, 1);
    clock = Date.parse((await storage.get('state')).schedule.nextAt) + 1; await tick();
    assert.equal((await storage.get('state')).history[0].code, 'SUCCESS'); assert.equal(sends, 1);
    clock += 90 * 60000; await tick(); assert.equal(sends, 1);
  } finally { globalThis.fetch = originalFetch; Date.now = originalNow; }
});

test('NodeSeek uncertain response is reconciled on its next random retry without another attendance POST', async () => {
  const store = new Store(), env = { STATE: store, CREDENTIAL_KEY: 'n'.repeat(40), NODESEEK_COOKIE: 'pjwt=test', NS_RANDOM: 'true' };
  await store.put('settings:v2', JSON.stringify({ enabled: true, random: true }));
  const day = '2026-12-31', first = await dailyPlan(env, day); let clock = Date.parse(first.primaryAt), posts = 0, reads = 0;
  const deps = { now: () => clock, sleep: async () => {}, fetch: async (_url, init) => {
    if (init?.method === 'POST') { posts++; throw Error('response lost'); }
    reads++; return Response.json({ success: true, data: [[6, null, '签到收益 6 个鸡腿', day + 'T09:00:00+08:00']] });
  } };
  await scheduledTick(env, deps); assert.equal(posts, 1);
  await scheduledTick(env, deps); assert.equal(posts, 1); assert.equal(reads, 0);
  clock = Date.parse((await store.get('auto-plan:v2:' + day, 'json')).nextAt) + 1;
  const report = await scheduledTick(env, deps); assert.equal(report.ok, true); assert.equal(posts, 1); assert.ok(reads > 0);
  clock += 90 * 60000; await scheduledTick(env, deps); assert.equal(posts, 1);
});
