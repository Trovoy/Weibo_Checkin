import { createHash } from 'node:crypto';
import { base64 } from '../crypto.ts';
import { encode, packet, unpack, type Fields } from './tars.ts';

export interface Room { id: string; uid: number; name: string }
export interface Inventory { count: number; checkedAt: string }
export interface Receipt { code: number; count: number; order: string; uid: number; item: number; cost: number }
export interface Transport {
  inventory(): Promise<Inventory>;
  sequence(): Promise<string>;
  send(count: number, order: string): Promise<Receipt>;
}
export function cleanCookie(input: unknown) {
  if (typeof input !== 'string' || input.length > 16000 || /[\r\n\x00]/.test(input)) throw new Error('COOKIE');
  const parts = input.trim().split(';').map(x => x.trim()).filter(Boolean), seen = new Set<string>();
  for (const part of parts) { const p = part.indexOf('='); const name = part.slice(0, p); if (p < 1 || !/^[\w-]+$/.test(name) || seen.has(name)) throw new Error('COOKIE'); seen.add(name); }
  const cookie = parts.join(';');
  if (!/^(?:[1-9]\d{0,14})$/.test(cookieValue(cookie, 'udb_uid')) || !cookieValue(cookie, 'username')) throw new Error('COOKIE');
  return cookie;
}
function cookieValue(cookie: string, key: string) {
  const raw = cookie.split(';').find(x => x.startsWith(key + '='))?.slice(key.length + 1) || '';
  // Match the official package page's legacy unescape() when constructing its passport/signature.
  return raw.replace(/%u([a-f0-9]{4})|%([a-f0-9]{2})/gi, (_, wide, narrow) => String.fromCharCode(parseInt(wide || narrow, 16)));
}
const integer = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
export async function readBounded(response: Response, max = 1024 * 1024) {
  const reader = response.body?.getReader(); const parts: Uint8Array[] = []; let length = 0;
  if (reader) for (;;) { const { done, value } = await reader.read(); if (done) break; length += value.length; if (length > max) { await reader.cancel(); throw new Error('RESPONSE'); } parts.push(value); }
  const result = new Uint8Array(length); let offset = 0; for (const part of parts) { result.set(part, offset); offset += part.length; } return result;
}
export async function resolveRoom(input: unknown, fetcher: typeof fetch = fetch): Promise<Room> {
  if (typeof input !== 'string' || !/^[1-9]\d{0,11}$/.test(input)) throw new Error('ROOM');
  const response = await fetcher('https://www.huya.com/' + input, { redirect: 'manual', signal: AbortSignal.timeout(20000) });
  if (!response.ok) { await response.body?.cancel(); throw new Error('ROOM'); }
  const html = new TextDecoder().decode(await readBounded(response, 3 * 1024 * 1024));
  const body = /<body\b[^>]*>/i.exec(html)?.[0] || '', uid = Number(/\bdata-lp=["'](\d+)["']/.exec(body)?.[1]);
  const title = /<title>([^<]{1,200})<\/title>/i.exec(html)?.[1] || '';
  if (!integer(uid) || uid === 0 || !title.includes('虎牙')) throw new Error('ROOM');
  return { id: input, uid, name: title.split('_')[0].replace(/官方直播$/, '').slice(0, 80) };
}
export function inventoryFrom(data: Record<number, any>): Inventory {
  if (!Array.isArray(data[0]) || !integer(data[1]) || data[1] <= 0) throw new Error('RESPONSE');
  const items = data[0].filter((x: any) => x?.[0]?.[0] === 4 && x[0][3] === '虎粮');
  // Only ordinary tiger food (item 4) already in the backpack. Super-fan food and other gifts are excluded.
  if (items.length > 1) throw new Error('RESPONSE');
  const count = items[0]?.[5] ?? 0; if (!integer(count) || count > 2147483647) throw new Error('RESPONSE');
  return { count, checkedAt: new Date().toISOString() };
}
export class HuyaClient implements Transport {
  private cookie: string;
  private uid: number;
  private room: Room;
  private fetcher: typeof fetch;
  constructor(cookie: string, room: Room, fetcher: typeof fetch = fetch) {
    this.room = room; this.fetcher = (url, init) => fetcher(url, init);
    this.cookie = cleanCookie(cookie); this.uid = Number(cookieValue(this.cookie, 'udb_uid'));
    if (!Number.isSafeInteger(this.uid) || this.uid <= 0) throw new Error('COOKIE');
  }
  private identity(): Fields { return { 0: this.uid, 1: '', 2: '', 3: 'webh5&1.0.0&huya', 4: this.cookie, 5: 0, 6: '', 7: '' }; }
  private async rpc(servant: string, func: string, req: Fields) {
    const info = encode({ 0: this.uid, 1: '', 2: 'webh5&1.0.0&huya', 3: 'HUYA&ZH&2052', 4: '', 5: '', 6: 0, 7: '', 8: this.cookie, 9: '', 10: { map: [] } });
    // Fixed provider endpoint. Never log the URL: baseinfo contains the provider's login cookies.
    const response = await this.fetcher('https://cdnws.api.huya.com/?baseinfo=' + encodeURIComponent(base64(info)), {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream', Cookie: this.cookie, Origin: 'https://hd.huya.com', Referer: 'https://hd.huya.com/' },
      body: packet(servant, func, req), redirect: 'manual', signal: AbortSignal.timeout(25000)
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error('HTTP:' + response.status); }
    return unpack(await readBounded(response), servant, func);
  }
  async inventory() { return inventoryFrom(await this.rpc('wupui', 'getPackageGift', { 0: { struct: this.identity() }, 1: this.room.uid })); }
  async sequence() {
    // These are public web-client protocol constants, not user credentials.
    const sign = createHash('md5').update(`${this.uid}151AzCXiouW6aLc4AsVGKAOOLlNLawNQsuV`).digest('hex');
    const data = await this.rpc('sequenceui', 'getSequence', { 0: { struct: this.identity() }, 1: 1, 2: 5, 3: 1, 4: sign });
    if (data[0] !== 0 || typeof data[1] !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(data[1])) throw new Error('RESPONSE'); return data[1];
  }
  async send(count: number, order: string): Promise<Receipt> {
    if (!integer(count) || count < 1 || count > 2147483647 || !/^[A-Za-z0-9_-]{1,200}$/.test(order)) throw new Error('PLAN');
    // iPayPloy=2 is BACKPACK ONLY, as used by the official package page. Never retry using a different policy.
    const sign = createHash('md5').update(`${this.uid}004${count}${this.room.uid}${order}255${cookieValue(this.cookie, 'username')}2Hi2UfWa8LhRM07ZjucWL9wzuX7okmGvd`).digest('hex');
    const data = await this.rpc('PropsUIServer', 'consumeGiftSafe', { 0: { struct: this.identity() }, 1: 0, 2: 0, 3: 4, 4: count,
      5: this.room.uid, 6: this.room.uid, 7: order, 8: '', 9: 2, 10: 5, 11: '', 12: 5,
      13: cookieValue(this.cookie, 'username'), 14: 2, 15: sign, 16: 0, 17: 0, 18: 0, 19: { map: [] }, 20: '', 21: '' });
    if (!integer(data[0])) throw new Error('RESPONSE');
    return { code: data[0], count: data[2], order: data[3], uid: data[6], item: data[1], cost: data[12] };
  }
}
