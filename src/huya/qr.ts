import puppeteer, { type Browser, type BrowserWorker, type Page } from '@cloudflare/puppeteer';
import { base64 } from '../crypto.ts';
import { cleanCookie } from './client.ts';

export interface QRSession { sessionId: string; expiresAt: number; image: string }
const LOGIN = 'https://www.huya.com/';
async function capture(page: Page) {
  const shot = async (clip?: { x: number; y: number; width: number; height: number }) => {
    let bytes = await page.screenshot({ type: 'jpeg', quality: 80, ...(clip ? { clip } : {}) });
    if (bytes.length > 60000) bytes = await page.screenshot({ type: 'jpeg', quality: 40, ...(clip ? { clip } : {}) });
    if (bytes.length > 60000) throw new Error('QR_IMAGE'); return base64(bytes);
  };
  for (const frame of page.frames()) {
    if (!/^https:\/\/(?:[^/]+\.)?huya\.com\//.test(frame.url()) || frame === page.mainFrame()) continue;
    if (!/udb|login|passport/i.test(frame.url())) continue;
    const element = await frame.frameElement(); const box = await element?.boundingBox();
    if (box && box.width >= 250 && box.height >= 200 && box.x >= 0 && box.y >= 0) return shot(box);
  }
  return shot();
}
async function currentPage(browser: Browser) {
  const pages = await browser.pages(); const page = pages.find(p => p.url().startsWith(LOGIN));
  if (!page) throw new Error('QR_EXPIRED'); return page;
}
export async function startQR(binding: Fetcher): Promise<QRSession> {
  const browser = await puppeteer.launch(binding as unknown as BrowserWorker, { keep_alive: 180000 });
  let keep = false, phase = 'QR_PAGE';
  try {
    const page = await browser.newPage(); await page.setViewport({ width: 1200, height: 850 });
    await page.setRequestInterception(true);
    page.on('request', request => { if (request.resourceType() === 'media') void request.abort(); else void request.continue(); });
    await page.goto(LOGIN, { waitUntil: 'domcontentloaded', timeout: 45000 });
    phase = 'QR_ENTRY';
    await page.waitForFunction(`Array.from(document.querySelectorAll('#J_duyaHeaderRight a, #J_duyaHeaderRight button, #J_duyaHeaderRight span')).some(e => e.textContent.trim() === '登录' && e.getBoundingClientRect().width > 0)`, { timeout: 20000 });
    const clicked = await page.evaluate(`(() => { const e = Array.from(document.querySelectorAll('#J_duyaHeaderRight a, #J_duyaHeaderRight button, #J_duyaHeaderRight span')).find(e => e.textContent.trim() === '登录' && e.getBoundingClientRect().width > 0); if (!e) return false; e.click(); return true; })()`);
    if (!clicked) throw new Error('QR_UI');
    phase = 'QR_WINDOW';
    // Wait for the official login frame, not a fixed delay or a guessed QR endpoint.
    await page.waitForFunction(`Array.from(document.querySelectorAll('iframe')).some(e => /udb|login|passport/i.test(e.src) && e.getBoundingClientRect().width >= 250 && e.getBoundingClientRect().height >= 200)`, { timeout: 25000 });
    phase = 'QR_IMAGE';
    const session = { sessionId: browser.sessionId(), expiresAt: Date.now() + 180000, image: await capture(page) };
    keep = true; return session;
  } catch { throw new Error(phase); }
  finally { if (keep) await browser.disconnect(); else await browser.close().catch(() => {}); }
}
export async function pollQR(binding: Fetcher, session: QRSession): Promise<{ status: 'waiting' | 'connected'; cookie?: string; image?: string }> {
  const browser = await puppeteer.connect(binding as unknown as BrowserWorker, session.sessionId);
  try {
    const page = await currentPage(browser);
    const loggedIn = await page.evaluate(`(() => { const e = document.querySelector('#J_duyaHeaderRight a[href*="i.huya.com"]'); return !!e && e.getBoundingClientRect().width > 0; })()`);
    if (!loggedIn) return { status: 'waiting', image: await capture(page) };
    const cookies = await page.cookies('https://www.huya.com/', 'https://hd.huya.com/');
    const selected = new Map<string, string>();
    for (const c of cookies) {
      if (!['huya.com', '.huya.com', 'www.huya.com', 'hd.huya.com'].includes(c.domain) || c.path !== '/' || (c.expires > 0 && c.expires * 1000 <= Date.now())) continue;
      if (selected.has(c.name) && selected.get(c.name) !== c.value) throw new Error('QR_COOKIE_CONFLICT');
      selected.set(c.name, c.value);
    }
    let cookie: string;
    try { cookie = cleanCookie([...selected].map(([k, v]) => k + '=' + v).join(';')); }
    catch { return { status: 'waiting' }; }
    return { status: 'connected', cookie };
  } finally { await browser.disconnect(); }
}
export async function closeQR(binding: Fetcher, session: QRSession) {
  const browser = await puppeteer.connect(binding as unknown as BrowserWorker, session.sessionId); await browser.close();
}
