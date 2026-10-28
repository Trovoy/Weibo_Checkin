import { MORNING, validMorning, firstAt, planFor, claimAttempt, scheduleView } from '../schedule.ts';
// Native NodeSeek engine, maintained in this repository. No legacy panel or external Worker dependency.
const ORIGIN = 'https://www.nodeseek.com';
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';
const CONFIG_KEY = 'settings:v2';
const inFlight = new WeakMap();
const reconciling = new WeakSet();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const encoder = new TextEncoder();

export function localDate(time = Date.now()) {
  return new Date(time + 8 * 3600000).toISOString().slice(0, 10);
}
function result(code, ok, retryable = false, extra = {}) { return { ok, code, retryable, ...extra }; }
const DESCRIPTIONS = {
  RECONCILED: '已从 NodeSeek 账单补全签到记录', BUSY: '签到或账单查询进行中，请稍后重试',
  SUCCESS: '签到成功', ALREADY: 'NodeSeek 确认今天已完成签到', SKIPPED: '今天已有成功记录，跳过请求',
  AUTH: '登录失效或缺少权限，请更新 Cookie', CHALLENGE: '被网站验证或访问策略拦截',
  RATE_LIMIT: '请求被限流，等待下次计划运行', NETWORK: '网络错误或超时，未能确认签到结果',
  UPSTREAM: 'NodeSeek 暂时返回服务错误', RESPONSE: '接口返回内容不符合预期',
  CONFIG: '缺少 STATE、Cookie 或配置格式有误', STORAGE: '无法读取状态存储',
  BROWSER: '云端浏览器暂不可用，请稍后重试', BROWSER_LIMIT: '云端浏览器额度或并发已达上限，请等待后重试',
  CREDENTIAL: '无法解密账号配置，请核对 CREDENTIAL_KEY 或重新保存 Cookie', INTERNAL: '执行异常，请检查 Worker 配置',
};

export async function classify(response) {
  const status = response.status;
  if (response.headers.get('cf-mitigated') === 'challenge') return result('CHALLENGE', false);
  const text = await response.text();
  if (/just a moment|cf-chl-|challenge-platform|verify you are human|enable javascript and cookies/i.test(text)) return result('CHALLENGE', false);
  if (status >= 300 && status < 400) {
    const location = response.headers.get('location') || '';
    try {
      if (new URL(location, ORIGIN).hostname === 'warning.nodeseek.com') return result('CHALLENGE', false);
    } catch { /* Malformed redirects remain an unconfirmed response. */ }
    return result(/sign.?in|login/i.test(location) ? 'AUTH' : 'RESPONSE', false);
  }
  let data;
  try { data = JSON.parse(text); } catch { /* classified below */ }
  const message = typeof data?.message === 'string' ? data.message : '';
  if (status === 401 || data?.status === 404 || /USER NOT FOUND|not logged|unauthenticated|登录已过期|未登录|请先登录|登录失效/i.test(message)) return result('AUTH', false);
  if (status === 403) return result('CHALLENGE', false);
  if (/今天已完成签到|今日已完成签到|今天已经签到|今日已经签到|今天已签到|今日已签到|already (?:checked|signed)[ -]?in/i.test(message)) return result('ALREADY', true);
  if (response.ok && data?.success === true) {
    const fromMessage = message.match(/(?:今天|今日)的?签到收益(?:是|为|：|:)\s*(\d+)\s*个鸡腿/);
    const gain = Number.isSafeInteger(data.gain) && data.gain >= 0 ? data.gain : fromMessage ? Number(fromMessage[1]) : null;
    return result('SUCCESS', true, false, Number.isSafeInteger(gain) && gain >= 0 ? { gain } : {});
  }
  if (status === 429) {
    const raw = response.headers.get('retry-after');
    const seconds = raw && /^\d+$/.test(raw) ? Number(raw) : (raw ? (Date.parse(raw) - Date.now()) / 1000 : 2);
    const delayMs = Number.isFinite(seconds) ? Math.max(1000, seconds * 1000) : 2000;
    return result('RATE_LIMIT', false, delayMs <= 10000, { delayMs: Math.min(delayMs, 10000) });
  }
  if (status >= 500) return result('UPSTREAM', false, false);
  return result('RESPONSE', false);
}

