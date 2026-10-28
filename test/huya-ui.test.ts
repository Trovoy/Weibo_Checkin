import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/huya.js', import.meta.url), 'utf8');
function setup(api, hash = '#/huya') {
  const elements = new Map();
  const node = (_tag?, text?, _class?) => ({ textContent: text, hidden: false, children: [], listeners: {},
    append(...nodes) { this.children.push(...nodes); }, replaceChildren() { this.children = []; },
    addEventListener(name, handler) { this.listeners[name] = handler; }, removeAttribute() {} });
  const $ = id => { if (!elements.has(id)) elements.set(id, node()); return elements.get(id); };
  const context = vm.createContext({ $, node, api, platformEpoch: 1, platformRegistry: [{ id: 'huya', available: true }],
    busy: new Set(), location: { hash }, time: value => value, clearTimeout, setTimeout,
    action: (_button, task) => task(), renderPlatformCards() {}, renderPlatformHistory() {}, toast() {} });
  vm.runInContext(source, context);
  return { $, run: code => vm.runInContext(code, context) };
}
const snapshot = (count, checkedAt) => ({ configured: true, paused: false, enabled: true, time: '09:30',
  inventory: { count, checkedAt }, history: [], record: { code: 'EMPTY', at: '2026-01-01T01:30:00Z' } });

test('Huya replaces an old zero snapshot with a real backpack read and distinguishes the previous empty task', async () => {
  const calls = [], old = snapshot(0, '2026-01-01T01:30:00Z'), current = snapshot(18, new Date().toISOString());
  const { $, run } = setup(async path => { calls.push(path); return path.endsWith('/probe') ? current : old; });
  await run('refreshHuya()');
  assert.deepEqual(calls, ['platforms/huya/status', 'platforms/huya/probe']);
  assert.equal($('hy-count').textContent, '18 个');
  assert.equal($('hy-state').textContent, '有虎粮待赠送');
  assert.match($('hy-result').textContent, /上次任务（2026-01-01T01:30:00Z）/);
  assert.match($('hy-result').textContent, /当前已检测到虎粮/);
});

test('Huya refresh button forces a provider read even with a recent cached snapshot', async () => {
  const calls = [], current = snapshot(18, new Date().toISOString());
  const { $, run } = setup(async path => { calls.push(path); return current; });
  await run('refreshHuya()'); assert.deepEqual(calls, ['platforms/huya/status']);
  await $('hy-refresh').listeners.click();
  assert.deepEqual(calls.slice(1), ['platforms/huya/status', 'platforms/huya/probe']);
});

test('Huya read failures show unknown inventory instead of a cached zero and allow another probe', async () => {
  const { $, run } = setup(async path => { if (path.endsWith('/probe')) throw Error('背包暂时无法读取'); return snapshot(0, '2026-01-01T01:30:00Z'); });
  await run('refreshHuya()');
  assert.equal($('hy-count').textContent, '—');
  assert.equal($('hy-state').textContent, '读取失败');
  assert.equal($('hy-probe').disabled, false);
  assert.equal($('hy-run').disabled, true);
  await assert.rejects($('hy-probe').listeners.click(), /背包暂时无法读取/);
  assert.equal($('hy-count').textContent, '—');
});

test('Huya collapses concurrent background refreshes and ignores inventory returned after locking', async () => {
  let release, probes = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const { $, run } = setup(async path => {
    if (path.endsWith('/status')) return snapshot(0, '2026-01-01T01:30:00Z');
    probes++; await gate; return snapshot(18, new Date().toISOString());
  });
  const first = run('refreshHuya()'), second = run('refreshHuya()');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(probes, 1);
  run('platformEpoch++; resetHuya()'); release(); await Promise.all([first, second]);
  assert.equal(run('hySnapshot'), undefined);
  assert.notEqual($('hy-count').textContent, '18 个');
});

test('Huya overview polling does not repeatedly call the backpack provider', async () => {
  const calls = [];
  const { run } = setup(async path => { calls.push(path); return snapshot(0, '2026-01-01T01:30:00Z'); }, '#/overview');
  await run('refreshHuya()'); assert.deepEqual(calls, ['platforms/huya/status']);
});
