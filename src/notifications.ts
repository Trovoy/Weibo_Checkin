import type { Env } from './account.ts';
import { open, seal } from './crypto.ts';
import { localDay } from './schedule.ts';

interface Settings { enabled: boolean; daily: boolean; alerts: boolean; time: string; credentials?: string }
interface Credentials { token: string; chatId: string }
interface Delivery { key: string; at: string; status: 'sending' | 'sent' | 'failed' | 'unknown'; tries: number; retryAt?: string; reason?: string }
interface Stored { settings: Settings; deliveries: Delivery[] }
export interface PlatformReport { id: string; name: string; line: string; issue?: string; complete: boolean }
const defaults = (): Stored => ({ settings: { enabled: false, daily: true, alerts: true, time: '13:00' }, deliveries: [] });
const codes: Record<string, string> = { AUTH: '登录失效，请更新登录', CHALLENGE: '需要安全验证', NETWORK: '网络异常，等待安全补查', UPSTREAM: '平台暂时异常', RATE_LIMIT: '请求限流', BROWSER: '云端浏览器暂不可用', BROWSER_LIMIT: '云端浏览器额度或并发受限', RESPONSE: '响应不明，补查前先核对账单', CONFIG: '配置不完整', CREDENTIAL: '登录凭证无法读取', STORAGE: '记录保存失败，请核对结果', INTERNAL: '执行异常', BUSY: '任务正在处理' };
const when = (stamp?: string) => stamp ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(stamp)) : '';
const html = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export function formatNotification(kind: 'daily' | 'manual' | 'alert' | 'recovery' | 'test', reports: PlatformReport[] = [], now = Date.now()) {
  const title = { daily: '每日汇报', manual: '当前汇报', alert: '异常提醒', recovery: '任务恢复', test: '连接成功' }[kind];
  const stamp = localDay(now).slice(5).replace('-', '/') + ' ' + when(new Date(now).toISOString()) + ' · UTC+8';
  const icon = kind === 'alert' ? '⚠️' : kind === 'recovery' ? '✅' : kind === 'test' ? '🔔' : '📋';
  const header = `<b>${icon} 每日签到</b> · ${title}\n<code>${stamp}</code>`;
  if (kind === 'test') return header + '\n\n每日汇报与异常提醒已连接。';
  const rows = reports.map(report => {
    let detail = report.line.startsWith(report.name + '：') ? report.line.slice(report.name.length + 1) : report.line;
    if (report.complete) {
      detail = detail.replace(' · 已完成', '').replace(/^已签到 · 鸡腿 (\d+)$/, '+$1 鸡腿').replace(/^已赠送 (\d+) 个免费虎粮$/, '$1 个免费虎粮已送出');
    }
    const icon = report.complete ? '✅' : report.issue ? '⚠️' : detail.includes('关闭') ? '⏸' : '🕒';
    return `${icon} <b>${html(report.name)}</b> · ${html(detail)}`;
  }).join('\n');
  const done = reports.filter(x => x.complete).length;
  const footer = kind === 'daily' || kind === 'manual' ? done === reports.length ? `<b>全部完成</b> · ${done}/${reports.length} 平台` : `<b>已完成 ${done}/${reports.length} 平台</b>\n未完成项继续按计划补查。` : kind === 'alert' ? reports.some(x => x.id === 'huya' && x.issue === 'REVIEW') ? '赠送结果待核对，已暂停后续赠送。' : '请查看面板；普通失败次日重新开始。' : '今日任务已完成，无需再操作。';
  return `${header}\n\n${rows}\n\n${footer}`;
}

