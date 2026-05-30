// suppress-firebase-warn.js
// Suppresses a known Firebase-internal console warning that cannot be fixed
// in user code: the "deprecated parameters" warning emitted by the Firebase JS
// SDK's feature_collector module when it processes the app config internally.
//
// MUST be imported (as an ES module) before firebase-config.js loads, so the
// patch is installed before any Firebase module scripts execute.
// In firebase-config.js: import './suppress-firebase-warn.js';
(function () {
  const _warn = console.warn.bind(console);
  console.warn = function (...args) {
    const first = typeof args[0] === 'string' ? args[0] : '';
    if (
      first.includes('deprecated parameters') ||
      first.includes('feature_collector') ||
      first.includes('initialization function') ||
      first.includes('pass a single object')
    ) {
      return; // swallow silently
    }
    _warn(...args);
  };
})();
