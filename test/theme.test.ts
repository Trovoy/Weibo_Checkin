import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/theme.js', import.meta.url), 'utf8');
function setup({ saved = null, dark = false, blocked = false }: { saved?: string | null; dark?: boolean; blocked?: boolean } = {}) {
  const events = new Map(), windowEvents = new Map(), writes: string[] = [];
  let meta = '', updates = 0, systemListener, ready = false;
  function element(appearance = '') {
    const handlers = new Map(), attrs = new Map();
    return { dataset: {appearance}, hidden: true, title: '', handlers, attrs,
      addEventListener: (name, fn) => handlers.set(name, fn),
      setAttribute: (name, value) => attrs.set(name, value),
      focus() { document.activeElement = this; },
      fire(name, event = {}) { handlers.get(name)?.(event); }
    };
  }
  const root = { dataset: {} as Record<string, string> };
  const icon = element(), control = {...element(), querySelector: () => icon};
  const items = ['light','dark','system'].map(value => element(value));
  const menu = {...element(), querySelectorAll: () => items};
  const wrapper = {...element(), contains: target => target === control || target === menu || items.includes(target)};
  const elements = {appearance:control,'appearance-menu':menu,'appearance-control':wrapper};
  const system = { matches: dark, addEventListener: (_name, fn) => { systemListener = fn; } };
  const document = {
    activeElement: null, hidden: false, documentElement: root,
    getElementById: id => ready ? elements[id] : null,
    querySelector: () => ({ setAttribute: (_name, value) => { meta = value; } }), querySelectorAll: () => items,
    addEventListener: (name, fn) => events.set(name, fn), dispatchEvent: () => { updates++; }
  };
  vm.runInNewContext(source, { document, Event: class { type: string; constructor(type: string) { this.type = type; } },
    matchMedia: query => query.includes('color-scheme') ? system : {matches:false},
    localStorage: { getItem() { if (blocked) throw new Error('denied'); return saved; }, setItem(_key, value) { if (blocked) throw new Error('denied'); writes.push(value); } },
    window: { addEventListener: (name, fn) => windowEvents.set(name, fn) }
  });
  return { root, control, menu, items, icon, writes, wrapper,
    get selected() { return items.find(item => item.attrs.get('aria-checked') === 'true')?.dataset.appearance; },
    get focused() { return document.activeElement; }, get meta() { return meta; }, get updates() { return updates; },
    ready() { ready = true; events.get('DOMContentLoaded')(); },
    choose(value) { items.find(item => item.dataset.appearance === value).fire('click'); },
    system(dark) { system.matches = dark; systemListener(); }, storage(key, newValue) { windowEvents.get('storage')({key,newValue}); },
    key(target, key) { let prevented = false; target.fire('keydown',{key,preventDefault(){ prevented = true; }}); return prevented; },
    escape() { events.get('keydown')({key:'Escape',preventDefault(){}}); },
    outside() { events.get('pointerdown')({target:{}}); }, resize() { windowEvents.get('resize')(); }
  };
}

test('system appearance is applied before controls load, including browser chrome color', () => {
  const s = setup({dark:true}); assert.equal(s.root.dataset.theme,'dark'); assert.equal(s.meta,'#19191d');
  s.ready(); assert.equal(s.selected,'system'); s.system(false); assert.equal(s.root.dataset.theme,'light'); assert.equal(s.meta,'#fafafa');
});

test('explicit appearance overrides the system and is saved; choosing system follows changes again', () => {
  const s = setup({saved:'light',dark:true}); assert.equal(s.root.dataset.theme,'light'); s.ready();
  s.choose('dark'); assert.equal(s.root.dataset.theme,'dark'); assert.deepEqual(s.writes,['dark']);
  assert.equal(s.selected,'dark'); assert.equal(s.icon.attrs.get('href'),'#icon-moon'); assert.match(s.control.attrs.get('aria-label'),/深色/);
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
  s.storage('checkin-appearance','dark'); assert.equal(s.root.dataset.theme,'dark'); assert.equal(s.selected,'dark');
  s.storage(null,null); assert.equal(s.root.dataset.theme,'light'); assert.equal(s.selected,'system');
  assert.deepEqual(s.writes,[]);
});

test('appearance menu supports keyboard navigation, selection and Escape with focus restoration', () => {
  const s = setup(); s.ready(); assert.equal(s.key(s.control,'ArrowDown'),true);
  assert.equal(s.menu.hidden,false); assert.equal(s.control.attrs.get('aria-expanded'),'true'); assert.equal(s.focused,s.items[0]);
  s.key(s.menu,'End'); assert.equal(s.focused,s.items[2]); s.key(s.menu,'ArrowDown'); assert.equal(s.focused,s.items[0]);
  s.key(s.menu,'ArrowUp'); assert.equal(s.focused,s.items[2]); s.key(s.menu,'Home'); assert.equal(s.focused,s.items[0]);
  s.choose('dark'); assert.equal(s.menu.hidden,true); assert.equal(s.focused,s.control);
  s.control.fire('click'); assert.equal(s.focused,s.items[1]); s.escape(); assert.equal(s.menu.hidden,true); assert.equal(s.focused,s.control);
});

test('outside click, focus departure and resize dismiss the appearance menu without trapping focus', () => {
  const s = setup(); s.ready(); s.control.fire('click'); s.outside(); assert.equal(s.menu.hidden,true);
  s.control.fire('click'); s.wrapper.fire('focusout',{relatedTarget:s.items[0]}); assert.equal(s.menu.hidden,false);
  s.wrapper.fire('focusout',{relatedTarget:null}); assert.equal(s.menu.hidden,true);
  s.control.fire('click'); s.resize(); assert.equal(s.menu.hidden,true); assert.equal(s.control.attrs.get('aria-expanded'),'false');
});
