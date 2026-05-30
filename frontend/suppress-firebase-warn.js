// suppress-firebase-warn.js
// Suppresses a known Firebase-internal console warning that cannot be fixed
// in user code: the "deprecated parameters" warning emitted by the Firebase JS
// SDK's feature_collector module when it processes the app config internally.
//
// Why this is necessary:
//   The Firebase JS SDK (v10+) internally passes config values through an
//   initialisation helper that still uses the legacy positional-argument
//   signature. There is no public API to opt out. Stripping `measurementId`
//   from the config (done in firebase-config.js) prevents Analytics from
//   auto-initialising, but the feature_collector path in the core app module
//   still runs and emits the warning for the remaining config keys.
//
// Safety: the filter is intentionally narrow — it only swallows messages whose
// first string argument matches the Firebase deprecation pattern. All other
// console.warn calls pass through unchanged.
//
// MUST be the first <script> tag in every HTML page that loads Firebase,
// so the patch is installed before any module scripts execute.
(function () {
  const _warn = console.warn.bind(console);
  console.warn = function (...args) {
    const first = typeof args[0] === 'string' ? args[0] : '';
    // Match the Firebase SDK deprecation warning in any capitalisation/phrasing
    // variant seen across firebase-js-sdk 9.x–10.x and firebase-functions v7.
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
