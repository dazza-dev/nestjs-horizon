/*
 * Applies the saved colour scheme before the bundle paints.
 *
 * A file rather than inline: `script-src 'self'` accepts it without a nonce.
 */
(function () {
  var choice = localStorage.getItem('sentinelColorScheme') || 'system';
  var dark =
    choice === 'dark' ||
    (choice === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);

  document.documentElement.setAttribute('data-bs-theme', dark ? 'dark' : 'light');
})();
