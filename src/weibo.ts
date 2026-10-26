import { CookieJar } from './cookies.ts';
export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
export type FailureKind = 'auth' | 'risk' | 'network' | 'protocol' | 'business';
export class WeiboError extends Error {
  kind: FailureKind;
  constructor(kind: FailureKind, message: string) { super(message); this.kind = kind; }
}
export function allowedURL(raw: string | URL): URL {
  const url = new URL(raw.toString());
  if (url.protocol === 'http:') url.protocol = 'https:';
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') ||
    !['weibo.com', 'www.weibo.com', 'login.sina.com.cn', 'passport.weibo.com', 'passport.weibo.cn', 'passport.sina.com.cn', 'passport.sina.cn'].includes(url.hostname)) {
    throw new WeiboError('protocol', '微博返回了不受支持的登录地址');
  }
  return url;
}
type Data = Record<string, any>;
export function parsePayload(text: string): Data {
  const body = text.trim();
  try {
    const match = /^(?:(?:window\.)?([A-Za-z_$][\w$]*|\d+)\s*&&\s*)?([A-Za-z_$][\w$]*|\d+)\s*\(([\s\S]*)\)\s*;?$/.exec(body);
    if (match?.[1] && match[1] !== match[2]) throw new Error();
    const data: unknown = JSON.parse(match ? match[3] : body);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data as Data;
  } catch { throw new WeiboError('protocol', '微博返回非预期响应，可能需要验证，已停止操作'); }
}
export class WeiboClient {
  jar: CookieJar;
  transport: typeof fetch;
  constructor(jar: CookieJar, transport: typeof fetch = (...args) => fetch(...args)) { this.jar = jar; this.transport = transport; }
  async request(raw: string | URL, init: RequestInit = {}): Promise<Response> {
    let url = allowedURL(raw);
    let options = { ...init };
    for (let hop = 0; hop < 7; hop++) {
      const headers = new Headers(options.headers);
      headers.set('User-Agent', UA);
      headers.set('Referer', 'https://weibo.com/');
      headers.set('Cookie', this.jar.header(url));
      headers.set('Accept', 'application/json, text/plain, */*');
      if (url.hostname === 'weibo.com') {
        headers.set('X-Requested-With', 'XMLHttpRequest');
        const token = /(?:^|; )XSRF-TOKEN=([^;]*)/.exec(this.jar.header(url))?.[1];
        if (token) {
          try { headers.set('X-Xsrf-Token', decodeURIComponent(token)); } catch { /* Ignore malformed XSRF token. */ }
        }
      }
      let response: Response;
      try { response = await this.transport(url, { ...options, headers, redirect: 'manual', signal: AbortSignal.timeout(15000) }); }
      catch { throw new WeiboError('network', '连接微博失败或超时，请稍后重试'); }
      this.jar.absorb(url, response.headers);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('Location');
        await response.body?.cancel();
        if (!location) throw new WeiboError('protocol', '微博跳转缺少目标地址');
        const next = allowedURL(new URL(location, url));
        // An API redirect to SSO is an expired session, never follow it with a POST body.
        if (url.hostname === 'weibo.com' && url.pathname.startsWith('/ajax') && next.hostname !== 'weibo.com') {
          throw new WeiboError('auth', '微博登录已失效，请重新扫码');
        }
        if (next.pathname.includes('security') || next.pathname.includes('verify')) throw new WeiboError('risk', '微博要求安全验证，请先在官方客户端完成验证');
        if (response.status === 303 || ([301, 302].includes(response.status) && options.method === 'POST')) options = {};
        url = next;
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 401) throw new WeiboError('auth', '微博登录已失效，请重新扫码');
        if ([403, 418, 429].includes(response.status)) throw new WeiboError('risk', `微博拒绝访问（HTTP ${response.status}），请在官方客户端检查账号`);
        throw new WeiboError('network', `微博服务暂不可用（HTTP ${response.status}）`);
      }
      return response;
    }
    throw new WeiboError('protocol', '微博登录跳转次数过多');
  }
  async json(raw: string | URL, init?: RequestInit) {
    const response = await this.request(raw, init);
    const text = await response.text();
    if (text.length > 1024 * 1024) throw new WeiboError('protocol', '微博响应过大');
    const data = parsePayload(text);
    if (Number(data.ok) === -100 || ['100001', '21301', '21314', '21315', '21327', '100005'].includes(String(data.code))) {
      throw new WeiboError('auth', '微博登录已失效，请重新扫码');
    }
    return data;
  }
  async validate() {
    const data = await this.json('https://weibo.com/ajax/setting/getPrivacy');
    if (Number(data.ok) !== 1 || !data.data || !Object.hasOwn(data.data, 'privacy')) {
      throw new WeiboError('auth', '未能确认微博登录状态，请重新登录');
    }
  }
  async createQR() {
    const data = await this.json(`https://login.sina.com.cn/sso/qrcode/image?entry=weibo&size=180&callback=STK_qr&_=${Date.now()}`);
    if (Number(data.retcode) !== 20000000 || typeof data.data?.qrid !== 'string' || typeof data.data?.image !== 'string') {
      throw new WeiboError('protocol', '微博暂未提供登录二维码，请使用 Cookie 备用入口');
    }
    const image = new URL(data.data.image, 'https://login.sina.com.cn');
    if (image.protocol === 'http:') image.protocol = 'https:';
    if (image.protocol !== 'https:' || image.username || image.password || (image.port && image.port !== '443') || !(image.hostname === 'v2.qr.weibo.cn' || ['sina.com.cn', 'weibo.com', 'sinaimg.cn'].some(d => image.hostname === d || image.hostname.endsWith('.' + d)))) {
      throw new WeiboError('protocol', '微博返回了不受支持的二维码地址');
    }
    return { qrid: data.data.qrid as string, image: image.href };
  }
  async pollQR(qrid: string): Promise<'pending' | 'scanned' | 'expired' | 'ok'> {
    const url = new URL('https://login.sina.com.cn/sso/qrcode/check');
    url.search = new URLSearchParams({ entry: 'weibo', qrid, callback: 'STK_poll', _: String(Date.now()) }).toString();
    const data = await this.json(url);
    const code = Number(data.retcode);
    if (code === 50114001) return 'pending';
    if (code === 50114002) return 'scanned';
    if ([50114003, 50114004].includes(code)) return 'expired';
    if (code !== 20000000 || typeof data.data?.alt !== 'string') throw new WeiboError('protocol', '扫码登录未完成，请重试或使用 Cookie 入口');
    const login = new URL('https://login.sina.com.cn/sso/login.php');
    login.search = new URLSearchParams({ entry: 'weibo', returntype: 'TEXT', crossdomain: '1', cdult: '3', domain: 'weibo.com', alt: data.data.alt, savestate: '30', callback: 'STK_login' }).toString();
    const result = await this.json(login);
    if (Number(result.retcode) !== 0 && Number(result.retcode) !== 20000000) throw new WeiboError('auth', '微博未接受扫码登录，请重试');
    if (!Array.isArray(result.crossDomainUrlList) || result.crossDomainUrlList.length > 6) throw new WeiboError('protocol', '微博跨域登录响应异常');
    for (const [i, raw] of result.crossDomainUrlList.entries()) {
      const cross = allowedURL(raw);
      if (i === 0) cross.searchParams.set('action', 'login');
      const response = await this.request(cross);
      await response.body?.cancel();
    }
    // Prime weibo.com's cookies (including XSRF) after SSO.
    const home = await this.request('https://weibo.com/');
    await home.body?.cancel();
    await this.validate();
    return 'ok';
  }
  async checkin(id: string): Promise<'success' | 'already'> {
    const data = await this.json('https://weibo.com/ajax_proxy/chaohua/page/checkin', {
      method: 'POST',
      body: new URLSearchParams({ scene_id: 'pc_checkin', page_id: id, timezone: 'Asia/Shanghai', lang: 'zh-cn', plat: 'Win32', ua: UA })
    });
    if (String(data.code) === '100000') return 'success';
    if (String(data.code) === '382004') return 'already';
    // Never echo upstream text: it can contain credentials, HTML, or an arbitrary URL.
    if (/验证|频繁|安全|风控/.test(String(data.msg ?? data.message ?? ''))) throw new WeiboError('risk', '微博要求安全验证或降低频率，本轮任务已停止');
    throw new WeiboError('business', `签到未成功（代码 ${/^\d{1,9}$/.test(String(data.code)) ? data.code : '未知'}）`);
  }
}