export async function checkIn(env, dependencies = {}) {
  const pause = dependencies.sleep || sleep;
  const randomMode = String(env.NS_RANDOM ?? 'true');
  const cookie = typeof env.NODESEEK_COOKIE === 'string' ? env.NODESEEK_COOKIE.trim() : '';
  if (!cookie || /[\r\n]/.test(cookie) || !['true', 'false'].includes(randomMode)) return result('CONFIG', false, false, { attempts: 0 });
  if (env.NS_TRANSPORT === 'browser' && !dependencies.browserPage) {
    try { return await withCloudBrowser(env, page => checkIn(env, { ...dependencies, browserPage: page }), dependencies); }
    catch (error) { return result(browserError(error), false, false, { attempts: 0, transport: 'browser' }); }
  }
  const request = dependencies.browserPage ? browserFetch(dependencies.browserPage) : dependencies.fetch || globalThis.fetch;
  let outcome;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 15000);
    try {
      const response = await request(`${ORIGIN}/api/attendance?random=${randomMode}`, {
        method: 'POST', redirect: 'manual', signal: abort.signal,
        headers: { Cookie: cookie, 'User-Agent': env.NODESEEK_UA || DEFAULT_UA, Origin: ORIGIN, Referer: `${ORIGIN}/board`, Accept: 'application/json', 'Content-Type': 'application/json' },
        body: '{}',
      });
      outcome = await classify(response);
      if (dependencies.browserPage) outcome.transport = 'browser';
      // Public response metadata only; never retain upstream bodies or headers containing credentials.
      outcome.upstreamStatus = response.status;
      const contentType = response.headers.get('content-type') || '';
      outcome.upstreamFormat = /json/i.test(contentType) ? 'json' : /html/i.test(contentType) ? 'html' : 'other';
      if (response.status >= 300 && response.status < 400) {
        try {
          const target = new URL(response.headers.get('location'), ORIGIN);
          outcome.redirectHost = /^[a-z0-9.-]{1,253}$/i.test(target.hostname) ? target.hostname : 'other';
        } catch { outcome.redirectHost = 'invalid'; }
      }
    } catch { outcome = result('NETWORK', false, false); }
    finally { clearTimeout(timer); }
    outcome.attempts = attempt;
    if (outcome.ok || !outcome.retryable || attempt === 3) return outcome;
    await pause(outcome.delayMs ?? 1000 * 2 ** (attempt - 1));
  }
  return outcome;
}

function keyReady(env) { return typeof env.CREDENTIAL_KEY === 'string' && env.CREDENTIAL_KEY.length >= 32; }
async function encryptionKey(env) {
  if (!keyReady(env)) throw new Error('CREDENTIAL');
  const bytes = await crypto.subtle.digest('SHA-256', encoder.encode(env.CREDENTIAL_KEY));
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
function base64(bytes) { return btoa(String.fromCharCode(...bytes)); }
function unbase64(text) { return Uint8Array.from(atob(text), c => c.charCodeAt(0)); }
export async function encryptCookie(cookie, env) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const bytes = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode('nodeseek-cookie:v2') }, await encryptionKey(env), encoder.encode(cookie));
  return { iv: base64(iv), data: base64(new Uint8Array(bytes)) };
}
export async function decryptCookie(encrypted, env) {
  const bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unbase64(encrypted.iv), additionalData: encoder.encode('nodeseek-cookie:v2') }, await encryptionKey(env), unbase64(encrypted.data));
  return new TextDecoder().decode(bytes);
}

async function loadAccount(env) {
  const config = await env.STATE.get(CONFIG_KEY, 'json');
  let cookie = env.NODESEEK_COOKIE || env.NS_COOKIE;
  if (config?.encryptedCookie) {
    try { cookie = await decryptCookie(config.encryptedCookie, env); }
    catch { throw new Error('CREDENTIAL'); }
  }
  return { ...env, NODESEEK_COOKIE: cookie, NODESEEK_UA: config?.userAgent || env.NODESEEK_UA, NS_RANDOM: typeof config?.random === 'boolean' ? String(config.random) : (env.NS_RANDOM ?? 'true') };
}
async function configuration(env) {
  const config = await env.STATE.get(CONFIG_KEY, 'json');
  const paired = await env.STATE.get('sync-client:v4', 'json');
  let loginCookiePresent = null, cookieHealth;
  try {
    const cookie = config?.encryptedCookie ? await decryptCookie(config.encryptedCookie, env) : env.NODESEEK_COOKIE || env.NS_COOKIE || '';
    loginCookiePresent = /(?:^|;\s*)(?:pjwt|session)=[^;\s]+/.test(cookie);
    cookieHealth = await healthSnapshot(env, { ...env, NODESEEK_COOKIE: cookie, NODESEEK_UA: config?.userAgent || env.NODESEEK_UA });
  } catch { /* An unreadable credential is still reported by the execution path. */ }
  return {
    configured: Boolean(config?.encryptedCookie || env.NODESEEK_COOKIE || env.NS_COOKIE),
    enabled: config?.enabled === true,
    source: config?.encryptedCookie ? 'panel' : env.NODESEEK_COOKIE || env.NS_COOKIE ? 'secret' : 'none',
    browserSyncReady: syncReady(env),
    transport: env.NS_TRANSPORT === 'browser' ? 'browser' : 'fetch',
    loginCookiePresent,
    cookieHealth: cookieHealth || { status: 'unknown', code: 'CREDENTIAL', checkedAt: null, lastValidAt: null },
    browserPaired: Boolean(paired?.tokenHash), browserProtocol: paired?.protocol === 5 ? 5 : 4,
    syncedAt: config?.syncedAt || null,
    encryptionReady: keyReady(env), random: typeof config?.random === 'boolean' ? config.random : String(env.NS_RANDOM ?? 'true') === 'true',
    updatedAt: config?.updatedAt || null,
    schedule: await scheduleSnapshot(env),
    demo: env.DEMO_MODE === 'true',
  };
}
async function readBody(request) {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new Error('415');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('400');
  const chunks = [];
  let size = 0;
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    size += item.value.length;
    if (size > 16384) { await reader.cancel(); throw new Error('413'); }
    chunks.push(item.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new Error('400'); }
}
async function saveConfiguration(request, env) {
  const body = await readBody(request);
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.random !== 'boolean') return json({ error: 'random_must_be_boolean' }, 400);
  const cookie = typeof body.cookie === 'string' ? body.cookie.trim() : '';
  if (body.cookie !== undefined && typeof body.cookie !== 'string') return json({ error: 'invalid_cookie' }, 400);
  if (cookie && (/[\r\n]/.test(cookie) || cookie.length > 10000 || !cookie.includes('=') || /^Cookie:/i.test(cookie))) return json({ error: 'cookie_format_use_single_line_value_only' }, 400);
  if (cookie && !keyReady(env)) return json({ error: 'set_CREDENTIAL_KEY_min_32_characters' }, 503);
  if (body.userAgent !== undefined && (typeof body.userAgent !== 'string' || body.userAgent.length > 1024 || /[\r\n]/.test(body.userAgent))) return json({ error: 'invalid_user_agent' }, 400);
  const previous = await env.STATE.get(CONFIG_KEY, 'json') || {};
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') return json({ error: 'invalid_enabled' }, 400);
  const config = { ...previous, random: body.random, enabled: body.enabled ?? previous.enabled ?? false, updatedAt: new Date().toISOString() };
  if (body.userAgent !== undefined) config.userAgent = body.userAgent.trim();
  if (cookie) { config.encryptedCookie = await encryptCookie(cookie, env); config.syncedAt = null; }
  await env.STATE.put(CONFIG_KEY, JSON.stringify(config));
  return json({ ok: true, config: { configured: Boolean(config.encryptedCookie || env.NODESEEK_COOKIE || env.NS_COOKIE), source: config.encryptedCookie ? 'panel' : env.NODESEEK_COOKIE || env.NS_COOKIE ? 'secret' : 'none', encryptionReady: keyReady(env), random: config.random, updatedAt: config.updatedAt, syncedAt: config.syncedAt || null } });
}

