import type { Env } from '../account.ts';
import { dayKey } from '../account.ts';
import { open, seal, unbase64 } from '../crypto.ts';
import { cleanCookie, HuyaClient, resolveRoom, type Room, type Transport, type Inventory } from './client.ts';
import { startQR, pollQR, closeQR, type QRSession } from './qr.ts';
interface QRDriver { start: typeof startQR; poll: typeof pollQR; close: typeof closeQR }
const qrDriver: QRDriver = { start: startQR, poll: pollQR, close: closeQR };

export type Code = 'SUCCESS' | 'EMPTY' | 'ERROR' | 'REJECTED' | 'REVIEW';
export interface Entry { day: string; at: string; code: Code; count: number; room: Room; source: 'manual' | 'cron' }
export interface State {
  credentials?: string; room?: Room; enabled: boolean; time: string; attemptedDay?: string;
  inventory?: Inventory; history: Entry[]; pending?: { count: number; order: string; room: Room; at: string };
}
export const messages: Record<Code, string> = { SUCCESS: '免费背包虎粮已全部赠送，回执与库存已核对', EMPTY: '背包未读到可赠送的普通虎粮，本次未赠送，也未确认续期',
  ERROR: '无法读取虎牙背包，请检查 Cookie 或稍后检测', REJECTED: '虎牙拒绝本次背包赠送，没有改用付费方式', REVIEW: '赠送结果未完全确认，已暂停后续赠送，请先到虎牙核对' };

