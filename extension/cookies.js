export const NODESEEK_ORIGINS = ['https://nodeseek.com/*', 'https://www.nodeseek.com/*'];
// Chromium checks an unmarked cookie against an http:// origin even on an HTTPS page.
// HTTP permission is only for cookie access; all navigation and sync stay HTTPS.
export const NODESEEK_COOKIE_PERMISSIONS = [...NODESEEK_ORIGINS, 'http://nodeseek.com/*', 'http://www.nodeseek.com/*'];
const ATTENDANCE_URL = 'https://www.nodeseek.com/api/attendance';
export function nodeSeekDomain(domain) {
  const host = typeof domain === 'string' ? domain.toLowerCase().replace(/^\./, '') : '';
  return host === 'www.nodeseek.com' || host === 'nodeseek.com';
}
export function cookieHeader(cookies) {
  return cookies.filter(c => c.value && nodeSeekDomain(c.domain))
    .sort((a, b) => b.path.length - a.path.length).map(c => `${c.name}=${c.value}`).join('; ');
}
export function hasLoginCookie(cookies) { return cookies.some(c => nodeSeekDomain(c.domain) && ['pjwt', 'session'].includes(c.name) && c.value); }
export async function readNodeSeekCookies(api = chrome) {
  const permissions = await Promise.all(NODESEEK_COOKIE_PERMISSIONS.map(origin => api.permissions.contains({ origins: [origin] })));
  const diagnostic = { permissions, tabs: 0, stores: 0, selectedStore: false, urlCookies: 0, partitionCookies: 0, domainCookies: 0, loginCookie: false, nonSecureCookies: 0 };
  if (permissions.some(granted => !granted)) return { cookies: [], diagnostic };
  const tabs = await api.tabs.query({ url: NODESEEK_ORIGINS });
  tabs.sort((a, b) => Number(b.active) - Number(a.active) || (b.lastAccessed || 0) - (a.lastAccessed || 0));
  const stores = await api.cookies.getAllCookieStores();
  diagnostic.tabs = tabs.length; diagnostic.stores = stores.length;
  // Read one tab's store; never combine normal and incognito accounts.
  const store = tabs[0] && stores.find(item => item.tabIds.includes(tabs[0].id));
  diagnostic.selectedStore = Boolean(store);
  const details = { url: ATTENDANCE_URL, ...(store ? { storeId: store.id } : {}) };
  const cookies = await api.cookies.getAll(details);
  diagnostic.urlCookies = cookies.length;
  if (tabs[0] && api.cookies.getPartitionKey) {
    try {
      const key = await api.cookies.getPartitionKey({ tabId: tabs[0].id, frameId: 0 });
      // Only the first-party NodeSeek partition, never another site's partition.
      if (key.partitionKey?.topLevelSite === 'https://nodeseek.com' && key.partitionKey.hasCrossSiteAncestor !== true) {
        const partitioned = await api.cookies.getAll({ ...details, partitionKey: key.partitionKey });
        const seen = new Set(cookies.map(cookie => JSON.stringify(cookie)));
        for (const cookie of partitioned) if (!seen.has(JSON.stringify(cookie))) cookies.push(cookie);
        diagnostic.partitionCookies = partitioned.length;
      }
    } catch { /* Older Chrome or a tab closed during the query: keep regular cookies. */ }
  }
  if (!cookieHeader(cookies)) {
    // Counts help distinguish URL/path filtering from an empty or inaccessible jar.
    // Cookie names and values are never included in the diagnostic.
    const domainCookies = await api.cookies.getAll({ domain: 'nodeseek.com', ...(store ? { storeId: store.id } : {}) });
    diagnostic.domainCookies = domainCookies.filter(c => nodeSeekDomain(c.domain)).length;
  }
  diagnostic.loginCookie = hasLoginCookie(cookies);
  diagnostic.nonSecureCookies = cookies.filter(cookie => nodeSeekDomain(cookie.domain) && !cookie.secure).length;
  return { cookies, diagnostic };
}
export function diagnosticText(d, version) {
  return `诊断 v${version}\nHTTPS 根域：${d.permissions[0] ? '允许' : '缺少'}；www：${d.permissions[1] ? '允许' : '缺少'}\n普通 Cookie 根域：${d.permissions[2] ? '允许' : '缺少'}；www：${d.permissions[3] ? '允许' : '缺少'}\nNodeSeek 标签：${d.tabs}；Cookie 存储区：${d.stores}；匹配标签存储区：${d.selectedStore ? '是' : '否'}\n接口 Cookie：${d.urlCookies}；普通 Cookie：${d.nonSecureCookies}；登录 Cookie：${d.loginCookie ? '已发现' : '未发现'}\n本站分区 Cookie：${d.partitionCookies}；空结果时域名查询：${d.domainCookies}\n仅包含数量和权限，不包含 Cookie 内容。`;
}
