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
    !['weibo.com', 'www.weibo.com', 's.weibo.com', 'login.sina.com.cn', 'passport.weibo.com', 'passport.weibo.cn', 'passport.sina.com.cn', 'passport.sina.cn'].includes(url.hostname)) {
    throw new WeiboError('protocol', `微博返回了不受支持的登录地址（${url.hostname}）`);
  }
  return url;
}
type Data = Record<string, any>;
export function parseTopicSearch(html: string, query: string): { id: string; name: string }[] {
  const decode = (value: string) => value.replace(/<[^>]*>/g, '').replace(/&#(x[\da-f]+|\d+);/gi, (_, raw: string) => {
    const code = raw[0].toLowerCase() === 'x' ? parseInt(raw.slice(1), 16) : Number(raw);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  }).replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
  const found = new Map<string, { id: string; name: string }>();
  for (const anchor of html.matchAll(/<a\b([^>]*?)>([\s\S]*?)<\/a>/gi)) {
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(anchor[1])?.[1];
    if (!href) continue;
    let url: URL;
    try { url = new URL(decode(href), 'https://s.weibo.com'); } catch { continue; }
    if (!['weibo.com', 'www.weibo.com'].includes(url.hostname)) continue;
    const id = /^\/p\/(100808[a-f0-9]{32})(?:\/|$)/i.exec(url.pathname)?.[1]?.toLowerCase();
    if (!id) continue;
    const title = /\btitle\s*=\s*["']([^"']+)["']/i.exec(anchor[1])?.[1];
    const name = decode(title || anchor[2]).replace(/^[#＃]|[#＃]$/g, '').replace(/超话$/, '').trim();
    if (!name || name.length > 60 || /^(?:进入|查看|更多|关注)/.test(name)) continue;
    if (!found.has(id)) found.set(id, { id, name });
  }
  const normalized = query.replace(/超话$/, '').trim().toLowerCase();
  return [...found.values()].sort((a, b) => Number(b.name.toLowerCase() === normalized) - Number(a.name.toLowerCase() === normalized)).slice(0, 12);
}
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
  loginStage = '查询扫码状态';
  constructor(jar: CookieJar, transport: typeof fetch = (...args) => fetch(...args)) { this.jar = jar; this.transport = transport; }
  async request(raw: string | URL, init: RequestInit = {}): Promise<Response> {
    let url = allowedURL(raw);
    let options = { ...init };
    for (let hop = 0; hop < 7; hop++) {
      const headers = new Headers(options.headers);
      headers.set('User-Agent', UA);
      headers.set('Referer', url.hostname === 's.weibo.com' ? 'https://s.weibo.com/' : 'https://weibo.com/');
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
  async searchTopics(query: string) {
    const url = new URL('https://s.weibo.com/weibo');
    url.searchParams.set('q', query.endsWith('超话') ? query : query + '超话');
    const response = await this.request(url);
    const html = await response.text();
    if (html.length > 2 * 1024 * 1024) throw new WeiboError('protocol', '微博搜索响应过大，请换一个关键词');
    if (/登录后查看|访问频次过高|访问频率过高|完成验证/.test(html)) throw new WeiboError('risk', '微博搜索暂时要求验证，请稍后再试或使用超话链接添加');
    return parseTopicSearch(html, query);
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
    this.loginStage = '查询扫码状态';
    const url = new URL('https://login.sina.com.cn/sso/qrcode/check');
    url.search = new URLSearchParams({ entry: 'weibo', qrid, callback: 'STK_poll', _: String(Date.now()) }).toString();
    const data = await this.json(url);
    const code = Number(data.retcode);
    if (code === 50114001) return 'pending';
    if (code === 50114002) return 'scanned';
    if ([50114003, 50114004].includes(code)) return 'expired';
    if (code !== 20000000 || typeof data.data?.alt !== 'string') throw new WeiboError('protocol', '扫码登录未完成，请重试或使用 Cookie 入口');
    this.loginStage = '兑换登录票据';
    const login = new URL('https://login.sina.com.cn/sso/login.php');
    login.search = new URLSearchParams({ entry: 'weibo', returntype: 'TEXT', crossdomain: '1', cdult: '3', domain: 'weibo.com', alt: data.data.alt, savestate: '30', callback: 'STK_login' }).toString();
    const result = await this.json(login);
    if (Number(result.retcode) !== 0 && Number(result.retcode) !== 20000000) throw new WeiboError('auth', '微博未接受扫码登录，请重试');
    if (!Array.isArray(result.crossDomainUrlList) || result.crossDomainUrlList.length > 6) throw new WeiboError('protocol', '微博跨域登录响应异常');
    let synced = false;
    for (const raw of result.crossDomainUrlList) {
      // SSO includes unrelated affiliated services. Only exchange the desktop Weibo session.
      const target = new URL(raw);
      if (!['passport.weibo.com', 'weibo.com', 'www.weibo.com'].includes(target.hostname)) continue;
      this.loginStage = '同步微博登录';
      const cross = allowedURL(raw);
      cross.searchParams.set('action', 'login');
      const response = await this.request(cross);
      await response.body?.cancel();
      synced = true;
    }
    if (!synced) throw new WeiboError('protocol', '扫码结果未包含微博登录地址');
    // Prime weibo.com's cookies (including XSRF) after SSO.
    this.loginStage = '初始化微博会话';
    const home = await this.request('https://weibo.com/');
    await home.body?.cancel();
    this.loginStage = '验证登录状态';
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
