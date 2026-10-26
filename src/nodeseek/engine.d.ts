export function engineFetch(request: Request, env: unknown): Promise<Response>;
export function encryptCookie(cookie: string, env: unknown): Promise<unknown>;
export function decryptCookie(cookie: unknown, env: unknown): Promise<string>;
export function dailyPlan(env: unknown, date: string, window?: unknown): Promise<any>;
export function scheduledTick(env: unknown, deps?: unknown): Promise<any>;
export function checkIn(env: unknown, deps?: unknown): Promise<any>;
export function run(env: unknown, source?: string, deps?: unknown): Promise<any>;