function syncReady(env) {
  return keyReady(env);
}
async function syncBrowser(request, env) {
  if (!syncReady(env)) return json({ error: 'nodeseek_encryption_not_ready' }, 503);
  if (!env.STATE) return json({ error: 'missing_STATE_binding' }, 503);
  const authorization = request.headers.get('Authorization') || '';
  const paired = await env.STATE.get('sync-client:v4', 'json');
  const pairedAllowed = /^Bearer [A-Za-z0-9_-]{43}$/.test(authorization) && paired?.tokenHash === await digest(authorization.slice(7));
  if (!pairedAllowed) return json({ error: 'unauthorized' }, 401);
  const body = await readBody(request);
  const cookie = typeof body?.cookie === 'string' ? body.cookie.trim() : '';
  const ua = body?.userAgent;
  if (!cookie || cookie.length > 10000 || /[\r\n]/.test(cookie) || !cookie.includes('=') || /^Cookie:/i.test(cookie)) return json({ error: 'invalid_cookie' }, 400);
  if (!/(?:^|;\s*)(?:pjwt|session)=[^;\s]+/.test(cookie)) return json({ error: 'login_cookie_missing' }, 400);
  if (typeof ua !== 'string' || !ua || ua.length > 1024 || /[\r\n]/.test(ua)) return json({ error: 'invalid_user_agent' }, 400);
  const config = await env.STATE.get(CONFIG_KEY, 'json') || {};
  const syncedAt = new Date().toISOString();
  await env.STATE.put(CONFIG_KEY, JSON.stringify({ ...config, encryptedCookie: await encryptCookie(cookie, env), userAgent: ua, syncedAt, updatedAt: syncedAt }));
  // The sync token cannot query history, read configuration, or trigger check-in.
  return json({ ok: true, syncedAt });
}

