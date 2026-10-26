import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.ts';
import { session } from '../src/crypto.ts';

const privateToken = 'node-service-private-' + 'a'.repeat(32);
async function setup(transport?: (url: string, init: RequestInit) => Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const env = { ADMIN_TOKEN: 'panel-' + 'b'.repeat(40), ENCRYPTION_KEY: btoa('k'.repeat(32)),
    ACCOUNT: { idFromName: () => 'one', get: () => ({ fetch: async () => Response.json({ login: 'valid', topics: [] }) }) },
    ASSETS: { fetch: async () => new Response('shell') }, NODESEEK_CREDENTIAL_KEY: privateToken,
    NODESEEK: { idFromName: () => 'one', get: () => ({ fetch: async (url: string, init: RequestInit) => { calls.push({ url: String(url), init }); return transport ? transport(String(url), init) : Response.json({}); } }) } };
  const cookie = 'wc_session=' + await session(env.ADMIN_TOKEN), base = 'https://panel.example.com';
  const call = (path: string, body?: unknown, headers: Record<string, string> = {}) => worker.fetch(new Request(base + '/api/' + path, {
    method: body === undefined ? 'GET' : 'POST', headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body)
  }), env, {});
  return { env, calls, call };
}
const entry = { date: '2026-10-26', ok: true, code: 'SUCCESS', gain: 0, claimedAt: '2026-10-26T01:00:00.000Z', cookie: 'never-return', token: privateToken };

test('platform registry and connector share panel auth, enforce Origin and never expose service credentials', async () => {
  const { call, calls } = await setup();
  for (const path of ['platforms', 'platforms/nodeseek/status', 'platforms/nodeseek/history']) {
    assert.equal((await call(path, undefined, { Cookie: '' })).status, 401);
    assert.equal((await call(path, undefined, { Cookie: 'wc_session=forged' })).status, 401);
  }
  assert.equal((await call('platforms/nodeseek/run', {}, { Origin: 'https://other.example.com' })).status, 403);
  assert.equal(calls.length, 0);
  const list = await (await call('platforms')).text(); assert.ok(!list.includes(privateToken)); assert.ok(list.includes('nodeseek'));
});

test('NodeSeek snapshot and history use fixed internal targets and an output allowlist; zero reward stays zero', async () => {
  const { call, calls } = await setup(async url => {
    if (url.endsWith('/status')) return Response.json({ date: '2026-10-26', record: entry, secret: privateToken });
    if (url.endsWith('/config')) return Response.json({ configured: true, random: true, cookie: 'never-return', encryptedCookie: { data: 'secret-cipher' },
      cookieHealth: { status: 'valid', code: 'VALID', checkedAt: entry.claimedAt, token: privateToken }, schedule: { start: '09:00', end: '12:00', retry: '14:00', nextAt: entry.claimedAt } });
    return Response.json({ records: [entry, { ...entry, gain: null }] });
  });
  const snapshot = await call('platforms/nodeseek/status', undefined, { Authorization: 'Bearer browser-token', 'Cf-Access-Jwt-Assertion': 'browser-jwt' });
  assert.equal(snapshot.status, 200); const raw = await snapshot.text();
  for (const secret of [privateToken, 'never-return', 'secret-cipher', 'browser-token', 'browser-jwt']) assert.ok(!raw.includes(secret));
  assert.equal(JSON.parse(raw).record.gain, 0);
  const history = await (await call('platforms/nodeseek/history?month=2026-10')).json();
  assert.deepEqual(history.records.map(r => r.gain), [0, null]);
  for (const request of calls) {
    assert.equal(new URL(request.url).origin, 'https://platform.internal'); assert.equal(request.init.redirect, 'manual');
    const headers = new Headers(request.init.headers); assert.equal(headers.get('Authorization'), null);
    assert.equal(headers.get('Cookie'), null); assert.equal(headers.get('Cf-Access-Jwt-Assertion'), null); assert.equal(headers.get('Origin'), null);
  }
});

test('connector rejects unregistered operations and invalid inputs before contacting the service', async () => {
  const { call, calls } = await setup();
  for (const path of ['platforms/unknown/run', 'platforms/nodeseek/sync', 'platforms/nodeseek/pair', 'platforms/nodeseek/run']) assert.equal((await call(path)).status, 404);
  assert.equal((await call('platforms/nodeseek/history?month=https://evil.example')).status, 400);
  assert.equal((await call('platforms/nodeseek/config', { random: true, cookie: 'secret\r\nInjected: x' })).status, 400);
  assert.equal((await call('platforms/nodeseek/schedule', { start: '13:59', end: '14:00' })).status, 400);
  assert.equal((await call('platforms/nodeseek/schedule', { start: '12:00', end: '15:00' })).status, 400);
  assert.equal(calls.length, 0);
});

test('connector forwards only permitted settings and makes a single call for a manual run', async () => {
  const { call, calls } = await setup(async () => Response.json(entry));
  assert.equal((await call('platforms/nodeseek/config', { random: false, cookie: 'session=fake', userAgent: 'test', url: 'https://evil.example', enabled: true })).status, 200);
  assert.deepEqual(JSON.parse(calls[0].init.body as string), { random: false, enabled: true, cookie: 'session=fake', userAgent: 'test' });
  await call('platforms/nodeseek/schedule', { start: '10:00', end: '12:00', triggerNow: true });
  assert.deepEqual(JSON.parse(calls[1].init.body as string), { start: '10:00', end: '12:00' });
  const result = await (await call('platforms/nodeseek/run', { target: 'https://evil.example', random: false })).json();
  assert.equal(result.code, 'SUCCESS'); assert.equal(calls.filter(c => c.url.endsWith('/run')).length, 1);
  assert.deepEqual(JSON.parse(calls.at(-1)!.init.body as string), {});
});

test('unavailable or failing NodeSeek does not block Weibo and uncertain operations are never retried', async () => {
  const { env, call, calls } = await setup(async () => { throw new Error('private-details-' + privateToken); });
  assert.equal((await call('status')).status, 200);
  const result = await call('platforms/nodeseek/run', {}); assert.equal(result.status, 502); assert.ok(!(await result.text()).includes(privateToken)); assert.equal(calls.length, 1);
  env.NODESEEK_CREDENTIAL_KEY = '';
  assert.equal((await call('platforms/nodeseek/status')).status, 409);
  const list = await (await call('platforms')).json(); assert.equal(list.platforms.find(p => p.id === 'nodeseek').available, false);
  assert.equal((await call('status')).status, 200);
});

test('redirects, oversized responses and invalid success bodies fail closed without leaking upstream content', async () => {
  for (const response of [new Response(null, { status: 302, headers: { Location: 'https://evil.example/' } }), Response.json({ code: 'UNKNOWN', secret: privateToken }),
    new Response('x'.repeat(1024 * 1024 + 1))]) {
    const { call, calls } = await setup(async () => response);
    const result = await call('platforms/nodeseek/run', {}); assert.equal(result.status, 502); assert.ok(!(await result.text()).includes(privateToken)); assert.equal(calls.length, 1);
  }
});
