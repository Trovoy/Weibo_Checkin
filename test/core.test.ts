import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CookieJar } from '../src/cookies.ts';
import { open, seal, session, validSession } from '../src/crypto.ts';
import { WeiboClient, WeiboError, allowedURL, parsePayload } from '../src/weibo.ts';
import { dayKey, topicsFromInput } from '../src/account.ts';

const key = btoa('a'.repeat(32));
test('encrypted credentials authenticate ciphertext and use a fresh IV', async () => {
  const a = await seal({ cookie: 'private' }, key), b = await seal({ cookie: 'private' }, key);
  assert.notEqual(a, b); assert.ok(!a.includes('private'));
  assert.deepEqual(await open(a, key), { cookie: 'private' });
  await assert.rejects(() => open(a, btoa('b'.repeat(32))));
  const [iv, data] = a.split('.');
  const bytes = Uint8Array.from(atob(data), x => x.charCodeAt(0)); bytes[0] ^= 1;
  await assert.rejects(() => open(iv + '.' + btoa(String.fromCharCode(...bytes)), key));
});
test('signed console session expires and invalidates when admin token changes', async () => {
  const token = await session('admin', 1000);
  assert.equal(await validSession(token, 'admin', 1000), true);
  assert.equal(await validSession(token, 'another', 1000), false);
  assert.equal(await validSession(token, 'admin', 1000 + 43200000), false);
  assert.equal(await validSession('not-a-session', 'admin'), false);
});
test('cookie jar isolates domains, paths, deletions, and expiry', () => {
  const jar = new CookieJar();
  jar.absorb(new URL('https://login.sina.com.cn/sso/login.php'), new Headers({ 'Set-Cookie': 'SUB=sina-secret; Domain=.sina.com.cn; Path=/; Secure' }));
  assert.equal(jar.header(new URL('https://weibo.com/')), '');
  jar.absorb(new URL('https://passport.weibo.com/'), new Headers({ 'Set-Cookie': 'SUB=weibo-secret; Domain=.weibo.com; Path=/; Secure' }));
  assert.equal(jar.header(new URL('https://weibo.com/ajax/setting')), 'SUB=weibo-secret');
  jar.absorb(new URL('https://weibo.com/ajax/test'), new Headers({ 'Set-Cookie': 'XSRF-TOKEN=abc; Path=/ajax; Max-Age=10' }), 1000);
  assert.ok(jar.header(new URL('https://weibo.com/ajax/test'), 2000).includes('XSRF-TOKEN=abc'));
  assert.ok(!jar.header(new URL('https://weibo.com/ajaxevil'), 2000).includes('XSRF'));
  assert.ok(!jar.header(new URL('https://weibo.com/ajax/test'), 12000).includes('XSRF'));
  jar.absorb(new URL('https://weibo.com/'), new Headers({ 'Set-Cookie': 'SUB=deleted; Domain=.weibo.com; Path=/; Max-Age=0' }));
  assert.equal(jar.header(new URL('https://weibo.com/')), '');
  assert.equal(jar.header(new URL('https://evilweibo.com/')), '');
  jar.absorb(new URL('https://weibo.com/'), new Headers({ 'Set-Cookie': 'bad=1; Domain=.com; Path=/' }));
  assert.ok(!jar.cookies.some(c => c.name === 'bad'));
});
test('manual Cookie parsing preserves equals signs and rejects header injection', () => {
  const jar = CookieJar.fromHeader('SUB=a=b; XSRF-TOKEN=hello%20world');
  assert.equal(jar.header(new URL('https://weibo.com/')), 'SUB=a=b; XSRF-TOKEN=hello%20world');
  assert.throws(() => CookieJar.fromHeader('SUB=x\r\nX-Other: true'));
  assert.throws(() => CookieJar.fromHeader('SUBP=only'));
});
test('JSONP is parsed as data and untrusted destinations are rejected', () => {
  assert.deepEqual(parsePayload('STK_123({"retcode":20000000,"data":{"value":"(hello)"}});'), { retcode: 20000000, data: { value: '(hello)' } });
  assert.deepEqual(parsePayload('123({"retcode":0})'), { retcode: 0 });
  assert.deepEqual(parsePayload('window.STK_probe && STK_probe({"retcode":20000000});'), { retcode: 20000000 });
  assert.deepEqual(parsePayload('STK_probe && STK_probe({"retcode":0});'), { retcode: 0 });
  assert.throws(() => parsePayload('window.bad && good({"retcode":0});'));
  assert.throws(() => parsePayload('<html>login</html>'), WeiboError);
  assert.throws(() => parsePayload('callback({});alert(1)'), WeiboError);
  for (const raw of ['https://weibo.com.evil.test/', 'https://127.0.0.1/', 'https://weibo.com:8080/', 'https://user@weibo.com/']) assert.throws(() => allowedURL(raw));
  assert.equal(allowedURL('http://passport.weibo.com/wbsso/login').protocol, 'https:');
});
test('client persists rotated cookies and sends XSRF only to weibo.com', async () => {
  const client = new WeiboClient(CookieJar.fromHeader('SUB=old; XSRF-TOKEN=token%2Babc'), async (_url, init) => {
    const headers = new Headers(init.headers);
    assert.equal(headers.get('X-Xsrf-Token'), 'token+abc');
    assert.equal(init.redirect, 'manual');
    return new Response('{"ok":1,"data":{"privacy":{}}}', { headers: { 'Set-Cookie': 'SUB=new; Domain=.weibo.com; Path=/; Secure' } });
  });
  await client.validate();
  assert.ok(client.jar.header(new URL('https://weibo.com/')).includes('SUB=new'));
});
test('client stops on login redirect, HTTP risk, unknown HTML, and auth business code', async () => {
  for (const [response, kind] of [
    [new Response('', { status: 302, headers: { Location: 'https://login.sina.com.cn/' } }), 'auth'],
    [new Response('', { status: 403 }), 'risk'],
    [new Response('<html>challenge</html>'), 'protocol'],
    [Response.json({ ok: -100 }), 'auth']
  ]) {
    const client = new WeiboClient(new CookieJar(), async () => response);
    await assert.rejects(() => client.validate(), error => error.kind === kind);
  }
});
test('check-in accepts numeric and string codes, rejects unknown business responses', async () => {
  for (const code of [100000, '100000', 382004, '382004', 900000]) {
    const client = new WeiboClient(new CookieJar(), async (url, init) => {
      assert.equal(new URL(url).pathname, '/ajax_proxy/chaohua/page/checkin');
      assert.equal(init.method, 'POST'); assert.equal(init.body.get('page_id'), 'topic');
      return Response.json({ code });
    });
    if (code === 900000) await assert.rejects(() => client.checkin('topic'), WeiboError);
    else assert.equal(await client.checkin('topic'), String(code) === '100000' ? 'success' : 'already');
  }
});
test('QR login retains domain cookies across SSO and verifies the final account', async () => {
  const seen = [];
  const client = new WeiboClient(new CookieJar(), async (raw, init) => {
    const url = new URL(raw); seen.push(url.href);
    const headers = new Headers(init.headers);
    if (url.pathname === '/sso/qrcode/image') return new Response('window.STK_qr && STK_qr({"retcode":20000000,"data":{"qrid":"private-id","image":"https://v2.qr.weibo.cn/qr.png"}});');
    if (url.pathname === '/sso/qrcode/check') return Response.json({ retcode: 20000000, data: { alt: 'private-ticket' } });
    if (url.pathname === '/sso/login.php') return Response.json({ retcode: 0, crossDomainUrlList: ['http://passport.weibo.com/wbsso/login?ticket=test'] });
    if (url.pathname === '/wbsso/login') {
      assert.equal(headers.get('Cookie'), ''); assert.equal(url.searchParams.get('action'), 'login');
      return new Response('{}', { headers: { 'Set-Cookie': 'SUB=final-secret; Domain=.weibo.com; Path=/; Secure' } });
    }
    assert.equal(headers.get('Cookie'), 'SUB=final-secret');
    if (url.pathname === '/ajax/setting/getPrivacy') return Response.json({ ok: 1, data: { privacy: {} } });
    return new Response('home');
  });
  assert.equal((await client.createQR()).qrid, 'private-id');
  assert.equal(await client.pollQR('private-id'), 'ok');
  assert.ok(seen.every(url => url.startsWith('https:')));
});
test('day boundary uses UTC+8 and topic configuration rejects duplicate IDs', () => {
  assert.equal(dayKey(new Date('2026-10-25T15:59:59Z')), '2026-10-25');
  assert.equal(dayKey(new Date('2026-10-25T16:00:00Z')), '2026-10-26');
  const topic = { name: ' 示例 ', id: '100808' + 'a'.repeat(32) };
  assert.equal(topicsFromInput([topic])[0].name, '示例');
  assert.throws(() => topicsFromInput([topic, topic]));
  assert.throws(() => topicsFromInput([{ name: 'bad', id: '100808wrong' }]));
});
