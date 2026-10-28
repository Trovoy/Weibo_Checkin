// Runs before styles render to avoid flashing the wrong theme on reload.
(() => {
  const key = 'checkin-appearance', system = matchMedia('(prefers-color-scheme: dark)');
  const choices = ['system', 'light', 'dark'];
  let preference = 'system';
  try { const saved = localStorage.getItem(key); if (choices.includes(saved)) preference = saved; } catch { /* Private browsing can deny storage. */ }
  function apply() {
    const theme = preference === 'system' ? system.matches ? 'dark' : 'light' : preference;
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#19191d' : '#fafafa');
    const control = document.getElementById('appearance');
    if (control) control.value = preference;
    document.dispatchEvent(new Event('appearancechange'));
  }
  apply();
  system.addEventListener('change', () => { if (preference === 'system') apply(); });
  window.addEventListener('storage', event => {
    if (event.key !== key && event.key !== null) return;
    preference = choices.includes(event.newValue) ? event.newValue : 'system'; apply();
  });
  document.addEventListener('DOMContentLoaded', () => {
    const control = document.getElementById('appearance');
    control.value = preference;
    control.addEventListener('change', () => {
      if (!choices.includes(control.value)) return;
      preference = control.value;
      try { localStorage.setItem(key, preference); } catch { /* Keep the choice for this page. */ }
      apply();
    });
  }, { once: true });
})();
