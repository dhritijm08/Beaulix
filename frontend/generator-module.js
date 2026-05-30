    import { app } from './firebase-config.js';
    import { getAuth } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js';
    import { initNavAuth } from './nav-module.js';
    import { initCloudinaryModule } from './cloudinary-module.js';
    import { initStep2Module, renderImprovementBanner } from './step2-module.js';

    const auth = getAuth(app);
    // Mutable ref so cloudinary-module always reads the current user without closure issues
    const currentUserIdRef = { current: null };

    // Reveal body once Firebase auth resolves (handles visibility:hidden flash guard)
    setTimeout(() => { document.body.style.visibility = 'visible'; }, 4000);

    initNavAuth({
      injectDropdownLinks: true,
      onUser: user => {
        currentUserIdRef.current = user.uid;
        document.body.style.visibility = 'visible';
      },
      onNoUser: () => {
        currentUserIdRef.current = null;
        window.location.href = 'login.html';
      },
    });

    // Registers window.saveToHistory
    initCloudinaryModule({
      app,
      currentUserIdRef,
      ngrokHeaders: window.NGROK_HEADERS,
      debug: typeof DEBUG !== 'undefined' && DEBUG,
    });

    // Registers window.onStep2SelectionChange and window.renderImprovementBanner
    // These bridge into the classic <script> block via window globals.
    const { onStep2SelectionChange } = initStep2Module({
      mlApiBase:            window._ML_API_BASE,
      mlHeaders:            window._ML_HEADERS,
      buildStep2Payload:    () => window._buildStep2Payload?.(),
      getLastPredictionData: () => window._lastPredictionData,
      setStep2PredictionData: d => { window._step2PredictionData = d; },
      debug: typeof DEBUG !== 'undefined' && DEBUG,
    });
    window.onStep2SelectionChange = onStep2SelectionChange;
    window.renderImprovementBanner = (opts) => renderImprovementBanner(opts);