// Read only local platform state. Notification checks never start a browser, check-in or gift.
export async function collectReports(env: Env): Promise<PlatformReport[]> {
  const read = async (binding: DurableObjectNamespace | undefined, name: string, path: string) => {
    if (!binding) throw Error('binding');
    const response = await binding.get(binding.idFromName(name)).fetch('https://state/' + path);
    if (!response.ok) throw Error('state');
    return await response.json() as any;
  };
  return Promise.all(['weibo', 'nodeseek', 'huya'].map(async id => {
    const name = { weibo: '微博', nodeseek: 'NodeSeek', huya: '虎牙' }[id]!;
    try {
      if (id === 'weibo') {
        const s = await read(env.ACCOUNT, 'personal-account', 'api/status');
        const total = s.topics.length, count = s.topics.filter((t: any) => s.completedToday.includes(t.id)).length;
        const complete = total > 0 && count === total;
        const failed = s.job?.day === s.today && s.job.status === 'stopped' && s.history[0]?.day === s.today && s.history[0]?.result === 'failed';
        const issue = complete ? undefined : s.enabled && s.login !== 'valid' ? 'LOGIN' : failed ? s.job.pendingTopic ? 'REVIEW' : 'FAILED' : undefined;
        const label = complete ? '已完成' : issue === 'LOGIN' ? '登录需处理' : issue === 'REVIEW' ? '本日结果需核对，次日重新开始' : issue ? '未完成，等待补查或处理提示' : s.job?.status === 'running' ? '执行中' : !s.enabled ? '自动签到关闭' : total ? '等待计划执行' : '未配置超话';
        return { id, name, complete, issue, line: `${name}：${count}/${total} 个超话 · ${label}` };
      }
      if (id === 'nodeseek') {
        const [s, c] = await Promise.all([read(env.NODESEEK, 'personal-nodeseek', 'status'), read(env.NODESEEK, 'personal-nodeseek', 'config')]);
        const complete = s.record?.ok === true;
        const issue = complete ? undefined : s.record && !s.record.ok ? Object.hasOwn(codes, s.record.code) ? s.record.code : 'INTERNAL' : c.enabled && !c.configured ? 'CONFIG' : undefined;
        const label = complete ? `已签到 · 鸡腿 ${s.record.gain ?? '未知'}` : issue ? codes[issue] : c.enabled ? '等待计划执行' : '自动签到关闭';
        return { id, name, complete, issue, line: `${name}：${label}` };
      }
      const s = await read(env.HUYA, 'personal-huya', 'status');
      const success = s.history.find((x: any) => x.day === s.date && x.code === 'SUCCESS');
      const complete = !!success;
      const issue = s.paused ? 'REVIEW' : complete ? undefined : s.record && s.record.code !== 'SUCCESS' ? s.record.code : s.enabled && !s.configured ? 'CONFIG' : undefined;
      const label = complete ? `已赠送 ${success.count} 个免费虎粮` : issue === 'REVIEW' ? '赠送结果待核对，已暂停' : issue === 'EMPTY' ? '暂无免费虎粮，等待补查' : issue ? '本次未成功，等待补查或处理' : s.enabled ? '等待计划执行' : '自动赠送关闭';
      return { id, name, complete, issue, line: `${name}：${label}${!complete && !s.paused && s.enabled && s.schedule?.nextAt ? ' · 下次 ' + when(s.schedule.nextAt) : ''}` };
    } catch { return { id, name, complete: false, issue: 'STATE', line: `${name}：暂时无法读取状态，请查看面板` }; }
  }));
}