// Public response shape verified against dragonff/NodeSeek's Python credit query.
// Store only attendance amount/time, never balance or unrelated ledger descriptions.
export function parseLedger(rows) {
  if (!Array.isArray(rows)) throw new Error('RESPONSE');
  const records = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 4) throw new Error('RESPONSE');
    const [raw, , description, timestamp] = row;
    if (typeof description !== 'string' || !description.includes('签到收益') || !description.includes('鸡腿')) continue;
    const gain = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN;
    const time = typeof timestamp === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(timestamp) ? Date.parse(timestamp) : NaN;
    if (!Number.isSafeInteger(gain) || gain < 0 || !Number.isFinite(time)) continue;
    records.push({ date: localDate(time), gain, ledgerAt: new Date(time).toISOString() });
  }
  return records;
}
async function readLedger(account, pages, dependencies = {}, month = null) {
  if (account.NS_TRANSPORT === 'browser' && !dependencies.browserPage) {
    try { return await withCloudBrowser(account, page => readLedger(account, pages, { ...dependencies, browserPage: page }, month), dependencies); }
    catch (error) { return { code: browserError(error), records: [], pages: 0, partial: true }; }
  }
  const request = dependencies.browserPage ? browserFetch(dependencies.browserPage) : dependencies.fetch || globalThis.fetch;
  const records = [];
  for (let page = 1; page <= pages; page++) {
    try {
      const response = await request(`${ORIGIN}/api/account/credit/page-${page}`, {
        redirect: 'manual', signal: AbortSignal.timeout(10000),
        headers: { Cookie: account.NODESEEK_COOKIE, 'User-Agent': account.NODESEEK_UA || DEFAULT_UA, Accept: 'application/json', Referer: `${ORIGIN}/board` },
      });
      const raw = await response.text();
      const copy = () => new Response(raw, { status: response.status, headers: response.headers });
      let data;
      try { data = JSON.parse(raw); } catch { return { code: (await classify(copy())).code, records, pages: page, partial: true }; }
      if (!response.ok || data?.success !== true) return { code: (await classify(copy())).code, records, pages: page, partial: true };
      if (!Array.isArray(data.data)) return { code: 'RESPONSE', records, pages: page, partial: true };
      records.push(...parseLedger(data.data));
      // Only stop by age when every row has a valid zoned timestamp and all
      // rows are older than the month. No assumption about the last row alone.
      const older = month && data.data.length && data.data.every(row => typeof row?.[3] === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(row[3]) && Number.isFinite(Date.parse(row[3])) && localDate(Date.parse(row[3])).slice(0, 7) < month);
      if (!data.data.length || older) return { code: 'SUCCESS', records, pages: page, partial: false };
    } catch (error) { return { code: error.message === 'RESPONSE' ? 'RESPONSE' : 'NETWORK', records, pages: page, partial: true }; }
    if (page < pages) await (dependencies.sleep || sleep)(500);
  }
  return { code: 'SUCCESS', records, pages, partial: true };
}
function uniqueDay(records, date) {
  const matches = records.filter(row => row.date === date);
  const distinct = [...new Map(matches.map(row => [`${row.ledgerAt}:${row.gain}`, row])).values()];
  return distinct.length === 1 ? distinct[0] : null;
}
export async function reconcile(env, month, dependencies = {}) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || month < '2020-01' || month > '2099-12') throw new Error('400');
  const account = await loadAccount(env);
  if (!account.NODESEEK_COOKIE) return { ok: false, code: 'CONFIG', updated: 0 };
  const ledger = await readLedger(account, 5, dependencies, month);
  let updated = 0, conflicts = 0;
  const now = new Date((dependencies.now || Date.now)()).toISOString();
  for (const date of new Set(ledger.records.filter(row => row.date.startsWith(month)).map(row => row.date))) {
    const entry = uniqueDay(ledger.records, date);
    if (!entry) { conflicts++; continue; }
    const key = `daily:${date}`, previous = await env.STATE.get(key, 'json');
    if (previous?.ok && Number.isSafeInteger(previous.gain) && previous.gain !== entry.gain) { conflicts++; continue; }
    if (previous?.ledgerAt === entry.ledgerAt && previous.gain === entry.gain && previous.ok) continue;
    await env.STATE.put(key, JSON.stringify({ ...previous, schema: 2, date, ok: true, code: previous?.ok ? previous.code : 'RECONCILED',
      source: previous?.source || 'ledger', gain: entry.gain, ledgerAt: entry.ledgerAt, verifiedAt: now,
      time: previous?.time || now, checkedAt: previous?.checkedAt || now, claimedAt: previous?.claimedAt || null,
      attempts: previous?.attempts || 0, runCount: previous?.runCount || 0, events: previous?.events || [],
    }));
    updated++;
  }
  return { ok: ledger.code === 'SUCCESS', code: ledger.code, updated, conflicts, pages: ledger.pages, partial: ledger.partial };
}

async function notify(env, report, request) {
  if (!env.TG_BOT_TOKEN || !env.TG_CHAT_ID || report.code === 'SKIPPED') return 'disabled_or_skipped';
  if ((env.NOTIFY_MODE || 'failure') !== 'all' && report.ok) return 'disabled_or_skipped';
  try {
    const response = await request(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000), headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TG_CHAT_ID, text: `NodeSeek ${report.date}\n${DESCRIPTIONS[report.code]}\n鸡腿：${report.gain ?? '未知'}；尝试：${report.attempts || 0}` }),
    });
    const data = await response.json();
    return response.ok && data.ok === true ? 'sent' : 'failed';
  } catch { return 'failed'; }
}

