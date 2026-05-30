// Suppress the Firebase feature_collector "deprecated parameters" console warning.
// Firebase Hosting auto-injects /__/firebase/init.js which calls initializeApp()
// internally with old positional arguments. This warning cannot be fixed in user
// code — it comes from inside the Firebase SDK's analytics bootstrap. We filter it
// here so it doesn't clutter the production console.
(function () {
  const _warn = console.warn.bind(console);
  console.warn = function (...args) {
    if (
      typeof args[0] === 'string' &&
      args[0].includes('deprecated parameters for the initialization function')
    ) {
      return; // swallow only this specific Firebase internal warning
    }
    _warn(...args);
  };
})();
