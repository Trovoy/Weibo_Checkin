import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';

const root = new URL('../', import.meta.url);
const parsed = ts.parseConfigFileTextToJson('wrangler.jsonc', readFileSync(new URL('wrangler.jsonc', root), 'utf8'));
if (parsed.error) throw new Error('公开 Wrangler 配置不是有效 JSONC');
const config = parsed.config;
if (config.account_id || config.zone_id || config.routes?.length || config.route || config.workers_dev !== true || config.preview_urls !== false) {
  throw new Error('公开配置应使用 workers.dev 并关闭版本预览；账号、域名配置请放入 wrangler.local.jsonc');
}
const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
const privateFiles = files.filter(path => path !== '.dev.vars.example' &&
  /^(?:\.dev\.vars(?:\..*)?|\.env(?:\..*)?|wrangler\.local\.jsonc|\.wrangler\/|outputs\/|work\/)/.test(path));
if (privateFiles.length) throw new Error('发现不应提交的私有文件：' + privateFiles.join(', '));
console.log('公开配置与私有文件排除检查通过。此检查不能代替人工脱敏审查。');