async function execute(env, source, dependencies) {
  const clock = dependencies.now || Date.now;
  const startedAt = new Date(clock()).toISOString();
  const date = localDate(clock());
  const base = { schema: 2, date, source, startedAt };
  if (!env.STATE?.get || !env.STATE?.put) return { ...base, ...result('CONFIG', false), attempts: 0 };
  const key = `daily:${date}`;
  let previous;
  try { previous = await env.STATE.get(key, 'json'); }
  catch { return { ...base, ...result('STORAGE', false), attempts: 0 }; }
  if (previous?.ok) return { ...previous, code: 'SKIPPED', attempts: 0, checkedAt: startedAt, message: DESCRIPTIONS.SKIPPED };
  let account, outcome;
  try { account = await loadAccount(env); }
  catch (error) { outcome = result(error.message === 'CREDENTIAL' ? 'CREDENTIAL' : 'STORAGE', false, false, { attempts: 0 }); }
  let ledgerEntry = null, ledgerStatus = 'not_needed';
  if (!outcome) {
    const perform = async deps => {
      if (previous && ['NETWORK', 'UPSTREAM', 'RESPONSE', 'BROWSER', 'BROWSER_LIMIT'].includes(previous.code)) {
        const ledger = await readLedger(account, 1, deps);
        ledgerEntry = uniqueDay(ledger.records, date);
        if (ledger.code !== 'SUCCESS' || (!ledgerEntry && ledger.partial)) outcome = result('NETWORK', false, false, { attempts: 0 });
        else if (ledgerEntry) outcome = result('ALREADY', true, false, { attempts: 0, gain: ledgerEntry.gain });
      }
      if (!outcome) outcome = await checkIn(account, deps);
      if (outcome.ok && (outcome.code === 'ALREADY' || !Number.isSafeInteger(outcome.gain))) {
        const ledger = await readLedger(account, 1, deps);
        ledgerStatus = ledger.code;
        ledgerEntry = uniqueDay(ledger.records, date);
      }
    };
    if (account.NS_TRANSPORT === 'browser' && typeof account.NODESEEK_COOKIE === 'string' && account.NODESEEK_COOKIE.trim() && !/[\r\n]/.test(account.NODESEEK_COOKIE) && ['true', 'false'].includes(String(account.NS_RANDOM ?? 'true'))) {
      try { await withCloudBrowser(account, page => perform({ ...dependencies, browserPage: page }), dependencies); }
      catch (error) { outcome = result(browserError(error), false, false, { attempts: 0, transport: 'browser' }); }
    } else await perform(dependencies);
  }
  const completedAt = new Date(clock()).toISOString();
  if (account?.NODESEEK_COOKIE && !['CONFIG', 'CREDENTIAL', 'STORAGE', 'BUSY'].includes(outcome.code)) {
    try { await recordCookieHealth(env, account, outcome.code, completedAt); }
    catch { /* A health-cache write must not hide the attendance result. */ }
  }
  const report = {
    ...base, ...outcome, time: completedAt, checkedAt: completedAt,
    // This is when our request confirmed success, not a claimed server timestamp.
    claimedAt: outcome.code === 'SUCCESS' ? completedAt : null,
    gain: Number.isSafeInteger(outcome.gain) ? outcome.gain : ledgerEntry?.gain ?? null,
    ledgerAt: ledgerEntry?.ledgerAt || null, ledgerStatus,
    random: String(account?.NS_RANDOM ?? 'true') === 'true',
    runCount: (previous?.runCount || (previous ? 1 : 0)) + 1,
    message: DESCRIPTIONS[outcome.code],
  };
  report.events = [...(previous?.events || []), { time: completedAt, source, code: report.code, attempts: report.attempts, gain: report.gain, ...(dependencies.scheduleSlot ? { slot: dependencies.scheduleSlot } : {}) }].slice(-20);
  report.notification = await notify(env, report, dependencies.fetch || globalThis.fetch);
  try {
    // No TTL: keep one small record per day until the owner deletes the namespace.
    await env.STATE.put(key, JSON.stringify(report));
    report.storage = 'saved';
  } catch { report.storage = 'failed'; }
  console.log(JSON.stringify({ date, source, code: report.code, ok: report.ok, gain: report.gain, attempts: report.attempts, storage: report.storage, notification: report.notification }));
  return report;
}
export async function run(env, source = 'manual', dependencies = {}) {
  if (!env || typeof env !== 'object') return result('CONFIG', false);
  if (reconciling.has(env) || credentialChecks.has(env)) return result('BUSY', false);
  const active = inFlight.get(env);
  if (active) return active;
  const pending = execute(env, source, dependencies);
  inFlight.set(env, pending);
  try { return await pending; } finally { inFlight.delete(env); }
}

function safeRecord(record) {
  if (!record) return null;
  return {
    schema: record.schema || 1, date: record.date, ok: record.ok === true, code: record.code,
    source: ['manual', 'cron', 'ledger'].includes(record.source) ? record.source : 'unknown',
    time: record.time || null, checkedAt: record.checkedAt || record.time || null,
    // v1 time was a request start time, so it cannot be called the claim time.
    claimedAt: record.schema === 2 ? record.claimedAt || null : null,
    ledgerAt: record.ledgerAt || null, verifiedAt: record.verifiedAt || null,
    gain: Number.isSafeInteger(record.gain) && record.gain >= 0 ? record.gain : null,
    random: typeof record.random === 'boolean' ? record.random : null,
    attempts: record.attempts || 0, runCount: record.runCount ?? 1,
    message: DESCRIPTIONS[record.code] || '历史记录',
    events: Array.isArray(record.events) ? record.events.map(e => ({ time: e.time, source: e.source, code: e.code, attempts: e.attempts || 0, gain: Number.isSafeInteger(e.gain) ? e.gain : null, ...(['primary', 'retry'].includes(e.slot) ? { slot: e.slot } : {}) })) : [],
  };
}
export async function history(env, month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || month < '2020-01' || month > '2099-12') throw new Error('400');
  const keys = [];
  let cursor;
  do {
    const page = await env.STATE.list({ prefix: `daily:${month}-`, limit: 1000, ...(cursor ? { cursor } : {}) });
    keys.push(...page.keys.map(key => key.name));
    if (page.list_complete) break;
    if (!page.cursor || page.cursor === cursor) throw new Error('STORAGE');
    cursor = page.cursor;
  } while (true);
  const records = (await Promise.all(keys.map(key => env.STATE.get(key, 'json')))).filter(Boolean).map(safeRecord).sort((a, b) => b.date.localeCompare(a.date));
  const completed = records.filter(r => r.ok);
  const known = completed.filter(r => r.gain !== null);
  return { month, records, summary: { recordedDays: records.length, completedDays: completed.length, knownGain: known.reduce((sum, r) => sum + r.gain, 0), unknownGainDays: completed.length - known.length } };
}
function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' } });
}


