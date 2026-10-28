import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/theme.js', import.meta.url), 'utf8');
function setup({ saved = null, dark = false, blocked = false }: { saved?: string | null; dark?: boolean; blocked?: boolean } = {}) {
  const events = new Map(), windowEvents = new Map(), controlEvents = new Map(), writes: string[] = [];
  const control = { value: '', addEventListener: (name, fn) => controlEvents.set(name, fn) };
  const root = { dataset: {} as Record<string, string> };
  let meta = '', updates = 0, systemListener, ready = false;
  const system = { matches: dark, addEventListener: (_name, fn) => { systemListener = fn; } };
  const document = {
    documentElement: root, getElementById: () => ready ? control : null,
    querySelector: () => ({ setAttribute: (_name, value) => { meta = value; } }),
    addEventListener: (name, fn) => events.set(name, fn), dispatchEvent: () => { updates++; }
  };
  vm.runInNewContext(source, { document, Event: class { type: string; constructor(type: string) { this.type = type; } },
    matchMedia: () => system,
    localStorage: { getItem() { if (blocked) throw new Error('denied'); return saved; }, setItem(_key, value) { if (blocked) throw new Error('denied'); writes.push(value); } },
    window: { addEventListener: (name, fn) => windowEvents.set(name, fn) }
  });
  return { root, control, writes, get meta() { return meta; }, get updates() { return updates; },
    ready() { ready = true; events.get('DOMContentLoaded')(); }, choose(value) { control.value = value; controlEvents.get('change')(); },
    system(dark) { system.matches = dark; systemListener(); }, storage(key, newValue) { windowEvents.get('storage')({key,newValue}); } };
}
test('system appearance is applied before controls load, including browser chrome color', () => {
  const s = setup({dark:true}); assert.equal(s.root.dataset.theme,'dark'); assert.equal(s.meta,'#19191d');
  s.ready(); assert.equal(s.control.value,'system'); s.system(false); assert.equal(s.root.dataset.theme,'light'); assert.equal(s.meta,'#fafafa');
});
test('explicit appearance overrides the system and is saved; choosing system follows changes again', () => {
  const s = setup({saved:'light',dark:true}); assert.equal(s.root.dataset.theme,'light'); s.ready();
  s.choose('dark'); assert.equal(s.root.dataset.theme,'dark'); assert.deepEqual(s.writes,['dark']);
  s.system(false); assert.equal(s.root.dataset.theme,'dark');
  s.choose('system'); assert.equal(s.root.dataset.theme,'light'); s.system(true); assert.equal(s.root.dataset.theme,'dark');
});
test('denied storage still permits switching; invalid saved values fall back to the system', () => {
  for (const options of [{blocked:true,dark:true},{saved:'invalid',dark:true}]) {
    const s = setup(options); assert.equal(s.root.dataset.theme,'dark'); s.ready(); s.choose('light'); assert.equal(s.root.dataset.theme,'light');
  }
});
test('cross-tab appearance changes update controls and notify charts without touching credentials', () => {
  const s = setup(); s.ready(); const before = s.updates;
  s.storage('unrelated','dark'); assert.equal(s.updates,before);
  s.storage('checkin-appearance','dark'); assert.equal(s.root.dataset.theme,'dark'); assert.equal(s.control.value,'dark');
  s.storage(null,null); assert.equal(s.root.dataset.theme,'light'); assert.equal(s.control.value,'system');
  assert.deepEqual(s.writes,[]);
});
