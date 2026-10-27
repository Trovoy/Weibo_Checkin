import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encode, decode, packet, unpack } from '../src/huya/tars.ts';
import { cleanCookie, HuyaClient, inventoryFrom, resolveRoom, type Transport } from '../src/huya/client.ts';
import { execute, HuyaAccount, type State } from '../src/huya/account.ts';
import { open, seal, session } from '../src/crypto.ts';
import worker from '../src/index.ts';

const room = { id: '42', uid: 1234567890, name: 'Test broadcaster' };
const cookie = 'udb_uid=123456789;username=test-user;udb_biztoken=test-only-token';
const env = { ENCRYPTION_KEY: btoa('t'.repeat(32)) };
const initial = (): State => ({ enabled: false, time: '09:30', room: { ...room }, history: [] });
const now = new Date('2026-10-27T01:30:00Z');
function transport(overrides: Partial<Transport> = {}) {
  let reads = 0, sends = 0;
  return { client: { inventory: async () => ({ count: reads++ === 0 ? 35 : 0, checkedAt: now.toISOString() }), sequence: async () => 'order-1',
    send: async (count, order) => { sends++; return { code: 0, count, order, uid: room.uid, item: 4, cost: 0 }; }, ...overrides } as Transport, sends: () => sends };
}
function response(func: string, fields: Record<number, any>, servant = 'wupui') {
  const body = encode({ 1: 3, 2: 0, 3: 0, 4: 1, 5: servant, 6: func,
    7: encode({ 0: { map: [['', encode({ 0: 0 })], ['tRsp', encode({ 0: { struct: fields } })]] } }), 8: 0, 9: { map: [] }, 10: { map: [] } });
  const bytes = new Uint8Array(body.length + 4); new DataView(bytes.buffer).setUint32(0, bytes.length); bytes.set(body, 4); return new Response(bytes);
}
test('Huya codec preserves UTF-8, signed integers, nested lists and maps and rejects ambiguous or oversized packets', () => {
  const data = decode(encode({ 0: 0, 1: -129, 2: 2940000000, 3: '虎粮', 4: { list: [{ struct: { 0: 4, 3: '虎粮' } }] }, 5: { map: [['key', Uint8Array.from([1, 2])]] } }));
  assert.equal(data[2], 2940000000); assert.equal(data[1], -129); assert.equal(data[3], '虎粮'); assert.equal(data[4][0][0], 4);
  assert.deepEqual(data[5].get('key'), Uint8Array.from([1, 2]));
  for (const b of [Uint8Array.from([0x16, 4, 65]), Uint8Array.from([12, 12]), new Uint8Array(1024 * 1024 + 1), Uint8Array.from([0x0a, 0x0c])]) assert.throws(() => decode(b));
  assert.throws(() => unpack(packet('wupui', 'other', {}), 'wupui', 'getPackageGift'));
});
test('Huya only counts exact ordinary tiger food in backpack and rejects unrecognized response shapes', () => {
  const gift = (id, name, n) => ({ struct: { 0: { struct: { 0: id, 3: name } }, 5: n } });
  const decoded = decode(encode({ 0: { list: [gift(4, '虎粮', 1800), gift(99, '超级虎粮', 10), gift(5, '其他礼物', 100)] }, 1: 1790000000 }));
  assert.equal(inventoryFrom(decoded).count, 1800);
  assert.equal(inventoryFrom({ 0: [], 1: 1790000000 }).count, 0);
  for (const x of [{}, { 0: [], 1: 0 }, { 0: [{ 0: { 0: 4, 3: '虎粮' }, 5: -1 }], 1: 1790000000 }]) assert.throws(() => inventoryFrom(x));
});
test('Huya fixed-host protocol sends only item 4 with backpack policy 2 and the complete exact inventory count', async () => {
  const calls: any[] = [];
  const client = new HuyaClient(cookie, room, async function (url, init) {
    assert.equal(this, undefined, 'fetch must be invoked without the client instance as receiver');
    const bytes = new Uint8Array(init.body as Uint8Array), envelope = decode(bytes.subarray(4));
    const request = decode(decode(envelope[7])[0].get('tReq'))[0]; calls.push({ url: String(url), init, envelope, request });
    return response('consumeGiftSafe', { 0: 0, 1: 4, 2: 1800, 3: 'order-1', 6: room.uid, 12: 0 }, 'PropsUIServer');
  });
  const receipt = await client.send(1800, 'order-1'); assert.equal(receipt.cost, 0);
  assert.equal(calls.length, 1); const call = calls[0];
  assert.equal(new URL(call.url).origin, 'https://cdnws.api.huya.com'); assert.equal(call.init.redirect, 'manual');
  assert.equal(call.envelope[5], 'PropsUIServer'); assert.equal(call.envelope[6], 'consumeGiftSafe');
  assert.equal(call.request[3], 4); assert.equal(call.request[4], 1800); assert.equal(call.request[5], room.uid); assert.equal(call.request[6], room.uid); assert.equal(call.request[9], 2);
  assert.equal(call.request[15].length, 32);
  await assert.rejects(client.send(0, 'order-1')); await assert.rejects(client.send(-1, 'order-1')); assert.equal(calls.length, 1);
});
test('Huya refuses redirect rooms, arbitrary URLs and Cookie header injection', async () => {
  for (const s of ['https://evil.test', '998/path', '0', '1?x=y']) await assert.rejects(resolveRoom(s));
  await assert.rejects(resolveRoom('42', async () => new Response(null, { status: 302, headers: { Location: 'https://evil.test' } })));
  const resolved = await resolveRoom('42', async () => new Response('<title>主播官方直播_虎牙直播</title><body data-lp="1234567890">'));
  assert.deepEqual(resolved, { id: '42', uid: room.uid, name: '主播' });
  for (const s of ['udb_uid=1\r\nCookie: x', 'udb_uid=1;udb_uid=2;username=x', 'udb_uid=1', 'username=x']) assert.throws(() => cleanCookie(s));
});
test('Huya writes an intent before the only gift request and confirms exact receipt and empty remaining inventory', async () => {
  const state = initial(), events: string[] = [], mock = transport();
  const send = mock.client.send; mock.client.send = async (n, order) => { assert.equal(state.pending?.count, 35); assert.equal(events[0], 'intent'); events.push('send'); return send(n, order); };
  const entry = await execute(state, mock.client, async () => { events.push(state.pending ? 'intent' : 'complete'); }, 'manual', now);
  assert.equal(entry.code, 'SUCCESS'); assert.equal(entry.count, 35); assert.equal(state.pending, undefined); assert.equal(mock.sends(), 1); assert.deepEqual(events, ['intent', 'send', 'complete']);
});
test('Huya never creates an order when empty, when reading fails or when the intent cannot be persisted', async () => {
  for (const fail of [false, true]) {
    const state = initial(); let orders = 0;
    const { client } = transport({ inventory: async () => { if (fail) throw Error('private cookie exception'); return { count: 0, checkedAt: now.toISOString() }; }, sequence: async () => { orders++; return 'order-1'; } });
    const result = await execute(state, client, async () => {}, 'manual', now); assert.equal(result.code, fail ? 'ERROR' : 'EMPTY'); assert.equal(result.count, 0); assert.equal(orders, 0);
  }
  const state = initial(), mock = transport(); await assert.rejects(execute(state, mock.client, async () => { throw Error('storage unavailable'); }, 'manual', now)); assert.equal(mock.sends(), 0);
});
test('Huya uncertain POST, changed receipt, paid cost or unmatched inventory pauses delivery without retry', async () => {
  const good = { code: 0, count: 35, order: 'order-1', uid: room.uid, item: 4, cost: 0 };
  for (const overrides of [{ send: async () => { throw Error('unknown response'); } }, ...[{ code: 999 }, { uid: 7 }, { item: 8 }, { count: 1 }, { order: 'different' }, { cost: 100 }].map(x => ({ send: async () => ({ ...good, ...x }) })), { inventory: async () => ({ count: 35, checkedAt: now.toISOString() }) }]) {
    const state = initial(), mock = transport(overrides); const result = await execute(state, mock.client, async () => {}, 'manual', now);
    assert.equal(result.code, 'REVIEW'); assert.ok(state.pending); assert.equal(result.count, 0);
    await assert.rejects(execute(state, mock.client, async () => {}, 'cron', now)); assert.ok(mock.sends() <= 1);
  }
});
test('Huya explicit rejection never falls back to a paid policy', async () => {
  const state = initial(); let sends = 0;
  const { client } = transport({ send: async () => { sends++; return { code: 40, count: 0, uid: room.uid, item: 4, order: 'order-1', cost: 0 }; } });
  assert.equal((await execute(state, client, async () => {}, 'manual', now)).code, 'REJECTED'); assert.equal(sends, 1); assert.equal(state.pending, undefined);
});
test('Huya credentials stay encrypted and a persisted uncertain operation survives disconnect and object recreation', async () => {
  const data = initial(); data.credentials = await seal({ platform: 'huya', cookie }, env.ENCRYPTION_KEY); data.pending = { count: 35, order: 'order-1', room, at: now.toISOString() };
  const values = new Map([['state', structuredClone(data)]]);
  const ctx = { storage: { get: async k => structuredClone(values.get(k)), put: async (k, v) => { values.set(k, structuredClone(v)); }, delete: async k => values.delete(k), deleteAlarm: async () => {} } };
  let object = new HuyaAccount(ctx as any, env as any);
  let result = await object.fetch(new Request('https://internal/status')); const text = await result.text(); assert.ok(!text.includes(cookie)); assert.ok(!text.includes('credentials')); assert.ok(!text.includes('order-1'));
  result = await object.fetch(new Request('https://internal/run', { method: 'POST' })); assert.equal(result.status, 409);
  await object.fetch(new Request('https://internal/disconnect', { method: 'POST' }));
  object = new HuyaAccount(ctx as any, env as any); const status = await (await object.fetch(new Request('https://internal/status'))).json();
  assert.equal(status.paused, true); assert.equal(status.configured, false); assert.equal(status.enabled, false);
});
test('Huya shared route requires panel authentication and same-origin writes and never exposes its internal tick', async () => {
  const calls: any[] = []; const e = { ...env, ADMIN_TOKEN: 'panel-' + 'a'.repeat(40), HUYA: { idFromName: x => x, get: () => ({ fetch: async (...args) => { calls.push(args); return Response.json({ configured: false }); } }) } };
  const auth = 'wc_session=' + await session(e.ADMIN_TOKEN), origin = 'https://panel.test';
  const request = (path, body?, headers = {}) => worker.fetch(new Request(origin + '/api/platforms/huya/' + path, { method: body === undefined ? 'GET' : 'POST', headers: { Cookie: auth, Origin: origin, 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }), e as any, {} as any);
  assert.equal((await request('status', undefined, { Cookie: '' })).status, 401);
  assert.equal((await request('run', {}, { Origin: 'https://other.test' })).status, 403);
  assert.equal((await request('tick', {})).status, 404); assert.equal(calls.length, 0);
  assert.equal((await request('status')).status, 200); assert.equal(calls[0][0], 'https://huya/status'); assert.equal(new Headers(calls[0][1].headers).get('Cookie'), null);
});
test('Huya serializes concurrent manual and cron runs, skips after success and persists once-per-day cron attempts', async () => {
  const data = initial(); data.credentials = await seal({ platform: 'huya', cookie }, env.ENCRYPTION_KEY); data.enabled = true; data.time = '00:00';
  const values = new Map([['state', data]]), ctx = { storage: { get: async k => structuredClone(values.get(k)), put: async (k, v) => { values.set(k, structuredClone(v)); } } };
  const original = globalThis.fetch; let inventoryReads = 0, sends = 0;
  try {
    globalThis.fetch = async (_url, init) => {
      if (String(_url) === 'https://www.huya.com/42') return new Response('<title>主播官方直播_虎牙直播</title><body data-lp="1234567890">');
      const envelope = decode(new Uint8Array(init!.body as Uint8Array).subarray(4)), func = envelope[6];
      if (func === 'getPackageGift') return response(func, { 0: { list: inventoryReads++ === 0 ? [{ struct: { 0: { struct: { 0: 4, 3: '虎粮' } }, 5: 35 } }] : [] }, 1: 1790000000 });
      if (func === 'getSequence') return response(func, { 0: 0, 1: 'order-1' }, 'sequenceui');
      if (func === 'consumeGiftSafe') { sends++; return response(func, { 0: 0, 1: 4, 2: 35, 3: 'order-1', 6: room.uid, 12: 0 }, 'PropsUIServer'); }
      throw Error('unexpected RPC');
    };
    const object = new HuyaAccount(ctx as any, env as any), call = action => object.fetch(new Request('https://internal/' + action, { method: 'POST' }));
    await Promise.all([call('run'), call('run'), call('tick'), call('tick')]); assert.equal(sends, 1); assert.equal(inventoryReads, 2);
    assert.equal(values.get('state')!.history.length, 1); assert.equal(values.get('state')!.history[0].code, 'SUCCESS');
    assert.match(values.get('state')!.attemptedDay!, /^\d{4}-\d{2}-\d{2}$/);
  } finally { globalThis.fetch = original; }
});
test('Huya QR login encrypts temporary sessions and cookies, exposes only the image, and closes the browser on completion', async () => {
  const values = new Map<string, any>(), ctx = { storage: { get: async k => values.get(k), put: async (k, v) => { values.set(k, v); }, delete: async k => values.delete(k), setAlarm: async at => values.set('alarm', at), deleteAlarm: async () => values.delete('alarm') } };
  let closed = 0, connected = false;
  const driver = { start: async () => ({ sessionId: 'private-browser-session', expiresAt: Date.now() + 180000, image: btoa('private-qr-image') }),
    poll: async () => connected ? { status: 'connected' as const, cookie } : { status: 'waiting' as const }, close: async () => { closed++; } };
  const object = new HuyaAccount(ctx as any, { ...env, BROWSER: {} } as any, driver);
  const call = action => object.fetch(new Request('https://internal/' + action, { method: 'POST' }));
  const start = await (await call('qrstart')).text(); assert.ok(!start.includes('private-browser-session')); assert.ok(!start.includes('private-qr-image'));
  assert.ok(!values.get('qr').includes('private-browser-session')); assert.ok(!values.get('qr').includes('private-qr-image'));
  const restored = await (await object.fetch(new Request('https://internal/status'))).text();
  assert.ok(!restored.includes('private-browser-session')); assert.ok(!restored.includes('private-qr-image')); assert.ok(JSON.parse(restored).qr.expiresAt > Date.now());
  const image = await object.fetch(new Request('https://internal/qrimage')); assert.equal(image.headers.get('Content-Type'), 'image/jpeg'); assert.equal(await image.text(), 'private-qr-image');
  assert.equal((await (await call('qrpoll')).json()).status, 'waiting');
  connected = true; const result = await (await call('qrpoll')).text(); assert.ok(!result.includes(cookie)); assert.equal(JSON.parse(result).status, 'connected');
  assert.equal(closed, 1); assert.equal(values.has('qr'), false); assert.equal(values.has('alarm'), false);
  const state = values.get('state'); assert.ok(!JSON.stringify(state).includes(cookie)); assert.equal((await open<any>(state.credentials, env.ENCRYPTION_KEY)).cookie, cookie);
});
test('Huya QR expiry and cancellation clear the private session without logging in or delivering gifts', async () => {
  const values = new Map<string, any>(), ctx = { storage: { get: async k => values.get(k), put: async (k, v) => values.set(k, v), delete: async k => values.delete(k), setAlarm: async () => {}, deleteAlarm: async () => {} } };
  let closes = 0, polls = 0;
  const driver = { start: async () => ({ sessionId: 'session', expiresAt: Date.now() - 1, image: btoa('qr') }), poll: async () => { polls++; return { status: 'waiting' as const }; }, close: async () => { closes++; } };
  const object = new HuyaAccount(ctx as any, { ...env, BROWSER: {} } as any, driver);
  const call = action => object.fetch(new Request('https://internal/' + action, { method: 'POST' }));
  await call('qrstart'); assert.equal((await object.fetch(new Request('https://internal/qrimage'))).status, 404);
  assert.equal((await (await call('qrpoll')).json()).status, 'expired'); assert.equal(polls, 0); assert.equal(closes, 1);
  await call('qrstart'); await call('qrcancel'); assert.equal(closes, 2); assert.equal(values.has('state'), false); assert.equal(values.has('qr'), false);
});
