// Small, bounded Tars/WUP v3 codec. No provider scripts are downloaded or executed.
export type Fields = Record<number, Value>;
type Value = number | string | Uint8Array | { struct: Fields } | { list: Value[] } | { map: [Value, Value][] };
export function encode(fields: Fields): Uint8Array<ArrayBuffer> {
  const out: number[] = [];
  const head = (tag: number, type: number) => { if (tag < 15) out.push(tag << 4 | type); else out.push(240 | type, tag); };
  const raw = (value: bigint, width: number) => { for (let i = width - 1; i >= 0; i--) out.push(Number(value >> BigInt(i * 8) & 255n)); };
  const field = (tag: number, value: Value) => {
    if (typeof value === 'number') {
      if (!Number.isSafeInteger(value)) throw new Error('Tars integer');
      const width = value === 0 ? 0 : value >= -128 && value <= 127 ? 1 : value >= -32768 && value <= 32767 ? 2 : value >= -2147483648 && value <= 2147483647 ? 4 : 8;
      head(tag, width === 0 ? 12 : width === 1 ? 0 : width === 2 ? 1 : width === 4 ? 2 : 3); raw(BigInt(value), width);
    } else if (typeof value === 'string') {
      const b = new TextEncoder().encode(value); head(tag, b.length < 256 ? 6 : 7); raw(BigInt(b.length), b.length < 256 ? 1 : 4); out.push(...b);
    } else if (value instanceof Uint8Array) { head(tag, 13); head(0, 0); field(0, value.length); out.push(...value); }
    else if ('struct' in value) { head(tag, 10); fieldsOut(value.struct); head(0, 11); }
    else if ('list' in value) { head(tag, 9); field(0, value.list.length); for (const x of value.list) field(0, x); }
    else { head(tag, 8); field(0, value.map.length); for (const [k, v] of value.map) { field(0, k); field(1, v); } }
  };
  const fieldsOut = (data: Fields) => { for (const [tag, value] of Object.entries(data)) field(Number(tag), value); };
  fieldsOut(fields); return Uint8Array.from(out);
}
export function decode(bytes: Uint8Array): Record<number, any> {
  if (bytes.length > 1024 * 1024) throw new Error('Tars size');
  let p = 0, budget = 20000;
  const byte = () => { if (p >= bytes.length) throw new Error('Tars truncated'); return bytes[p++]; };
  const raw = (n: number, signed = false) => { let v = 0n; for (let i = 0; i < n; i++) v = v << 8n | BigInt(byte()); if (signed && v >> BigInt(n * 8 - 1)) v -= 1n << BigInt(n * 8); const x = Number(v); if (!Number.isSafeInteger(x)) throw new Error('Tars precision'); return x; };
  const head = () => { const h = byte(); return { tag: h >> 4 === 15 ? byte() : h >> 4, type: h & 15 }; };
  const take = (n: number) => { if (!Number.isSafeInteger(n) || n < 0 || p + n > bytes.length) throw new Error('Tars length'); const b = bytes.slice(p, p + n); p += n; return b; };
  const length = (depth: number) => { const h = head(); if (h.tag !== 0) throw new Error('Tars count'); const n = value(h.type, depth); if (!Number.isSafeInteger(n) || n < 0 || n > 20000) throw new Error('Tars count'); return n as number; };
  const fieldsIn = (depth: number, nested: boolean) => {
    const result: Record<number, any> = {}; let ended = false;
    while (p < bytes.length) { const h = head(); if (h.type === 11) { if (!nested) throw new Error('Tars end'); ended = true; break; } if (Object.hasOwn(result, h.tag)) throw new Error('Tars duplicate'); result[h.tag] = value(h.type, depth); }
    if (nested && !ended) throw new Error('Tars unterminated'); return result;
  };
  const value = (type: number, depth: number): any => {
    if (--budget < 0 || depth > 24) throw new Error('Tars complexity');
    if (type <= 3) return raw([1, 2, 4, 8][type], true);
    if (type === 12) return 0;
    if (type === 6 || type === 7) return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(take(raw(type === 6 ? 1 : 4)));
    if (type === 10) return fieldsIn(depth + 1, true);
    if (type === 13) { const h = head(); if (h.tag !== 0 || h.type !== 0) throw new Error('Tars bytes'); return take(length(depth + 1)); }
    if (type === 9) { const n = length(depth + 1), result = []; for (let i = 0; i < n; i++) result.push(value(head().type, depth + 1)); return result; }
    if (type === 8) { const n = length(depth + 1), result = new Map(); for (let i = 0; i < n; i++) { const k = value(head().type, depth + 1); if (result.has(k)) throw new Error('Tars map duplicate'); result.set(k, value(head().type, depth + 1)); } return result; }
    throw new Error('Tars unsupported');
  };
  return fieldsIn(0, false);
}
export function packet(servant: string, func: string, req: Fields) {
  const payload = encode({ 0: { map: [['tReq', encode({ 0: { struct: req } })]] } });
  const body = encode({ 1: 3, 2: 0, 3: 0, 4: 1, 5: servant, 6: func, 7: payload, 8: 15000, 9: { map: [] }, 10: { map: [] } });
  const result = new Uint8Array(body.length + 4); new DataView(result.buffer).setUint32(0, result.length); result.set(body, 4); return result;
}
export function unpack(bytes: Uint8Array, servant: string, func: string) {
  if (bytes.length < 4 || new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0) !== bytes.length) throw new Error('WUP frame');
  const envelope = decode(bytes.subarray(4));
  if (envelope[1] !== 3 || envelope[5] !== servant || envelope[6] !== func || !(envelope[7] instanceof Uint8Array)) throw new Error('WUP envelope');
  const params = decode(envelope[7])[0]; if (!(params instanceof Map)) throw new Error('WUP parameters');
  const code = params.get(''); if (code && decode(code)[0] !== 0) throw new Error('WUP rejected:' + decode(code)[0]);
  const rsp = params.get('tRsp'); if (!(rsp instanceof Uint8Array)) throw new Error('WUP missing response');
  const result = decode(rsp)[0]; if (!result || typeof result !== 'object') throw new Error('WUP response'); return result;
}
