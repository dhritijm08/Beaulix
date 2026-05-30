    import { app } from './firebase-config.js';
    import { getAuth } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
    import { initNavAuth } from './nav-module.js';
    import { initCloudinaryModule } from './cloudinary-module.js';
    import { initStep2Module, renderImprovementBanner } from './step2-module.js';

    const auth = getAuth(app);
    // Mutable ref so cloudinary-module always reads the current user without closure issues
    const currentUserIdRef = { current: null };

    // Reveal body once Firebase auth resolves.
    // A 2.5s safety timeout ensures the page is never permanently invisible if
    // auth takes longer than expected (e.g. slow connection, cold start).
    // The auth callbacks (onUser / onNoUser) reveal the body immediately on success.
    const _foucGuard = setTimeout(() => { document.body.style.visibility = 'visible'; }, 2500);
    // _foucGuard is cleared inside onUser/onNoUser via window._clearFoucGuard
    window._clearFoucGuard = () => clearTimeout(_foucGuard);

    initNavAuth({
      injectDropdownLinks: true,
      onUser: user => {
        currentUserIdRef.current = user.uid;
        window._clearFoucGuard?.();
        document.body.style.visibility = 'visible';
      },
      onNoUser: () => {
        currentUserIdRef.current = null;
        window._clearFoucGuard?.();
        window.location.href = 'login.html';
      },
    });

    // Registers window.saveToHistory
    initCloudinaryModule({
      app,
      currentUserIdRef,
      ngrokHeaders: window.BEAULIX_CONFIG?.NGROK_HEADERS,
      debug: typeof DEBUG !== 'undefined' && DEBUG,
    });

    // Registers window.onStep2SelectionChange and window.renderImprovementBanner.
    // ML calls are routed through window._mlPredictStep2 (httpsCallable set by
    // generator-init.js) — the backend URL and API key never leave Firebase Secrets.
    const { onStep2SelectionChange } = initStep2Module({
      mlPredictStep2Fn:     () => window._mlPredictStep2,
      buildStep2Payload:    () => window._buildStep2Payload?.(),
      getLastPredictionData: () => window._lastPredictionData,
      setStep2PredictionData: d => { window._step2PredictionData = d; },
      debug: typeof DEBUG !== 'undefined' && DEBUG,
    });
    window.onStep2SelectionChange = onStep2SelectionChange;
    window.renderImprovementBanner = (opts) => renderImprovementBanner(opts);
