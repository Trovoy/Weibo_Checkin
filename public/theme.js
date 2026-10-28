// Runs before styles render to avoid flashing the wrong theme on reload.
(() => {
  const key = 'checkin-appearance', system = matchMedia('(prefers-color-scheme: dark)');
  const choices = ['system', 'light', 'dark'];
  const names = { system: '跟随系统', light: '浅色', dark: '深色' };
  const icons = { system: 'monitor', light: 'sun', dark: 'moon' };
  let preference = 'system';
  try { const saved = localStorage.getItem(key); if (choices.includes(saved)) preference = saved; } catch { /* Private browsing can deny storage. */ }
  function apply() {
    const theme = preference === 'system' ? system.matches ? 'dark' : 'light' : preference;
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#19191d' : '#fafafa');
    const control = document.getElementById('appearance');
    if (control) {
      control.setAttribute('aria-label', '外观模式，当前：' + names[preference]);
      control.title = '外观：' + names[preference];
      control.querySelector('use').setAttribute('href', '#icon-' + icons[preference]);
      document.querySelectorAll('[data-appearance]').forEach(item => item.setAttribute('aria-checked', String(item.dataset.appearance === preference)));
    }
    document.dispatchEvent(new Event('appearancechange'));
  }
  apply();
  system.addEventListener('change', () => { if (preference === 'system') apply(); });
  window.addEventListener('storage', event => {
    if (event.key !== key && event.key !== null) return;
    preference = choices.includes(event.newValue) ? event.newValue : 'system'; apply();
  });
  document.addEventListener('DOMContentLoaded', () => {
    const control = document.getElementById('appearance'), wrapper = document.getElementById('appearance-control'), menu = document.getElementById('appearance-menu');
    const items = [...menu.querySelectorAll('[data-appearance]')];
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    function close(restoreFocus = false) {
      window.gsap?.killTweensOf(menu);
      menu.hidden = true; control.setAttribute('aria-expanded', 'false');
      if (restoreFocus) control.focus({ preventScroll: true });
    }
    function open(index = items.findIndex(item => item.dataset.appearance === preference)) {
      menu.hidden = false; control.setAttribute('aria-expanded', 'true');
      window.gsap?.killTweensOf(menu);
      if (window.gsap && !reduced.matches) window.gsap.fromTo(menu, { opacity: 0, y: -4 }, { opacity: 1, y: 0, duration: .16, ease: 'power2.out', clearProps: 'opacity,transform' });
      else window.gsap?.set(menu, { clearProps: 'opacity,transform' });
      items[index].focus({ preventScroll: true });
    }
    apply();
    control.addEventListener('click', () => { if (menu.hidden) open(); else close(); });
    control.addEventListener('keydown', event => {
      if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
      event.preventDefault(); open(event.key === 'ArrowDown' ? 0 : items.length - 1);
    });
    items.forEach(item => item.addEventListener('click', () => {
      preference = item.dataset.appearance;
      try { localStorage.setItem(key, preference); } catch { /* Keep the choice for this page. */ }
      apply(); close(true);
    }));
    menu.addEventListener('keydown', event => {
      const index = items.indexOf(document.activeElement);
      let next;
      if (event.key === 'ArrowDown') next = (index + 1) % items.length;
      if (event.key === 'ArrowUp') next = (index + items.length - 1) % items.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = items.length - 1;
      if (next !== undefined) { event.preventDefault(); items[next].focus({ preventScroll: true }); }
    });
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && !menu.hidden) { event.preventDefault(); close(true); } });
    document.addEventListener('pointerdown', event => { if (!wrapper.contains(event.target)) close(); });
    wrapper.addEventListener('focusout', event => { if (!wrapper.contains(event.relatedTarget)) close(); });
    window.addEventListener('resize', () => close());
    document.addEventListener('visibilitychange', () => { if (document.hidden) close(); });
  }, { once: true });
})();
