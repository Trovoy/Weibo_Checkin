import type { Env } from './account.ts';
import { validMorning } from './schedule.ts';

type Data = Record<string, any>;
interface PlatformAdapter {
  id: string; name: string; description: string; page: string;
  available(env: Env): boolean;
  handle(request: Request, action: string, env: Env): Promise<Response>;
}
const json = (data: unknown, status = 200) => Response.json(data, { status });
const messages: Record<string, string> = {
  SUCCESS: '签到成功', ALREADY: '今日已签到', SKIPPED: '今日已有成功记录，已跳过', AUTH: '登录失效，请更新 Cookie',
  CHALLENGE: 'NodeSeek 要求验证，请在官方网站完成', RATE_LIMIT: '请求被限流，请稍后检查', NETWORK: '网络异常，结果未确认',
  CONFIG: '请检查 NodeSeek 登录配置', CREDENTIAL: 'NodeSeek 凭证无法解密', STORAGE: '记录存储异常',
  BROWSER: '云端浏览器暂不可用', BROWSER_LIMIT: '云端浏览器额度或并发已达上限', BUSY: '已有任务在执行',
  UPSTREAM: 'NodeSeek 服务暂不可用', RESPONSE: 'NodeSeek 响应异常', RECONCILED: '已补全签到记录', VALID: '登录有效', INTERNAL: 'NodeSeek 服务异常'
};
const number = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0 ? value as number : null;
const stamp = (value: unknown) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)) ? value : null;
const date = (value: unknown) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
function record(data: Data | null) {
  if (!data || !date(data.date)) return null;
  const code = Object.hasOwn(messages, data.code) ? data.code : 'RESPONSE';
  return { date: data.date, ok: data.ok === true, code, message: messages[code], gain: number(data.gain),
    source: ['manual', 'cron', 'ledger'].includes(data.source) ? data.source : 'unknown',
    claimedAt: stamp(data.claimedAt), ledgerAt: stamp(data.ledgerAt), checkedAt: stamp(data.checkedAt), runCount: number(data.runCount),
    storage: data.storage === 'failed' ? 'failed' : undefined };
}
function schedule(data: Data = {}) {
  const clock = (x: unknown) => typeof x === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(x) ? x : null;
  return { start: clock(data.start), end: clock(data.end), retry: clock(data.retry), nextAt: stamp(data.nextAt), paused: data.paused === true, attempts: number(data.attempts), retryMinutes: { min: 45, max: 75 },
    today: data.today ? { primaryAt: stamp(data.today.primaryAt), retryAt: stamp(data.today.retryAt), completed: data.today.completed === true } : null };
}
function config(data: Data) {
  const health = data.cookieHealth || {};
  return { configured: data.configured === true, enabled: data.enabled === true, random: data.random === true, browserPaired: data.browserPaired === true, browserProtocol: data.browserProtocol === 5 ? 5 : 4,
    syncedAt: stamp(data.syncedAt), updatedAt: stamp(data.updatedAt),
    cookieHealth: { status: ['valid', 'invalid', 'unknown', 'unchecked', 'stale', 'missing'].includes(health.status) ? health.status : 'unknown',
      checkedAt: stamp(health.checkedAt), code: Object.hasOwn(messages, health.code) ? health.code : null }, schedule: schedule(data.schedule) };
}
function available(env: Env) { return !!env.NODESEEK && typeof env.NODESEEK_CREDENTIAL_KEY === 'string' && env.NODESEEK_CREDENTIAL_KEY.length >= 32; }
async function call(env: Env, path: string, body?: Data) {
  // Only the adapter's fixed API paths are used. Never forward browser headers or accept a URL from the client.
  const response = await env.NODESEEK!.get(env.NODESEEK!.idFromName('personal-nodeseek')).fetch('https://platform.internal' + path, {
    method: body ? 'POST' : 'GET', redirect: 'manual', signal: AbortSignal.timeout(body ? 90000 : 15000),
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  if ([301, 302, 303, 307, 308, 401, 403].includes(response.status)) { await response.body?.cancel(); throw new Error('connection'); }
  const reader = response.body?.getReader(); const parts: Uint8Array[] = []; let size = 0;
  if (reader) for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length;
    if (size > 1024 * 1024) { await reader.cancel(); throw new Error('response'); } parts.push(value); }
  const bytes = new Uint8Array(size); let offset = 0; for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  const data = JSON.parse(new TextDecoder().decode(bytes));
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('response');
  return { data: data as Data, status: response.status };
}
function validMonth(month: string) { return /^20\d{2}-(0[1-9]|1[0-2])$/.test(month); }
async function nodeSeek(request: Request, action: string, env: Env) {
  if (!available(env)) return json({ error: '请先配置 NodeSeek 原生存储与加密密钥' }, 409);
  const method = request.method, url = new URL(request.url);
  if (['pairapprove', 'pairrevoke'].includes(action) && method === 'POST') {
    const body = await request.json() as Data;
    if (action === 'pairapprove' && (!/^[A-Za-z0-9_-]{43}$/.test(body.flow || '') || !/^[A-Za-z0-9_-]{43}$/.test(body.challenge || ''))) return json({ error: '无效的扩展配对请求' }, 400);
    const result = await call(env, action === 'pairapprove' ? '/pair/approve' : '/pair/revoke', action === 'pairapprove' ? { flow: body.flow, challenge: body.challenge } : {});
    return json(result.status === 200 ? { ok: true, expiresAt: stamp(result.data.expiresAt) } : { error: '配对操作失败，请重新发起连接' }, result.status);
  }
  if (action === 'status' && method === 'GET') {
    const [status, settings] = await Promise.all([call(env, '/status'), call(env, '/config')]);
    if (status.status !== 200 || settings.status !== 200 || !date(status.data.date)) throw new Error('response');
    return json({ date: status.data.date, record: record(status.data.record), config: config(settings.data) });
  }
  if (action === 'history' && method === 'GET') {
    const month = url.searchParams.get('month') || new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 7);
    if (!validMonth(month)) return json({ error: '请输入有效月份' }, 400);
    const result = await call(env, '/history?month=' + month);
    if (result.status !== 200 || !Array.isArray(result.data.records)) throw new Error('response');
    return json({ month, records: result.data.records.slice(0, 31).map(record).filter(Boolean) });
  }
  if (method !== 'POST' || !['run', 'health', 'config', 'schedule', 'reconcile'].includes(action)) return json({ error: '不支持的平台操作' }, 404);
  const input = await request.json() as Data; let body: Data = {};
  if (action === 'config') {
    if (typeof input.random !== 'boolean' || (input.enabled !== undefined && typeof input.enabled !== 'boolean') || (input.cookie !== undefined && (typeof input.cookie !== 'string' || input.cookie.length > 10000 || /[\r\n]/.test(input.cookie))) ||
      (input.userAgent !== undefined && (typeof input.userAgent !== 'string' || input.userAgent.length > 1024 || /[\r\n]/.test(input.userAgent)))) return json({ error: 'NodeSeek 配置格式不正确' }, 400);
    body = { random: input.random, ...(input.enabled !== undefined ? { enabled: input.enabled } : {}), ...(input.cookie ? { cookie: input.cookie } : {}), ...(input.userAgent?.trim() ? { userAgent: input.userAgent.trim() } : {}) };
  }
  if (action === 'schedule') {
    const minute = (x: unknown) => typeof x === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(x) ? Number(x.slice(0, 2)) * 60 + Number(x.slice(3)) : NaN;
    const start = minute(input.start), end = minute(input.end);
    if (!Number.isFinite(start + end) || !validMorning({ start: input.start, end: input.end })) return json({ error: '请选择 08:00–12:00 内至少相隔 5 分钟的时段' }, 400);
    body = { start: input.start, end: input.end };
  }
  if (action === 'reconcile') { if (!validMonth(input.month)) return json({ error: '请输入有效月份' }, 400); body = { month: input.month }; }
  const result = await call(env, '/' + action, body); const data = result.data;
  if (result.status >= 400) {
    const code = Object.hasOwn(messages, data.code) ? data.code : 'INTERNAL';
    return json({ error: messages[code], code }, result.status === 409 ? 409 : 502);
  }
  if (action === 'run') { const entry = record(data); if (!entry || !Object.hasOwn(messages, data.code)) throw new Error('response'); return json(entry); }
  if (action === 'health') return json({ status: config({ cookieHealth: data }).cookieHealth.status,
    message: data.status === 'valid' ? 'NodeSeek 登录有效' : data.status === 'invalid' ? messages.AUTH : '暂时无法确认登录状态，请查看检测结果' });
  if (action === 'config') return json({ message: 'NodeSeek 配置已保存' });
  if (action === 'schedule') return json({ message: '随机签到时段已保存', schedule: schedule(data.schedule) });
  return json({ message: `已补全 ${number(data.updated) ?? 0} 天记录${data.partial ? '，较早记录可能尚未覆盖' : ''}`, updated: number(data.updated), conflicts: number(data.conflicts) });
}

