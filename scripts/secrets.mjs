import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const file = resolve(root, '.dev.vars');
if (!existsSync(file)) {
  writeFileSync(file, `ADMIN_TOKEN=${randomBytes(32).toString('base64url')}\nENCRYPTION_KEY=${randomBytes(32).toString('base64')}\n`, { mode: 0o600, flag: 'wx' });
  console.log('已生成 .dev.vars；它已被 Git 忽略。管理密钥不会打印到终端。');
}
if (process.argv.includes('--upload')) {
  const vars = Object.fromEntries(readFileSync(file, 'utf8').split(/\r?\n/).filter(x => x && !x.startsWith('#')).map(line => {
    const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)];
  }));
  if (!vars.ADMIN_TOKEN || !vars.ENCRYPTION_KEY) throw new Error('.dev.vars 缺少密钥');
  const child = spawn(process.execPath, [resolve(root, 'node_modules/wrangler/bin/wrangler.js'), 'secret', 'bulk'], {
    cwd: root, stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true
  });
  child.stdin.end(JSON.stringify(vars));
  child.on('error', () => { console.error('无法启动 Wrangler'); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
}
