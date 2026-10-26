import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const file = resolve(root, '.dev.vars');
let upload = false, config;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--upload') upload = true;
  else if (args[i] === '--config' && args[i + 1] && !args[i + 1].startsWith('--')) config = resolve(root, args[++i]);
  else throw new Error('用法：node scripts/secrets.mjs [--upload] [--config wrangler.local.jsonc]');
}
if (config && !existsSync(config)) throw new Error('指定的 Wrangler 配置不存在');
if (!existsSync(file)) {
  writeFileSync(file, `ADMIN_TOKEN=${randomBytes(32).toString('base64url')}\nENCRYPTION_KEY=${randomBytes(32).toString('base64')}\n`, { mode: 0o600, flag: 'wx' });
  console.log('已生成 .dev.vars；它已被 Git 忽略。管理密钥不会打印到终端。');
}
if (upload) {
  const vars = Object.fromEntries(readFileSync(file, 'utf8').split(/\r?\n/).filter(x => x && !x.startsWith('#')).map(line => {
    const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)];
  }));
  if (!vars.ADMIN_TOKEN || vars.ADMIN_TOKEN.length < 32 || Buffer.from(vars.ENCRYPTION_KEY ?? '', 'base64').length !== 32) throw new Error('.dev.vars 密钥格式不正确，请使用生成的密钥');
  const secrets = { ADMIN_TOKEN: vars.ADMIN_TOKEN, ENCRYPTION_KEY: vars.ENCRYPTION_KEY };
  if (vars.NODESEEK_ADMIN_TOKEN) {
    if (vars.NODESEEK_ADMIN_TOKEN.length < 32 || vars.NODESEEK_ADMIN_TOKEN === vars.ADMIN_TOKEN) throw new Error('NodeSeek 管理密钥至少 32 字符，且应与面板管理密钥不同');
    secrets.NODESEEK_ADMIN_TOKEN = vars.NODESEEK_ADMIN_TOKEN;
  }
  if (vars.NOTIFY_WEBHOOK_URL) {
    let valid = false;
    try { const url = new URL(vars.NOTIFY_WEBHOOK_URL); valid = url.protocol === 'https:' && !url.username && !url.password; } catch { /* Do not echo a private webhook URL. */ }
    if (!valid) throw new Error('通知地址必须是有效的 HTTPS URL，且不能带用户名或密码');
    secrets.NOTIFY_WEBHOOK_URL = vars.NOTIFY_WEBHOOK_URL;
  }
  const child = spawn(process.execPath, [resolve(root, 'node_modules/wrangler/bin/wrangler.js'), 'secret', 'bulk', ...(config ? ['--config', config] : [])], {
    cwd: root, stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true
  });
  child.stdin.on('error', () => { console.error('无法向 Wrangler 传入密钥'); process.exitCode = 1; });
  child.stdin.end(JSON.stringify(secrets));
  child.on('error', () => { console.error('无法启动 Wrangler'); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
}
