// Applies the saved theme before the app starts, so the page never flashes the wrong one.
// Mirrors ThemeService (src/app/core/theme/theme.ts): "light" | "dark" | "system" (default),
// stored in localStorage under "homelab.theme". A file, not inline, so a CSP can allow it as 'self'.
(function () {
  var choice = 'system';
  try {
    choice = localStorage.getItem('homelab.theme') || 'system';
  } catch (e) {
    // Storage blocked: follow the system.
  }
  var systemDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  var dark = choice === 'dark' || (choice !== 'light' && systemDark);
  document.documentElement.classList.toggle('dark', dark);
  // The browser bar's colour: the theme's page background (THEME_COLORS in theme.constants.ts).
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#0d0e16' : '#fdfdff');
})();
