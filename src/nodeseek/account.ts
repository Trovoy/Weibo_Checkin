import type { Env } from '../account.ts';
import { engineFetch, decryptCookie } from './engine.js';

interface Value { text: string; expires?: number }
// This small KV-shaped facade keeps the engine portable; all live data is in this DO.
export class NativeStore {
  storage: DurableObjectStorage;
  constructor(storage: DurableObjectStorage) { this.storage = storage; }
  async get(key: string, type?: string) {
    const value = await this.storage.get<Value>('data:' + key);
    if (!value || (value.expires && value.expires <= Date.now())) return null;
    return type === 'json' ? JSON.parse(value.text) : value.text;
  }
  async put(key: string, text: string, options?: { expirationTtl?: number }) {
    await this.storage.put('data:' + key, { text, ...(options?.expirationTtl ? { expires: Date.now() + options.expirationTtl * 1000 } : {}) });
  }
  async list({ prefix = '', limit = 1000, cursor }: { prefix?: string; limit?: number; cursor?: string }) {
    const values = await this.storage.list<Value>({ prefix: 'data:' + prefix, limit: Math.min(limit, 1000), ...(cursor ? { startAfter: cursor } : {}) });
    const keys = [...values].filter(([, v]) => !v.expires || v.expires > Date.now()).map(([name]) => ({ name: name.slice(5) }));
    return { keys, list_complete: values.size < Math.min(limit, 1000), cursor: [...values.keys()].at(-1) };
  }
}
export class NodeSeekAccount {
  ctx: DurableObjectState; env: Env; store: NativeStore;
  private tail: Promise<unknown> = Promise.resolve();
  private initialized = false;
  // Tests may inject an engine; production always uses the native engine above.
  execute: typeof engineFetch = engineFetch;
  constructor(ctx: DurableObjectState, env: Env) { this.ctx = ctx; this.env = env; this.store = new NativeStore(ctx.storage); }
  private engineEnv() { return { STATE: this.store, CREDENTIAL_KEY: this.env.NODESEEK_CREDENTIAL_KEY, BROWSER: this.env.BROWSER, NS_TRANSPORT: 'browser', NS_RANDOM: 'true' }; }
  private async initialize() {
    if (this.initialized) return;
    if (!await this.ctx.storage.get('migration:v1')) {
      const legacy = this.env.NODESEEK_LEGACY_STATE;
      const entries: Record<string, Value> = {}; let cursor: string | undefined; let count = 0;
      if (legacy) do {
        const page = await legacy.list({ limit: 1000, ...(cursor ? { cursor } : {}) });
        for (const key of page.keys) {
          if (!/^(?:settings:v2|cookie-health:v1|schedule-settings:v1|sync-client:v4|daily:\d{4}-\d{2}-\d{2}|schedule-claims:v1:\d{4}-\d{2}-\d{2})$/.test(key.name)) continue;
          const text = await legacy.get(key.name); if (text === null) throw new Error('Legacy snapshot changed');
          const value = JSON.parse(text);
          if (key.name === 'settings:v2' && value.encryptedCookie) await decryptCookie(value.encryptedCookie, this.engineEnv());
          // Preserve the legacy instance's active schedule; fresh installations default off.
          if (key.name === 'settings:v2') value.enabled = value.enabled ?? true;
          entries['data:' + key.name] = { text: JSON.stringify(value), ...(key.expiration ? { expires: key.expiration * 1000 } : {}) }; count++;
          if (count > 5000) throw new Error('Migration too large');
        }
        if (page.list_complete) break;
        if (!page.cursor || page.cursor === cursor) throw new Error('Invalid migration cursor'); cursor = page.cursor;
      } while (true);
      await this.ctx.storage.transaction(async txn => {
        for (const [key, value] of Object.entries(entries)) await txn.put(key, value);
        await txn.put('migration:v1', { ready: true, imported: count, at: new Date().toISOString() });
      });
    }
    // An interrupted attendance call must be reconciled before another POST.
    const pending = await this.ctx.storage.get<{ date: string }>('operation:v1');
    if (pending) {
      const previous = await this.store.get('daily:' + pending.date, 'json');
      if (!previous?.ok) await this.store.put('daily:' + pending.date, JSON.stringify({ ...previous, date: pending.date, ok: false, code: 'NETWORK', checkedAt: new Date().toISOString() }));
      await this.ctx.storage.delete('operation:v1');
    }
    this.initialized = true;
  }
  fetch(request: Request): Promise<Response> {
    const job = this.tail.then(async () => {
      try {
        await this.initialize();
        const path = new URL(request.url).pathname;
        if (path === '/migration' && request.method === 'GET') return Response.json(await this.ctx.storage.get('migration:v1'));
        const attendance = ['/run', '/tick'].includes(path) && request.method === 'POST';
        if (attendance) await this.ctx.storage.put('operation:v1', { date: new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10) });
        const response = await this.execute(request, this.engineEnv());
        if (attendance) await this.ctx.storage.delete('operation:v1');
        return response;
      } catch { this.initialized = false; return Response.json({ code: 'STORAGE', error: 'NodeSeek storage or migration failed' }, { status: 503 }); }
    });
    this.tail = job.catch(() => {}); return job;
  }
}
