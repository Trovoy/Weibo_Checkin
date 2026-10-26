import { type Env, WeiboAccount } from './account.ts';
import { sameSecret, session, validSession, unbase64 } from './crypto.ts';
export { WeiboAccount };

function secure(response: Response) {
  const result = new Response(response.body, response);
  result.headers.set('Cache-Control', 'no-store');
  result.headers.set('X-Content-Type-Options', 'nosniff');
  result.headers.set('Referrer-Policy', 'no-referrer');
  result.headers.set('X-Frame-Options', 'DENY');
  result.headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
  result.headers.set('Strict-Transport-Security', 'max-age=15552000');
  result.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  result.headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https://*.sina.com.cn https://*.weibo.com https://*.sinaimg.cn https://v2.qr.weibo.cn; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  return result;
}
function json(data: unknown, status = 200) { return Response.json(data, { status }); }
function configured(env: Env) {
  try { return env.ADMIN_TOKEN?.length >= 32 && unbase64(env.ENCRYPTION_KEY).length === 32; } catch { return false; }
}
async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
  if (!configured(env)) return json({ error: '请先设置 ADMIN_TOKEN（至少 32 字符）和 ENCRYPTION_KEY（32 字节 Base64）' }, 503);
  if (!['GET', 'POST'].includes(request.method)) return json({ error: '不支持的请求方法' }, 405);
  // All browser writes, including login, require a same-origin JSON request.
  if (request.method === 'POST') {
    if (request.headers.get('Origin') !== url.origin || !request.headers.get('Content-Type')?.startsWith('application/json')) {
      return json({ error: '请求来源不正确' }, 403);
    }
    if (Number(request.headers.get('Content-Length')) > 32768) return json({ error: '请求过大' }, 413);
    const reader = request.body?.getReader();
    const chunks: Uint8Array[] = []; let size = 0;
    if (reader) while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 32768) { await reader.cancel(); return json({ error: '请求过大' }, 413); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const body = new TextDecoder().decode(bytes);
    try {
      const parsed = JSON.parse(body);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    } catch { return json({ error: '请求必须为 JSON 对象' }, 400); }
    request = new Request(request.url, { method: 'POST', headers: request.headers, body });
  }
  const secureFlag = url.protocol === 'https:' ? '; Secure' : '';
  if (url.pathname === '/api/session' && request.method === 'POST') {
    const input = await request.json() as { token?: unknown };
    if (typeof input.token !== 'string' || !await sameSecret(input.token, env.ADMIN_TOKEN)) return json({ error: '管理密钥不正确' }, 401);
    return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json',
      'Set-Cookie': `wc_session=${await session(env.ADMIN_TOKEN)}; HttpOnly; SameSite=Strict; Path=/api/; Max-Age=43200${secureFlag}` } });
  }
  const value = /(?:^|;\s*)wc_session=([^;]+)/.exec(request.headers.get('Cookie') ?? '')?.[1];
  if (!value || !await validSession(value, env.ADMIN_TOKEN)) return json({ error: '请使用管理密钥解锁控制台' }, 401);
  if (url.pathname === '/api/session/logout' && request.method === 'POST') return new Response('{}', { headers: { 'Content-Type': 'application/json',
    'Set-Cookie': `wc_session=; HttpOnly; SameSite=Strict; Path=/api/; Max-Age=0${secureFlag}` } });
  const stub = env.ACCOUNT.get(env.ACCOUNT.idFromName('personal-account'));
  return stub.fetch(request);
}
export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      url.protocol = 'https:';
      return secure(Response.redirect(url.href, 308));
    }
    try { return secure(await handle(request, env)); }
    catch { return secure(json({ error: '服务暂不可用，请检查 Worker 配置' }, 500)); }
  },
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    if (!configured(env)) return;
    const stub = env.ACCOUNT.get(env.ACCOUNT.idFromName('personal-account'));
    ctx.waitUntil((async () => {
      const response = await stub.fetch('https://account/internal/cron', { method: 'POST' });
      if (!response.ok) throw new Error('Scheduled check-in could not start');
    })());
  }
} satisfies ExportedHandler<Env>;
