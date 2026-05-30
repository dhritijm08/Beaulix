// Suppress known Firebase-internal console noise that cannot be fixed in user code.
// 1. feature_collector "deprecated parameters" warning — fired by Firebase Hosting's
//    auto-injected /__/firebase/init.js, which calls initializeApp() with old
//    positional arguments.  Unfixable from user code; filtered here.
// 2. CSP/CORS errors from the GPU health-check during early page load — these are
//    benign races while GPU_API_BASE is still null; the real status is set once
//    getGpuUrl resolves.
(function () {
  // ── console.warn filter ────────────────────────────────────────────────────
  const _warn = console.warn.bind(console);
  console.warn = function (...args) {
    const msg = typeof args[0] === 'string' ? args[0] : '';
    if (
      msg.includes('deprecated parameters for the initialization function') ||
      msg.includes('using deprecated parameters')
    ) {
      return; // swallow only this specific Firebase internal warning
    }
    _warn(...args);
  };

  // ── console.error filter — suppress benign CSP/fetch races on load ─────────
  const _error = console.error.bind(console);
  console.error = function (...args) {
    const msg = typeof args[0] === 'string' ? args[0] : '';
    // Suppress the CORS/CSP preflight error for getGpuUrl that fires before
    // the user is authenticated — the generator-init.js catch() block handles
    // this gracefully and shows "GPU: Offline" in the UI.
    if (
      msg.includes('getGpuUrl') ||
      msg.includes('Access-Control-Allow-Origin') ||
      (msg.includes('Content Security Policy') && msg.includes('beaulix.onrender.com'))
    ) {
      return;
    }
    _error(...args);
  };
})();
