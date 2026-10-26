const encoder = new TextEncoder();
export function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}
export function unbase64(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), c => c.charCodeAt(0));
}
async function key(secret: string) {
  const bytes = unbase64(secret);
  if (bytes.length !== 32) throw new Error('ENCRYPTION_KEY 必须为 32 字节的 Base64');
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function seal(value: unknown, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(secret), encoder.encode(JSON.stringify(value)));
  return base64(iv) + '.' + base64(new Uint8Array(encrypted));
}
export async function open<T>(value: string, secret: string): Promise<T> {
  const [iv, body] = value.split('.');
  const data = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unbase64(iv) }, await key(secret), unbase64(body));
  return JSON.parse(new TextDecoder().decode(data)) as T;
}
export async function sameSecret(a: string, b: string): Promise<boolean> {
  const [aa, bb] = await Promise.all([a, b].map(x => crypto.subtle.digest('SHA-256', encoder.encode(x))));
  const left = new Uint8Array(aa), right = new Uint8Array(bb);
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
  return diff === 0;
}
async function sign(value: string, secret: string) {
  const k = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return base64(new Uint8Array(await crypto.subtle.sign('HMAC', k, encoder.encode(value))));
}
export async function session(secret: string, now = Date.now()) {
  const expires = String(now + 12 * 60 * 60 * 1000);
  return expires + '.' + await sign(expires, secret);
}
export async function validSession(value: string, secret: string, now = Date.now()) {
  const [expires, signature] = value.split('.');
  const expiry = Number(expires);
  return Number.isFinite(expiry) && expiry > now && expiry <= now + 12 * 60 * 60 * 1000 && !!signature && await sameSecret(signature, await sign(expires, secret));
}