export class NotificationCenter {
  private tail: Promise<unknown> = Promise.resolve();
  private ctx: DurableObjectState;
  private env: Env;
  transport: typeof fetch = (...args) => fetch(...args);
  constructor(ctx: DurableObjectState, env: Env) { this.ctx = ctx; this.env = env; }
  fetch(request: Request) {
    const next = this.tail.then(() => this.handle(request));
    this.tail = next.catch(() => {});
    return next.catch(() => Response.json({ error: '通知操作失败，请检查配置或稍后重试' }, { status: 502 }));
  }
  private async handle(request: Request) {
    const action = new URL(request.url).pathname.slice(1);
    const state = await this.ctx.storage.get<Stored>('notifications:v1') || defaults();
    const save = () => this.ctx.storage.put('notifications:v1', state);
    const view = async () => {
      const cred = state.settings.credentials ? await open<Credentials>(state.settings.credentials, this.env.ENCRYPTION_KEY) : undefined;
      const { credentials: _, ...settings } = state.settings;
      return { ...settings, configured: !!cred, chatHint: cred ? '••••' + cred.chatId.slice(-4) : '', deliveries: state.deliveries.slice(0, 20) };
    };
    if (request.method === 'GET' && action === 'status') return Response.json(await view());
    if (request.method !== 'POST' || !['config', 'verify', 'test', 'report', 'tick', 'disconnect'].includes(action)) return new Response(null, { status: 404 });
    if (action === 'disconnect') { delete state.settings.credentials; state.settings.enabled = false; state.deliveries = []; await save(); return Response.json(await view()); }
    if (action === 'config') {
      const input = await request.json() as Record<string, unknown>;
      if (['enabled', 'daily', 'alerts'].some(k => typeof input[k] !== 'boolean') || typeof input.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.time) || (input.token !== undefined && typeof input.token !== 'string') || (input.chatId !== undefined && typeof input.chatId !== 'string')) return Response.json({ error: '通知设置格式不正确' }, { status: 400 });
      const old = state.settings.credentials ? await open<Credentials>(state.settings.credentials, this.env.ENCRYPTION_KEY) : undefined;
      const token = (input.token as string | undefined)?.trim() || old?.token, chatId = (input.chatId as string | undefined)?.trim() || old?.chatId;
      if ((token || chatId || input.enabled) && (!token || !/^\d{5,20}:[A-Za-z0-9_-]{20,100}$/.test(token) || !chatId || !/^-?[1-9]\d{0,19}$/.test(chatId))) return Response.json({ error: '请填写有效的 Bot Token 和数字 Chat ID' }, { status: 400 });
      if (token && chatId) {
        state.settings.credentials = await seal({ token, chatId }, this.env.ENCRYPTION_KEY);
        if (old?.token !== token || old?.chatId !== chatId) state.deliveries = [];
      }
      Object.assign(state.settings, { enabled: input.enabled, daily: input.daily, alerts: input.alerts, time: input.time });
      await save(); return Response.json(await view());
    }
    if (!state.settings.credentials) return action === 'tick' ? Response.json({ skipped: true }) : Response.json({ error: '请先保存 Bot Token 与 Chat ID' }, { status: 409 });
    if (action === 'tick' && !state.settings.enabled) return Response.json({ skipped: true });
    if (action === 'verify') {
      const cred = await open<Credentials>(state.settings.credentials, this.env.ENCRYPTION_KEY);
      try {
        for (const method of ['getMe', 'getChat']) {
          const r = await this.transport(`https://api.telegram.org/bot${cred.token}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(10000), body: JSON.stringify(method === 'getChat' ? { chat_id: cred.chatId } : {}) });
          if (r.status >= 300 && r.status < 400) { await r.body?.cancel(); return Response.json({ error: 'Telegram 重定向已拒绝' }, { status: 502 }); }
          const d = await r.json() as { ok?: boolean };
          if (!r.ok || !d.ok) return Response.json({ error: `${method === 'getMe' ? 'Bot' : '接收会话'}验证未通过（HTTP ${r.status}）` }, { status: 502 });
        }
        return Response.json({ ok: true, message: 'Bot 和接收会话有效，未发送消息' });
      } catch (error) { return Response.json({ error: error instanceof SyntaxError ? 'Telegram 响应无法解析' : error instanceof DOMException && error.name === 'TimeoutError' ? 'Telegram 连接超时' : 'Telegram 网络连接失败' }, { status: 502 }); }
    }
    const now = Date.now(), day = localDay(now);
    state.deliveries = state.deliveries.filter(x => x.at.slice(0, 10) >= new Date(now - 8 * 86400000).toISOString().slice(0, 10)).slice(0, 100);
    const send = async (key: string, text: string) => {
      const previous = state.deliveries.find(x => x.key === key);
      if (previous && (previous.status !== 'failed' || !previous.retryAt || now < Date.parse(previous.retryAt) || previous.tries >= 3)) return false;
      const delivery: Delivery = { key, at: new Date(now).toISOString(), status: 'sending', tries: (previous?.tries || 0) + 1 };
      state.deliveries = [delivery, ...state.deliveries.filter(x => x.key !== key)].slice(0, 100);
      await save(); // Persist the claim before contacting Telegram; unknown sends are never blindly repeated.
      const cred = await open<Credentials>(state.settings.credentials!, this.env.ENCRYPTION_KEY);
      try {
        const response = await this.transport(`https://api.telegram.org/bot${cred.token}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(10000), body: JSON.stringify({ chat_id: cred.chatId, text, parse_mode: 'HTML', protect_content: true, link_preview_options: { is_disabled: true } }) });
        if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); delivery.status = 'failed'; delivery.reason = 'Telegram 重定向已拒绝'; await save(); return false; }
        const data = await response.json() as { ok?: boolean; error_code?: number; parameters?: { retry_after?: number } };
        if (response.ok && data.ok === true) delivery.status = 'sent';
        else {
          delivery.status = 'failed'; delivery.reason = response.status === 429 ? '限流' : response.status === 401 ? 'Bot Token 无效' : response.status === 403 ? 'Bot 被阻止或未加入会话' : 'Telegram 拒绝请求';
          if (response.status === 429 || response.status >= 500) delivery.retryAt = new Date(now + Math.max(900, Math.min(86400, Number(data.parameters?.retry_after) || 0)) * 1000).toISOString();
        }
      } catch (error) { delivery.status = 'unknown'; delivery.reason = error instanceof SyntaxError ? 'Telegram 响应无法解析，请核对送达' : error instanceof DOMException && error.name === 'TimeoutError' ? '连接超时，请核对送达' : '网络连接失败，发送结果未确认'; }
      await save(); return delivery.status === 'sent';
    };
    if (action === 'test') { const ok = await send('test:' + crypto.randomUUID(), formatNotification('test', [], now)); return Response.json({ ok, ...await view() }, { status: ok ? 200 : 502 }); }
    const reports = await collectReports(this.env);
    if (action === 'report') { const ok = await send('manual:' + crypto.randomUUID(), formatNotification('manual', reports, now)); return Response.json({ ok, ...await view() }, { status: ok ? 200 : 502 }); }
    if (state.settings.alerts) for (const report of reports) {
      if (report.issue) await send(`alert:${day}:${report.id}:${report.issue}`, formatNotification('alert', [report], now));
      else if (report.complete && state.deliveries.some(x => x.key.startsWith(`alert:${day}:${report.id}:`) && x.status === 'sent')) await send(`recovery:${day}:${report.id}`, formatNotification('recovery', [report], now));
    }
    const localMinute = Math.floor((now - Date.parse(day + 'T00:00:00+08:00')) / 60000);
    const [hour, minute] = state.settings.time.split(':').map(Number);
    if (state.settings.daily && localMinute >= hour * 60 + minute) await send('daily:' + day, formatNotification('daily', reports, now));
    return Response.json(await view());
  }
}