const url64 = bytes => base64(bytes).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
const randomSecret = () => url64(crypto.getRandomValues(new Uint8Array(32)));
export async function digest(value) { return url64(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))); }
const pairPattern = /^[A-Za-z0-9_-]{43}$/;
async function approvePair(request, env) {
  if (!keyReady(env)) return json({ error: 'pairing_not_ready' }, 503);
  const body = await readBody(request);
  if (!pairPattern.test(body?.flow || '') || !pairPattern.test(body?.challenge || '')) return json({ error: 'invalid_pair' }, 400);
  const key = 'pair:v4:' + body.flow;
  const previous = await env.STATE.get(key, 'json');
  if (previous) return json({ error: 'pair_already_approved' }, 409);
  const token = randomSecret(), tokenHash = await digest(token), expires = Date.now() + 600000;
  // One paired browser. A new pairing revokes the previous browser token.
  await env.STATE.put('sync-client:v4', JSON.stringify({ tokenHash, protocol: 5, pairedAt: new Date().toISOString() }));
  await env.STATE.put(key, JSON.stringify({ challenge: body.challenge, token: await encryptCookie(token, env), tokenHash, expires }), { expirationTtl: 600 });
  return json({ ok: true, expiresAt: new Date(expires).toISOString() });
}
async function pollPair(request, env) {
  if (!env.STATE || !keyReady(env)) return json({ error: 'pairing_not_ready' }, 503);
  const body = await readBody(request);
  if (!pairPattern.test(body?.flow || '') || !pairPattern.test(body?.verifier || '')) return json({ error: 'invalid_pair' }, 400);
  const record = await env.STATE.get('pair:v4:' + body.flow, 'json');
  if (!record || record.expires <= Date.now()) return json({ pending: true }, 202);
  if (await digest(body.verifier) !== record.challenge) return json({ error: 'invalid_proof' }, 403);
  const active = await env.STATE.get('sync-client:v4', 'json');
  if (!active || active.tokenHash !== record.tokenHash) return json({ error: 'pair_revoked' }, 410);
  return json({ ok: true, token: await decryptCookie(record.token, env) });
}

