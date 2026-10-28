export interface Window { start: string; end: string }
export interface DailySchedule { day: string; attempts: number; nextAt?: string; lastAt?: string; paused?: boolean }
export const MORNING: Window = { start: '08:00', end: '12:00' };
export const localDay = (now: number) => new Date(now + 8 * 3600000).toISOString().slice(0, 10);
const midnight = (day: string) => Date.parse(day + 'T00:00:00+08:00');
export function validMorning(window: Window) {
  const minute = (s: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s) ? Number(s.slice(0, 2)) * 60 + Number(s.slice(3)) : NaN;
  const start = minute(window?.start ?? ''), end = minute(window?.end ?? '');
  return start >= 480 && end <= 720 && end - start >= 5;
}
async function draw(secret: string, label: string, range: number) {
  if (typeof secret !== 'string' || secret.length < 32) throw Error('CONFIG');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('daily-schedule:v2:' + label));
  return new DataView(bytes).getUint32(0) % range;
}
export async function firstAt(secret: string, platform: string, day: string, window: Window = MORNING) {
  if (!validMorning(window) || !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw Error('CONFIG');
  const minute = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
  return new Date(midnight(day) + (minute(window.start) + await draw(secret, `${platform}:${day}:${window.start}:${window.end}`, minute(window.end) - minute(window.start))) * 60000).toISOString();
}
export async function planFor(saved: DailySchedule | undefined, secret: string, platform: string, now = Date.now(), window = MORNING): Promise<DailySchedule> {
  const day = localDay(now);
  return saved?.day === day ? { ...saved } : { day, attempts: 0, nextAt: await firstAt(secret, platform, day, window) };
}
// Claim before I/O. The next retry stays stable across minute ticks and object restarts.
export async function claimAttempt(plan: DailySchedule, secret: string, platform: string, now = Date.now()): Promise<DailySchedule> {
  if (localDay(now) !== plan.day) throw Error('DAY');
  const attempts = plan.attempts + 1;
  const delay = 45 + await draw(secret, `${platform}:${plan.day}:retry:${attempts}`, 31);
  const next = Math.ceil((now + delay * 60000) / 60000) * 60000;
  return { day: plan.day, attempts, lastAt: new Date(now).toISOString(), nextAt: localDay(next) === plan.day ? new Date(next).toISOString() : undefined };
}
export async function scheduleView(saved: DailySchedule | undefined, secret: string, platform: string, completed: boolean, now = Date.now(), window = MORNING) {
  const plan = await planFor(saved, secret, platform, now, window);
  const primaryAt = await firstAt(secret, platform, plan.day, window);
  const nextAt = completed || (!plan.nextAt && !plan.paused) ? await firstAt(secret, platform, localDay(now + 86400000), window) : plan.paused ? null : plan.nextAt;
  return { ...window, primaryAt, nextAt, attempts: plan.attempts, paused: !!plan.paused, completed, retryMinutes: { min: 45, max: 75 }, timeZone: 'Asia/Taipei' };
}
