import { CookieJar, type Cookie } from './cookies.ts';
import { open, seal } from './crypto.ts';
import { WeiboClient, WeiboError, UA, type AccountProfile } from './weibo.ts';

export interface Env {
  ACCOUNT: DurableObjectNamespace;
  ASSETS: Fetcher;
  ADMIN_TOKEN: string;
  ENCRYPTION_KEY: string;
  NOTIFY_WEBHOOK_URL?: string;
  NODESEEK?: DurableObjectNamespace;
  HUYA?: DurableObjectNamespace;
  NODESEEK_CREDENTIAL_KEY?: string;
  NODESEEK_LEGACY_STATE?: KVNamespace;
  BROWSER?: Fetcher;
}
export interface Topic { id: string; name: string }
interface Entry { at: string; day: string; topic: Topic; result: 'success' | 'already' | 'failed'; message: string }
interface Job { id: string; day: string; topics: Topic[]; index: number; startedAt: string; finishedAt?: string; status: 'running' | 'done' | 'stopped'; message?: string }
interface State {
  enabled: boolean; topics: Topic[]; credentials?: string;
  login: 'missing' | 'valid' | 'expired' | 'blocked';
  lastChecked?: string; message?: string; job?: Job;
  profile?: AccountProfile;
  history: Entry[]; completed: Record<string, string[]>; lastAlert?: string;
}
interface QR { qrid: string; image: string; cookies: Cookie[]; expires: number; lastPoll: number; mobile?: boolean; expectedUid?: string }
export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
export function dayKey(now = new Date()) {
  return new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10);
}
export function recentCompletions(completed: Record<string, string[]>, today = dayKey(), history: Entry[] = []) {
  const end = Date.parse(today + 'T00:00:00+08:00');
  return Array.from({ length: 7 }, (_, index) => {
    const date = dayKey(new Date(end - (6 - index) * 86400000));
    const ids = new Set(completed[date] ?? []);
    for (const entry of history) if (entry.day === date && ['success', 'already'].includes(entry.result)) ids.add(entry.topic.id);
    return { date, count: ids.size };
  });
}
export function topicsFromInput(input: unknown): Topic[] {
  if (!Array.isArray(input) || input.length > 30) throw new HttpError(400, '最多配置 30 个超话');
  const ids = new Set<string>();
  return input.map(item => {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !/^100808[a-f0-9]{32}$/i.test(item.id) ||
      typeof item.name !== 'string' || !item.name.trim() || item.name.length > 60 || ids.has(item.id.toLowerCase())) {
      throw new HttpError(400, '每个超话需要名称和有效、无重复的 100808 ID（后接 32 位十六进制字符）');
    }
    const id = item.id.toLowerCase(); ids.add(id);
    return { id, name: item.name.trim() };
  });
}
export class WeiboAccount {
  ctx: DurableObjectState;
  env: Env;
  private tail: Promise<unknown> = Promise.resolve();
  // Injectable transport keeps protocol and job tests independent of a real account.
  transport: typeof fetch = (...args) => fetch(...args);
  constructor(ctx: DurableObjectState, env: Env) { this.ctx = ctx; this.env = env; }
  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const next = this.tail.then(action, action);
    this.tail = next.catch(() => {});
    return next;
  }
  private async load(): Promise<State> {
    return await this.ctx.storage.get<State>('state') ?? { enabled: false, topics: [], login: 'missing', history: [], completed: {} };
  }
  private async save(state: State) { await this.ctx.storage.put('state', state); }
  private idle(state: State) {
    if (state.job?.status === 'running') throw new HttpError(409, '签到正在进行，请完成或停止后再更换配置 / 登录');
  }
  private async client(state: State) {
    if (!state.credentials) throw new HttpError(409, '请先扫码登录或导入 Cookie');
    return new WeiboClient(new CookieJar(await open<Cookie[]>(state.credentials, this.env.ENCRYPTION_KEY)), this.transport);
  }
  private async remember(state: State, client: WeiboClient) {
    state.credentials = await seal(client.jar.cookies, this.env.ENCRYPTION_KEY);
    await this.save(state);
  }
  private async alert(state: State, message: string) {
    if (state.lastAlert === message || !this.env.NOTIFY_WEBHOOK_URL) return;
    const url = new URL(this.env.NOTIFY_WEBHOOK_URL);
    if (url.protocol !== 'https:') return;
    try {
      const result = await this.transport(url, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: '微博签到需要处理', content: message }), signal: AbortSignal.timeout(8000) });
      await result.body?.cancel();
      if (result.ok) { state.lastAlert = message; await this.save(state); }
    } catch { /* Notification failure must not roll back a recorded check-in. */ }
  }
  private async recordFailure(state: State, error: unknown) {
    const problem = error instanceof WeiboError ? error : new WeiboError('protocol', '处理微博响应失败，请检查配置或重新登录');
    state.message = problem.message;
    if (problem.kind === 'auth') state.login = 'expired';
    if (problem.kind === 'risk' || problem.kind === 'protocol') state.login = 'blocked';
    await this.save(state);
    await this.alert(state, problem.message);
    return problem;
  }
  private view(state: State) {
    const today = dayKey();
    return { enabled: state.enabled, topics: state.topics, login: state.login, lastChecked: state.lastChecked,
      message: state.message, job: state.job, history: state.history, today,
      recentCompletions: recentCompletions(state.completed, today, state.history),
      completedToday: state.completed[today] ?? [], hasCredentials: !!state.credentials, profile: state.profile };
  }
  private async start(state: State) {
    if (state.job?.status === 'running') return { started: false, message: '已有正在执行的任务' };
    if (state.login !== 'valid' || !state.credentials) throw new HttpError(409, '请先完成登录状态检测');
    if (!state.topics.length) throw new HttpError(409, '请先添加要签到的超话');
    const day = dayKey();
    const topics = state.topics.filter(t => !(state.completed[day] ?? []).includes(t.id));
    if (!topics.length) return { started: false, message: '今天配置的超话均已签到' };
    state.job = { id: crypto.randomUUID(), day, topics, index: 0, startedAt: new Date().toISOString(), status: 'running' };
    state.message = undefined;
    for (const date of Object.keys(state.completed).sort().slice(0, -7)) delete state.completed[date];
    // Put state and alarm together: a successful start always has a durable wakeup.
    await this.ctx.storage.transaction(async txn => {
      await txn.put('state', state);
      await txn.setAlarm(Date.now() + 1000);
    });
    return { started: true, message: '任务已开始，每次处理一个超话' };
  }
  async fetch(request: Request): Promise<Response> {
    return this.exclusive(async () => {
      try {
        const result = await this.route(request);
        return result instanceof Response ? result : Response.json(result);
      } catch (error) {
        if (error instanceof HttpError) return Response.json({ error: error.message }, { status: error.status });
        if (error instanceof WeiboError) return Response.json({ error: error.message }, { status: 502 });
        return Response.json({ error: '服务处理失败，请检查加密密钥与 Worker 配置' }, { status: 500 });
      }
    });
  }
  private async route(request: Request): Promise<unknown> {
    const path = new URL(request.url).pathname;
    const state = await this.load();
    if (path === '/api/status' && request.method === 'GET') return this.view(state);
    if (path === '/api/avatar' && request.method === 'GET') {
      if (!state.credentials || !state.profile?.avatar) throw new HttpError(404, '头像暂不可用');
      const url = new URL(state.profile.avatar);
      if (url.protocol !== 'https:' || url.username || url.password || url.port || !url.hostname.endsWith('.sinaimg.cn')) throw new HttpError(404, '头像地址不受支持');
      let response: Response;
      try { response = await this.transport(url, { headers: { 'User-Agent': UA, Referer: 'https://weibo.com/' }, redirect: 'error', signal: AbortSignal.timeout(10000) }); }
      catch { throw new HttpError(404, '头像暂不可用'); }
      const type = response.headers.get('Content-Type')?.split(';')[0] ?? '';
      if (!response.ok || !['image/jpeg', 'image/png', 'image/webp', 'image/avif'].includes(type) || Number(response.headers.get('Content-Length')) > 1024 * 1024) {
        await response.body?.cancel(); throw new HttpError(404, '头像暂不可用');
      }
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > 1024 * 1024) throw new HttpError(404, '头像过大');
      return new Response(bytes, { headers: { 'Content-Type': type } });
    }
    if (request.method !== 'POST') throw new HttpError(404, '接口不存在');
    if (path === '/internal/cron') {
      if (!state.enabled || state.login !== 'valid' || !state.topics.length) return { skipped: true };
      return this.start(state);
    }
    if (path === '/api/run') return this.start(state);
    if (path === '/api/profile') {
      this.idle(state);
      if (state.login !== 'valid') throw new HttpError(409, '请先连接微博账号');
      const client = await this.client(state);
      try { state.profile = await client.accountProfile(); return { profile: state.profile }; }
      finally { await this.remember(state, client); }
    }
    if (path === '/api/topics/levels') {
      this.idle(state);
      const input = await request.json() as { cursor?: unknown };
      const cursor = input.cursor ?? '';
      if (typeof cursor !== 'string' || cursor.length > 200 || /[\x00-\x20]/.test(cursor)) throw new HttpError(400, '分页参数不正确');
      if (state.login !== 'valid') throw new HttpError(409, '请先连接微博账号');
      const client = await this.client(state);
      try { return await client.followedLevels(cursor); }
      finally { await this.remember(state, client); }
    }
    if (path === '/api/topics/followed') {
      this.idle(state);
      const input = await request.json() as { page?: unknown };
      const page = input.page === undefined ? 1 : Number(input.page);
      if (!Number.isInteger(page) || page < 1 || page > 100) throw new HttpError(400, '分页参数不正确');
      if (state.login !== 'valid') throw new HttpError(409, '请先连接微博账号');
      const client = await this.client(state);
      try { return await client.followedTopics(page); }
      finally { await this.remember(state, client); }
    }
    if (path === '/api/topics/search') {
      this.idle(state);
      const input = await request.json() as { query?: unknown };
      if (typeof input.query !== 'string' || !input.query.trim() || input.query.length > 60) throw new HttpError(400, '请输入 1–60 字的超话名称');
      if (state.login !== 'valid') throw new HttpError(409, '请先连接微博账号');
      const client = await this.client(state);
      try { return { topics: await client.searchTopics(input.query.trim()) }; }
      finally { await this.remember(state, client); }
    }
    if (path === '/api/stop') {
      if (state.job?.status === 'running') { state.job.status = 'stopped'; state.job.finishedAt = new Date().toISOString(); state.job.message = '手动停止'; }
      await this.ctx.storage.transaction(async txn => { await txn.put('state', state); await txn.deleteAlarm(); });
      return { message: '任务已停止' };
    }
    if (path === '/api/settings') {
      this.idle(state);
      const input = await request.json() as Record<string, unknown>;
      if (typeof input.enabled !== 'boolean') throw new HttpError(400, 'enabled 必须为布尔值');
      state.topics = topicsFromInput(input.topics); state.enabled = input.enabled;
      await this.save(state); return this.view(state);
    }
    if (path === '/api/logout') {
      this.idle(state);
      state.credentials = undefined; state.login = 'missing'; state.message = undefined; state.profile = undefined;
      state.enabled = false; state.lastChecked = undefined;
      state.completed = {};
      await this.ctx.storage.delete('qr'); await this.save(state);
      return { message: '微博登录信息已删除，自动签到已关闭' };
    }
    if (path === '/api/cookie') {
      this.idle(state);
      const input = await request.json() as { cookie?: unknown };
      if (typeof input.cookie !== 'string') throw new HttpError(400, '请提供 Cookie 文本');
      let jar: CookieJar;
      try { jar = CookieJar.fromHeader(input.cookie); } catch (e) { throw new HttpError(400, (e as Error).message); }
      const client = new WeiboClient(jar, this.transport);
      await client.validate();
      // Do not replace the existing working credentials until the new login is verified.
      state.login = 'valid'; state.lastChecked = new Date().toISOString(); state.message = undefined; state.lastAlert = undefined; state.profile = undefined;
      await this.remember(state, client); await this.ctx.storage.delete('qr');
      return { message: 'Cookie 已验证并加密保存' };
    }
    if (path === '/api/validate') {
      this.idle(state);
      const client = await this.client(state);
      try {
        await client.validate(); state.login = 'valid'; state.message = undefined; state.lastAlert = undefined;
        return { message: '微博登录状态有效' };
      } catch (error) { throw await this.recordFailure(state, error); }
      finally { state.lastChecked = new Date().toISOString(); await this.remember(state, client); }
    }
    if (path === '/api/qr/create') {
      this.idle(state);
      const input = await request.json() as { mobile?: unknown };
      const mobile = input.mobile === true;
      if (mobile && state.login !== 'valid') throw new HttpError(409, '请先连接微博账号');
      const existing = await this.ctx.storage.get<string>('qr');
      if (existing) {
        const qr = await open<QR>(existing, this.env.ENCRYPTION_KEY);
        if (!mobile && !qr.mobile && qr.expires > Date.now() && qr.cookies.some(c => c.name === 'SUB' && c.domain.endsWith('weibo.com'))) {
          return { image: qr.image, expires: qr.expires };
        }
      }
      const client = mobile ? await this.client(state) : new WeiboClient(new CookieJar(), this.transport);
      const expectedUid = mobile ? await client.selfUID() : undefined;
      const { qrid, image } = await client.createQR(mobile);
      const qr: QR = { qrid, image, cookies: client.jar.cookies, expires: Date.now() + 120000, lastPoll: 0, mobile, expectedUid };
      await this.ctx.storage.put('qr', await seal(qr, this.env.ENCRYPTION_KEY));
      return { image, expires: qr.expires };
    }
    if (path === '/api/qr/poll') {
      this.idle(state);
      const sealed = await this.ctx.storage.get<string>('qr');
      if (!sealed) return { status: 'expired' };
      const qr = await open<QR>(sealed, this.env.ENCRYPTION_KEY);
      if (qr.expires <= Date.now()) { await this.ctx.storage.delete('qr'); return { status: 'expired' }; }
      if (qr.lastPoll > Date.now() - 2500) throw new HttpError(429, '请稍后再查询扫码状态');
      qr.lastPoll = Date.now();
      const client = new WeiboClient(new CookieJar(qr.cookies), this.transport);
      try {
        let status: 'pending' | 'scanned' | 'expired' | 'ok';
        if (qr.mobile) status = await client.pollMobileQR(qr.qrid, qr.expectedUid!);
        else if (/(?:^|; )SUB=/.test(client.jar.header(new URL('https://weibo.com/')))) {
          // Resume a partial SSO exchange without consuming the mobile confirmation again.
          client.loginStage = '验证已保存的扫码会话';
          await client.validate(); status = 'ok';
        } else status = await client.pollQR(qr.qrid);
        if (status === 'ok') {
          if (qr.mobile) {
            // Keep the working desktop session even if the mobile SSO rotates desktop cookies.
            const original = await this.client(state);
            original.jar.cookies = original.jar.cookies.filter(c => !c.domain.endsWith('weibo.cn'))
              .concat(client.jar.cookies.filter(c => c.domain === 'weibo.cn' || c.domain.endsWith('.weibo.cn')));
            state.message = undefined;
            await this.remember(state, original); await this.ctx.storage.delete('qr');
            return { status, mobile: true };
          }
          state.login = 'valid'; state.message = undefined; state.lastAlert = undefined; state.lastChecked = new Date().toISOString(); state.profile = undefined;
          await this.remember(state, client); await this.ctx.storage.delete('qr');
        } else if (status === 'expired') await this.ctx.storage.delete('qr');
        else {
          qr.cookies = client.jar.cookies;
          await this.ctx.storage.put('qr', await seal(qr, this.env.ENCRYPTION_KEY));
        }
        return { status };
      } catch (error) {
        const message = error instanceof WeiboError ? error.message : '处理扫码会话失败，请检查服务配置';
        state.message = `${client.loginStage}：${message}`;
        await this.save(state);
        if (/(?:^|; )SUB=/.test(client.jar.header(new URL('https://weibo.com/')))) {
          qr.cookies = client.jar.cookies;
          await this.ctx.storage.put('qr', await seal(qr, this.env.ENCRYPTION_KEY));
        } else await this.ctx.storage.delete('qr');
        throw new HttpError(502, state.message);
      }
    }
    throw new HttpError(404, '接口不存在');
  }
  async alarm() {
    return this.exclusive(async () => {
      const state = await this.load();
      const job = state.job;
      if (!job || job.status !== 'running') return;
      if (job.day !== dayKey()) {
        job.status = 'stopped'; job.finishedAt = new Date().toISOString(); job.message = '已跨日，请开始新任务';
        await this.save(state); return;
      }
      const topic = job.topics[job.index];
      if (!topic) { job.status = 'done'; job.finishedAt = new Date().toISOString(); await this.save(state); return; }
      const client = await this.client(state);
      try {
        if (job.index === 0) { await client.validate(); state.lastChecked = new Date().toISOString(); }
        const result = (state.completed[job.day] ?? []).includes(topic.id) ? 'already' : await client.checkin(topic.id);
        const completed = state.completed[job.day] ??= [];
        if (!completed.includes(topic.id)) completed.push(topic.id);
        state.history.unshift({ at: new Date().toISOString(), day: job.day, topic, result, message: result === 'success' ? '签到成功' : '今日已签到' });
        job.index++;
        if (job.index >= job.topics.length) { job.status = 'done'; job.finishedAt = new Date().toISOString(); }
      } catch (error) {
        const problem = error instanceof WeiboError ? error : new WeiboError('protocol', '处理微博响应失败，本轮已停止');
        state.history.unshift({ at: new Date().toISOString(), day: job.day, topic, result: 'failed', message: problem.message });
        job.status = 'stopped'; job.finishedAt = new Date().toISOString(); job.message = problem.message;
        // A POST may have reached Weibo even if its response was lost. Do not retry automatically.
        await this.recordFailure(state, problem);
      }
      state.history = state.history.slice(0, 200);
      state.credentials = await seal(client.jar.cookies, this.env.ENCRYPTION_KEY);
      await this.ctx.storage.transaction(async txn => {
        await txn.put('state', state);
        if (job.status === 'running') await txn.setAlarm(Date.now() + 10000);
      });
    });
  }
}
