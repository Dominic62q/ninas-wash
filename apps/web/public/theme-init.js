// Runs before the page is drawn, so a dark phone never flashes white. Keep in step with src/lib/theme.ts.
(function () {
  var choice = 'system';
  try {
    choice = localStorage.getItem('niinas-theme') || 'system';
  } catch (e) {}
  var dark = choice === 'dark' || (choice !== 'light' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#0A111F' : '#0B2A5B');
})();