// Add a platform by implementing one adapter and registering it here; scheduling stays with its owner.
export const platforms: PlatformAdapter[] = [
  { id: 'weibo', name: '微博', description: '超话签到与个人等级', page: 'topics', available: () => true,
    handle: async (request, action, env) => {
      if (!((action === 'status' && request.method === 'GET') || (action === 'run' && request.method === 'POST'))) return json({ error: '不支持的平台操作' }, 404);
      return env.ACCOUNT.get(env.ACCOUNT.idFromName('personal-account')).fetch(new Request('https://account/api/' + action, { method: request.method, headers: { 'Content-Type': 'application/json' }, body: request.method === 'POST' ? '{}' : undefined }));
    } },
  { id: 'nodeseek', name: 'NodeSeek', description: '每日签到、鸡腿与随机时段', page: 'nodeseek', available, handle: nodeSeek },
  { id: 'huya', name: '虎牙', description: '将免费背包虎粮赠送至指定直播间', page: 'huya', available: env => !!env.HUYA,
    handle: async (request, action, env) => {
      if (!env.HUYA) return json({ error: '请先绑定虎牙原生存储' }, 409);
      if (!((request.method === 'GET' && ['status', 'qrimage'].includes(action)) || (request.method === 'POST' && ['config', 'probe', 'run', 'disconnect', 'reconcile', 'qrstart', 'qrpoll', 'qrcancel'].includes(action)))) return json({ error: '操作不存在' }, 404);
      return env.HUYA.get(env.HUYA.idFromName('personal-huya')).fetch('https://huya/' + action, {
        method: request.method, headers: { 'Content-Type': 'application/json' }, body: request.method === 'POST' ? await request.text() : undefined
      });
    } }
];
export async function platformRoute(request: Request, env: Env) {
  const path = new URL(request.url).pathname;
  if (path === '/api/platforms' && request.method === 'GET') return json({ platforms: platforms.map(({ id, name, description, page, available }) => ({ id, name, description, page, available: available(env) })) });
  const match = /^\/api\/platforms\/([a-z0-9-]+)\/([a-z]+)$/.exec(path);
  const adapter = match && platforms.find(p => p.id === match[1]);
  if (!adapter) return json({ error: '平台或操作不存在' }, 404);
  try { return await adapter.handle(request, match![2], env); }
  catch { return json({ error: '平台暂不可用，请检查存储和加密密钥；签到结果未知时请先刷新记录' }, 502); }
}

export async function extensionRoute(request: Request, env: Env) {
  if (!available(env)) return json({ error: 'NodeSeek 尚未配置' }, 503);
  const action = new URL(request.url).pathname.split('/').at(-1);
  if (request.method !== 'POST' || !['sync', 'pairpoll'].includes(action!)) return json({ error: '不支持的同步操作' }, 404);
  const stub = env.NODESEEK!.get(env.NODESEEK!.idFromName('personal-nodeseek'));
  return stub.fetch(new Request('https://platform.internal/' + (action === 'pairpoll' ? 'pair/poll' : 'sync'), {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: request.headers.get('Authorization') || '' }, body: await request.text()
  }));
}
