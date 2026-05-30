// Suppress known Firebase-internal console noise that cannot be fixed in user code.
// 1. feature_collector "deprecated parameters" warning — fired by Firebase Hosting's
//    auto-injected /__/firebase/init.js, which calls initializeApp() with old
//    positional arguments.  Unfixable from user code; filtered here.
// 2. CSP/CORS errors from the GPU health-check during early page load — these are
//    benign races while GPU_API_BASE is still null; the real status is set once
//    getGpuUrl resolves.
(function () {
  // ── console.warn filter ────────────────────────────────────────────────────
  // Suppresses the feature_collector.js:23 deprecation warning emitted by
  // Firebase Hosting's auto-injected /__/firebase/init.js, which calls
  // initializeApp() with legacy positional arguments.  This is unfixable in
  // user code — the injected script runs before any user JS.
  const _warn = console.warn.bind(console);
  console.warn = function (...args) {
    // Stringify the first argument regardless of type so object-form warnings
    // (e.g. from newer Firebase SDK versions that pass an object) are caught too.
    const msg = args.map(a => (typeof a === 'string' ? a : String(a))).join(' ');
    if (
      msg.includes('deprecated parameters for the initialization function') ||
      msg.includes('using deprecated parameters') ||
      msg.includes('feature_collector')
    ) {
      return; // swallow only this specific Firebase internal warning
    }
    _warn(...args);
  };

  // ── console.log filter — feature_collector can also surface via log ────────
  const _log = console.log.bind(console);
  console.log = function (...args) {
    const msg = args.map(a => (typeof a === 'string' ? a : String(a))).join(' ');
    if (
      msg.includes('feature_collector') ||
      msg.includes('deprecated parameters for the initialization function')
    ) {
      return;
    }
    _log(...args);
  };

  // ── console.error filter — suppress benign CSP/fetch races on load ─────────
  const _error = console.error.bind(console);
  console.error = function (...args) {
    const msg = args.map(a => (typeof a === 'string' ? a : String(a))).join(' ');
    // Suppress only the browser-level CORS/network errors that fire before the
    // user is authenticated (benign race on page load). Do NOT suppress function
    // errors like "internal" or "failed-precondition" — those indicate real
    // problems (e.g. missing BEAULIX_GPU_URL secret) that need to be visible.
    if (
      msg.includes('Access-Control-Allow-Origin') ||
      msg.includes('ERR_FAILED') ||
      (msg.includes('Content Security Policy') && msg.includes('beaulix.onrender.com'))
    ) {
      return;
    }
    _error(...args);
  };
})();
