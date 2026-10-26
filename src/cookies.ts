export interface Cookie {
  name: string; value: string; domain: string; path: string;
  hostOnly: boolean; secure: boolean; expires?: number;
}
function domainMatches(host: string, domain: string) {
  return host === domain || host.endsWith('.' + domain);
}
export class CookieJar {
  cookies: Cookie[];
  constructor(cookies: Cookie[] = []) { this.cookies = cookies; }
  static fromHeader(header: string) {
    if (!header || header.length > 24000 || /[\r\n]/.test(header)) throw new Error('Cookie 格式不正确');
    const jar = new CookieJar();
    for (const pair of header.trim().split(';')) {
      const i = pair.indexOf('=');
      if (i < 1) continue;
      const name = pair.slice(0, i).trim(), value = pair.slice(i + 1).trim();
      if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(name) || /[\x00-\x20\x7f]/.test(value)) throw new Error('Cookie 格式不正确');
      jar.cookies.push({ name, value, domain: 'weibo.com', path: '/', hostOnly: false, secure: true });
    }
    if (!jar.cookies.some(c => c.name === 'SUB' && c.value)) throw new Error('请复制完整 Cookie，其中必须包含 SUB');
    return jar;
  }
  header(url: URL, now = Date.now()) {
    return this.cookies.filter(c => (!c.expires || c.expires > now) &&
      (c.hostOnly ? c.domain === url.hostname : domainMatches(url.hostname, c.domain)) &&
      (url.pathname === c.path || (url.pathname.startsWith(c.path) && (c.path.endsWith('/') || url.pathname[c.path.length] === '/'))) &&
      (!c.secure || url.protocol === 'https:'))
      .sort((a, b) => b.path.length - a.path.length).map(c => `${c.name}=${c.value}`).join('; ');
  }
  absorb(url: URL, headers: Headers, now = Date.now()) {
    for (const raw of headers.getSetCookie()) {
      const [pair, ...attributes] = raw.split(';');
      const i = pair.indexOf('=');
      if (i < 1) continue;
      const c: Cookie = { name: pair.slice(0, i).trim(), value: pair.slice(i + 1).trim(), domain: url.hostname,
        path: url.pathname.slice(0, url.pathname.lastIndexOf('/') + 1) || '/', hostOnly: true, secure: false };
      let maxAge: number | undefined;
      let valid = true;
      for (const part of attributes) {
        const [rawName, ...rest] = part.trim().split('=');
        const name = rawName.toLowerCase(), value = rest.join('=');
        if (name === 'domain') {
          const domain = value.toLowerCase().replace(/^\./, '');
          // Only permit the service's registrable domains, never .com / .cn.
          if (!['weibo.com', 'sina.com.cn', 'weibo.cn', 'sina.cn'].some(d => domain === d || domain.endsWith('.' + d)) || !domainMatches(url.hostname, domain)) valid = false;
          c.domain = domain; c.hostOnly = false;
        }
        if (name === 'path' && value.startsWith('/')) c.path = value;
        if (name === 'secure') c.secure = true;
        if (name === 'expires' && Number.isFinite(Date.parse(value))) c.expires = Date.parse(value);
        if (name === 'max-age' && /^-?\d+$/.test(value)) maxAge = Number(value);
      }
      if (!valid) continue;
      if (maxAge !== undefined) c.expires = now + maxAge * 1000;
      this.cookies = this.cookies.filter(old => !(old.name === c.name && old.domain === c.domain && old.path === c.path));
      if (c.expires === undefined || c.expires > now) this.cookies.push(c);
    }
  }
}
