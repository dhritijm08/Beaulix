// firebase-config.js — single source of truth for Firebase configuration.
// Import from this file in every HTML module script instead of copy-pasting the config.
//
// Uses the /__/firebase/init.js auto-config pattern provided by Firebase Hosting.
// When served via `firebase serve` or Firebase Hosting, the SDK config is injected
// automatically at that URL — no credentials need to live in source control.
//
// For local development WITHOUT `firebase serve` (e.g. a plain static server),
// set window.__FIREBASE_CONFIG__ before this module loads, or fall back to the
// BEAULIX_FIREBASE_CONFIG environment variable injected by your build tool.
//
// See: https://firebase.google.com/docs/hosting/reserved-urls

import './suppress-firebase-warn.js';
import { initializeApp, getApps, getApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';

async function loadFirebaseConfig() {
  // 1. Try the Firebase Hosting reserved URL (production + emulator).
  try {
    const res = await fetch('/__/firebase/init.json');
    if (res.ok) return res.json();
  } catch {
    // Not served by Firebase Hosting — fall through.
  }

  // 2. Dev fallback: config injected by build tool / local server as a global.
  if (typeof window.__FIREBASE_CONFIG__ === 'object') {
    return window.__FIREBASE_CONFIG__;
  }

  // 3. [REMOVED] Hardcoded fallback removed for security.
  //    For local dev without `firebase serve`, set window.__FIREBASE_CONFIG__
  //    explicitly or run `firebase emulators:start`.
  throw new Error(
    "Firebase config unavailable. Run `firebase emulators:start` or set window.__FIREBASE_CONFIG__ for local dev."
  );

}

const _rawConfig = await loadFirebaseConfig();
// Strip measurementId so Firebase Analytics never auto-initializes.
// Analytics internally calls feature_collector with deprecated positional args,
// producing a console warning that cannot be suppressed from user code.
// Beaulix does not use Analytics — removing the key disables it entirely.
const firebaseConfig = (({measurementId, ...rest}) => rest)(_rawConfig);
// Guard against duplicate initialization (e.g. HMR or multiple module evaluations).
const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();

export { app, firebaseConfig };
