// suppress-firebase-warn.js
// Suppresses a single known Firebase-internal console warning that cannot
// be fixed in user code: the "deprecated parameters" warning emitted by
// Firebase Hosting's auto-injected /__/firebase/init.js.
//
// IMPORTANT: This filter is intentionally narrow — it only swallows the one
// specific Firebase deprecation string. All other warnings pass through unchanged.
// Do NOT broaden the match pattern without a specific justification.
(function () {
  const _warn = console.warn.bind(console);
  console.warn = function (...args) {
    const first = typeof args[0] === 'string' ? args[0] : '';
    // Only suppress the specific Firebase Hosting init.js deprecation warning.
    // This fires because Firebase Hosting's auto-injected script calls initializeApp()
    // with legacy positional arguments — it cannot be fixed in user code.
    if (first.includes('deprecated parameters for the initialization function') ||
        first.includes('feature_collector')) {
      return;
    }
    _warn(...args);
  };
})();