// Only public response metadata leaves this diagnostic; no IP, cookie or body is logged.
const NS_ORIGIN = 'https://www.nodeseek.com';
export function browserCookies(header) {
  const cookies = new Map();
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    const name = part.slice(0, index).trim(), value = part.slice(index + 1).trim();
    if (!cookies.has(name)) cookies.set(name, { name, value, url: NS_ORIGIN, secure: true, httpOnly: true, path: '/' });
  }
  return [...cookies.values()];
}
function browserError(error) {
  if (['CHALLENGE', 'AUTH', 'BROWSER_LIMIT'].includes(error.message)) return error.message;
  return /429|browser time limit|concurrent.*limit/i.test(error.message || '') ? 'BROWSER_LIMIT' : 'BROWSER';
}
export async function withCloudBrowser(account, operation, dependencies = {}) {
  let browser;
  try {
    if (!account.BROWSER) throw Error('BROWSER');
    const launch = dependencies.launchBrowser || (async binding => (await import('@cloudflare/puppeteer')).default.launch(binding));
    browser = await launch(account.BROWSER);
    const page = await browser.newPage();
    await page.setUserAgent(account.NODESEEK_UA || DEFAULT_UA);
    await page.setCookie(...browserCookies(account.NODESEEK_COOKIE));
    await page.goto(NS_ORIGIN + '/', { timeout: 20000, waitUntil: 'domcontentloaded' });
    if (new URL(page.url()).origin !== NS_ORIGIN) throw Error('CHALLENGE');
    if (/just a moment|cf-chl-|challenge-platform|verify you are human|enable javascript and cookies/i.test(await page.content())) throw Error('CHALLENGE');
    return await operation(page);
  } catch (error) { throw Error(browserError(error)); }
  finally { if (browser) await browser.close().catch(() => {}); }
}
export function browserFetch(page) {
  return async (url, options = {}) => {
    const target = new URL(url);
    if (target.origin !== NS_ORIGIN || !/^\/api\/(attendance|account\/credit\/page-\d+)$/.test(target.pathname)) throw Error('BROWSER');
    const raw = await page.evaluate(async ({ url, method, body }) => {
      const response = await fetch(url, {
        method, credentials: 'include', redirect: 'manual', signal: AbortSignal.timeout(15000),
        headers: { Accept: 'application/json', ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
        ...(method === 'POST' ? { body } : {}),
      });
      const text = await response.text();
      return { status: response.status, contentType: response.headers.get('content-type') || '', body: text.length <= 65536 ? text : '' };
    }, { url: target.href, method: options.method || 'GET', body: options.body || '{}' });
    // An opaque redirect is deliberately not followed. No cookie can reach another origin.
    if (!raw.status) return new Response(null, { status: 302 });
    return new Response(raw.body, { status: raw.status, headers: { 'Content-Type': raw.contentType } });
  };
}
const HEALTH_KEY = 'cookie-health:v1';
const SCHEDULE_KEY = 'schedule-settings:v1';
const credentialChecks = new WeakMap();
const scheduleTicks = new WeakMap();
const DEFAULT_WINDOW = MORNING;
const CRONS = ['* * * * *'];
const retryable = code => ['NETWORK', 'UPSTREAM', 'RATE_LIMIT', 'BROWSER', 'BROWSER_LIMIT', 'BUSY', 'RESPONSE'].includes(code);
const scheduleSeed = env => keyReady(env) ? env.CREDENTIAL_KEY : env.ADMIN_TOKEN;
async function scheduleWindow(env) {
  const saved = await env.STATE.get(SCHEDULE_KEY, 'json');
  return validMorning(saved || MORNING) ? { start: (saved || MORNING).start, end: (saved || MORNING).end } : MORNING;
}
export async function dailyPlan(env, date, window = DEFAULT_WINDOW) {
  const primaryAt = await firstAt(scheduleSeed(env), 'nodeseek', date, window);
  const retry = await claimAttempt({ day: date, attempts: 0 }, scheduleSeed(env), 'nodeseek', Date.parse(primaryAt));
  return { date, ...window, primaryAt, retryAt: retry.nextAt };
}
async function scheduleSnapshot(env, now = Date.now(), windowOverride = null) {
  const window = windowOverride || await scheduleWindow(env), date = localDate(now);
  if (!keyReady(env) && (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 32)) return { ...window, today: null, nextAt: null };
  const [saved, record, config] = await Promise.all([env.STATE.get('auto-plan:v2:' + date, 'json'), env.STATE.get('daily:' + date, 'json'), env.STATE.get(CONFIG_KEY, 'json')]);
  const blocked = record && !record.ok && !retryable(record.code) && !(Date.parse(config?.updatedAt || '') > Date.parse(record.time || record.checkedAt || ''));
  let plan = await planFor(saved || undefined, scheduleSeed(env), 'nodeseek', now, window);
  if (!saved && record?.time && localDate(Date.parse(record.time)) === date) plan = await claimAttempt(plan, scheduleSeed(env), 'nodeseek', Date.parse(record.time));
  if (blocked) plan.paused = true;
  const view = await scheduleView(plan, scheduleSeed(env), 'nodeseek', record?.ok === true, now, window);
  return { ...view, mode: 'random-window', crons: CRONS, today: { primaryAt: view.primaryAt, completed: record?.ok === true } };
}
async function saveSchedule(request, env) {
  const body = await readBody(request);
  if (!body || Array.isArray(body) || !validMorning(body)) return json({ error: 'invalid_schedule_window', message: '请选择 08:00–12:00 内至少相隔 5 分钟的时段。' }, 400);
  await env.STATE.put(SCHEDULE_KEY, JSON.stringify({ start: body.start, end: body.end, updatedAt: new Date().toISOString() }));
  return json({ ok: true, schedule: await scheduleSnapshot(env, Date.now(), { start: body.start, end: body.end }) });
}
async function tick(env, dependencies) {
  if (!env.STATE?.get || !env.STATE?.put || typeof scheduleSeed(env) !== 'string' || scheduleSeed(env).length < 32) return result('CONFIG', false);
  const config = await env.STATE.get(CONFIG_KEY, 'json');
  if (config?.enabled !== true) return result('WAITING', true);
  const now = (dependencies.now || Date.now)(), date = localDate(now), window = await scheduleWindow(env);
  const previous = await env.STATE.get('daily:' + date, 'json');
  if (previous?.ok) return result('SKIPPED', true, false, { date });
  if (previous && !retryable(previous.code) && !(Date.parse(config.updatedAt || '') > Date.parse(previous.time || previous.checkedAt || ''))) return result('WAITING', true);
  const key = 'auto-plan:v2:' + date, saved = await env.STATE.get(key, 'json');
  let plan = await planFor(saved || undefined, scheduleSeed(env), 'nodeseek', now, window);
  if (!saved && previous?.time && localDate(Date.parse(previous.time)) === date) plan = await claimAttempt(plan, scheduleSeed(env), 'nodeseek', Date.parse(previous.time));
  if (!saved && previous?.time) await env.STATE.put(key, JSON.stringify(plan), { expirationTtl: 7 * 86400 });
  if (plan.paused || !plan.nextAt || now < Date.parse(plan.nextAt) || inFlight.has(env) || credentialChecks.has(env)) return result('WAITING', true);
  plan = await claimAttempt(plan, scheduleSeed(env), 'nodeseek', now);
  await env.STATE.put(key, JSON.stringify(plan), { expirationTtl: 7 * 86400 });
  const report = await run(env, 'cron', { ...dependencies, scheduleSlot: 'attempt-' + plan.attempts });
  if (report.storage === 'failed') await env.STATE.put(key, JSON.stringify({ ...plan, paused: true }), { expirationTtl: 7 * 86400 });
  return report;
}
export async function scheduledTick(env, dependencies = {}) {
  if (scheduleTicks.has(env)) return scheduleTicks.get(env);
  const pending = tick(env, dependencies).catch(() => result('STORAGE', false));
  scheduleTicks.set(env, pending);
  try { return await pending; } finally { scheduleTicks.delete(env); }
}
async function credentialHash(account) {
  return digest((account.NODESEEK_COOKIE || '') + '\0' + (account.NODESEEK_UA || DEFAULT_UA));
}
function publicHealth(record) {
  return { status: record.status, code: record.code, checkedAt: record.checkedAt || null, lastValidAt: record.lastValidAt || null };
}
export async function healthSnapshot(env, account, now = Date.now()) {
  if (!account.NODESEEK_COOKIE) return { status: 'missing', code: 'CONFIG', checkedAt: null, lastValidAt: null };
  const saved = await env.STATE.get(HEALTH_KEY, 'json');
  if (!saved || saved.credentialHash !== await credentialHash(account)) return { status: 'unchecked', code: null, checkedAt: null, lastValidAt: null };
  const health = publicHealth(saved);
  if (health.status === 'valid' && now - Date.parse(health.checkedAt) > 86400000) health.status = 'stale';
  return health;
}
async function recordCookieHealth(env, account, code, checkedAt) {
  const hash = await credentialHash(account);
  const previous = await env.STATE.get(HEALTH_KEY, 'json');
  const status = ['SUCCESS', 'ALREADY'].includes(code) ? 'valid' : code === 'AUTH' ? 'invalid' : 'unknown';
  const record = { credentialHash: hash, status, code: status === 'valid' ? 'VALID' : code, checkedAt,
    lastValidAt: status === 'valid' ? checkedAt : previous?.credentialHash === hash ? previous.lastValidAt || null : null };
  await env.STATE.put(HEALTH_KEY, JSON.stringify(record));
  return publicHealth(record);
}
async function probeCookie(env, dependencies) {
  const clock = dependencies.now || Date.now;
  let account;
  try { account = await loadAccount(env); }
  catch { return { status: 'unknown', code: 'CREDENTIAL', checkedAt: new Date(clock()).toISOString(), lastValidAt: null }; }
  if (!/(?:^|;\s*)(?:pjwt|session)=[^;\s]+/.test(account.NODESEEK_COOKIE || '')) return { status: 'missing', code: 'CONFIG', checkedAt: null, lastValidAt: null };
  // The credit endpoint requires a live login. This GET cannot claim attendance.
  const ledger = await readLedger(account, 1, dependencies);
  const checkedAt = new Date(clock()).toISOString();
  try { return await recordCookieHealth(env, account, ledger.code, checkedAt); }
  catch { return { status: ledger.code === 'SUCCESS' ? 'valid' : ledger.code === 'AUTH' ? 'invalid' : 'unknown', code: ledger.code === 'SUCCESS' ? 'VALID' : ledger.code, checkedAt, lastValidAt: ledger.code === 'SUCCESS' ? checkedAt : null, storage: 'failed' }; }
}
export async function checkCookie(env, dependencies = {}) {
  if (credentialChecks.has(env)) return credentialChecks.get(env);
  if (inFlight.has(env)) return { status: 'unknown', code: 'BUSY', checkedAt: null, lastValidAt: null };
  const pending = probeCookie(env, dependencies);
  credentialChecks.set(env, pending);
  try { return await pending; } finally { credentialChecks.delete(env); }
}


export async function engineFetch(request, env) {
  const path = new URL(request.url).pathname, method = request.method;
  try {
    if (path === '/sync' && method === 'POST') return await syncBrowser(request, env);
    if (path === '/pair/poll' && method === 'POST') return await pollPair(request, env);
    if (path === '/pair/approve' && method === 'POST') return await approvePair(request, env);
    if (path === '/pair/revoke' && method === 'POST') { await env.STATE.put('sync-client:v4', JSON.stringify({ tokenHash: null })); return json({ ok: true }); }
    if (path === '/config' && method === 'GET') return json(await configuration(env));
    if (path === '/config' && method === 'POST') return await saveConfiguration(request, env);
    if (path === '/schedule' && method === 'POST') return await saveSchedule(request, env);
    if (path === '/health' && method === 'POST') return json(await checkCookie(env));
    if (path === '/status' && method === 'GET') { const date = localDate(); return json({ date, record: safeRecord(await env.STATE.get('daily:' + date, 'json')) }); }
    if (path === '/history' && method === 'GET') return json(await history(env, new URL(request.url).searchParams.get('month') || localDate().slice(0, 7)));
    if (path === '/reconcile' && method === 'POST') { const input = await readBody(request); const report = await reconcile(env, input.month); return json(report, report.ok ? 200 : 502); }
    if (path === '/run' && method === 'POST') { const report = await run(env); return json(report, report.ok ? 200 : 502); }
    if (path === '/tick' && method === 'POST') { const report = await scheduledTick(env); return json(report, report.ok ? 200 : 502); }
    return json({ error: 'not_found' }, 404);
  } catch (error) { return json({ code: 'INTERNAL', error: 'NodeSeek operation failed' }, ['400', '413', '415'].includes(error.message) ? Number(error.message) : 500); }
}
