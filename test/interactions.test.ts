import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8').split('const pages =')[0];
function setup() {
  const listeners = new Map(), elements = new Map(), tweens = [], animations = [];
  const document = { activeElement: null, addEventListener(type, fn) { listeners.set(type, [...(listeners.get(type) || []), fn]); }, querySelector: () => sidebar,
    getElementById: id => elements.get(id) };
  const element = (id, parent = null) => {
    const attrs = new Map(), classes = new Set();
    const item = { id, parentElement: parent, hidden: false, inert: false, focusCount: 0, blurCount: 0,
      classList: { add: name => classes.add(name), toggle(name, on) { if (on) classes.add(name); else classes.delete(name); }, contains: name => classes.has(name) },
      querySelector: () => ({ textContent: '' }), setAttribute: (name, value) => attrs.set(name, value), getAttribute: name => attrs.get(name),
      addEventListener() {}, contains(other) { for (let target = other; target; target = target.parentElement) if (target === item) return true; return false; },
      focus() { this.focusCount++; document.activeElement = this; }, blur() { this.blurCount++; document.activeElement = null; } };
    elements.set(id, item); return item;
  };
  const sidebar = element('sidebar'), panel = element('workspace-navigation', sidebar), button = element('mobile-menu-toggle', sidebar), backdrop = element('mobile-menu-backdrop');
  const child = element('nav-link', panel), mobile = { matches: true, addEventListener(_type, fn) { this.change = fn; } }, reduced = { matches: false };
  const targets = target => Array.isArray(target) ? target : [target];
  const schedule = (target, props) => { const tween = { targets: targets(target), props, killed: false }; tweens.push(tween); animations.push(props); };
  const motion = { killTweensOf(target) { for (const tween of tweens) if (tween.targets.some(item => targets(target).includes(item))) tween.killed = true; },
    set() {}, to: schedule, fromTo(target, from, to) { animations.push(from); schedule(target, to); } };
  const context = vm.createContext({ document, window: { gsap: motion }, matchMedia: query => query.includes('max-width') ? mobile : reduced });
  vm.runInContext(source, context);
  const run = code => vm.runInContext(code, context);
  const finish = () => { for (const tween of tweens.splice(0)) if (!tween.killed) tween.props.onComplete?.(); };
  const event = (type, data = {}) => { for (const fn of listeners.get(type) || []) fn(data); };
  return { document, panel, button, backdrop, child, sidebar, mobile, reduced, run, finish, event, animations };
}

test('rapid mobile menu toggles keep the latest visibility and inert state without layout-property tweens', () => {
  const ui = setup();
  ui.run('setMobileMenu(true); setMobileMenu(false); setMobileMenu(true)'); ui.finish();
  assert.equal(ui.button.getAttribute('aria-expanded'), 'true');
  assert.equal(ui.panel.hidden, false); assert.equal(ui.panel.inert, false); assert.equal(ui.backdrop.hidden, false);
  assert.equal(ui.sidebar.classList.contains('menu-open'), true);
  ui.run('setMobileMenu(false)'); ui.finish();
  assert.equal(ui.panel.hidden, true); assert.equal(ui.panel.inert, true); assert.equal(ui.backdrop.hidden, true);
  for (const props of ui.animations) for (const key of ['height', 'width', 'top', 'left', 'margin', 'padding']) assert.equal(Object.hasOwn(props, key), false);
});

test('pointer menu dismissal avoids programmatic focus; keyboard dismissal restores focus', () => {
  const ui = setup(); ui.run('setMobileMenu(true, false)'); ui.document.activeElement = ui.child;
  ui.event('pointerdown'); ui.run('setMobileMenu(false, false)');
  assert.equal(ui.child.blurCount, 1); assert.equal(ui.button.focusCount, 0);
  ui.run('setMobileMenu(true, false)'); ui.document.activeElement = ui.child;
  ui.event('keydown', { key: 'Escape', preventDefault() {} }); ui.finish();
  assert.equal(ui.document.activeElement, ui.button); assert.equal(ui.button.focusCount, 1);
  assert.equal(ui.panel.hidden, true);
});

test('desktop resize cancels pending mobile closure and restores accessible navigation', () => {
  const ui = setup(); ui.run('setMobileMenu(true); setMobileMenu(false)');
  ui.mobile.matches = false; ui.mobile.change(); ui.finish();
  assert.equal(ui.panel.hidden, false); assert.equal(ui.panel.inert, false); assert.equal(ui.backdrop.hidden, true);
  assert.equal(ui.sidebar.classList.contains('menu-open'), false);
});

test('reduced motion is immediate; interrupted disclosures cannot hide a reopened panel', () => {
  const ui = setup(); ui.reduced.matches = true; ui.run('setMobileMenu(true)');
  assert.equal(ui.animations.length, 0); assert.equal(ui.panel.hidden, false);
  ui.reduced.matches = false; ui.run("disclose($('workspace-navigation'), false); disclose($('workspace-navigation'), true)"); ui.finish();
  assert.equal(ui.panel.hidden, false); assert.equal(ui.panel.inert, false);
});
