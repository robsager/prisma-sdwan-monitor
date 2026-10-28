// Light/dark theme, shared by the Dashboard and Flow Search. The header toggle cycles
// Auto -> Light -> Dark; Auto (the default) follows the OS colour-scheme setting.
// Loaded in <head> so data-theme is set before first paint (no flash of the wrong theme).
(function () {
  const KEY = 'sdwan.theme';
  const MODES = ['auto', 'light', 'dark'];
  const ICONS = { auto: '◐', light: '☀', dark: '☾' };
  const LABELS = { auto: 'Auto (follows system)', light: 'Light', dark: 'Dark' };
  const systemDark = matchMedia('(prefers-color-scheme: dark)');
  const mode = () => MODES.includes(localStorage.getItem(KEY)) ? localStorage.getItem(KEY) : 'auto';

  function apply() {
    const m = mode();
    document.documentElement.dataset.theme = m === 'auto' ? (systemDark.matches ? 'dark' : 'light') : m;
    const next = MODES[(MODES.indexOf(m) + 1) % MODES.length];
    for (const btn of document.querySelectorAll('.theme-btn')) {
      btn.textContent = ICONS[m];
      btn.title = 'Theme: ' + LABELS[m] + ' (click for ' + LABELS[next].split(' ')[0] + ')';
      btn.setAttribute('aria-label', btn.title);
    }
  }

  window.toggleTheme = function () {
    const next = MODES[(MODES.indexOf(mode()) + 1) % MODES.length];
    // Auto is stored as no entry, so a missing or unrecognised value means "follow the OS".
    if (next === 'auto') localStorage.removeItem(KEY); else localStorage.setItem(KEY, next);
    apply();
  };

  systemDark.addEventListener('change', apply);
  // Keep other open tabs in step when the theme is toggled in one of them.
  window.addEventListener('storage', e => { if (e.key === KEY) apply(); });
  document.addEventListener('DOMContentLoaded', apply);
  apply();
})();
