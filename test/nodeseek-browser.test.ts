import test from 'node:test';
import assert from 'node:assert/strict';
import { checkIn, run, browserCookies, browserFetch, reconcile } from '../src/nodeseek/engine.js';

function fixture(responses = []) {
  const values = new Map(), calls = [], cookies = [];
  let launches = 0, closes = 0;
  const page = {
    setUserAgent: async ua => assert.equal(ua, 'TEST_UA'),
    setCookie: async (...items) => cookies.push(...items),
    goto: async url => { calls.push({ navigation: url }); },
    url: () => 'https://www.nodeseek.com/', content: async () => '<html>NodeSeek</html>',
    evaluate: async (fn, args) => { calls.push(args); assert.match(String(fn), /credentials: 'include'/); assert.equal('cookie' in args, false); assert.equal('token' in args, false); return responses.shift(); },
  };
  const env = {
    NS_TRANSPORT: 'browser', NODESEEK_COOKIE: 'session=SECRET_COOKIE=VALUE; pref=dark', NODESEEK_UA: 'TEST_UA', NS_RANDOM: 'false', BROWSER: {},
    STATE: { get: async key => values.has(key) ? JSON.parse(values.get(key)) : null, put: async (key, value) => values.set(key, value) },
  };
  const dependencies = { launchBrowser: async () => { launches++; return { newPage: async () => page, close: async () => { closes++; } }; }, fetch: async () => assert.fail('browser mode must not use Worker network fetch') };
  return { env, dependencies, calls, cookies, values, page, counts: () => ({ launches, closes }) };
}
const json = body => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

test('browser mode obtains a real receipt using only NodeSeek, closes the session and skips later cron launches', async () => {
  const f = fixture([json({ success: true, gain: 8, account: 'PRIVATE_ACCOUNT' })]);
  const report = await run(f.env, 'manual', f.dependencies);
  assert.equal(report.code, 'SUCCESS'); assert.equal(report.gain, 8); assert.equal(report.transport, 'browser');
  assert.deepEqual(f.counts(), { launches: 1, closes: 1 });
  assert.equal(f.calls[1].url, 'https://www.nodeseek.com/api/attendance?random=false'); assert.equal(f.calls[1].method, 'POST');
  assert.equal(f.cookies[0].value, 'SECRET_COOKIE=VALUE'); assert.equal(f.cookies[0].httpOnly, true);
  const stored = [...f.values.values()].join(''); assert.equal(stored.includes('SECRET_COOKIE'), false); assert.equal(stored.includes('PRIVATE_ACCOUNT'), false);
  assert.equal((await run(f.env, 'cron', f.dependencies)).code, 'SKIPPED'); assert.equal(f.counts().launches, 1);
});

test('already signed uses the same browser for a filtered earnings ledger, without storing balances', async () => {
  const f = fixture([json({ message: '今天已完成签到' }), json({ success: true, data: [[5, 12345, '签到收益 5 个鸡腿', '2026-10-23T01:00:00Z'], [90, 12345, '私密转账', '2026-10-23T02:00:00Z']] })]);
  f.dependencies.now = () => Date.parse('2026-10-23T13:00:00Z');
  const report = await run(f.env, 'manual', f.dependencies);
  assert.equal(report.code, 'ALREADY'); assert.equal(report.gain, 5); assert.equal(report.ledgerAt, '2026-10-23T01:00:00.000Z');
  assert.deepEqual(f.counts(), { launches: 1, closes: 1 }); assert.match(f.calls[2].url, /credit\/page-1$/);
  assert.equal(JSON.stringify(report).includes('12345'), false); assert.equal(JSON.stringify(report).includes('私密'), false);
});

test('browser API failure closes session and does not pretend success or leak exception details', async () => {
  const f = fixture(); f.page.evaluate = async () => { throw Error('SECRET_COOKIE=VALUE'); };
  f.dependencies.sleep = async () => {};
  const result = await checkIn(f.env, f.dependencies);
  assert.equal(result.ok, false); assert.equal(result.code, 'NETWORK'); assert.equal(JSON.stringify(result).includes('SECRET'), false); assert.equal(f.counts().closes, 1);
});

test('unusable cookie and browser quota failures do not retry browser launches or expose credentials', async () => {
  const f = fixture(); delete f.env.NODESEEK_COOKIE;
  assert.equal((await run(f.env, 'manual', f.dependencies)).code, 'CONFIG'); assert.equal(f.counts().launches, 0);
  f.env.NODESEEK_COOKIE = 'session=SECRET'; let calls = 0;
  f.dependencies.launchBrowser = async () => { calls++; throw Error('429 Browser time limit exceeded SECRET'); };
  const report = await checkIn(f.env, f.dependencies); assert.equal(report.code, 'BROWSER_LIMIT'); assert.equal(calls, 1); assert.equal(JSON.stringify(report).includes('SECRET'), false);
});

test('browser warning pages stop before posting, and API adapter rejects cross-origin or unrelated paths', async () => {
  const f = fixture(); f.page.url = () => 'https://warning.nodeseek.com/';
  assert.equal((await checkIn(f.env, f.dependencies)).code, 'CHALLENGE'); assert.equal(f.calls.length, 1); assert.equal(f.counts().closes, 1);
  for (const url of ['https://evil.example/api/attendance', 'https://www.nodeseek.com/api/account/signIn']) await assert.rejects(browserFetch(f.page)(url));
  const cookies = browserCookies('session=FIRST=VALUE; session=LAST; other=ok'); assert.equal(cookies[0].value, 'FIRST=VALUE'); assert.ok(cookies.every(c => c.url === 'https://www.nodeseek.com'));
});

test('monthly reconciliation also runs in the cloud browser and closes it', async () => {
  const f = fixture([json({ success: true, data: [] })]);
  const report = await reconcile(f.env, '2026-10', f.dependencies);
  assert.equal(report.ok, true); assert.equal(report.pages, 1); assert.deepEqual(f.counts(), { launches: 1, closes: 1 });
});