// Persist intent before sending. Any interruption after that point requires human reconciliation.
export async function execute(state: State, client: Transport, save: () => Promise<void>, source: 'manual' | 'cron', now = new Date()) {
  if (!state.room || state.pending) throw new Error('REVIEW');
  const entry: Entry = { day: dayKey(now), at: now.toISOString(), code: 'ERROR', count: 0, room: { ...state.room }, source };
  const finish = async (code: Code, count = 0) => { entry.code = code; entry.count = count; state.history.unshift(entry); state.history = state.history.slice(0, 200); await save(); return entry; };
  let inventory: Inventory;
  try { inventory = await client.inventory(); state.inventory = inventory; } catch { return finish('ERROR'); }
  if (!Number.isSafeInteger(inventory.count) || inventory.count < 0 || inventory.count > 2147483647) return finish('ERROR');
  if (inventory.count === 0) return finish('EMPTY');
  let order: string;
  try { order = await client.sequence(); } catch { return finish('ERROR'); }
  state.pending = { count: inventory.count, order, room: { ...state.room }, at: entry.at };
  await save(); // A failed storage write must prevent the gift request.
  let receipt;
  try { receipt = await client.send(inventory.count, order); } catch { return finish('REVIEW'); }
  if (receipt.code === 40) { delete state.pending; return finish('REJECTED'); } // Official package page: insufficient backpack inventory.
  if (receipt.code !== 0) return finish('REVIEW');
  if (receipt.item !== 4 || receipt.count !== inventory.count || receipt.uid !== state.room.uid || receipt.order !== order || receipt.cost !== 0) return finish('REVIEW');
  let after: Inventory;
  try { after = await client.inventory(); state.inventory = after; } catch { return finish('REVIEW'); }
  if (after.count !== 0) return finish('REVIEW');
  delete state.pending; return finish('SUCCESS', inventory.count);
}
export class HuyaAccount {
  private tail: Promise<unknown> = Promise.resolve();
  private ctx: DurableObjectState;
  private env: Env;
  private qrDriver: QRDriver;
  constructor(ctx: DurableObjectState, env: Env, driver: QRDriver = qrDriver) { this.ctx = ctx; this.env = env; this.qrDriver = driver; }
  alarm() {
    const next = this.tail.then(() => this.clearQR()); this.tail = next.catch(() => {}); return next;
  }
  private async readQR() {
    const raw = await this.ctx.storage.get<string>('qr');
    return raw ? open<QRSession>(raw, this.env.ENCRYPTION_KEY) : undefined;
  }
  private async clearQR() {
    const qr = await this.readQR();
    if (qr && this.env.BROWSER) try { await this.qrDriver.close(this.env.BROWSER, qr); } catch { /* Browser may already be expired. */ }
    await this.ctx.storage.delete('qr'); await this.ctx.storage.deleteAlarm();
  }
  fetch(request: Request) {
    const next = this.tail.then(() => this.handle(request)); this.tail = next.catch(() => {});
    return next.catch(() => Response.json({ error: '虎牙操作失败；赠送结果不明时请先核对记录' }, { status: 502 }));
  }
  private async handle(request: Request) {
    const action = new URL(request.url).pathname.slice(1);
    const state = await this.ctx.storage.get<State>('state') || { enabled: false, time: '09:30', history: [] };
    const save = () => this.ctx.storage.put('state', state);
    const client = async (verifyRoom = false) => {
      if (!state.room || !state.credentials) throw new Error('CONFIG');
      if (verifyRoom) {
        const room = await resolveRoom(state.room.id);
        if (room.uid !== state.room.uid) throw new Error('ROOM_CHANGED');
      }
      const data = await open<{ platform: string; cookie: string }>(state.credentials, this.env.ENCRYPTION_KEY);
      if (data.platform !== 'huya') throw new Error('CONFIG'); return new HuyaClient(data.cookie, state.room);
    };
    const view = () => ({ date: dayKey(), configured: !!state.credentials && !!state.room, enabled: state.enabled, time: state.time,
      room: state.room, inventory: state.inventory, paused: !!state.pending,
      history: state.history.map(x => ({ ...x, message: messages[x.code] })), record: state.history.find(x => x.day === dayKey()) || null });
    if (request.method === 'GET' && action === 'qrimage') {
      const qr = await this.readQR();
      if (!qr || qr.expiresAt <= Date.now()) return new Response(null, { status: 404 });
      return new Response(unbase64(qr.image), { headers: { 'Content-Type': 'image/jpeg' } });
    }
    if (request.method === 'POST' && ['qrstart', 'qrpoll', 'qrcancel'].includes(action)) {
      if (!this.env.BROWSER) return Response.json({ error: '请配置 BROWSER 云端浏览器绑定' }, { status: 409 });
      if (action === 'qrcancel') { await this.clearQR(); return Response.json({ status: 'cancelled' }); }
      if (action === 'qrstart') {
        await this.clearQR();
        let qr: QRSession | undefined;
        try {
          qr = await this.qrDriver.start(this.env.BROWSER); await this.ctx.storage.put('qr', await seal(qr, this.env.ENCRYPTION_KEY));
          await this.ctx.storage.setAlarm(qr.expiresAt);
          return Response.json({ status: 'waiting', expiresAt: qr.expiresAt, image: '/api/platforms/huya/qrimage' });
        } catch (error) {
          if (qr) try { await this.qrDriver.close(this.env.BROWSER, qr); } catch {}
          const phases: Record<string, string> = { QR_PAGE: '无法加载虎牙官方页面', QR_ENTRY: '虎牙登录入口暂未加载', QR_WINDOW: '虎牙扫码窗口暂未加载', QR_IMAGE: '无法读取官方扫码窗口' };
          const reason = error instanceof Error ? phases[error.message] : '';
          return Response.json({ error: (reason || '云端浏览器暂不可用') + '，可能遇到验证或额度限制，请稍后重试' }, { status: 502 });
        }
      }
      const qr = await this.readQR();
      if (!qr || qr.expiresAt <= Date.now()) { await this.clearQR(); return Response.json({ status: 'expired' }); }
      try {
        const result = await this.qrDriver.poll(this.env.BROWSER, qr);
        if (result.status === 'waiting') {
          if (result.image) qr.image = result.image;
          await this.ctx.storage.put('qr', await seal(qr, this.env.ENCRYPTION_KEY));
          return Response.json({ status: 'waiting', expiresAt: qr.expiresAt });
        }
        state.credentials = await seal({ platform: 'huya', cookie: cleanCookie(result.cookie) }, this.env.ENCRYPTION_KEY);
        delete state.inventory; await save(); await this.clearQR();
        return Response.json({ status: 'connected', ...view() });
      } catch { await this.clearQR(); return Response.json({ error: '扫码会话已结束或虎牙要求验证，请重新生成二维码' }, { status: 502 }); }
    }
    if (request.method === 'GET' && action === 'status') {
      const qr = await this.readQR();
      return Response.json({ ...view(), qr: qr && qr.expiresAt > Date.now() ? { expiresAt: qr.expiresAt, image: '/api/platforms/huya/qrimage' } : undefined });
    }
    if (request.method !== 'POST' || !['config', 'probe', 'run', 'tick', 'disconnect', 'reconcile'].includes(action)) return Response.json({ error: '操作不存在' }, { status: 404 });
    if (action === 'config') {
      const input = await request.json() as { room?: unknown; cookie?: unknown; enabled?: unknown; time?: unknown };
      if ((input.enabled !== undefined && typeof input.enabled !== 'boolean') || (input.time !== undefined && (typeof input.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.time)))) return Response.json({ error: '配置格式不正确' }, { status: 400 });
      let room: Room | undefined, credentials: string | undefined;
      try {
        if (input.room !== undefined && input.room !== state.room?.id) room = await resolveRoom(input.room);
        if (input.cookie !== undefined && input.cookie !== '') credentials = await seal({ platform: 'huya', cookie: cleanCookie(input.cookie) }, this.env.ENCRYPTION_KEY);
      } catch { return Response.json({ error: '房间号无效、无法核对主播，或 Cookie 缺少登录信息' }, { status: 400 }); }
      if (room) state.room = room;
      if (credentials) { await this.clearQR(); state.credentials = credentials; delete state.inventory; }
      if (input.enabled === true && (!state.credentials || !state.room || state.pending)) return Response.json({ error: '请先连接账号、设置房间，并处理待核对结果' }, { status: 409 });
      if (typeof input.enabled === 'boolean') state.enabled = input.enabled;
      if (typeof input.time === 'string') state.time = input.time;
      await save(); return Response.json(view());
    }
    if (action === 'disconnect') { await this.clearQR(); delete state.credentials; delete state.inventory; state.enabled = false; await save(); return Response.json(view()); }
    if (action === 'probe') {
      try { state.inventory = await (await client()).inventory(); await save(); return Response.json(view()); }
      catch (error) {
        const code = error instanceof Error && /^(?:WUP rejected:-?\d+|HTTP:\d{3}|RESPONSE|WUP (?:frame|envelope|parameters|missing response|response)|Tars [a-z ]+)$/.test(error.message) ? error.message :
          error instanceof TypeError ? 'READ_TYPE' : error instanceof DOMException ? error.name === 'TimeoutError' ? 'READ_TIMEOUT' : 'READ_CRYPTO' : 'READ_FAILED';
        return Response.json({ error: messages.ERROR, code }, { status: 502 });
      }
    }
    if (action === 'reconcile') {
      const input = await request.json() as { confirmed?: unknown };
      if (input.confirmed !== true) return Response.json({ error: '请先在虎牙核对背包与礼物收支' }, { status: 400 });
      // Only remove the pause after a successful read and explicit operator reconciliation.
      try { state.inventory = await (await client()).inventory(); } catch { return Response.json({ error: messages.ERROR }, { status: 502 }); }
      delete state.pending; state.enabled = false; await save(); return Response.json(view());
    }
    const today = dayKey();
    if (action === 'tick') {
      const clock = new Date(Date.now() + 8 * 3600000).toISOString().slice(11, 16);
      if (!state.enabled || !state.room || !state.credentials || state.pending || state.attemptedDay === today || clock < state.time) return Response.json({ ok: true, skipped: true });
      state.attemptedDay = today; await save();
    }
    if (state.pending) return Response.json({ error: messages.REVIEW }, { status: 409 });
    // One successful delivery per day, including manual calls. No automatic second order after success.
    if (state.history.some(x => x.day === today && x.code === 'SUCCESS')) return Response.json({ ...view(), skipped: true });
    try { await execute(state, await client(true), save, action === 'tick' ? 'cron' : 'manual'); return Response.json(view()); }
    catch { return Response.json({ error: '请先连接虎牙账号与目标房间；结果不明时请核对记录' }, { status: 409 }); }
  }
}
