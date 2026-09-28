    // ── Security note ────────────────────────────────────────────────────
    // ML predictions are routed through Firebase Cloud Functions (mlPredict /
    // mlPredictStep2).  The FastAPI backend URL and BEAULIX_API_KEY live only
    // in Firebase Secrets — they never reach the browser.  Do NOT add direct
    // fetch() calls to the Render backend here.
    //
    // GPU (Colab/ngrok) calls go directly from the browser to the ngrok tunnel
    // because the GPU is ephemeral and has no stable HTTPS domain that Firebase
    // Functions could proxy.  The GPU URL is fetched once via the getGpuUrl
    // Cloud Function so the tunnel URL is never hardcoded in static HTML.
    // ─────────────────────────────────────────────────────────────────────

    const FETCH_TIMEOUT = 300000;
    const VIDEO_LOAD_TIMEOUT = 180000;
    // Generation-specific timeouts. The general 300s FETCH_TIMEOUT above is
    // fine for one-off/manual actions, but it was silently being reused for
    // the automatic "Generate Variations" flow — meaning a slow/unresponsive
    // /predict or /generate call could leave the UI looking "stuck" for up to
    // 5 minutes per call (up to ~20 min for a 3-variation batch) before any
    // error ever surfaced. These are intentionally bounded so a dead backend
    // fails fast, while still allowing for real cold-start GPU/model-load time.
    const HEALTH_CHECK_TIMEOUT     = 8000;    // /health — should be near-instant if the server is actually up
    const IMAGE_GENERATION_TIMEOUT = 150000;  // /generate — 20-30s once the SDXL pipeline is warm, but the FIRST
                                               // request after a Colab restart also loads the pipeline onto the
                                               // GPU, which alone can take 1-3 minutes. 45s was too aggressive and
                                               // caused false "unreachable" errors on a perfectly healthy server.
    const SILENT_PREDICT_TIMEOUT   = 12000;   // best-effort /predict before generation; never blocks generation on its own
    const DEBUG = true; // verbose console tracing enabled while debugging the Generate Variations flow — see [Beaulix] logs

    // ML backend base URL — read from Firestore on load. No API key lives in the
    // browser: ML routes are authenticated with the user's Firebase ID token.
    let _mlBackendUrl  = null;

    // Single config namespace — avoids polluting window with individual globals.
    window.BEAULIX_CONFIG = {
      GPU_API_BASE: null,
      NGROK_HEADERS: { 'ngrok-skip-browser-warning': 'true', 'User-Agent': 'Mozilla/5.0 (compatible; Beaulix/1.0)' },
    };

    let GPU_API_BASE = null;

    // Disable Analyze button immediately; re-enable once Functions are confirmed loaded.
    const _analyzeBtn = document.getElementById('analyzeBtn');
    if (_analyzeBtn) {
      _analyzeBtn.disabled = true;
      _analyzeBtn.title = 'Loading configuration…';
    }

    (async () => {
      try {
        const { app } = await import('./firebase-config.js');
        const { getAuth }    = await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js');
        const { getFirestore, doc, getDoc } = await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js');

        // Wait for auth state once.
        const user = await new Promise(resolve => {
          const unsub = getAuth(app).onAuthStateChanged(u => { unsub(); resolve(u); });
        });
        if (!user) throw new Error('Not signed in');

        // GPU URL — read directly from Firestore config/gpu doc (no Cloud Function needed).
        // Colab writes the ngrok URL here on startup; frontend reads it directly.
        // Firestore rules allow authenticated reads of config/gpu and config/backend.
        try {
          const db = getFirestore(app);
          const [gpuDoc, backendDoc] = await Promise.all([
            getDoc(doc(db, 'config', 'gpu')),
            getDoc(doc(db, 'config', 'backend')),
          ]);

          const gpuUrl = gpuDoc.exists() ? gpuDoc.data()?.url : null;
          if (gpuUrl) {
            GPU_API_BASE = gpuUrl;
            window.BEAULIX_CONFIG.GPU_API_BASE = GPU_API_BASE;
            checkGPUConnection();
          } else {
            if (DEBUG) console.warn('config/gpu doc missing or empty — run Colab first.');
            document.getElementById('gpuDotStatus').className = 'status-dot offline';
            document.getElementById('gpuTextStatus').textContent = 'GPU: Offline';
          }

          _mlBackendUrl = backendDoc.exists() ? backendDoc.data()?.url : null;
          if (!_mlBackendUrl) {
            if (DEBUG) console.warn('config/backend doc missing — ML engine unavailable.');
          } else {
            checkMLEngine(); // URL is now set — run the health check immediately
          }
        } catch (gpuErr) {
          if (DEBUG) console.warn('Firestore config read failed:', gpuErr.message);
          document.getElementById('gpuDotStatus').className = 'status-dot offline';
          document.getElementById('gpuTextStatus').textContent = 'GPU: Offline';
        }

      } catch (e) {
        if (DEBUG) console.warn('Firebase config load failed:', e.message);
        document.getElementById('gpuDotStatus').className = 'status-dot offline';
        document.getElementById('gpuTextStatus').textContent = 'GPU: Offline';
      } finally {
        // Always re-enable the button.
        if (_analyzeBtn) {
          _analyzeBtn.disabled = false;
          _analyzeBtn.title = '';
        }
      }
    })();

    // NGROK_HEADERS: only sent to ngrok (Colab/GPU) URLs, never to production Firebase Functions.
    // Accessible via window.BEAULIX_CONFIG.NGROK_HEADERS for module scripts.
    const NGROK_HEADERS = window.BEAULIX_CONFIG.NGROK_HEADERS;

    // Firebase ID-token auth headers for the Render ML backend. Throws (never sends
    // an unauthenticated request) when there is no signed-in user / token.
    async function getMlAuthHeaders() {
      const { getAuth } = await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js');
      const { app } = await import('./firebase-config.js');
      const token = await getAuth(app).currentUser?.getIdToken();
      if (!token) throw new Error('You must be signed in to use this feature. Please sign in again.');
      return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` };
    }

    async function fetchWithTimeout(resource, options = {}) {
      const { timeout = FETCH_TIMEOUT } = options;
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), timeout);
      try {
        // Only attach ngrok bypass headers when the target URL is a ngrok tunnel.
        // Never send them to production Firebase Functions or the ML backend.
        const isNgrok = typeof resource === 'string' && resource.includes('ngrok');
        const baseHeaders = isNgrok ? NGROK_HEADERS : {};
        const response = await fetch(resource, { ...options, signal: controller.signal, headers: { ...baseHeaders, ...options.headers } });
        clearTimeout(id); return response;
      } catch (error) {
        clearTimeout(id);
        if (error.name === 'AbortError') throw new Error('Request timed out. Please try again.');
        throw error;
      }
    }

    const analyzeBtn = document.getElementById('analyzeBtn');
    const analysisResults = document.getElementById('analysisResults');
    const generateCreativeBtn = document.getElementById('generateCreativeBtn');
    const generateCreativeSpinner = document.getElementById('generateCreativeSpinner');
    const previewBox = document.getElementById('previewBox');
    const generatedOutput = document.getElementById('generatedOutput');
    const regenerateBtn = document.getElementById('regenerateBtn');
    const downloadBtn = document.getElementById('downloadBtn');
    const productCategory = document.getElementById('productCategory');
    const occasion = document.getElementById('occasion');
    const ageRangeSelect = document.getElementById('ageRange');
    const genderSelect = document.getElementById('gender');
    const categoryFieldsContainer = document.getElementById('categoryFieldsContainer');
    const decisionLogicText = document.getElementById('decisionLogicText');
    const activeDecisionDisplay = document.getElementById('activeDecisionDisplay');
    const productType = document.getElementById('productType');
    const productColor = document.getElementById('productColor');
    const sceneDescription = document.getElementById('sceneDescription');
    const includeHumanFace = document.getElementById('includeHumanFace');
    const brandStyleSelect = document.getElementById('brandStyle');
    const humanOptionsSection = document.getElementById('humanOptionsSection');
    const generationProgress = document.getElementById('generationProgress');
    const progressBar = document.getElementById('progressBar');
    const visualContent = document.getElementById('visualContent');
    const loadingStages = document.getElementById('loadingStages');
    const step1Header = document.getElementById('step1Header');
    const step1Content = document.getElementById('step1Content');
    const step2Header = document.getElementById('step2Header');
    const step2Content = document.getElementById('step2Content');
    const modelSourceNote = document.getElementById('modelSourceNote');
    const durationSelect = document.getElementById('duration');
    const improvementBanner = document.getElementById('improvementBanner');
    const improvementDetails = document.getElementById('improvementDetails');
    const visualStrategySection = document.getElementById('visualStrategySection');
    const visualStrategyItems = document.getElementById('visualStrategyItems');

    let lastPredictionData = null;
    console.log('[COPY DEBUG] generator-init.js build: copy-in-payload-v4');
    let step2PredictionData = null;  // set after /predict-step2 call, used for real before/after delta
    // Expose state for step2-module.js bridge
    Object.defineProperty(window, '_lastPredictionData',   { get: () => lastPredictionData });
    Object.defineProperty(window, '_step2PredictionData',  {
      get: () => step2PredictionData,
      set: v  => { step2PredictionData = v; },
    });
    let lastGeneratedFileUrl = null;
    let lastGeneratedBlobUrl = null;
    let lastGeneratedFilename = 'beaulix-visual.jpg';
    let retryPayload = null;

    // activeBenchmarks is populated from the /predict API response (benchmarks field).
    // The API is the single source of truth — values are derived from the 97,920-row
    // Excel training dataset and match CTR_TARGETS/CONV_TARGETS/ENG_TARGETS in constants.py.
    // No hardcoded copy here: if the backend values change, the frontend automatically reflects them.
    let activeBenchmarks = { ctr: 0, conversion: 0, engagement: 0 }; // populated on first /predict response

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    // Canonical display labels for visual strategy keys — covers both
    // underscore variants (from Excel lookup) and space variants (from fallback).
    const VISUAL_KEY_LABELS = {
      'VISUAL_SHOT':      'VISUAL SHOT',
      'VISUAL SHOT':      'VISUAL SHOT',
      'LIGHTING':         'LIGHTING',
      'COMPOSITION':      'COMPOSITION',
      'PROPS':            'PROPS',
      'MODEL_EXPRESSION': 'MODEL EXPRESSION',
      'MODEL EXPRESSION': 'MODEL EXPRESSION',
      'CAMERA_ANGLE':     'CAMERA ANGLE',
      'CAMERA ANGLE':     'CAMERA ANGLE',
      'BACKGROUND':       'BACKGROUND',
      'COLOR_PALETTE':    'COLOR PALETTE',
      'COLOR PALETTE':    'COLOR PALETTE',
    };

    // Display labels for the chip headings
    const STYLE_DISPLAY_LABELS = {
      'luxury-elegant':    'Luxury Elegant',
      'modern-minimalist': 'Modern Minimalist',
      'bold-vibrant':      'Bold & Vibrant',
      'natural-organic':   'Natural & Organic',
      'glam-dramatic':     'Glam & Dramatic',
      'soft-romantic':     'Soft Romantic',
    };
    const RATIO_DISPLAY_LABELS = {
      '1:1':  '1:1 Square',
      '9:16': '9:16 Portrait',
      '16:9': '16:9 Landscape',
      '4:5':  '4:5 Instagram',
    };

    function updateStep2RecsFromAPI(recs) {
      if (!recs || (!recs.recommended_brand_style && !recs.recommended_aspect_ratio && !recs.recommended_output_type)) {
        visualStrategySection.classList.add('hidden'); visualStrategySection.style.display = 'none';
        return;
      }

      // Include face — now data-driven from Excel column, not inferred
      const suggestFace = recs.include_human_face || null;

      const rows = [
        { key: 'SCENE DESCRIPTION',  value: recs.suggested_scene },
        { key: 'BRAND STYLE',        value: STYLE_DISPLAY_LABELS[recs.recommended_brand_style] || recs.recommended_brand_style },
        { key: 'INCLUDE HUMAN FACE', value: suggestFace },
        { key: 'ASPECT RATIO',       value: RATIO_DISPLAY_LABELS[recs.recommended_aspect_ratio] || recs.recommended_aspect_ratio },
        { key: 'OUTPUT TYPE',        value: (recs.recommended_output_type||'').charAt(0).toUpperCase() + (recs.recommended_output_type||'').slice(1) },
      ];

      visualStrategyItems.innerHTML = '';
      rows.forEach(({ key, value }) => {
        if (!value || String(value).trim() === '' || String(value).trim() === 'nan') return;
        const item = document.createElement('div');
        item.className = 'visual-strategy-item';
        const arrow = document.createElement('span');
        arrow.className = 'visual-strategy-arrow';
        arrow.textContent = '→';
        const textSpan = document.createElement('span');
        textSpan.className = 'visual-strategy-item-text';
        textSpan.innerHTML = `<strong>${escapeHtml(key)}:</strong> ${escapeHtml(String(value))}`;
        item.appendChild(arrow);
        item.appendChild(textSpan);
        visualStrategyItems.appendChild(item);
      });

      visualStrategySection.classList.remove('hidden'); visualStrategySection.style.display = 'block';
    }

    async function checkGPUConnection() {
      if (!GPU_API_BASE) {
        document.getElementById('gpuDotStatus').className = 'status-dot offline';
        document.getElementById('gpuTextStatus').textContent = 'GPU: Connecting\u2026';
        return;
      }
      try {
        const res = await fetch(`${GPU_API_BASE}/health`, {
          headers: { 'ngrok-skip-browser-warning': 'true' }
        });
        if (!res.ok) throw new Error();
        document.getElementById('gpuDotStatus').className = 'status-dot online';
        document.getElementById('gpuTextStatus').textContent = 'GPU: Ready';
      } catch {
        document.getElementById('gpuDotStatus').className = 'status-dot offline';
        document.getElementById('gpuTextStatus').textContent = 'GPU: Offline';
      }
    }

    // Tracks whether the ML backend is reachable; used to gate the Analyze button.
    let _mlEngineOnline = false;

    function _applyMLDegradedState(online) {
      _mlEngineOnline = online;
      document.getElementById('mlDot').className  = online ? 'status-dot online'  : 'status-dot offline';
      document.getElementById('mlText').textContent = online ? 'ML Engine: Online' : 'ML Engine: Offline';

      // Show / hide a degraded-state banner so users know why analysis is unavailable.
      let banner = document.getElementById('mlDegradedBanner');
      // Banner is pre-rendered in generator.html — just toggle display.
      if (!online) {
        if (banner) banner.style.display = 'flex';
      } else if (banner) {
        banner.style.display = 'none';
      }
      // Re-evaluate Analyze button: also requires the form to be valid.
      updateAnalyzeButtonState();
    }

    async function checkMLEngine() {
      try {
        if (!_mlBackendUrl) { _applyMLDegradedState(false); return; }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10000);
        const res = await fetch(`${_mlBackendUrl}/health`, { signal: controller.signal });
        clearTimeout(timer);
        _applyMLDegradedState(res.ok);
      } catch {
        _applyMLDegradedState(false);
      }
    }
    const productTypeOptions = {
      skincare: [
        // Cleansers
        'Micellar Water','Cleansing Oil','Cleansing Balm','Foam Cleanser','Gel Cleanser','Cream Cleanser','Milk Cleanser','Bar Cleanser','Clay Cleanser','Powder Cleanser','Cleansing Wipes','Makeup Remover',
        // Toners & Essences
        'Toner','Essence','Facial Mist','Lotion (Japanese)',
        // Serums & Treatments
        'Serum','Face Oil','Ampoule','Booster','Retinol Treatment','Vitamin C Serum','Niacinamide Serum','Hyaluronic Acid Serum','Exfoliating Serum','Brightening Serum','Anti-Aging Serum',
        // Moisturisers
        'Moisturiser','Day Cream','Night Cream','Gel Moisturiser','Water Cream','Sleeping Mask','Face Butter','Rich Cream','Lightweight Lotion',
        // Eye & Lip Care
        'Eye Cream','Eye Gel','Eye Serum','Lip Balm','Lip Mask','Lip Treatment','Lip Scrub',
        // Masks & Exfoliants
        'Sheet Mask','Clay Mask','Peel-Off Mask','Sleeping Pack','Mud Mask','Brightening Mask','Exfoliating Mask','Chemical Exfoliant','Physical Scrub','Enzyme Powder',
        // SPF
        'Sunscreen SPF 30','Sunscreen SPF 50','SPF 50+ Sunscreen','Tinted Sunscreen','Mineral Sunscreen','Chemical Sunscreen','SPF Moisturiser','After-Sun Lotion',
        // Spot & Targeted
        'Spot Treatment','Pore Strip','Blackhead Mask','Neck Cream','Décolletage Serum','Face Primer (Skincare)'
      ],
      makeup: [
        // Face
        'Foundation','Tinted Moisturiser','BB Cream','CC Cream','Concealer','Colour Corrector','Face Primer','Setting Powder','Loose Powder','Setting Spray','Blush','Bronzer','Contour Powder','Contour Stick','Highlighter','Illuminator','Blush Stick','Bronzer Stick','Cheek Tint',
        // Eyes
        'Eyeshadow Palette','Single Eyeshadow','Eye Primer','Eyeliner Pencil','Liquid Eyeliner','Gel Eyeliner','Kohl Eyeliner','Eyeshadow Stick','Mascara','Lengthening Mascara','Volumising Mascara','Tubing Mascara','Brow Pencil','Brow Gel','Brow Pomade','Brow Powder','Brow Tint','Brow Serum','False Lashes','Lash Serum','Eyelid Tape',
        // Lips
        'Lipstick','Matte Lipstick','Satin Lipstick','Sheer Lipstick','Lip Gloss','Liquid Lipstick','Lip Liner','Lip Stain','Lip Plumper','Lip Oil','Tinted Lip Balm','Ombre Lip Tint',
        // Nails
        'Nail Polish','Gel Nail Polish','Nail Top Coat','Nail Base Coat','Nail Treatment','Cuticle Oil','Nail Strengthener','Press-On Nails',
        // Tools
        'Makeup Brush Set','Foundation Brush','Blending Sponge','Beauty Blender','Eyelash Curler','Makeup Setting Mist'
      ],
      fragrance: [
        // Fine Fragrance
        'Parfum (Extrait)','Eau de Parfum (EDP)','Eau de Toilette (EDT)','Eau de Cologne (EDC)','Eau Fraîche','Solid Perfume',
        // Body & Hair Fragrance
        'Body Mist','Body Spray','Hair Mist','Hair Perfume','Shower Gel (Scented)','Body Lotion (Scented)','Scented Body Oil','Perfumed Talc',
        // Home Fragrance
        'Scented Candle','Reed Diffuser','Room Spray','Linen Spray','Wax Melt','Car Freshener','Incense Sticks','Incense Cones','Potpourri','Diffuser Oil Refill',
        // Niche & Layering
        'Perfume Oil','Roll-On Perfume','Layering Fragrance','Discovery Set / Sampler','Gift Set'
      ],
      haircare: [
        // Cleansing
        'Shampoo','Clarifying Shampoo','Scalp Scrub Shampoo','Dry Shampoo','Co-Wash','Sulphate-Free Shampoo','Colour-Safe Shampoo','Volumising Shampoo','Anti-Dandruff Shampoo','Hair Cleansing Cream',
        // Conditioning
        'Conditioner','Deep Conditioner','Leave-In Conditioner','Rinse-Out Conditioner','Hair Mask','Protein Treatment','Moisture Treatment','Bond Repair Treatment','Overnight Hair Mask',
        // Scalp Care
        'Scalp Serum','Scalp Oil','Scalp Toner','Scalp Treatment','Anti-Dandruff Treatment','Scalp Exfoliant','DHT Blocker Serum',
        // Styling
        'Hair Oil','Argan Oil','Hair Serum','Heat Protectant','Curl Cream','Curl Gel','Curl Mousse','Defining Gel','Edge Control','Hair Wax','Hair Pomade','Hair Clay','Volumising Mousse','Texturising Spray','Salt Spray','Hold Spray','Flexible Hold Spray','Strong Hold Hairspray',
        // Colour & Treatment
        'Hair Dye / Colour','Root Touch-Up','Colour Gloss','Toning Shampoo','Purple Shampoo','Bond Builder','Keratin Treatment','Brazilian Blowout','Hair Bleach Kit',
        // Finishing
        'Shine Spray','Detangling Spray','Hair Growth Serum','Split End Repair Serum'
      ],
      bodycare: [
        // Moisturisers
        'Body Lotion','Body Cream','Body Butter','Body Oil','Dry Body Oil','Shea Butter','Body Gel','In-Shower Moisturiser','Body Milk',
        // Exfoliants & Cleansers
        'Body Scrub','Salt Scrub','Sugar Scrub','Coffee Scrub','Body Wash','Shower Gel','Shower Oil','Soap Bar','Body Foam','Exfoliating Mitt',
        // Hands & Feet
        'Hand Cream','Hand Lotion','Hand Sanitiser','Cuticle Cream','Foot Cream','Foot Mask','Foot Scrub','Heel Balm','Foot Soak',
        // Deodorant & Antiperspirant
        'Deodorant Stick','Antiperspirant Stick','Roll-On Deodorant','Deodorant Spray','Natural Deodorant','Deodorant Cream','Crystal Deodorant',
        // Tanning & Sun
        'Self-Tan Lotion','Self-Tan Mousse','Self-Tan Drops','Self-Tan Oil','Tanning Water','Gradual Tanner','After-Sun Lotion','After-Sun Gel','Tanning Accelerator',
        // Bath
        'Bath Bomb','Bath Salt','Bubble Bath','Bath Soak','Bath Oil','Bath Tablet','Bath Foam',
        // Slimming & Firming
        'Body Firming Cream','Anti-Cellulite Cream','Slimming Gel','Body Contouring Cream',
        // Intimate & Specialist
        'Stretch Mark Cream','Pregnancy Belly Balm','Intimate Wash','Body Brightening Lotion','Body SPF Lotion'
      ]
    };

    function populateProductTypeDropdown(category) {
      const productType = document.getElementById('productType');
      if (!productType) return;
      const options = productTypeOptions[category];
      if (!options || !options.length) {
        productType.innerHTML = '<option value="" disabled selected>No options for this category</option>';
        productType.disabled = true;
        return;
      }
      productType.innerHTML = '<option value="" disabled selected>Select product type</option>';
      options.forEach(opt => {
        const el = document.createElement('option');
        el.value = opt;
        el.textContent = opt;
        productType.appendChild(el);
      });
      productType.disabled = false;
    }

    const categoryFieldTemplates = {
      skincare: `<div class="category-field"><label for="skinType">Skin Type *</label><select id="skinType" class="form-control" required><option value="" disabled selected>Select skin type</option><option value="oily">Oily</option><option value="dry">Dry</option><option value="combination">Combination</option><option value="normal">Normal</option><option value="sensitive">Sensitive</option><option value="mature">Mature</option></select></div><div class="category-field"><label for="primaryConcern">Primary Concern *</label><select id="primaryConcern" class="form-control" required><option value="" disabled selected>Select concern</option><option value="acne">Acne / Breakouts</option><option value="aging">Aging / Wrinkles</option><option value="pigmentation">Pigmentation / Dark Spots</option><option value="dryness">Dryness</option><option value="dullness">Dullness / Uneven Tone</option><option value="sensitivity">Sensitivity</option><option value="oil-control">Oil Control</option><option value="pores">Large Pores</option></select></div>`,
      makeup: `<div class="category-field"><label for="skinType">Skin Type *</label><select id="skinType" class="form-control" required><option value="" disabled selected>Select skin type</option><option value="oily">Oily</option><option value="dry">Dry</option><option value="combination">Combination</option><option value="normal">Normal</option><option value="sensitive">Sensitive</option><option value="mature">Mature</option></select></div><div class="category-field"><label for="primaryConcern">Makeup Focus *</label><select id="primaryConcern" class="form-control" required><option value="" disabled selected>Select focus</option><option value="coverage">Coverage / Full Face</option><option value="natural">Natural Look</option><option value="bold">Bold / Dramatic</option><option value="longwear">Long-wear</option><option value="skincare">Skincare-infused</option><option value="fresh">Fresh / Lightweight</option><option value="clean">Clean Beauty</option></select></div>`,
      fragrance: `<div class="category-field"><label for="fragranceMood">Mood / Vibe *</label><select id="fragranceMood" class="form-control" required><option value="" disabled selected>Select mood</option><option value="romantic">Romantic / Sensual</option><option value="bold">Bold / Confident</option><option value="fresh">Fresh / Clean</option><option value="warm">Warm / Cozy</option><option value="calm">Calm / Serene</option><option value="energetic">Energetic / Uplifting</option></select></div><div class="category-field"><label for="scentProfile">Scent Profile *</label><select id="scentProfile" class="form-control" required><option value="" disabled selected>Select scent</option><option value="floral">Floral</option><option value="woody">Woody</option><option value="citrus">Citrus</option><option value="oriental">Oriental</option><option value="fresh">Fresh / Aquatic</option><option value="gourmand">Gourmand</option></select></div>`,
      haircare: `<div class="category-field"><label for="hairType">Hair Type *</label><select id="hairType" class="form-control" required><option value="" disabled selected>Select hair type</option><option value="straight">Straight</option><option value="wavy">Wavy</option><option value="curly">Curly</option><option value="coily">Coily</option></select></div><div class="category-field"><label for="hairConcern">Hair Concern *</label><select id="hairConcern" class="form-control" required><option value="" disabled selected>Select concern</option><option value="damage">Damage / Breakage</option><option value="frizz">Frizz Control</option><option value="volume">Volume / Thinning</option><option value="dryness">Dryness</option><option value="color">Colour Treated</option><option value="scalp">Scalp Health</option></select></div>`,
      bodycare: `<div class="category-field"><label for="bodyConcern">Body Concern *</label><select id="bodyConcern" class="form-control" required><option value="" disabled selected>Select concern</option><option value="dryness">Dryness</option><option value="firming">Firming</option><option value="smoothing">Smoothing</option><option value="relaxation">Relaxation</option><option value="energizing">Energizing</option></select></div><div class="category-field"><label for="bodyFormat">Product Format *</label><select id="bodyFormat" class="form-control" required><option value="" disabled selected>Select format</option><option value="lotion">Lotion</option><option value="cream">Cream</option><option value="oil">Oil</option><option value="scrub">Scrub</option><option value="butter">Butter</option></select></div>`
    };

    // Deterministic, keyword-based product-category resolver (spec: "Safe
    // category resolution"). This exists ONLY to fill in product_category
    // when the (now-optional) Marketing Intelligence panel is left blank —
    // it must never force the user through a questionnaire. Today the only
    // real per-product signal available in the simple Create flow is the
    // uploaded product image's filename, so that's what we key off; if a
    // future field carries an explicit product name/title, pass it in here
    // too. Falls back to null (caller decides the safe default) rather than
    // ever assuming a category it has no evidence for.
    const CATEGORY_KEYWORDS = {
      haircare:  ['shampoo', 'conditioner', 'hair mask', 'hair serum', 'hair oil', 'hair care', 'haircare', 'hair'],
      skincare:  ['serum', 'moisturizer', 'moisturiser', 'cleanser', 'face wash', 'toner', 'sunscreen', 'skincare', 'skin care'],
      makeup:    ['lipstick', 'lip gloss', 'foundation', 'concealer', 'blush', 'mascara', 'eyeliner', 'eyeshadow', 'makeup'],
      fragrance: ['perfume', 'fragrance', 'eau de parfum', 'eau de toilette', 'cologne'],
      bodycare:  ['grooming', 'beard', 'shaving', 'razor', 'body lotion', 'body wash', 'body scrub', 'bodycare', 'body care'],
    };
    function resolveProductCategoryFromText(text) {
      if (!text) return null;
      const t = String(text).toLowerCase().replace(/[._-]+/g, ' ');
      for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
        if (keywords.some(kw => t.includes(kw))) return category;
      }
      return null;
    }
    function resolveProductCategoryHint() {
      const productFile = document.getElementById('assetProductInput')?.files?.[0];
      return resolveProductCategoryFromText(productFile?.name);
    }

    function validateMarketingProfile() {
      const category = productCategory.value;
      const funnel = document.querySelector('input[name="funnelStage"]:checked');
      if (!category || !funnel || !ageRangeSelect.value || !genderSelect.value || !occasion.value) return false;
      if (category==='skincare'||category==='makeup') { if (!document.getElementById('skinType')?.value||!document.getElementById('primaryConcern')?.value) return false; }
      else if (category==='fragrance') { if (!document.getElementById('fragranceMood')?.value||!document.getElementById('scentProfile')?.value) return false; }
      else if (category==='haircare') { if (!document.getElementById('hairType')?.value||!document.getElementById('hairConcern')?.value) return false; }
      else if (category==='bodycare') { if (!document.getElementById('bodyConcern')?.value||!document.getElementById('bodyFormat')?.value) return false; }
      return true;
    }

    function updateAnalyzeButtonState() { analyzeBtn.disabled = !validateMarketingProfile() || !_mlEngineOnline; }

    // Fills the Marketing Intelligence fields (and Product Type) with sensible,
    // non-misleading defaults for anything the user hasn't set themselves, so
    // Generate Creative never has to force the user through the questionnaire.
    // Anything the user *has* already chosen is left untouched.
    async function ensureCreativeDefaults() {
      const firstRealOption = (select) => Array.from(select.options).find(o => o.value);

      if (!productCategory.value) {
        // Prefer a resolved category from actual product signal over
        // blindly picking the first dropdown option — the dropdown's
        // option order is alphabetical UI ordering, not a meaningful
        // default, and always landing on "skincare" here was sending every
        // non-skincare product (haircare, makeup, fragrance...) through
        // skincare-flavoured ad copy.
        const productFile = document.getElementById('assetProductInput')?.files?.[0];
        const filenameResolved = resolveProductCategoryHint();
        let imageResolved = null;
        let source = 'fallback';
        let resolved = filenameResolved;

        if (filenameResolved) {
          source = 'filename_resolver';
        } else {
          // Filename gave nothing usable (generic upload name like
          // "shopping.webp"/"image.webp") — fall back to classifying the
          // ACTUAL uploaded product image instead of guessing from the
          // filename alone. Deterministic OCR match against the same
          // category keywords (backend/image_category.py) — no new ML
          // model, no guessing "skincare" when this fails or finds nothing.
          const productImageUrl = window._beaulixAssets?.product?.cloudinaryUrl
                                || window._beaulixAssets?.product?.url || null;
          if (productImageUrl && _mlBackendUrl) {
            // Diagnostics only (no routing change): _mlBackendUrl is the ML
            // backend (server.py, e.g. beaulix.onrender.com) that owns
            // /classify-product-category — NOT the GPU/ngrok backend used by
            // /generate. These two backends are separate services.
            const classifierUrl = `${_mlBackendUrl}/classify-product-category`;
            let classifierStatus = null;
            try {
              const res = await fetchWithTimeout(classifierUrl, {
                method: 'POST', timeout: FETCH_TIMEOUT,
                headers: await getMlAuthHeaders(),
                body: JSON.stringify({ image_url: productImageUrl }),
              });
              classifierStatus = res.status;
              if (res.ok) {
                const data = await res.json();
                imageResolved = data?.category || null;
              } else {
                console.warn('[BEAULIX CATEGORY] /classify-product-category failed with status', res.status);
              }
            } catch (e) {
              // Network-level failure (no HTTP status at all) — e.g. CORS,
              // DNS, or the request never completing. Distinguish this from
              // an HTTP error status in the diagnostics line below.
              classifierStatus = 'error:' + (e?.name || 'Unknown') + (e?.message ? ' ' + e.message : '');
              console.warn('[BEAULIX CATEGORY] image classification request failed (leaving category unknown):', e.message);
            }
            console.log('[BEAULIX CATEGORY]',
                         'classifier_url=' + classifierUrl,
                         'classifier_status=' + classifierStatus);
          }
          resolved = imageResolved;
          source = imageResolved ? 'image_classifier' : 'fallback';
        }

        // STEP 6 (still in force): an unresolved category must NEVER
        // silently fall back to firstRealOption(productCategory) — that
        // option is "skincare" (alphabetically first in the <select>).
        // Unrecognized means "unknown", not "skincare": productCategory is
        // left unset (still ""), and every downstream copy request must
        // treat "" as unknown and use category-neutral fallback copy
        // instead of guessing a category it has no evidence for.
        console.log('[BEAULIX CATEGORY]',
                     'filename=' + (productFile?.name || null),
                     'filename_resolved_category=' + filenameResolved,
                     'image_resolved_category=' + imageResolved,
                     'final_category=' + resolved,
                     'source=' + source);
        if (resolved) {
          productCategory.value = resolved;
          productCategory.dataset.autoResolved = '1';
          updateCategoryFields();
        } else {
          console.warn('[BEAULIX CATEGORY] no keyword match from filename OR product image — leaving category UNKNOWN (not defaulting to skincare)');
        }
        console.log('[BEAULIX CATEGORY] productCategory.value(after) =', productCategory.value, 'source =', source);
      }
      if (!occasion.value) { const opt = firstRealOption(occasion); if (opt) occasion.value = opt.value; }
      if (!ageRangeSelect.value) { ageRangeSelect.value = '25-34'; }
      if (!genderSelect.value) { genderSelect.value = 'all-genders'; }
      if (!document.querySelector('input[name="funnelStage"]:checked')) {
        const awareness = document.querySelector('input[name="funnelStage"][value="awareness"]');
        if (awareness) awareness.checked = true;
      }
      // Category-specific sub-fields injected by updateCategoryFields()
      document.querySelectorAll('#categoryFieldsContainer select').forEach(sel => {
        if (!sel.value) { const opt = firstRealOption(sel); if (opt) sel.value = opt.value; }
      });

      populateProductTypeDropdown(productCategory.value);
      if (!productType.value) { const opt = firstRealOption(productType); if (opt) productType.value = opt.value; }

      if (!document.querySelector('input[name="aspect-ratio"]:checked')) {
        const sq = document.querySelector('input[name="aspect-ratio"][value="1:1"]');
        if (sq) sq.checked = true;
      }
      if (!document.querySelector('input[name="output-type"]:checked')) {
        const img = document.querySelector('input[name="output-type"][value="image"]');
        if (img) img.checked = true;
      }
      if (!brandStyleSelect.value) {
        const selectedStyleCard = document.querySelector('#styleGrid input[name="creative-style"]:checked');
        brandStyleSelect.value = selectedStyleCard ? selectedStyleCard.value : 'luxury-elegant';
      }

      updateDecisionLogic(); updateProfileSummary(); updateAnalyzeButtonState();
    }

    function updateGenerateButtonState() {
      // Creative-first gating: only the visible choices (what to create + style)
      // are required to enable Generate. Marketing profile / product type are
      // filled with sensible defaults automatically — see ensureCreativeDefaults().
      const contentTypeSelected = !!document.querySelector('input[name="content-type"]:checked');
      const styleSelected = !!document.querySelector('input[name="creative-style"]:checked');
      const outputType = document.querySelector('input[name="output-type"]:checked')?.value;
      const durationSelected = outputType === 'video' ? durationSelect?.value : true;
      generateCreativeBtn.disabled = !(contentTypeSelected && styleSelected && durationSelected);
    }

    window.copyToClipboard = function(id) {
      const el = document.getElementById(id);
      if (!el) return;
      navigator.clipboard.writeText(el.textContent).then(() => showToast('Copied!','success')).catch(() => showToast('Failed to copy','error'));
    };

    function showToast(message, type = 'info') {
      const container = document.getElementById('toastContainer');
      const toast = document.createElement('div');
      toast.className = `toast-notification toast-${type}`;
      toast.innerHTML = `<span>${message}</span>`;
      container.appendChild(toast);
      setTimeout(() => toast.classList.add('show'), 10);
      setTimeout(() => { toast.classList.remove('show'); setTimeout(() => toast.remove(), 300); }, 3500);
    }

    async function runStagedLoading() {
      loadingStages.classList.remove('hidden'); loadingStages.style.display = 'block';
      const stages = ['stage1','stage2','stage3','stage4'];
      const indicators = ['indicator1','indicator2','indicator3','indicator4'];
      stages.forEach(id => document.getElementById(id).classList.remove('active','completed'));
      indicators.forEach(id => { const el = document.getElementById(id); el.classList.remove('completed'); el.textContent = id.replace('indicator',''); });
      for (let i = 0; i < stages.length; i++) {
        for (let j = 0; j < i; j++) { document.getElementById(stages[j]).classList.replace('active','completed'); document.getElementById(indicators[j]).classList.add('completed'); }
        document.getElementById(stages[i]).classList.add('active');
        await new Promise(r => setTimeout(r, 700 + i * 200));
      }
      stages.forEach(id => { document.getElementById(id).classList.remove('active'); document.getElementById(id).classList.add('completed'); });
      indicators.forEach(id => document.getElementById(id).classList.add('completed'));
    }

    // `direction` is the creative direction this copy is for ('hero' /
    // 'lifestyle' / 'social' — see VARIATION_CONCEPTS keys). Optional and
    // defaults to 'hero' so every existing caller (marketing analysis,
    // /predict, /predict-step2) that doesn't care about direction-specific
    // copy keeps behaving exactly as before.
    function buildPayload(direction) {
      const category = productCategory.value;
      let attr1='', attr2='';
      if (category==='skincare'||category==='makeup') { attr1=document.getElementById('skinType')?.value||''; attr2=document.getElementById('primaryConcern')?.value||''; }
      else if (category==='fragrance') { attr1=document.getElementById('fragranceMood')?.value||''; attr2=document.getElementById('scentProfile')?.value||''; }
      else if (category==='haircare') { attr1=document.getElementById('hairType')?.value||''; attr2=document.getElementById('hairConcern')?.value||''; }
      else if (category==='bodycare') { attr1=document.getElementById('bodyConcern')?.value||''; attr2=document.getElementById('bodyFormat')?.value||''; }
      const funnelRadio = document.querySelector('input[name="funnelStage"]:checked');
      const productFileForLog = document.getElementById('assetProductInput')?.files?.[0];
      console.log('[BEAULIX CATEGORY] buildPayload.product_category =', category, 'direction =', direction || 'hero');
      console.log('[BEAULIX BUILD PAYLOAD] direction =', direction || 'hero',
                   'product_category =', category,
                   'product_image_url =', window._beaulixAssets?.product?.url || null,
                   'product_name =', productFileForLog?.name || null);
      return { product_category:category, decision_attribute_1:attr1, decision_attribute_2:attr2, funnel_stage:funnelRadio?funnelRadio.value:'', age_range:ageRangeSelect.value, gender:genderSelect.value, occasion:occasion.value, brand_style:brandStyleSelect.value||'', creative_direction: direction || 'hero' };
    }

    function buildStep2Payload() {
      // Full Step 1 + Step 2 inputs for /predict-step2
      const base = buildPayload();
      const aspectRatio = document.querySelector('input[name="aspect-ratio"]:checked')?.value || '1:1';
      const outputTypeRadio = document.querySelector('input[name="output-type"]:checked');
      const outputType = outputTypeRadio ? outputTypeRadio.value : 'image';
      return {
        ...base,
        brand_style:  brandStyleSelect.value || '',
        aspect_ratio: aspectRatio,
        output_type:  outputType,
      };
    }
    window._buildStep2Payload = buildStep2Payload;

    function rateMetric(value, benchmark) {
      const ratio = value / benchmark;
      if (ratio > 2.0) return { text:'EXCEPTIONAL', class:'badge-excellent', barWidth:Math.min(100,ratio*40) };
      if (ratio > 1.5) return { text:'GREAT',       class:'badge-great',     barWidth:Math.min(90,ratio*30)  };
      if (ratio > 1.0) return { text:'GOOD',        class:'badge-good',      barWidth:Math.min(70,ratio*25)  };
      if (ratio > 0.7) return { text:'AVERAGE',     class:'badge-average',   barWidth:Math.min(50,ratio*25)  };
      if (ratio > 0.4) return { text:'BELOW AVG',   class:'badge-below',     barWidth:Math.min(30,ratio*20)  };
      return               { text:'NEEDS WORK',  class:'badge-poor',      barWidth:Math.min(15,ratio*15)  };
    }

    function applyAnalysisPredictions(data) {
      if (data.benchmarks) activeBenchmarks = data.benchmarks;
      const benchmark = activeBenchmarks;

      // ── Metric values ─────────────────────────────────────────────────
      document.getElementById('analysisCTR').textContent        = (data.ctr||0).toFixed(2)+'%';
      document.getElementById('analysisConv').textContent       = (data.conversion_rate||0).toFixed(2)+'%';
      document.getElementById('analysisEng').textContent        = (data.engagement_rate||0).toFixed(2)+'%';
      document.getElementById('analysisConfidence').textContent = (data.confidence_score||0).toFixed(1)+'%';

      const applyRating = (badgeId, barId, val, bench) => {
        const r = rateMetric(val, bench);
        document.getElementById(badgeId).textContent  = r.text;
        document.getElementById(badgeId).className    = `metric-badge ${r.class}`;
        document.getElementById(barId).style.width    = r.barWidth + '%';
      };
      applyRating('ctrBadge',  'ctrBar',  data.ctr,             benchmark.ctr);
      applyRating('convBadge', 'convBar', data.conversion_rate, benchmark.conversion);
      applyRating('engBadge',  'engBar',  data.engagement_rate, benchmark.engagement);

      // ── Confidence card ───────────────────────────────────────────────
      const confScore = data.confidence_score || 0;
      const confR = confScore >= 90 ? { text:'EXCEPTIONAL', cls:'badge-excellent' }
                  : confScore >= 85 ? { text:'GREAT',       cls:'badge-great'     }
                  : confScore >= 78 ? { text:'GOOD',        cls:'badge-good'      }
                  : confScore >= 70 ? { text:'AVERAGE',     cls:'badge-average'   }
                  :                   { text:'BUILDING',    cls:'badge-below'     };
      document.getElementById('confBadge').textContent = confR.text;
      document.getElementById('confBadge').className   = `metric-badge ${confR.cls}`;
      document.getElementById('confBar').style.width   = confScore + '%';

      // CV R² from _calibration debug block (present after retrain with updated script)
      const cal        = data._calibration || {};
      const cvCtr      = cal.cv_r2_ctr;
      const cvConv     = cal.cv_r2_conversion;
      const cvEng      = cal.cv_r2_engagement;
      const hasCVScores = cvCtr != null && cvConv != null && cvEng != null;

      if (hasCVScores) {
        document.getElementById('confBenchmark').textContent =
          `CV R²: CTR ${(cvCtr*100).toFixed(1)}% · Conv ${(cvConv*100).toFixed(1)}% · Eng ${(cvEng*100).toFixed(1)}%`;
        document.getElementById('confProfilesBenchmark').textContent =
          `${data.similar_profiles||0} similar profiles · same age, gender & funnel`;
        const cvDetail = document.getElementById('confCVDetail');
        cvDetail.style.display = 'block';
        cvDetail.textContent   = `5-fold CV · CI: ${cal.ci_method||'rf_tree_variance'} · Calibration: ${cal.active ? 'on' : 'off'}`;
      } else {
        document.getElementById('confBenchmark').textContent =
          `Based on ${data.similar_profiles||0} profiles · same age, gender & funnel`;
        document.getElementById('confProfilesBenchmark').textContent = '';
        document.getElementById('confCVDetail').style.display = 'none';
      }

      // ── Benchmark comparison lines ────────────────────────────────────
      const pctLine = (val, bench) => {
        const d = ((val/bench - 1)*100).toFixed(0);
        return d > 0 ? `↑ ${d}% above avg (${bench}%)` : `↓ ${Math.abs(d)}% below avg (${bench}%)`;
      };
      document.getElementById('ctrBenchmark').textContent  = pctLine(data.ctr,             benchmark.ctr);
      document.getElementById('convBenchmark').textContent = pctLine(data.conversion_rate, benchmark.conversion);
      document.getElementById('engBenchmark').textContent  = pctLine(data.engagement_rate, benchmark.engagement);

      // ── Confidence intervals ──────────────────────────────────────────
      if (data.confidence_interval) {
        const ci = data.confidence_interval;
        document.getElementById('analysisCTRCI').textContent  = `95% CI: [${ci.ctr.lower.toFixed(2)}%, ${ci.ctr.upper.toFixed(2)}%]`;
        document.getElementById('analysisConvCI').textContent = `95% CI: [${ci.conversion_rate.lower.toFixed(2)}%, ${ci.conversion_rate.upper.toFixed(2)}%]`;
        document.getElementById('analysisEngCI').textContent  = `95% CI: [${ci.engagement_rate.lower.toFixed(2)}%, ${ci.engagement_rate.upper.toFixed(2)}%]`;
      }

      // ── Footer notes ──────────────────────────────────────────────────
      document.getElementById('analysisClusterMatch').textContent = (data.similar_profiles||0)+' profiles in your demographic';
      if (data.step2_recommendations)  updateStep2RecsFromAPI(data.step2_recommendations);

      const cvNote   = hasCVScores ? ` · CV R² ${(((cvCtr+cvConv+cvEng)/3)*100).toFixed(1)}%` : '';
      const noteText = `⚡ Beaulix ML · ${data.similar_profiles||0} profiles · v1.0.0${cvNote}`;
      document.getElementById('analysisFooterNote').textContent = noteText;
      modelSourceNote.textContent = noteText;
    }

    // Step 23: single source of truth for the copy that gets baked into the
    // image. Reads the visible Ad Text fields (headline / description→body /
    // CTA / offer); falls back to the copy-engine object if a field is empty
    // or still shows the '-' placeholder. Nothing is hardcoded here.
    //
    // STEP 26 fix: `fallback` is read fresh from `lastPredictionData.ad_copy`
    // by the caller at send-time (not a value captured once, up front, before
    // the batch's 3 sequential /generate calls) — see fillVariationCard.
    // Since each image generation takes ~20-30s, a slow /predict call that
    // missed the original 12s UI bound has almost always landed by the time
    // card 2 or 3 is sent, so this self-heals instead of permanently baking
    // in a null captured too early. Field-name mismatch (`description` vs
    // `body`) is normalized here — the copy engine's real field is
    // `description`; `body` is accepted too in case that ever changes.
    function getAdCopyForRender(fallback) {
      const fallbackBody = (fallback && (fallback.description ?? fallback.body)) || '';
      const read = (id, key, fallbackValue) => {
        const t = (document.getElementById(id)?.textContent || '').trim();
        if (t && t !== '-') return t;
        return (fallbackValue ?? (fallback && fallback[key]) ?? '').toString().trim();
      };
      return {
        headline: read('adHeadline', 'headline'),
        body:     read('adDescription', 'description', fallbackBody),
        cta:      read('adCTA', 'cta'),
        offer:    read('adOffer', 'offer'),
      };
    }

    // Single choke-point helper for the /generate request body. Resolves the
    // EXISTING copy (visible Ad Text fields first, then lastPredictionData.ad_copy
    // — the same objects the UI already shows; nothing hardcoded) and returns
    // the normalized {headline, body, cta, offer} shape the GPU server reads.
    function buildNormalizedAdCopyForGenerate(payload) {
      const existingAdCopy = (payload && payload.ad_copy) || (lastPredictionData && lastPredictionData.ad_copy) || null;
      console.log('[COPY DEBUG] copy immediately before /generate:', existingAdCopy);
      console.log('[COPY DEBUG] lastPredictionData:', lastPredictionData);
      const fieldCopy = getAdCopyForRender(existingAdCopy);
      const normalizedAdCopy = {
        headline: fieldCopy.headline || (existingAdCopy && (existingAdCopy.headline || existingAdCopy.hook)) || (payload && payload.headline) || '',
        body:     fieldCopy.body     || (existingAdCopy && (existingAdCopy.body || existingAdCopy.description)) || (payload && payload.body) || '',
        cta:      fieldCopy.cta      || (existingAdCopy && existingAdCopy.cta) || (payload && payload.cta) || '',
        offer:    fieldCopy.offer    || (existingAdCopy && existingAdCopy.offer) || (payload && payload.offer) || '',
      };
      console.log('[COPY DEBUG] normalizedAdCopy:', normalizedAdCopy);
      return normalizedAdCopy;
    }

    // Guarantees ad_copy (nested + flat) is inside the JSON body of the POST.
    function withAdCopyInPayload(payload) {
      if (!payload || payload.output_type === 'video') return payload;
      const n = buildNormalizedAdCopyForGenerate(payload);
      if (!n.headline && !n.body && !n.cta && !n.offer) {
        throw new Error('Ad copy is empty at /generate time — refusing to send a request without copy.');
      }
      return { ...payload, headline: n.headline, body: n.body, cta: n.cta, offer: n.offer, ad_copy: n };
    }

    function updateAdTextFromAPI(adCopyData) {
      if (!adCopyData) return;
      document.getElementById('adHook').textContent = adCopyData.hook || '-';
      document.getElementById('adHeadline').textContent = adCopyData.headline || '-';
      document.getElementById('adDescription').textContent = adCopyData.description || '-';
      document.getElementById('adCTA').textContent = adCopyData.cta || '-';
      document.getElementById('adOffer').textContent = adCopyData.offer || '-';
    }

    function updateTargetingFromAPI(targetingData) {
      if (!targetingData) return;
      const targetingTagsEl = document.getElementById('targetingTags');
      if (targetingTagsEl && targetingData.targeting) {
        targetingTagsEl.innerHTML = targetingData.targeting.map(tag => `<span class="targeting-tag">${escapeHtml(tag)}</span>`).join('');
      }
      const platformTagsEl = document.getElementById('platformTags');
      if (platformTagsEl && targetingData.platforms) {
        platformTagsEl.innerHTML = targetingData.platforms.map(platform => `<span class="targeting-tag">${escapeHtml(platform)}</span>`).join('');
      }
    }

    function estimateTokens(text) { return Math.ceil(text.length / 4); }

    function buildSilentPrompt() {
      const productTypeVal = productType?.value?.trim()||'';
      const productColorVal = productColor?.value?.trim()||'';
      const sceneDescVal = sceneDescription?.value?.trim()||'';
      const brandStyle = brandStyleSelect?.value||'';
      const includeHuman = includeHumanFace?.checked||false;
      const aspectRatio = document.querySelector('input[name="aspect-ratio"]:checked')?.value||'1:1';
      const funnelStage = document.querySelector('input[name="funnelStage"]:checked')?.value||'';
      const occasionVal = occasion?.value||'';
      const lightingMap = {'':'clean studio lighting','luxury-elegant':'cinematic lighting, elegant','modern-minimalist':'bright studio lighting, minimal','bold-vibrant':'vibrant colorful lighting','natural-organic':'soft natural light','glam-dramatic':'dramatic glamour lighting','soft-romantic':'soft diffused light'};
      const funnelLightMap = {awareness:'soft morning light',consideration:'clinical detailed lighting',conversion:'dramatic product lighting',retention:'warm lifestyle lighting'};
      const skinToneMap = {fair:'fair skin',light:'light skin',medium:'medium skin tone',tan:'tan skin',deep:'deep skin tone'};
      const actionMap = {
        // Serums & treatments
        'serum':'applying serum to face with dropper','ampoule':'applying ampoule serum to face','booster':'applying booster drops to face',
        // Moisturisers
        'moisturiser':'applying moisturiser to face','moisturizer':'applying moisturizer to face','cream':'applying cream to face','day cream':'applying day cream to face','night cream':'applying night cream to face','water cream':'applying water cream to face','sleeping mask':'applying overnight sleeping mask','sleeping pack':'applying sleeping pack to face',
        // Cleansers
        'cleanser':'washing face with cleanser','cleansing oil':'massaging cleansing oil onto face','cleansing balm':'massaging cleansing balm onto face','foam cleanser':'foaming cleanser on face','gel cleanser':'applying gel cleanser to face','micellar water':'removing makeup with micellar water on cotton pad','cleansing wipes':'wiping face with cleansing wipe','makeup remover':'removing makeup with cotton pad',
        // Toners & essences
        'toner':'patting toner onto face with hands','essence':'patting essence onto face','facial mist':'misting face with facial spray',
        // Oils & butters
        'face oil':'pressing face oil between palms applying to face','body oil':'applying body oil to smooth skin','body butter':'scooping body butter applying to skin',
        // Masks
        'sheet mask':'applying sheet mask to face','clay mask':'applying clay mask to face','peel-off mask':'peeling off mask from face','mud mask':'applying mud mask to face','exfoliating mask':'applying exfoliating mask','chemical exfoliant':'applying chemical exfoliant to skin','physical scrub':'scrubbing face with exfoliant','enzyme powder':'foaming enzyme powder cleanser on face',
        // SPF
        'sunscreen':'applying sunscreen to face','tinted sunscreen':'blending tinted sunscreen on face','spf moisturiser':'applying spf moisturiser to face',
        // Eye & lip
        'eye cream':'dabbing eye cream under eyes','eye gel':'dabbing eye gel under eyes','eye serum':'applying eye serum with fingertip','lip balm':'applying lip balm to lips','lip mask':'applying lip mask to lips','lip treatment':'applying lip treatment to lips','lip scrub':'scrubbing lips with lip scrub',
        // Makeup — face
        'foundation':'applying foundation with brush to face','concealer':'applying concealer under eyes','bb cream':'blending bb cream on face','cc cream':'blending cc cream on face','tinted moisturiser':'blending tinted moisturiser on face','primer':'applying primer to face','setting powder':'dusting setting powder over face','setting spray':'misting setting spray over face','blush':'brushing blush on cheekbones','bronzer':'sweeping bronzer on cheeks','contour':'contouring cheekbones with brush','highlighter':'applying highlighter to cheekbones',
        // Makeup — eyes
        'eyeshadow':'blending eyeshadow on eyelid','eyeliner':'applying eyeliner to eye','mascara':'applying mascara to lashes','brow':'filling in brows with pencil','false lashes':'applying false lashes','lash serum':'applying lash serum to lash line',
        // Makeup — lips
        'lipstick':'applying lipstick to lips','lip gloss':'applying lip gloss to lips','liquid lipstick':'applying liquid lipstick to lips','lip liner':'lining lips with lip liner','lip stain':'applying lip stain to lips','lip plumper':'applying lip plumper to lips','lip oil':'applying lip oil to lips',
        // Fragrance
        'parfum':'spraying perfume on neck and wrist','eau de parfum':'spraying eau de parfum on neck','eau de toilette':'spraying eau de toilette on neck','eau de cologne':'spraying cologne on neck','perfume':'spraying perfume on neck','body mist':'spraying body mist on skin','hair mist':'misting hair mist over hair','roll-on perfume':'rolling perfume on wrist',
        // Haircare
        'shampoo':'washing hair with shampoo, lathering','conditioner':'applying conditioner to wet hair','hair mask':'applying hair mask to hair','scalp serum':'applying scalp serum with dropper to parted hair','scalp scrub':'massaging scalp scrub into scalp','dry shampoo':'spraying dry shampoo at roots','heat protectant':'spraying heat protectant on hair before styling','curl cream':'scrunching curl cream into curly hair','curl gel':'applying gel to curly hair','hair oil':'applying hair oil to ends of hair','hair serum':'smoothing hair serum through hair',
        // Bodycare
        'body lotion':'applying body lotion to legs','body cream':'applying body cream to arms','lotion':'applying lotion to skin','body scrub':'scrubbing body scrub on skin','hand cream':'applying hand cream to hands','foot cream':'applying foot cream to feet','self-tan':'applying self-tan lotion to legs','bath bomb':'dropping bath bomb into bath','deodorant':'applying deodorant to underarm',
        // Fallbacks
        'oil':'applying oil to skin','lotion':'applying lotion to skin','balm':'applying balm'
      };
      const parts = [];
      const hasUploadedProduct = window._beaulixAssets?.product?.status === 'ready';
      const productSubject = productColorVal ? `${productColorVal} ${productTypeVal}` : productTypeVal;
      if (hasUploadedProduct) {
        // A real product photo was uploaded — the AI is asked to generate
        // ONLY the background/scene, with open space where the product will
        // be pixel-composited afterwards (see composite_product_on_scene on
        // the GPU server). We deliberately do NOT describe the product
        // itself here, and do NOT ask the model to draw or hold it — its
        // real, unaltered pixels are pasted in after generation instead.
        parts.push('elegant product display surface, clean open negative space at lower-center for product placement, no product objects in frame');
        if (includeHuman) {
          const hg = document.getElementById('humanGender')?.value||'';
          const ha = document.getElementById('humanAge')?.value||'';
          const st = document.querySelector('input[name="skin-tone"]:checked')?.value||'';
          const hr = document.getElementById('humanRegion')?.value?.trim()||'';
          const genderWord = hg==='woman'?'woman':hg==='man'?'man':'person';
          const humanDesc = [hr, genderWord, skinToneMap[st]||'', ha?`age ${ha}`:''].filter(Boolean).join(' ');
          // Backdrop presence only — the product is composited separately as
          // a hero placement, not into a hand, so avoid "holding" language.
          parts.push(`${humanDesc} softly blurred in the background`);
        }
      } else if (includeHuman && productTypeVal) {
        const hg = document.getElementById('humanGender')?.value||'';
        const ha = document.getElementById('humanAge')?.value||'';
        const st = document.querySelector('input[name="skin-tone"]:checked')?.value||'';
        const hr = document.getElementById('humanRegion')?.value?.trim()||'';
        const genderWord = hg==='woman'?'woman':hg==='man'?'man':'person';
        const humanDesc = [hr, genderWord, skinToneMap[st]||'', ha?`age ${ha}`:''].filter(Boolean).join(' ');
        const pl = productTypeVal.toLowerCase();
        const matchedAction = Object.entries(actionMap).sort((a,b)=>b[0].length-a[0].length).find(([k]) => pl.includes(k));
        parts.push(`${productSubject} held by ${humanDesc}, ${matchedAction?matchedAction[1]:`holding ${productTypeVal}`}`);
      } else if (productTypeVal) {
        // No real product photo — nothing to composite, so the model has to
        // draw a representative product from the text description (best
        // effort; not pixel-accurate to any specific real product).
        parts.push(`${productSubject}, studio hero shot, isolated`);
      }
      if (sceneDescVal) parts.push(sceneDescVal.split(' ').slice(0,8).join(' '));
      else if (occasionVal==='gym') parts.push('post-workout gym setting');
      else parts.push(funnelLightMap[funnelStage]||'natural lighting');
      parts.push(lightingMap[brandStyle]||'professional beauty lighting');
      parts.push('beauty photography, 85mm, soft focus background');
      const compositionMap = {'9:16':'vertical portrait composition','1:1':'square centered composition','16:9':'horizontal wide composition','4:5':'instagram portrait crop'};
      parts.push(compositionMap[aspectRatio]||'centered composition');
      let prompt = '';
      for (const part of parts) { const candidate = prompt ? `${prompt}, ${part}` : part; if (estimateTokens(candidate)<=70) prompt=candidate; else break; }
      return prompt;
    }

    async function loadImageAsBlob(remoteUrl) {
      const response = await fetchWithTimeout(remoteUrl, { timeout: 30000 });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      return URL.createObjectURL(blob);
    }

    // ── Blob URL cleanup helpers ────────────────────────────────────────
    // Generated images/videos are loaded as blob: URLs (createObjectURL)
    // and kept alive for as long as they're displayed or downloadable.
    // These two helpers are the ONLY place URL.revokeObjectURL is called
    // from, and only ever revoke a URL that is being replaced or whose
    // card is being removed from the DOM — never the one currently shown.
    function safeRevokeBlobUrl(url) {
      // Guards: only a real blob: URL, and safe to call twice (revoking an
      // already-revoked URL is a documented no-op, but we still avoid it
      // where the caller can easily track "already revoked").
      if (url && typeof url === 'string' && url.indexOf('blob:') === 0) {
        try { URL.revokeObjectURL(url); } catch (e) { /* already revoked / invalid — ignore */ }
      }
    }
    function revokeCardBlobUrls(containerEl) {
      // Revokes every card's stored blob URL under containerEl. Only call
      // this immediately before the container's cards are discarded
      // (innerHTML reset or the container itself removed) — never while
      // any of those cards are still the ones on screen.
      if (!containerEl) return;
      containerEl.querySelectorAll('[data-blob-url]').forEach(el => {
        safeRevokeBlobUrl(el.dataset.blobUrl);
        el.dataset.blobUrl = '';
      });
    }

    async function renderVisualContent(remoteUrl, outputType, retryFn) {
      const vc = document.getElementById('visualContainer');
      if (vc) vc.classList.remove('placeholder-mode');
      visualContent.innerHTML = `<div class="image-loading-wrapper loading" id="imgWrapper"><div class="image-loading-overlay" id="imgLoadingOverlay"><div class="spinner"></div><span>Loading ${outputType}...</span></div></div>`;
      // This legacy single-preview panel keeps only one blob alive at a
      // time in lastGeneratedBlobUrl. Capture the outgoing one so it can
      // be revoked only AFTER the new one has successfully replaced it
      // on screen — never before, and never the new one.
      const _previousLastGeneratedBlobUrl = lastGeneratedBlobUrl;

      if (outputType === 'video') {
        try {
          const response = await fetchWithTimeout(remoteUrl, { timeout: VIDEO_LOAD_TIMEOUT });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const blob = await response.blob();
          const blobUrl = URL.createObjectURL(blob);
          lastGeneratedBlobUrl = blobUrl;
          const video = document.createElement('video');
          video.className = 'generated-video'; video.controls = true; video.loop = true; video.muted = false; video.playsInline = true;
          video.onloadeddata = () => {
            document.getElementById('imgLoadingOverlay')?.remove();
            document.getElementById('imgWrapper')?.classList.remove('loading');
            downloadBtn.disabled = false;
            lastGeneratedFilename = remoteUrl.split('/').pop() || 'beaulix-video.mp4';
            // New video is decoded and on screen — the previous blob (if
            // any) is no longer displayed anywhere, safe to release now.
            if (_previousLastGeneratedBlobUrl !== blobUrl) safeRevokeBlobUrl(_previousLastGeneratedBlobUrl);
          };
          video.onerror = () => showImageError(retryFn);
          video.src = blobUrl; video.load();
          const wrapper = document.getElementById('imgWrapper');
          wrapper.innerHTML = ''; wrapper.appendChild(video);
        } catch (error) { showImageError(retryFn); }
      } else {
        try {
          const blobUrl = await loadImageAsBlob(remoteUrl);
          lastGeneratedBlobUrl = blobUrl;
          const img = document.createElement('img');
          img.className = 'generated-image';
          img.onload = () => {
            document.getElementById('imgLoadingOverlay')?.remove(); document.getElementById('imgWrapper')?.classList.remove('loading'); downloadBtn.disabled = false;
            // Same reasoning as the video branch above — only revoke once
            // the new image has actually loaded and taken its place.
            if (_previousLastGeneratedBlobUrl !== blobUrl) safeRevokeBlobUrl(_previousLastGeneratedBlobUrl);
          };
          img.onerror = () => showImageError(retryFn);
          img.src = blobUrl;
          document.getElementById('imgWrapper').appendChild(img);
        } catch { showImageError(retryFn); }
      }
    }

    function showImageError(retryFn) {
      visualContent.innerHTML = `<div class="image-error-box"><div class="error-icon">⚠️</div><p>Could not load the generated visual</p><small>The Colab session may have expired</small>${retryFn?'<button class="retry-btn" id="retryGenBtn">Try Again</button>':''}</div>`;
      if (retryFn) document.getElementById('retryGenBtn')?.addEventListener('click', retryFn);
      downloadBtn.disabled = true;
    }

    function updateCategoryFields() {
      const category = productCategory.value;
      if (categoryFieldTemplates[category]) {
        categoryFieldsContainer.style.display = 'grid';
        categoryFieldsContainer.innerHTML = categoryFieldTemplates[category];
        categoryFieldsContainer.querySelectorAll('select').forEach(f => f.addEventListener('change', () => { updateDecisionLogic(); updateAnalyzeButtonState(); }));
      } else { categoryFieldsContainer.style.display='none'; categoryFieldsContainer.innerHTML=''; }
      updateAnalyzeButtonState();
    }

    function updateProfileSummary() {
      const funnel = document.querySelector('input[name="funnelStage"]:checked')?.value;
      document.querySelector('#summaryCategory span').textContent = productCategory.value ? productCategory.options[productCategory.selectedIndex].text : '-';
      document.querySelector('#summaryFunnel span').textContent = funnel ? funnel.charAt(0).toUpperCase()+funnel.slice(1) : '-';
      document.querySelector('#summaryDemographic span').textContent = (ageRangeSelect.value && genderSelect.value) ? `${ageRangeSelect.value} · ${genderSelect.value}` : '-';
    }

    function getFieldText(id) { const el=document.getElementById(id); if(!el)return''; if(el.tagName==='SELECT')return el.options[el.selectedIndex]?.text||''; return el.value; }

    function updateDecisionLogic() {
      const category = productCategory?.value;
      const funnel = document.querySelector('input[name="funnelStage"]:checked')?.value||'';
      activeDecisionDisplay.textContent = category && funnel ? `${productCategory.options[productCategory.selectedIndex]?.text} • ${funnel.charAt(0).toUpperCase()+funnel.slice(1)}` : '-';
      decisionLogicText.innerHTML = '';
      const tags = [];
      if (category==='skincare'||category==='makeup') { const c=getFieldText('primaryConcern'),s=getFieldText('skinType'); if(c)tags.push(c+' focus'); if(s)tags.push(s+' skin'); }
      else if (category==='fragrance') { const m=getFieldText('fragranceMood'),sc=getFieldText('scentProfile'); if(m)tags.push(m+' mood'); if(sc)tags.push(sc+' scent'); }
      else if (category==='haircare') { const ht=getFieldText('hairType'),hc=getFieldText('hairConcern'); if(ht)tags.push(ht+' hair'); if(hc)tags.push(hc); }
      else if (category==='bodycare') { const bc=getFieldText('bodyConcern'),bf=getFieldText('bodyFormat'); if(bc)tags.push(bc); if(bf)tags.push(bf); }
      if (funnel==='awareness') tags.push('Educational hook');
      else if (funnel==='consideration') tags.push('Benefit focus');
      else if (funnel==='conversion') tags.push('Urgency/direct response');
      else if (funnel==='retention') tags.push('Loyalty messaging');
      tags.slice(0,4).forEach(tag => { const el=document.createElement('span'); el.className='logic-tag'; el.textContent=tag; decisionLogicText.appendChild(el); });
    }

    function updateVisualContent(productTypeVal) {
      const category = productCategory?.value;
      const funnel = document.querySelector('input[name="funnelStage"]:checked')?.value||'awareness';
      const occasionVal = occasion?.value||'';
      document.getElementById('mappingCategory').textContent = productCategory?.options[productCategory.selectedIndex]?.text||'Product';
      document.getElementById('mappingFunnel').textContent = funnel?funnel.charAt(0).toUpperCase()+funnel.slice(1):'-';
      let primaryAttr='', secondaryAttr='';
      if (category==='skincare'||category==='makeup') { primaryAttr=getFieldText('primaryConcern').split(' ')[0]||'Skincare'; secondaryAttr=getFieldText('skinType')||'All Skin'; }
      else if (category==='fragrance') { primaryAttr=getFieldText('fragranceMood')||'Romantic'; secondaryAttr=getFieldText('scentProfile')||'Floral'; }
      else if (category==='haircare') { primaryAttr=getFieldText('hairType')||'All Hair'; secondaryAttr=getFieldText('hairConcern')||'Care'; }
      else if (category==='bodycare') { primaryAttr=getFieldText('bodyConcern')||'Body Care'; secondaryAttr=getFieldText('bodyFormat')||'Lotion'; }
      document.getElementById('mappingConcern').textContent = primaryAttr||'-';
      document.getElementById('mappingSkin').textContent = secondaryAttr||'-';
      let scene='', badge=productTypeVal||'Product';
      if (category==='fragrance'){scene='Luxury fragrance';}
      else if (category==='haircare'){scene='Hair care';}
      else if (category==='bodycare'){scene='Body care';}
      else if (category==='makeup'){scene='Makeup';}
      else{scene='Skincare';}
      if (occasionVal==='gym') scene='Post-workout active';
      else if (occasionVal==='party') scene+=' · Evening glam';
      else if (occasionVal==='wedding') scene+=' · Bridal';
      if (funnel==='awareness') scene+=' · Soft natural light';
      else if (funnel==='conversion') scene+=' · Product focus';
      document.getElementById('visualCaption').textContent = scene;
      document.getElementById('luxeBadge').textContent = badge;
    }

    function setupSectionToggle(header, content) {
      const toggle = () => { const exp=header.getAttribute('aria-expanded')==='true'; header.classList.toggle('collapsed'); content.classList.toggle('collapsed'); header.setAttribute('aria-expanded',!exp); };
      header.addEventListener('click', toggle);
      header.addEventListener('keydown', e => { if (e.key==='Enter'||e.key===' ') { e.preventDefault(); toggle(); } });
    }

    async function runGeneration(payload) {
      generateCreativeSpinner.classList.remove('hidden'); generateCreativeSpinner.style.display = 'block';
      generateCreativeBtn.disabled = true;
      generationProgress.classList.remove('hidden'); generationProgress.style.display = 'block';
      progressBar.style.width = '0%';
      let progress = 0;
      const interval = setInterval(() => { progress += 2; if (progress <= 90) progressBar.style.width = progress + '%'; }, 500);
      try {
        if (!GPU_API_BASE) throw new Error('GPU server URL not yet loaded. Please wait a moment and try again.');
        payload = withAdCopyInPayload(payload);
        console.log('[COPY DEBUG] FINAL /generate payload.ad_copy (runGeneration):', payload && payload.ad_copy);
        const response = await fetchWithTimeout(`${GPU_API_BASE}/generate`, {
          method: 'POST', timeout: FETCH_TIMEOUT,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        clearInterval(interval); progressBar.style.width = '100%';
        if (!response.ok) { const err = await response.json().catch(() => ({})); throw new Error(err.detail || `Server error ${response.status}`); }
        const data = await response.json();
        if (data.files?.length > 0) {
          const fileUrl = `${GPU_API_BASE}${data.files[0]}`;
          lastGeneratedFileUrl = fileUrl;
          lastGeneratedFilename = data.files[0].split('/').pop() || 'beaulix-visual.jpg';

          // Save to history immediately using the direct Colab URL (runs in background)
          if (window.saveToHistory) {
            window.saveToHistory(fileUrl, payload).catch(e => { if (DEBUG) console.warn('History save error:', e); });
          }

          renderVisualContent(fileUrl, payload.output_type, () => runGeneration(payload));
        } else { throw new Error('No files returned from server'); }

        updateVisualContent(payload._productType || '');

        previewBox.style.display = 'none';
        generatedOutput.classList.remove('hidden'); generatedOutput.style.display = 'flex';

        // Delegate banner rendering to step2-module.js
        window.renderImprovementBanner?.({
          step2PredictionData,
          lastPredictionData,
          activeBenchmarks,
          improvementBanner,
          improvementDetails,
        });

        // Be honest about whether the uploaded product/logo actually steered
        // generation — never let the preview imply either was used when it wasn't.
        if (data.warning) {
          showToast(data.warning, 'info');
        } else if (payload.product_image_url && data.identity_applied === false) {
          showToast('Note: this creative was generated from the text description only — the uploaded product image could not be used this time.', 'info');
        } else if (payload.logo_image_url && data.logo_applied === true) {
          showToast('Brand logo applied.', 'success');
        } else if (payload.logo_image_url && data.logo_applied === false) {
          showToast('Logo stored — this generation mode does not currently apply logos.', 'info');
        } else {
          showToast(`${payload.output_type === 'video' ? 'Video' : 'Image'} generated successfully!`, 'success');
        }
      } catch (error) {
        clearInterval(interval);
        // A bare "Failed to fetch" means the browser couldn't complete the
        // request at all (most often a CORS rejection or a dead/expired
        // ngrok tunnel) — the raw browser message gives no useful detail,
        // so replace it with something actually actionable.
        const isOpaqueNetworkError = error instanceof TypeError && /failed to fetch/i.test(error.message || '');
        const displayMessage = isOpaqueNetworkError
          ? 'Could not reach the GPU server. This usually means the Colab tunnel has expired, or BEAULIX_FRONTEND_URL in Colab Secrets doesn\'t match this site\'s URL (CORS).'
          : error.message;
        showToast(`Error: ${displayMessage}`, 'error');
        visualContent.innerHTML = `<div class="image-error-box"><div class="error-icon">⚠️</div><p>${displayMessage}</p><small>Check that your Colab notebook is still running</small><button class="retry-btn" id="retryGenBtn">Retry</button></div>`;
        document.getElementById('retryGenBtn')?.addEventListener('click', () => runGeneration(payload));
        previewBox.style.display = 'none'; generatedOutput.classList.remove('hidden'); generatedOutput.style.display = 'flex'; downloadBtn.disabled = true;
      } finally {
        generateCreativeSpinner.classList.add('hidden'); generateCreativeSpinner.style.display = 'none'; generateCreativeBtn.disabled = false;
        generationProgress.classList.add('hidden'); generationProgress.style.display = 'none'; progressBar.style.width = '0%';
        updateGenerateButtonState();
      }
    }

    // ═══════════════════════════════════════════════════════════════════
    // CREATIVE VARIATIONS — the primary "Generate" action. Produces several
    // genuinely different creative concepts (composition/background/mood)
    // for the SAME uploaded product, same shade, and same selected style —
    // via multiple real requests to the GPU server (never faked). Each
    // result gets its own Creative ID for future consumer-response learning.
    // ═══════════════════════════════════════════════════════════════════
    const BEAULIX_VARIATION_COUNT = 3; // Restored: 3 sequential variations, same product/shade/style, different scene per STYLE_SCENE_VARIANTS.

    function uuidv4() {
      if (window.crypto?.randomUUID) return window.crypto.randomUUID();
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
      });
    }

    // ── Strategic creative concepts ───────────────────────────────────────
    // The 3 variations are no longer "same ad, different background" — each
    // index now maps to a distinct advertising CONCEPT (hero / lifestyle /
    // social), and the scene text below is written per style PER CONCEPT so
    // the three results read as three different creative directions rather
    // than three palette swaps. Product identity, shade, and the user's
    // selected brand style direction still stay fixed across all three —
    // only the concept (and the scene/composition that expresses it) changes.
    const VARIATION_CONCEPTS = [
      { key: 'hero',      label: 'Product Hero',     badge: '01 — PRODUCT HERO',    subtitle: 'Premium product-focused concept',    bestFor: 'Product launches & premium campaigns', directionTags: ['Product-first', null, 'Editorial'] },
      { key: 'lifestyle', label: 'Beauty Lifestyle', badge: '02 — BEAUTY LIFESTYLE', subtitle: 'Aspirational beauty/lifestyle concept', bestFor: 'Instagram & lifestyle campaigns',       directionTags: ['Human-led', null, 'Lifestyle'] },
      { key: 'social',    label: 'Social Concept',   badge: '03 — SOCIAL CONCEPT',   subtitle: 'Scroll-stopping social-first concept', bestFor: 'Reels & social discovery',              directionTags: ['Attention-grabbing', null, 'Experimental'] },
    ];

    // Static, canned one-line descriptions shown in the "Selected Direction"
    // panel (Select/Refine spec item 2). Deliberately NOT AI-generated —
    // reused verbatim per concept, sourced only from the existing concept
    // metadata above (key/badge/directionTags), never a new explanation system.
    const DIRECTION_DESCRIPTIONS = {
      hero:      'Keep the product at the center with a premium, composition-led treatment.',
      lifestyle: 'Keep the product integrated into a human-led beauty context.',
      social:    'Keep the scroll-stopping visual language while exploring a new execution.',
    };

    // Short tone word per brand style, dropped into the middle slot of each
    // concept's "Creative direction" tags below — this is what keeps those
    // tags honest for whichever style the user actually picked (e.g. a UGC
    // hero shot should not still read "Premium").
    const STYLE_TONE_WORD = {
      'luxury-elegant': 'Luxury',
      'modern-minimalist': 'Minimal',
      'editorial': 'Editorial',
      'bold-vibrant': 'Bold',
      'natural-organic': 'Natural',
      'glam-dramatic': 'Glam',
      'soft-romantic': 'Romantic',
      'ugc-inspired': 'UGC',
      '': 'Classic',
    };

    function getDirectionTags(conceptKey, brandStyle) {
      const concept = VARIATION_CONCEPTS.find(c => c.key === conceptKey);
      const toneWord = STYLE_TONE_WORD[brandStyle] || STYLE_TONE_WORD[''];
      return concept.directionTags.map(tag => tag === null ? toneWord : tag);
    }

    // Composition/mood language that reinforces each concept regardless of
    // brand style — layered on top of the per-style scene text below.
    const CONCEPT_COMPOSITION = {
      hero: 'sophisticated single-product hero composition, strong visual hierarchy, generous uncluttered negative space',
      lifestyle: 'believable lifestyle framing, product naturally integrated into the scene, warm emotional feel',
      social: 'bold scroll-stopping composition, distinctive off-center crop, strong visual hook',
    };

    // Per-style scene text, one entry per concept (hero, lifestyle, social —
    // same order as VARIATION_CONCEPTS). Each style has to describe all
    // three concepts differently — this is what stops the batch collapsing
    // back into "same ad, three backgrounds".
    const STYLE_SCENE_VARIANTS = {
      'luxury-elegant': [
        'polished marble pedestal, soft gold accent light, minimal luxury backdrop',
        'elegant vanity table at golden hour, silk robe draped nearby, luxurious getting-ready moment',
        'dark velvet backdrop, single dramatic spotlight, bold editorial close-up crop',
      ],
      'modern-minimalist': [
        'plain white seamless backdrop, soft even studio light, single clean product placement',
        'minimalist bathroom counter, natural window light, everyday routine moment',
        'pale grey backdrop with subtle shadow, bold off-center crop, clean modern social hook',
      ],
      'editorial': [
        'architectural concrete backdrop, directional hard light, confident editorial hero shot',
        'fashion-editorial styled room, soft directional window light, high-fashion getting-ready moment',
        'colour-blocked paper set, bold graphic shadows, dynamic off-center crop',
      ],
      'bold-vibrant': [
        'saturated color-block backdrop, punchy contrast lighting, product-forward hero framing',
        'vibrant colorful room, energetic natural light, playful beauty-routine lifestyle moment',
        'neon-toned gradient backdrop, high-energy off-kilter crop, pop-art inspired social hook',
      ],
      'natural-organic': [
        'natural linen surface, soft daylight from a window, clean botanical hero styling',
        'sunlit bathroom with greenery, relaxed skincare-routine moment, organic lifestyle feel',
        'raw wood surface with dried botanicals, candid handheld framing, earthy scroll-stopping shot',
      ],
      'glam-dramatic': [
        'black glossy surface, dramatic rim lighting, high-glam hero product shot',
        'glamorous vanity mirror with warm bulbs, getting-ready-for-a-night-out moment',
        'deep jewel-tone backdrop, mirrored reflections, bold glam close-up crop',
      ],
      'soft-romantic': [
        'blush pastel backdrop, soft diffused light, delicate hero product styling',
        'dreamy bedroom vanity with sheer curtains, soft romantic morning-routine moment',
        'pale pink silk surface, gentle glow, tender close-up crop designed for social sharing',
      ],
      'ugc-inspired': [
        'clean bathroom counter, natural window light, simple honest product-forward shot',
        'cozy bedroom vanity, warm authentic lighting, casual beauty-routine moment',
        'handheld phone-selfie mirror framing, natural daylight, candid authentic social moment',
      ],
      '': [
        'clean studio backdrop, soft even lighting, simple confident hero framing',
        'neutral home setting, natural light, believable everyday routine moment',
        'simple gradient backdrop, bold off-center crop, attention-grabbing social framing',
      ],
    };

    function getSceneVariant(brandStyle, index) {
      const list = STYLE_SCENE_VARIANTS[brandStyle] || STYLE_SCENE_VARIANTS[''];
      return list[index % list.length];
    }

    function getConceptMeta(index, conceptKeyOverride) {
      if (conceptKeyOverride) {
        return VARIATION_CONCEPTS.find(c => c.key === conceptKeyOverride) || VARIATION_CONCEPTS[index % VARIATION_CONCEPTS.length];
      }
      return VARIATION_CONCEPTS[index % VARIATION_CONCEPTS.length];
    }

    // Same as buildSilentPrompt() but swaps in a different background/
    // composition phrase per variantIndex so variations are genuinely
    // different rather than near-duplicates, while product identity, shade
    // and brand style direction remain identical across all variations.
    function buildVariantPrompt(variantIndex) {
      const base = buildSilentPrompt();
      const brandStyle = brandStyleSelect?.value || '';
      const variant = getSceneVariant(brandStyle, variantIndex);
      const concept = getConceptMeta(variantIndex);
      // Combine the per-style scene text with the concept's composition
      // language so the concept (hero/lifestyle/social) is expressed on
      // top of the chosen brand style, not instead of it.
      const sceneAndComposition = `${variant}, ${CONCEPT_COMPOSITION[concept.key]}`;
      const hasUploadedProduct = window._beaulixAssets?.product?.status === 'ready';
      if (hasUploadedProduct) {
        // Replace the generic negative-space phrase with this variant's
        // background/composition direction (still leaves open space for
        // the real product to be composited in afterwards).
        return base.replace(
          'elegant product display surface, clean open negative space at lower-center for product placement, no product objects in frame',
          `${sceneAndComposition}, clean open negative space at lower-center for product placement, no product objects in frame`
        );
      }
      // No uploaded product photo: swap the closing "studio hero shot,
      // isolated" phrase for the scene variant instead.
      if (base.includes('studio hero shot, isolated')) {
        return base.replace('studio hero shot, isolated', sceneAndComposition);
      }
      return `${base}, ${sceneAndComposition}`;
    }

    // ── Refinement executions ("Create More Like This") ──────────────────
    // These vary environment / composition / camera angle / props / mood
    // WITHOUT changing which concept (hero/lifestyle/social) is being
    // expressed — that's what keeps a refinement batch "more Product Hero
    // shots", not a random mix of concepts. Layered on top of the same
    // per-style, per-concept base scene + composition text used for the
    // original 3 concepts, so brand style and concept direction still hold.
    const REFINEMENT_EXECUTION_VARIANTS = {
      hero: [
        'overhead flat-lay angle, minimal supporting props, crisp shadow',
        'eye-level three-quarter angle, single complementary prop, soft rim light',
        'low straight-on angle, subtle reflective surface, warm accent light',
      ],
      lifestyle: [
        'over-the-shoulder candid angle, soft morning light, relaxed everyday props nearby',
        'close-up hands-in-frame angle, warm afternoon light, styled vanity props',
        'wide environmental angle, soft evening ambient light, cozy lived-in props',
      ],
      social: [
        'extreme close-up crop, handheld tilt, bold graphic supporting prop',
        'top-down flat-lay crop, punchy accent prop, high-contrast light',
        'dynamic diagonal crop, energetic framing, playful supporting prop',
      ],
    };

    function getRefinementExecution(conceptKey, variantIndex) {
      const list = REFINEMENT_EXECUTION_VARIANTS[conceptKey] || REFINEMENT_EXECUTION_VARIANTS.hero;
      return list[variantIndex % list.length];
    }

    // Same layering as buildVariantPrompt, but the concept is FIXED (the one
    // the user selected) and only the execution slice varies per index —
    // this is what makes a refinement batch "3 more Product Hero shots"
    // rather than 3 fresh, potentially-different concepts.
    function buildRefinementPrompt(conceptKey, variantIndex) {
      const base = buildSilentPrompt();
      const brandStyle = brandStyleSelect?.value || '';
      const conceptIndex = VARIATION_CONCEPTS.findIndex(c => c.key === conceptKey);
      const styleBaseScene = getSceneVariant(brandStyle, conceptIndex === -1 ? 0 : conceptIndex);
      const execution = getRefinementExecution(conceptKey, variantIndex);
      const sceneAndComposition = `${styleBaseScene}, ${CONCEPT_COMPOSITION[conceptKey] || ''}, ${execution}`;
      const hasUploadedProduct = window._beaulixAssets?.product?.status === 'ready';
      if (hasUploadedProduct) {
        return base.replace(
          'elegant product display surface, clean open negative space at lower-center for product placement, no product objects in frame',
          `${sceneAndComposition}, clean open negative space at lower-center for product placement, no product objects in frame`
        );
      }
      if (base.includes('studio hero shot, isolated')) {
        return base.replace('studio hero shot, isolated', sceneAndComposition);
      }
      return `${base}, ${sceneAndComposition}`;
    }

    // ── Select/Refine spec: the four simple "Refinements" choices ─────────
    // Deliberately small and non-technical (spec item 3/4) — no prompt box,
    // no AI controls. Each choice maps to a short, human-readable phrase
    // layered onto the SAME base scene/composition text already used by
    // buildRefinementPrompt above, so the underlying generation pipeline
    // (payload shape, /generate call, product/logo compositing) is untouched.
    const REFINEMENT_CHOICE_DEFAULTS = {
      productFocus: 'balanced',
      visualTreatment: 'keep',
      composition: 'keep',
      setting: 'keep',
    };

    const PRODUCT_FOCUS_PHRASES = {
      'more-product': 'product shown larger and sharper in frame, more product-forward crop',
      'balanced': '',
      'more-environment': 'richer environmental context and styling around the product, product slightly smaller in frame',
    };

    const VISUAL_TREATMENT_PHRASES = {
      'keep': '',
      'more-premium': 'elevated premium finish, refined luxury styling, polished high-end look',
      'more-experimental': 'bolder experimental art direction, unexpected creative styling',
    };

    // Builds one new "Create More Like This" execution using the user's
    // four Refinements choices (spec item 3), on top of the SAME concept,
    // brand style and per-style base scene as buildRefinementPrompt() —
    // the concept itself never changes, only the described execution.
    function buildRefinementPromptFromChoices(conceptKey, choices, seedIndex) {
      const base = buildSilentPrompt();
      const brandStyle = brandStyleSelect?.value || '';
      const conceptIndex = VARIATION_CONCEPTS.findIndex(c => c.key === conceptKey);
      const safeIndex = conceptIndex === -1 ? 0 : conceptIndex;

      // Setting: "Keep Setting" reuses the exact same base scene as the
      // original concept; "New Setting" swaps in a different scene variant
      // from the same per-style pool used everywhere else in the app.
      const sceneList = STYLE_SCENE_VARIANTS[brandStyle] || STYLE_SCENE_VARIANTS[''];
      const styleBaseScene = choices.setting === 'new'
        ? sceneList[(safeIndex + 1 + (seedIndex || 0)) % sceneList.length]
        : getSceneVariant(brandStyle, safeIndex);

      // Composition: "Keep Composition" uses only the concept's baseline
      // composition language; "New Composition" layers on one of the
      // existing execution-angle phrases (same pool "Create More Like
      // This" has always drawn from) for a genuinely different framing.
      const compositionPhrase = choices.composition === 'new'
        ? getRefinementExecution(conceptKey, seedIndex || 0)
        : '';

      const parts = [
        styleBaseScene,
        CONCEPT_COMPOSITION[conceptKey] || '',
        compositionPhrase,
        PRODUCT_FOCUS_PHRASES[choices.productFocus] || '',
        VISUAL_TREATMENT_PHRASES[choices.visualTreatment] || '',
      ].filter(Boolean);
      const sceneAndComposition = parts.join(', ');

      const hasUploadedProduct = window._beaulixAssets?.product?.status === 'ready';
      if (hasUploadedProduct) {
        return base.replace(
          'elegant product display surface, clean open negative space at lower-center for product placement, no product objects in frame',
          `${sceneAndComposition}, clean open negative space at lower-center for product placement, no product objects in frame`
        );
      }
      if (base.includes('studio hero shot, isolated')) {
        return base.replace('studio hero shot, isolated', sceneAndComposition);
      }
      return `${base}, ${sceneAndComposition}`;
    }

    // Reads the four Refinements <select> controls (spec item 3), falling
    // back to the documented defaults (Balanced / Keep Direction / Keep
    // Composition / Keep Setting) if a control is missing for any reason.
    function getRefinementChoices() {
      const read = (id, key) => document.getElementById(id)?.value || REFINEMENT_CHOICE_DEFAULTS[key];
      return {
        productFocus: read('refineProductFocus', 'productFocus'),
        visualTreatment: read('refineVisualTreatment', 'visualTreatment'),
        composition: read('refineComposition', 'composition'),
        setting: read('refineSetting', 'setting'),
      };
    }

    function resetRefinementChoicesUi() {
      const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
      set('refineProductFocus', REFINEMENT_CHOICE_DEFAULTS.productFocus);
      set('refineVisualTreatment', REFINEMENT_CHOICE_DEFAULTS.visualTreatment);
      set('refineComposition', REFINEMENT_CHOICE_DEFAULTS.composition);
      set('refineSetting', REFINEMENT_CHOICE_DEFAULTS.setting);
    }

    // ═══════════════════════════════════════════════════════════════════
    // PURPOSEFUL "Create Variation" ROLES (Step 3) — three fixed, explicit
    // dimensions (composition / lighting & environment / art direction).
    // Distinct from REFINEMENT_EXECUTION_VARIANTS above (used only by the
    // separate "Create More Like This" flow): here each of the 3 children
    // changes exactly ONE named dimension, everything else — concept,
    // product, brand style, format/platform — stays identical to the
    // parent, so the user can look at all three and immediately understand
    // *why* each one is different.
    // ═══════════════════════════════════════════════════════════════════
    const VARIATION_ROLES = ['composition', 'lighting', 'art_direction'];

    const ROLE_META = {
      composition:   { label: 'COMPOSITION',    explanation: 'Same concept with a new product composition.' },
      lighting:      { label: 'LIGHTING',       explanation: 'Same concept with a different lighting and environment treatment.' },
      art_direction: { label: 'ART DIRECTION',  explanation: 'Same concept with elevated editorial art direction.' },
    };

    // Number of distinct scene-text variants available for a given role —
    // used only to pick a genuinely different execution when learning from
    // a winning variation (spec STEP 8: never reproduce the winner's exact
    // image). Composition depends on aspect ratio but every ratio list is
    // the same length, so a fixed default is safe here.
    function getRoleVariantListLength(role, aspectRatio) {
      if (role === 'composition') return (COMPOSITION_BY_RATIO[aspectRatio] || COMPOSITION_BY_RATIO['1:1']).length;
      if (role === 'art_direction') return ART_DIRECTION_VARIANTS.length;
      return (LIGHTING_BY_CATEGORY.default).length; // lighting: every category list is this length
    }

    // VARIATION 01 — COMPOSITION: product position, camera framing, crop,
    // negative space, scale. The product itself and the lighting/scene mood
    // are NOT touched here. Platform-aware (spec item 6) because "framing"
    // means something different in a 9:16 story crop vs a 16:9 banner.
    const COMPOSITION_BY_RATIO = {
      '4:5': [
        'tighter product-forward crop filling more of the vertical frame, shallow depth of field',
        'wider feed framing with generous clean uncluttered space above the product',
        'product shifted off-center within the vertical frame, asymmetric negative space',
      ],
      '9:16': [
        'close vertical crop with the product in the lower third, tall clean open space above',
        'full-height vertical framing with the product centered, balanced top and bottom margin',
        'product placed high in the vertical frame with sweeping clean open space below',
      ],
      '1:1': [
        'centered square composition with the product filling the middle third',
        'wider square framing with even negative space on all sides',
        'product placed in one square-grid third, diagonal clean open space',
      ],
      '16:9': [
        'wide landscape framing with the product positioned in one horizontal third, clean open space',
        'centered landscape hero composition, symmetric negative space on either side',
        'product scaled smaller within a wide landscape frame, sweeping clean open space',
      ],
    };
    function getCompositionVariant(aspectRatio, regenIndex) {
      const list = COMPOSITION_BY_RATIO[aspectRatio] || COMPOSITION_BY_RATIO['1:1'];
      return list[regenIndex % list.length];
    }

    // VARIATION 02 — LIGHTING & ENVIRONMENT: beauty-category-aware (spec
    // item 5) — skincare leans clean/vanity/daylight, makeup leans
    // studio/editorial, etc. Composition and concept stay as the parent's.
    const LIGHTING_BY_CATEGORY = {
      skincare: [
        'soft natural daylight through a window, clean bathroom-vanity environment, hydrated fresh visual language',
        'bright premium clinical-editorial lighting, minimal sink/vanity backdrop, crisp clean mood',
        'warm golden-hour daylight, sunlit vanity surface, calm skincare-routine atmosphere',
      ],
      makeup: [
        'controlled beauty-studio lighting with a soft key light, cosmetic-vanity backdrop, true-to-shade color rendering',
        'warm luxury lighting with a gentle glow, premium fashion-beauty environment',
        'editorial makeup lighting with a crisp rim light, sophisticated studio backdrop',
      ],
      fragrance: [
        'warm ambient evening light, elegant vanity surface, luxurious getting-ready mood',
        'soft directional studio light, minimal reflective surface, refined premium atmosphere',
        'golden-hour daylight through sheer curtains, romantic sunlit environment',
      ],
      haircare: [
        'bright natural daylight, clean bathroom environment, fresh haircare-routine mood',
        'warm studio lighting, soft backdrop, glossy healthy-hair atmosphere',
        'soft window light, lived-in vanity environment, relaxed everyday mood',
      ],
      bodycare: [
        'soft natural daylight, spa-like bathroom environment, relaxed self-care mood',
        'warm studio lighting, clean minimal backdrop, fresh premium atmosphere',
        'gentle diffused light, calm textured surface, soothing body-care mood',
      ],
      default: [
        'soft natural daylight, clean premium environment, fresh visual language',
        'controlled studio lighting, minimal elevated backdrop, confident premium mood',
        'warm ambient lighting, subtle lifestyle environment, inviting atmosphere',
      ],
    };
    function getLightingVariant(category, regenIndex) {
      const list = LIGHTING_BY_CATEGORY[category] || LIGHTING_BY_CATEGORY.default;
      return list[regenIndex % list.length];
    }

    // VARIATION 03 — ART DIRECTION: the most noticeably different of the
    // three, but still layered on top of the parent's own scene/composition
    // language so it reads as a premium beauty variation of the same
    // creative — never an unrelated ad (spec item 1).
    const ART_DIRECTION_VARIANTS = [
      'sophisticated editorial-photography treatment, refined styling and color grading',
      'elevated luxury cosmetic-photography treatment, refined premium art direction',
      'minimalist premium-studio treatment, restrained high-end gallery styling',
      'fashion-beauty editorial-photography treatment, elevated premium styling',
    ];
    function getArtDirectionVariant(regenIndex) {
      return ART_DIRECTION_VARIANTS[regenIndex % ART_DIRECTION_VARIANTS.length];
    }

    // Builds the prompt for one role-based "Create Variation" child. Unlike
    // buildRefinementPrompt() above (used only by "Create More Like This"),
    // this changes exactly ONE explicit dimension per call — the parent's
    // concept, brand style, product identity, and everything else in
    // buildSilentPrompt() stay fixed. Product pixels themselves are never
    // regenerated: only the surrounding scene text changes (spec item 3).
    function buildRoleVariantPrompt(conceptKey, role, aspectRatio, regenIndex = 0) {
      const base = buildSilentPrompt();
      const brandStyle = brandStyleSelect?.value || '';
      const conceptIndex = VARIATION_CONCEPTS.findIndex(c => c.key === conceptKey);
      const styleBaseScene = getSceneVariant(brandStyle, conceptIndex === -1 ? 0 : conceptIndex);
      const conceptComposition = CONCEPT_COMPOSITION[conceptKey] || '';
      const category = productCategory?.value || 'default';

      let roleText;
      if (role === 'composition') {
        // Keep the parent's own lighting/environment scene; only add a
        // framing/crop instruction. The product itself is not touched.
        roleText = `${styleBaseScene}, ${conceptComposition}, ${getCompositionVariant(aspectRatio, regenIndex)}`;
      } else if (role === 'lighting') {
        // Keep the parent's composition language; swap in a beauty-aware
        // lighting/environment phrase.
        roleText = `${conceptComposition}, ${getLightingVariant(category, regenIndex)}`;
      } else {
        // art_direction — bigger swing, still anchored to the parent's own
        // scene/composition so it stays a variation, not a new ad.
        roleText = `${styleBaseScene}, ${conceptComposition}, ${getArtDirectionVariant(regenIndex)}`;
      }

      const hasUploadedProduct = window._beaulixAssets?.product?.status === 'ready';
      if (hasUploadedProduct) {
        return base.replace(
          'elegant product display surface, clean open negative space at lower-center for product placement, no product objects in frame',
          `${roleText}, clean open negative space at lower-center for product placement, no product objects in frame`
        );
      }
      if (base.includes('studio hero shot, isolated')) {
        return base.replace('studio hero shot, isolated', roleText);
      }
      return `${base}, ${roleText}`;
    }

    // ═══════════════════════════════════════════════════════════════════
    // STEP 10 — HISTORICAL LEARNING -> FUTURE GENERATION STRATEGY.
    // Turns the SAME real, ACTUAL-performance dataset Beaulix Creative
    // Learning already aggregates into a concrete 3-slot generation
    // strategy: a "learned direction" (strongest historical concept), a
    // "learned optimization" (strongest historical variation
    // characteristic, applied to a different, compatible concept), and a
    // genuine "exploration" slot. Never invents a pattern that isn't
    // backed by real saved performance — mirrors the exact tie/threshold
    // rules refreshCreativeLearning already uses, and never touches the
    // product-fidelity pipeline (only the surrounding scene/style prompt
    // text changes below).
    // ═══════════════════════════════════════════════════════════════════

    // Honest, non-statistical confidence label (spec: "LEARNING
    // CONFIDENCE") — describes how much real data currently backs the
    // strategy, never dresses up a small sample as certainty.
    function creativeLearningConfidenceLabel(n) {
      if (n < 3) return 'early signal';
      if (n < 8) return 'emerging pattern';
      return 'consistent historical pattern';
    }

    // Strongest historically-supported creative DIRECTION (hero /
    // lifestyle / social) by average CTR, reusing the exact same grouping
    // helper the Beaulix Creative Learning panel already uses. Returns
    // null unless there's a clear (non-tied) winner among >=2 directions.
    function computeHistoricalConceptWinner(records) {
      const result = computeCategoryWinner(records, 'ctr', r => r.performance, r => r.creativeType);
      if (!result || result.tie) return null;
      const concept = VARIATION_CONCEPTS.find(c => c.key === result.item.creativeType);
      if (!concept) return null;
      const n = records.filter(r => r.creativeType === concept.key && isFiniteNum(calcRealMetrics(r.performance).ctr)).length;
      return { concept, ctr: result.value, n };
    }

    // Strongest historically-supported variation CHARACTERISTIC
    // (composition / lighting / art direction) by average CTR among
    // recorded role-based variations. Returns null unless there's a clear
    // winner among >=2 recorded roles (the "original" bucket is not a
    // characteristic on its own).
    function computeHistoricalCharacteristicWinner(records) {
      const roleRecords = records.filter(r => r.variationRole && ROLE_META[r.variationRole]);
      const result = computeCategoryWinner(roleRecords, 'ctr', r => r.performance, r => r.variationRole);
      if (!result || result.tie) return null;
      const role = result.item.variationRole;
      const n = roleRecords.filter(r => r.variationRole === role && isFiniteNum(calcRealMetrics(r.performance).ctr)).length;
      return { role, ctr: result.value, n };
    }

    // "Current campaign" signal (spec: "CURRENT CAMPAIGN VS HISTORICAL
    // LEARNING") — the strongest concept among the batch of cards already
    // on screen for THIS product, if any of them already have real
    // recorded performance. MUST be read before the grid is cleared for
    // a new batch, so callers should invoke this before wiping the grid.
    async function computeCurrentSessionConceptWinner() {
      try {
        const grid = document.getElementById('creativeVariationsGrid');
        if (!grid) return null;
        const cards = Array.from(grid.querySelectorAll(':scope > .variation-card'));
        if (!cards.length) return null;
        const ids = cards.map(c => c.dataset.creativeId).filter(Boolean);
        if (!ids.length) return null;
        const perfMap = await window.getCreativePerformanceBatch?.(ids) || {};
        const rows = cards
          .map(c => ({ creativeType: c.dataset.conceptKey, performance: perfMap[c.dataset.creativeId]?.performance }))
          .filter(r => r.performance && ['impressions', 'clicks', 'conversions'].some(k => isFiniteNum(r.performance[k])));
        if (rows.length < 2) return null;
        const result = computeCategoryWinner(rows, 'ctr', r => r.performance, r => r.creativeType);
        if (!result || result.tie) return null;
        const concept = VARIATION_CONCEPTS.find(c => c.key === result.item.creativeType);
        return concept ? { concept, ctr: result.value } : null;
      } catch (e) {
        console.warn('[Beaulix] current-session learning check failed (non-blocking, falls back to historical):', e);
        return null;
      }
    }

    // Builds the full learning strategy for a product's next generation
    // batch, or null when there is NO real historical data at all yet
    // (spec: "NO HISTORICAL DATA" -> keep the normal 3-concept generation
    // behavior, never invent learning). Whenever >=2 real historical
    // records exist, a strategy IS returned — with directionWinner and/or
    // characteristicWinner set to null when that particular signal isn't
    // clear yet, so the UI can always show WHY each slot is what it is,
    // rather than silently falling all the way back the moment only one
    // of the two signals is available.
    async function computeGenerationLearningStrategy(productId) {
      if (!productId) return null;
      const historicalRecords = await fetchHistoricalPerformanceRecords(productId);
      if (historicalRecords.length < 2) return null;

      const historicalConceptWinner = computeHistoricalConceptWinner(historicalRecords);
      const characteristicWinner = computeHistoricalCharacteristicWinner(historicalRecords);
      const currentWinner = await computeCurrentSessionConceptWinner();
      // Current, actual, in-flight campaign performance for THIS product
      // takes priority over older historical performance when both exist.
      const directionWinner = currentWinner || historicalConceptWinner;

      return {
        directionWinner,
        characteristicWinner,
        usedCurrentSignal: !!currentWinner,
        confidence: creativeLearningConfidenceLabel(historicalRecords.length),
        sampleSize: historicalRecords.length,
      };
    }

    // Structured, minimal learning context — this is the actual object
    // that gets attached to the generation request payload (spec:
    // "CRITICAL GENERATION REQUIREMENT"). Deliberately small and
    // pre-summarized (never the raw historical records) so nothing more
    // than the learned pattern itself reaches the generation request.
    function buildHistoricalLearningPayload(strategy) {
      if (!strategy) return null;
      return {
        topCreativeDirection: strategy.directionWinner ? {
          key: strategy.directionWinner.concept.key,
          label: strategy.directionWinner.concept.badge.replace(/^\d+\s*—\s*/, '').replace(/\b\w/g, ch => ch.toUpperCase()),
          ctr: strategy.directionWinner.ctr,
        } : null,
        topVariationCharacteristic: strategy.characteristicWinner ? {
          role: strategy.characteristicWinner.role,
          label: ROLE_META[strategy.characteristicWinner.role]?.label || strategy.characteristicWinner.role,
          ctr: strategy.characteristicWinner.ctr,
        } : null,
        metrics: {
          topDirectionCTR: strategy.directionWinner ? strategy.directionWinner.ctr : null,
          topCharacteristicCTR: strategy.characteristicWinner ? strategy.characteristicWinner.ctr : null,
        },
        sampleSize: strategy.sampleSize,
        confidence: strategy.confidence,
        usedCurrentCampaignSignal: strategy.usedCurrentSignal,
      };
    }

    // Turns a computed learning strategy into 3 concrete generation slots
    // — one per VARIATION_CONCEPTS-length card. Each slot changes only the
    // creative environment/composition/art-direction prompt text; product
    // pixels, shade, and packaging are never touched here (buildVariantPrompt
    // and buildRoleVariantPrompt both preserve the same product-fidelity
    // negative-space anchor used by every other generation path).
    //
    // Slots are ALWAYS labeled 01/02/03 whenever this is called (i.e.
    // whenever there is any real historical data at all) — even if one of
    // the two signals (direction / characteristic) isn't clear yet, in
    // which case that slot falls back to a sensible default concept and
    // says so honestly in its explanation, rather than the whole batch
    // silently losing its labels.
    function buildLearningSlots(strategy, aspectRatio) {
      const hasDirection = !!strategy.directionWinner;
      const hasCharacteristic = !!strategy.characteristicWinner;

      const directionConcept = hasDirection ? strategy.directionWinner.concept : VARIATION_CONCEPTS[0];
      const remaining = VARIATION_CONCEPTS.filter(c => c.key !== directionConcept.key);
      const optimizationConcept = remaining[0] || directionConcept;
      const explorationConcept = remaining[1] || remaining[0] || directionConcept;
      const role = hasCharacteristic ? strategy.characteristicWinner.role : VARIATION_ROLES[0];
      const directionLabel = directionConcept.badge.replace(/^\d+\s*—\s*/, '').replace(/\b\w/g, ch => ch.toUpperCase());

      return [
        {
          conceptKey: directionConcept.key,
          // A NEW execution of the learned direction — same concept, but
          // an elevated art-direction treatment layered on top, so this
          // is never a duplicate of the historical winner's image.
          prompt: buildRoleVariantPrompt(directionConcept.key, 'art_direction', aspectRatio, 1),
          strategyType: 'learned_direction',
          strategyLabel: 'LEARNED DIRECTION',
          strategyExplanation: hasDirection
            ? `Influenced by stronger ${strategy.usedCurrentSignal ? 'current-campaign' : 'historical'} CTR for ${directionLabel}.`
            : `Not enough recorded data yet to identify a stronger direction — using ${directionLabel} as the default while more campaign data is collected.`,
        },
        {
          conceptKey: optimizationConcept.key,
          // Learned characteristic (composition/lighting/art direction)
          // applied to a DIFFERENT, compatible concept than the direction
          // slot above, so the batch reads as 3 distinct directions.
          prompt: buildRoleVariantPrompt(optimizationConcept.key, role, aspectRatio, 0),
          strategyType: 'learned_optimization',
          strategyLabel: 'LEARNED OPTIMIZATION',
          strategyExplanation: hasCharacteristic
            ? `Uses ${ROLE_META[role]?.label || role} based on stronger recorded variation performance.`
            : `Not enough recorded variation-level data yet to identify a stronger characteristic — using a ${ROLE_META[role]?.label || role} treatment as the default.`,
        },
        {
          conceptKey: explorationConcept.key,
          // Genuine exploration — the one remaining concept, generated
          // through its own normal (non-learned) prompt path.
          prompt: buildVariantPrompt(Math.max(0, VARIATION_CONCEPTS.findIndex(c => c.key === explorationConcept.key))),
          strategyType: 'exploration',
          strategyLabel: 'EXPLORATION',
          strategyExplanation: 'Exploration concept designed to test a different creative direction.',
        },
      ];
    }

    async function requestGenerationOnce(payload) {
      payload = withAdCopyInPayload(payload);
      console.log('[COPY DEBUG] FINAL /generate payload.ad_copy:', payload && payload.ad_copy);
      // Stage 1: payload
      console.log('[Beaulix] (1) generation payload:', payload);

      if (!GPU_API_BASE) {
        console.error('[Beaulix] (2) GPU_API_BASE is not set — request never leaves the browser.');
        throw new Error('GPU server URL not yet loaded. Please wait a moment and try again.');
      }
      const endpoint = `${GPU_API_BASE}/generate`;
      console.log('[Beaulix] (2) GPU endpoint:', endpoint);

      // Preflight /health check — fast (8s) and near-instant if the server
      // is actually up. This is what tells us WHICH failure mode we're in:
      // if this itself fails, the tunnel/server is genuinely unreachable; if
      // it succeeds but /generate below still times out, the server is up
      // but slow (most commonly: first request after a restart still
      // loading the SDXL pipeline onto the GPU, which can take 1-3 minutes
      // by itself and is unrelated to the ~20-30s steady-state generation time).
      try {
        const healthRes = await fetchWithTimeout(`${GPU_API_BASE}/health`, {
          timeout: HEALTH_CHECK_TIMEOUT,
          headers: { 'ngrok-skip-browser-warning': 'true' },
        });
        console.log(`[Beaulix] (2b) /health check: status ${healthRes.status}`);
        if (!healthRes.ok) {
          throw new Error(`GPU server /health returned status ${healthRes.status} — the tunnel is up but the server process itself is reporting unhealthy. Check the Colab cell output.`);
        }
      } catch (healthError) {
        console.error('[Beaulix] (2b) /health check failed — server/tunnel is genuinely unreachable:', healthError);
        throw new Error(`GPU server is unreachable (health check failed: ${healthError.message}). The ngrok tunnel is likely dead or config/gpu has a stale URL — check the Colab cell is still running.`);
      }

      let response;
      const startedAt = performance.now();
      try {
        // Stage 3: bounded request. Generous timeout to allow for first-call
        // model loading, but still bounded so the UI can't hang forever.
        response = await fetchWithTimeout(endpoint, {
          method: 'POST', timeout: IMAGE_GENERATION_TIMEOUT,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      } catch (networkError) {
        // We already confirmed /health responded above, so a failure here
        // means the server accepted the connection but didn't finish
        // generating within the timeout — most likely still loading the
        // model on a fresh restart, or a genuinely slow/stuck generation.
        console.error(`[Beaulix] (3) /generate request failed after ${Math.round(performance.now() - startedAt)}ms (server IS reachable — /health succeeded):`, networkError);
        throw new Error(`GPU server is reachable but /generate didn't finish within ${Math.round(IMAGE_GENERATION_TIMEOUT / 1000)}s (${networkError.message}). If the Colab cell just (re)started, the SDXL pipeline may still be loading onto the GPU — check the Colab output and try again in a minute or two.`);
      }
      console.log(`[Beaulix] (4) GPU server responded: status ${response.status} after ${Math.round(performance.now() - startedAt)}ms`);

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        console.error('[Beaulix] (4) GPU server returned an error body:', err);
        throw new Error(err.detail || `Server error ${response.status}`);
      }

      // Stage 5: parse
      let data;
      try {
        data = await response.json();
      } catch (parseError) {
        console.error('[Beaulix] (5) response body was not valid JSON:', parseError);
        throw new Error('GPU server returned a response the frontend could not parse (not valid JSON).');
      }
      console.log('[Beaulix] (5) parsed response body:', data);

      if (!(data.files?.length > 0)) {
        console.error('[Beaulix] (5) response parsed fine but contained no files:', data);
        throw new Error('No files returned from server');
      }

      // Stage 6/7: the actual compositing happens server-side (GPU) before
      // this response is sent — by the time we're here the composited file
      // already exists at this URL; we just need to fetch its bytes next.
      const fileUrl = `${GPU_API_BASE}${data.files[0]}`;
      const filename = data.files[0].split('/').pop() || 'beaulix-visual.jpg';
      console.log('[Beaulix] (6/7) composited file URL to fetch:', fileUrl);
      return { fileUrl, filename, data };
    }

    // ═══════════════════════════════════════════════════════════════════
    // STEP 4 — CREATIVE PERFORMANCE & LEARNING FOUNDATION. Real, manually
    // entered campaign results only — NOTHING here is fabricated. Metrics
    // are derived purely from what the user typed in; a metric is simply
    // omitted (never shown as "0" or "--") when its inputs are missing.
    // ═══════════════════════════════════════════════════════════════════

    function isFiniteNum(v) { return typeof v === 'number' && Number.isFinite(v); }

    // Parses one performance form's raw string inputs into numbers/null.
    // Blank string -> null (field left empty), NaN passes through so the
    // caller's validation can catch it rather than silently coercing to 0.
    function parsePerformanceInput(raw) {
      const toNum = (v) => (v === '' || v === undefined || v === null) ? null : Number(v);
      return {
        impressions: toNum(raw.impressions),
        clicks:      toNum(raw.clicks),
        conversions: toNum(raw.conversions),
        spend:       toNum(raw.spend),
        revenue:     toNum(raw.revenue),
      };
    }

    // Validation (spec item 14). Returns an error string, or null if valid.
    // Impressions/Clicks/Conversions are the required core of a performance
    // record (spend/revenue stay optional per spec item 1).
    function validatePerformanceInput(perf) {
      const required = ['impressions', 'clicks', 'conversions'];
      for (const key of required) {
        if (perf[key] === null) return `${key[0].toUpperCase()}${key.slice(1)} is required.`;
        if (Number.isNaN(perf[key])) return `${key[0].toUpperCase()}${key.slice(1)} must be a number.`;
        if (perf[key] < 0) return `${key[0].toUpperCase()}${key.slice(1)} cannot be negative.`;
      }
      for (const key of ['spend', 'revenue']) {
        if (perf[key] !== null && (Number.isNaN(perf[key]) || perf[key] < 0)) {
          return `${key[0].toUpperCase()}${key.slice(1)} cannot be negative.`;
        }
      }
      if (perf.clicks > perf.impressions) return 'Clicks cannot exceed impressions.';
      if (perf.conversions > perf.clicks) return 'Conversions cannot exceed clicks.';
      return null;
    }

    // Calculates ONLY the metrics whose required inputs actually exist
    // (spec item 2) — never invents a value, never shows "--" as if it
    // were a real zero.
    function calcRealMetrics(perf) {
      if (!perf) return {};
      const { impressions, clicks, conversions, spend, revenue } = perf;
      const m = {};
      if (isFiniteNum(impressions) && isFiniteNum(clicks) && impressions > 0) m.ctr = (clicks / impressions) * 100;
      if (isFiniteNum(clicks) && isFiniteNum(conversions) && clicks > 0) m.cvr = (conversions / clicks) * 100;
      if (isFiniteNum(spend) && isFiniteNum(clicks) && clicks > 0) m.cpc = spend / clicks;
      if (isFiniteNum(spend) && isFiniteNum(conversions) && conversions > 0) m.cpa = spend / conversions;
      if (isFiniteNum(spend) && isFiniteNum(revenue) && spend > 0) m.roas = revenue / spend;
      return m;
    }

    function formatMetric(key, value) {
      if (key === 'ctr' || key === 'cvr') return `${value.toFixed(1)}%`;
      if (key === 'roas') return `${value.toFixed(1)}x`;
      return `$${value.toFixed(2)}`;
    }

    const METRIC_LABELS = { ctr: 'CTR', cvr: 'CVR', cpc: 'CPC', cpa: 'CPA', roas: 'ROAS' };

    // Two numeric metric values only count as "tied" when they're equal
    // within a small, explicit rounding tolerance — never from comparing
    // display strings, and never from raw floating point equality (which
    // is too strict and can miss legitimate near-ties from rounding).
    const METRIC_TIE_TOLERANCE = 0.005;
    function metricsAreTied(a, b) {
      return Math.abs(a - b) <= METRIC_TIE_TOLERANCE;
    }

    // A tie must reflect what the user actually SEES, not raw floating
    // point closeness. ROAS is displayed rounded to a whole "x" (formatMetric),
    // so two raw values like 2.96 and 3.04 both display as "3x" but sit
    // outside METRIC_TIE_TOLERANCE — that previously let the raw-value
    // comparison silently pick one of them as a "unique" winner even
    // though the Performance Decision card (and Creative Performance
    // table) shows both at the identical "3x". Tie detection for any
    // metric a person can see must therefore be based on the same rounded
    // value formatMetric() renders, not the unrounded number underneath.
    function metricsAreTiedForDisplay(key, a, b) {
      return formatMetric(key, a) === formatMetric(key, b);
    }

    // ── STEP 4: Smart Performance Decision helpers ──────────────────────
    // Generic "best by metric" computation, reused by both the Beaulix
    // Performance Decision panel (session rows) and Beaulix Creative
    // Learning (cross-session records). Only ever looks at real, saved
    // ACTUAL performance — never AI estimates. Returns:
    //   null                → no row has this metric at all
    //   { tie: true }        → 2+ rows share the same top value
    //   { tie:false, label, value, item } → a single clear winner
    function computeCategoryWinner(rows, metricKey, getPerf, getLabel) {
      const withVal = rows
        .map(item => ({ item, v: calcRealMetrics(getPerf(item))[metricKey] }))
        .filter(x => isFiniteNum(x.v));
      if (!withVal.length) return null;
      const max = Math.max(...withVal.map(x => x.v));
      const winners = withVal.filter(x => metricsAreTiedForDisplay(metricKey, x.v, max));
      if (winners.length > 1) {
        // Preserve which labels are tied (deduped) so callers that need to
        // name the tied parties can — e.g. "X and Y recorded the highest
        // ROAS" — without recomputing the winner set themselves.
        const tieLabels = [...new Set(winners.map(w => getLabel(w.item)))];
        return { tie: true, value: max, tieLabels };
      }
      return { tie: false, label: getLabel(winners[0].item), value: max, item: winners[0].item };
    }

    // Compact "PERFORMANCE" block markup for one card. `record` is either
    // null (nothing saved yet — spec item 8) or the stored
    // { performance: {...} } doc from getCreativePerformance/Batch.
    function renderPerformanceSectionHtml(record) {
      const perf = record?.performance;
      const hasAny = perf && ['impressions', 'clicks', 'conversions'].some(k => isFiniteNum(perf[k]));
      if (!hasAny) {
        return `
          <div class="variation-performance">
            <span class="vp-label">PERFORMANCE</span>
            <span class="vp-empty">No data yet</span>
            <button type="button" class="vp-toggle-btn">Add Performance Data</button>
          </div>`;
      }
      const metrics = calcRealMetrics(perf);
      const rows = Object.keys(METRIC_LABELS)
        .filter(k => metrics[k] !== undefined)
        .map(k => `<span class="vp-metric"><span class="vp-metric-label">${METRIC_LABELS[k]}</span><span class="vp-metric-value">${formatMetric(k, metrics[k])}</span></span>`)
        .join('');
      const counts = `<span class="vp-counts">${isFiniteNum(perf.clicks) ? `${perf.clicks} clicks` : ''}${isFiniteNum(perf.conversions) ? ` · ${perf.conversions} conversions` : ''}</span>`;
      return `
        <div class="variation-performance has-data">
          <span class="vp-label">PERFORMANCE <span class="vp-actual-tag">ACTUAL</span></span>
          <div class="vp-metrics">${rows || '<span class="vp-empty">Not enough data for a rate yet — raw counts below.</span>'}</div>
          ${counts}
          <button type="button" class="vp-toggle-btn">Edit Data</button>
        </div>`;
    }

    // AI ESTIMATE block — kept visually and structurally separate from the
    // ACTUAL PERFORMANCE block above (spec item 12). Populated only from
    // the real /predict response already computed once per batch (see
    // generateCreativeVariations) — this is NOT campaign data and is
    // always labeled as an estimate, never implied to be the real result.
    function renderAiEstimateHtml(estimate) {
      if (!estimate) return '';
      const metrics = [];
      if (isFiniteNum(estimate.ctr)) metrics.push({ label: 'CTR', value: `${estimate.ctr.toFixed(1)}%` });
      if (isFiniteNum(estimate.conversion)) metrics.push({ label: 'Conversion', value: `${estimate.conversion.toFixed(1)}%` });
      if (isFiniteNum(estimate.engagement)) metrics.push({ label: 'Engagement', value: `${estimate.engagement.toFixed(1)}%` });
      if (!metrics.length) return '';
      // Legacy .vae-row spans are kept (hidden via CSS) so any code that
      // still reads that markup keeps working; the visible UI is the
      // compact metric row below.
      const legacyRows = metrics.map(m => `<span class="vae-row">${escapeHtml(m.label)} est. ${escapeHtml(m.value)}</span>`).join('');
      return `
        <div class="variation-ai-estimate">
          <span class="vae-label">AI INSIGHT</span>
          <div class="vae-metrics-row">${metrics.map(m => `<span class="vae-metric"><span class="vae-metric-value">${escapeHtml(m.value)}</span><span class="vae-metric-label">${escapeHtml(m.label)}</span></span>`).join('')}</div>
          ${legacyRows}
        </div>`;
    }

    // Renders the small inline entry form used by both "Add Performance
    // Data" and "Edit Data" — pre-filled with any existing values so
    // editing doesn't require re-typing everything.
    function renderPerformanceFormHtml(existingPerf) {
      const v = (k) => existingPerf && isFiniteNum(existingPerf[k]) ? existingPerf[k] : '';
      return `
        <div class="variation-performance-form">
          <span class="vp-label">PERFORMANCE DATA</span>
          <div class="vpf-grid">
            <label>Impressions<input type="number" min="0" step="1" class="vpf-impressions" value="${v('impressions')}" required></label>
            <label>Clicks<input type="number" min="0" step="1" class="vpf-clicks" value="${v('clicks')}" required></label>
            <label>Conversions<input type="number" min="0" step="1" class="vpf-conversions" value="${v('conversions')}" required></label>
            <label>Spend ($, optional)<input type="number" min="0" step="0.01" class="vpf-spend" value="${v('spend')}"></label>
            <label>Revenue ($, optional)<input type="number" min="0" step="0.01" class="vpf-revenue" value="${v('revenue')}"></label>
          </div>
          <span class="vpf-error hidden"></span>
          <div class="vpf-actions">
            <button type="button" class="vpf-save">Save</button>
            <button type="button" class="vpf-cancel">Cancel</button>
          </div>
        </div>`;
    }

    // Wires the "Add Performance Data" / "Edit Data" toggle and Save/Cancel
    // for one card. Persists via window.saveCreativePerformance (registered
    // by cloudinary-module.js) using the SAME creativeId/lineage fields
    // already tracked on cardState — no separate identity system (spec item 3).
    function wirePerformancePanel(cardEl, cardState) {
      const perfEl = cardEl.querySelector('.variation-performance');
      if (!perfEl) return;

      const meta = {
        creativeId:       cardState.creativeId,
        parentCreativeId: cardState.parentCreativeId || null,
        creativeVersion:  cardState.creativeVersion || 1,
        variationRole:    cardState.variationRole || null,
        productId:        window.getStableProductId ? window.getStableProductId() : (window._beaulixAssets?.product?.url || null),
        creativeType:     cardState.conceptKey || getConceptMeta(cardState.index, cardState.conceptKey).key,
        style:            cardState.style,
        format:           cardState.format,
      };

      function openForm(existingPerf) {
        const formEl = document.createElement('div');
        formEl.innerHTML = renderPerformanceFormHtml(existingPerf);
        const formNode = formEl.firstElementChild;
        cardEl.querySelector('.variation-performance')?.replaceWith(formNode);

        formNode.querySelector('.vpf-cancel').addEventListener('click', () => {
          formNode.replaceWith(buildPerfNode());
        });
        formNode.querySelector('.vpf-save').addEventListener('click', async () => {
          const errEl = formNode.querySelector('.vpf-error');
          const raw = {
            impressions: formNode.querySelector('.vpf-impressions').value,
            clicks:      formNode.querySelector('.vpf-clicks').value,
            conversions: formNode.querySelector('.vpf-conversions').value,
            spend:       formNode.querySelector('.vpf-spend').value,
            revenue:     formNode.querySelector('.vpf-revenue').value,
          };
          const perf = parsePerformanceInput(raw);
          const error = validatePerformanceInput(perf);
          if (error) {
            errEl.textContent = error;
            errEl.classList.remove('hidden');
            return;
          }
          errEl.classList.add('hidden');
          const saveBtn = formNode.querySelector('.vpf-save');
          saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
          try {
            await window.saveCreativePerformance?.(meta, perf);
            cardEl._perfCache = { performance: perf };
            formNode.replaceWith(buildPerfNode());
            showToast('Performance data saved', 'success');
            refreshPerformanceComparison();
          } catch (e) {
            errEl.textContent = `Could not save: ${e.message}`;
            errEl.classList.remove('hidden');
            saveBtn.disabled = false; saveBtn.textContent = 'Save';
          }
        });
      }

      function buildPerfNode() {
        const wrap = document.createElement('div');
        wrap.innerHTML = renderPerformanceSectionHtml(cardEl._perfCache);
        const node = wrap.firstElementChild;
        node.querySelector('.vp-toggle-btn').addEventListener('click', () => openForm(cardEl._perfCache?.performance || null));
        return node;
      }

      perfEl.querySelector('.vp-toggle-btn')?.addEventListener('click', () => openForm(cardEl._perfCache?.performance || null));

      // Best-effort: load any previously saved performance for this
      // creativeId (e.g. after a page refresh re-renders the card fresh —
      // though the grid itself isn't currently persisted across reloads,
      // this keeps the panel correct if the card is re-wired later).
      window.getCreativePerformance?.(cardState.creativeId).then(record => {
        if (record) {
          cardEl._perfCache = record;
          cardEl.querySelector('.variation-performance')?.replaceWith(buildPerfNode());
        }
      }).catch(() => {});
    }

    // Builds one <tr> for the comparison table (spec item 2), only filling
    // cells whose underlying real data actually exists. `strongestKey`
    // (optional) marks which metric column to visually highlight for this
    // row group, e.g. the highest CTR within a variation group.
    function buildTableRow({ label, sub, record, strongestKeys, selected }) {
      const perf = record?.performance || {};
      const m = calcRealMetrics(perf);
      const cell = (key, raw, fmt) => {
        if (!isFiniteNum(raw) && raw !== 0) return `<td class="pc-cell-na">—</td>`;
        const cls = strongestKeys?.has(key) ? ' pc-cell-strongest' : '';
        return `<td class="${cls.trim()}">${fmt ? fmt(raw) : raw}</td>`;
      };
      return `<tr class="${selected ? 'pc-row-selected' : ''}">
        <td class="pc-cell-label">${selected ? '<span class="pc-selected-tag" title="Currently selected concept">✓ Selected</span> ' : ''}${escapeHtml(label)}${sub ? `<div style="font-weight:400;font-size:0.68rem;color:var(--text-light);">${escapeHtml(sub)}</div>` : ''}</td>
        ${cell('impressions', perf.impressions)}
        ${cell('ctr', m.ctr, v => formatMetric('ctr', v))}
        ${cell('conversions', perf.conversions)}
        ${cell('cvr', m.cvr, v => formatMetric('cvr', v))}
        ${cell('spend', perf.spend, v => `$${v.toFixed(2)}`)}
        ${cell('roas', m.roas, v => formatMetric('roas', v))}
      </tr>`;
    }

    function keysWithStrongest(rows, key, getVal) {
      const withVal = rows.filter(r => isFiniteNum(getVal(r)));
      if (withVal.length < 2) return new Map(); // "strongest" only means something with 2+ real values
      const max = Math.max(...withVal.map(getVal));
      const out = new Map();
      withVal.forEach(r => { if (getVal(r) === max) { if (!out.has(r)) out.set(r, new Set()); out.get(r).add(key); } });
      return out;
    }

    // Merges per-row strongest-metric maps (one per metric key) into a
    // single Set-per-row lookup so buildTableRow can mark multiple
    // highlighted cells in one row.
    function mergeStrongest(rows, metricDefs) {
      const perRow = new Map(rows.map(r => [r, new Set()]));
      metricDefs.forEach(({ key, getVal }) => {
        const marks = keysWithStrongest(rows, key, getVal);
        marks.forEach((keys, row) => keys.forEach(k => perRow.get(row).add(k)));
      });
      return perRow;
    }

    // Simple, transparent data-quality label (spec item 8) — never
    // presented as statistical confidence, just how much real data backs
    // the comparison currently on screen.
    function renderConfidenceBadge(recordCount) {
      if (recordCount < 2) return `<span class="pc-confidence pc-confidence-limited">Limited data · more data needed</span>`;
      return `<span class="pc-confidence pc-confidence-ok">Data available · based on recorded campaign results</span>`;
    }

    // Fetches ALL historical, real-performance creativePerformance records
    // for a product (across every past session/campaign) — the SAME
    // dataset Beaulix Creative Learning already relies on. Extracted so a
    // caller that needs this data (e.g. refreshPerformanceComparison) can
    // fetch it once and hand it off to refreshCreativeLearning instead of
    // querying the database twice for the same records.
    async function fetchHistoricalPerformanceRecords(productId) {
      console.log('[Beaulix] Historical performance query — productId:', productId);
      let records = [];
      try {
        records = await window.getProductCreativePerformance?.(productId) || [];
      } catch (e) {
        console.warn('[Beaulix] Historical performance query failed:', e);
      }
      console.log('[Beaulix] Historical performance query — records returned:', records.length);
      records = records.filter(r => r?.performance && ['impressions', 'clicks', 'conversions'].some(k => isFiniteNum(r.performance[k])));
      console.log('[Beaulix] Historical performance query — records with real performance data:', records.length);
      return records;
    }

    // Sums raw counts across multiple historical performance records — only
    // fields that are actually present as real numbers get summed (never
    // invents a value nobody recorded). calcRealMetrics still derives every
    // rate (CTR/CVR/ROAS) from these summed counts — nothing is hardcoded.
    function sumPerformanceRecords(perfs) {
      const fields = ['impressions', 'clicks', 'conversions', 'spend', 'revenue'];
      const sums = {};
      fields.forEach(f => {
        const vals = perfs.map(p => p?.[f]).filter(isFiniteNum);
        if (vals.length) sums[f] = vals.reduce((a, b) => a + b, 0);
      });
      return sums;
    }

    // Aggregates historical ACTUAL campaign records by creative direction
    // (hero / lifestyle / social) so the Creative Performance table can show
    // real past results even when the creatives on screen right now (this
    // session) have no performance data of their own yet.
    function aggregateHistoricalByCreativeType(records) {
      const groups = new Map();
      records.forEach(r => {
        const concept = VARIATION_CONCEPTS.find(c => c.key === r.creativeType);
        if (!concept) return;
        if (!groups.has(concept.key)) groups.set(concept.key, { concept, perfs: [] });
        groups.get(concept.key).perfs.push(r.performance);
      });
      return VARIATION_CONCEPTS
        .map(concept => groups.get(concept.key))
        .filter(Boolean)
        .map(({ concept, perfs }) => ({
          label: concept.badge,
          sub: `${perfs.length} recorded campaign${perfs.length === 1 ? '' : 's'}`,
          record: { performance: sumPerformanceRecords(perfs) },
        }));
    }

    // ── Performance comparison across creatives/variations (spec items
    // 5/6/7/8) — reads ONLY real saved performance records via
    // getCreativePerformanceBatch; shows the "not enough data" state until
    // real numbers exist, and never labels anything "best" from AI alone.
    async function refreshPerformanceComparison() {
      const section = document.getElementById('performanceComparisonSection');
      const body = document.getElementById('performanceComparisonBody');
      if (!section || !body) return;

      const grid = document.getElementById('creativeVariationsGrid');
      if (!grid) return;
      const parentCards = Array.from(grid.querySelectorAll(':scope > .variation-card'));
      if (!parentCards.length) { section.classList.add('hidden'); return; }

      const allIds = [];
      const parentInfo = parentCards.map(pc => {
        const wrapper = pc._childWrapperEl;
        const children = wrapper ? Array.from(wrapper.querySelectorAll('.variation-card')) : [];
        allIds.push(pc.dataset.creativeId, ...children.map(c => c.dataset.creativeId));
        return { cardEl: pc, children };
      });

      let perfMap = {};
      try {
        perfMap = await window.getCreativePerformanceBatch?.(allIds) || {};
      } catch (e) {
        console.warn('[Beaulix] performance comparison fetch failed:', e);
      }

      const hasRealData = (record) => record?.performance && ['impressions', 'clicks', 'conversions'].some(k => isFiniteNum(record.performance[k]));
      const anyData = Object.values(perfMap).some(hasRealData);

      // Same historical dataset Beaulix Creative Learning already queries
      // (getProductCreativePerformance, scoped to this product's stable
      // productId) — fetched once here and handed to refreshCreativeLearning
      // below so both sections stay in sync from a single query.
      const productId = window.getStableProductId ? window.getStableProductId() : (window._beaulixAssets?.product?.url || null);
      const historicalRecords = productId ? await fetchHistoricalPerformanceRecords(productId) : [];
      const historicalRows = historicalRecords.length ? aggregateHistoricalByCreativeType(historicalRecords) : [];

      section.classList.remove('hidden');
      if (!anyData && !historicalRows.length) {
        body.innerHTML = `<div class="pc-empty">Add campaign performance data to compare creatives.<span class="pc-empty-sub">Add real performance data to compare your creatives and discover what resonates.</span></div>`;
        renderPerformanceInsights([]);
        refreshCreativeLearning(historicalRecords, []);
        return;
      }

      const TABLE_HEAD = `<thead><tr>
        <th>Creative</th><th>Impressions</th><th>CTR</th><th>Conversions</th><th>CVR</th><th>Spend</th><th>ROAS</th>
      </tr></thead>`;

      let html = '';
      const allRealRows = []; // flat list across everything, used for the winner picker
      // Same underlying creative can legitimately appear in TWO different
      // display groups above (once as a top-level "concept" row, e.g.
      // "Beauty Lifestyle", and again as the "Original" row inside its own
      // variation-comparison group) — both read the exact same performance
      // record. If both copies were pushed into allRealRows, the winner
      // picker would see two rows tied at the same value for the same
      // underlying data point and incorrectly report a "tie" even when
      // there is a single, clear winner. Dedupe by creative id so each
      // real creative is only ever counted once; prefer the more specific
      // variation-level label ("Original"/"Lighting"/etc.) over the generic
      // concept badge when both exist for the same id.
      const allRealRowsById = new Map();
      function pushRealRow(row, preferOverExisting) {
        const id = row.cardEl?.dataset?.creativeId;
        if (id && allRealRowsById.has(id)) {
          if (!preferOverExisting) return;
          const existing = allRealRowsById.get(id);
          const idx = allRealRows.indexOf(existing);
          if (idx !== -1) allRealRows.splice(idx, 1, row);
          allRealRowsById.set(id, row);
          return;
        }
        allRealRows.push(row);
        if (id) allRealRowsById.set(id, row);
      }

      // ── CREATIVE PERFORMANCE — across the top-level concepts ──
      const conceptRows = parentInfo
        .map(({ cardEl }) => ({
          label: cardEl.querySelector('.variation-concept-badge')?.textContent || cardEl.dataset.creativeId,
          sub: [cardEl.dataset.creativeType, cardEl.dataset.style].filter(Boolean).join(' · '),
          record: perfMap[cardEl.dataset.creativeId],
          cardEl,
        }))
        .filter(r => hasRealData(r.record));
      if (conceptRows.length) {
        conceptRows.forEach(r => pushRealRow({ ...r, conceptLabel: r.label, isRoleVariation: false }, false));
        const strongest = mergeStrongest(conceptRows, [
          { key: 'ctr',         getVal: r => calcRealMetrics(r.record.performance).ctr },
          { key: 'conversions', getVal: r => r.record.performance.conversions },
          { key: 'cvr',         getVal: r => calcRealMetrics(r.record.performance).cvr },
          { key: 'roas',        getVal: r => calcRealMetrics(r.record.performance).roas },
        ]);
        html += `<div class="pc-group"><span class="pc-group-title">CREATIVE PERFORMANCE <span class="pc-source-tag">Based on actual campaign data</span>${renderConfidenceBadge(conceptRows.length)}</span>
          <div class="pc-table-wrap"><table class="pc-table">${TABLE_HEAD}<tbody>
            ${conceptRows.map(r => buildTableRow({ ...r, strongestKeys: strongest.get(r), selected: r.cardEl?.classList.contains('is-selected') })).join('')}
          </tbody></table></div>`;

        // Global insight across the top-level concepts (associative language only).
        const withConv = conceptRows.filter(r => isFiniteNum(r.record.performance.conversions));
        if (withConv.length >= 2) {
          const sorted = [...withConv].sort((a, b) => b.record.performance.conversions - a.record.performance.conversions);
          const best = sorted[0], worst = sorted[sorted.length - 1];
          if (best.label !== worst.label && best.record.performance.conversions !== worst.record.performance.conversions) {
            html += `<div class="pc-insight">${escapeHtml(best.label)} generated more conversions than ${escapeHtml(worst.label)}.</div>`;
          }
        } else {
          html += `<div class="pc-insight">Not enough data to compare conversions yet.</div>`;
        }
        html += `</div>`;
      } else if (historicalRows.length) {
        // None of the creatives currently on screen (this session) have
        // performance data of their own yet, but this product DOES have
        // real recorded campaign history — show that instead of an empty
        // state (spec: Step 9D). Aggregated by creative direction from the
        // SAME historical records refreshCreativeLearning already queries.
        const strongest = mergeStrongest(historicalRows, [
          { key: 'ctr',         getVal: r => calcRealMetrics(r.record.performance).ctr },
          { key: 'conversions', getVal: r => r.record.performance.conversions },
          { key: 'cvr',         getVal: r => calcRealMetrics(r.record.performance).cvr },
          { key: 'roas',        getVal: r => calcRealMetrics(r.record.performance).roas },
        ]);
        html += `<div class="pc-group"><span class="pc-group-title">CREATIVE PERFORMANCE <span class="pc-source-tag">Based on actual recorded campaign data</span>${renderConfidenceBadge(historicalRecords.length)}</span>
          <div class="pc-table-wrap"><table class="pc-table">${TABLE_HEAD}<tbody>
            ${historicalRows.map(r => buildTableRow({ ...r, strongestKeys: strongest.get(r) })).join('')}
          </tbody></table></div>`;

        // These aggregated historical-by-creative-type rows ARE the real
        // performance data visibly shown in the table above — they must
        // feed the Beaulix Performance Decision panel too (allRealRows),
        // otherwise that panel can wrongly claim "no performance data"
        // while this very table displays real recorded numbers.
        historicalRows.forEach(r => pushRealRow({ ...r, conceptLabel: r.label, isRoleVariation: false }, false));

        const withConv = historicalRows.filter(r => isFiniteNum(r.record.performance.conversions));
        if (withConv.length >= 2) {
          const sorted = [...withConv].sort((a, b) => b.record.performance.conversions - a.record.performance.conversions);
          const best = sorted[0], worst = sorted[sorted.length - 1];
          if (best.label !== worst.label && best.record.performance.conversions !== worst.record.performance.conversions) {
            html += `<div class="pc-insight">${escapeHtml(best.label)} generated more conversions than ${escapeHtml(worst.label)}.</div>`;
          }
        } else {
          html += `<div class="pc-insight">Not enough data to compare conversions yet.</div>`;
        }
        html += `</div>`;
      }

      // ── VARIATION COMPARISON — per parent that has role-based children (spec item 5) ──
      parentInfo.forEach(({ cardEl, children }) => {
        if (!children.length) return;
        const parentRecord = perfMap[cardEl.dataset.creativeId];
        const conceptBadge = (cardEl.querySelector('.variation-concept-badge')?.textContent || '').split(' · ')[0];
        const rows = [];
        if (hasRealData(parentRecord)) rows.push({ label: 'Original', record: parentRecord, cardEl, conceptLabel: conceptBadge, isRoleVariation: false });
        children.forEach(childEl => {
          const record = perfMap[childEl.dataset.creativeId];
          if (!hasRealData(record)) return;
          const role = childEl.dataset.variationRole;
          rows.push({ label: ROLE_META[role]?.label || 'Variation', record, cardEl: childEl, conceptLabel: conceptBadge, isRoleVariation: true, role });
        });
        if (rows.length < 2) return; // nothing meaningful to compare yet (spec item 4 applies per-group too)
        // These rows are the authoritative, most-specific-label copy of
        // each creative in this group (they carry the concept name too),
        // so they should win over any earlier generic concept-level copy
        // of the SAME id pushed above.
        rows.forEach(r => pushRealRow(r, true));
        const strongest = mergeStrongest(rows, [
          { key: 'ctr',         getVal: r => calcRealMetrics(r.record.performance).ctr },
          { key: 'conversions', getVal: r => r.record.performance.conversions },
          { key: 'cvr',         getVal: r => calcRealMetrics(r.record.performance).cvr },
          { key: 'roas',        getVal: r => calcRealMetrics(r.record.performance).roas },
        ]);
        html += `<div class="pc-group"><span class="pc-group-title">${escapeHtml(conceptBadge)} — VARIATION COMPARISON <span class="pc-source-tag">Based on actual campaign data</span>${renderConfidenceBadge(rows.length)}</span>
          <div class="pc-table-wrap"><table class="pc-table">${TABLE_HEAD}<tbody>
            ${rows.map(r => buildTableRow({ ...r, strongestKeys: strongest.get(r) })).join('')}
          </tbody></table></div>`;

        // Insight (spec item 5/7) — associative language only, no causal claims.
        const withCtr = rows.filter(r => calcRealMetrics(r.record.performance).ctr !== undefined);
        if (withCtr.length >= 2) {
          const sorted = [...withCtr].sort((a, b) => calcRealMetrics(b.record.performance).ctr - calcRealMetrics(a.record.performance).ctr);
          const best = sorted[0], worst = sorted[sorted.length - 1];
          if (best.label !== worst.label && calcRealMetrics(best.record.performance).ctr !== calcRealMetrics(worst.record.performance).ctr) {
            html += `<div class="pc-insight">Among the ${escapeHtml(conceptBadge)} variants with recorded campaign data, the ${escapeHtml(best.label)} received the highest CTR.</div>`;
          }
        } else {
          html += `<div class="pc-insight">Not enough data to compare this metric yet.</div>`;
        }
        html += `</div>`;
      });

      body.innerHTML = html || `<div class="pc-empty">Add campaign performance data to compare creatives.<span class="pc-empty-sub">Add real performance data to compare your creatives and discover what resonates.</span></div>`;

      renderPerformanceInsights(allRealRows);

      // Step 5 also refreshes the cross-session "Beaulix Creative Learning"
      // panel every time real performance changes — reuses the SAME
      // historical records already fetched above instead of querying twice.
      // allRealRows is passed as the CANONICAL row set: it's the exact
      // same rows (same labels, same summed/raw performance numbers)
      // rendered in the Creative Performance table above, so the "highest
      // ROAS/CTR/CVR" statements Creative Learning makes are guaranteed to
      // match what's on screen instead of being recomputed from a
      // differently-scoped query.
      refreshCreativeLearning(historicalRecords, allRealRows);
    }
    // Best-performer hierarchy (spec item 3): ROAS (needs spend+revenue) is
    // preferred when at least 2 rows have it, else CVR, else CTR. Never
    // forces a metric that lacks real data, and never picks a winner from
    // a tie. Returns { row, metricKey, tie:false } | { tie:true, metricKey }
    // | null (not enough data at all).
    function computeBestPerformer(rows) {
      const tiers = [
        { key: 'roas', getVal: r => calcRealMetrics(r.record.performance).roas },
        { key: 'cvr',  getVal: r => calcRealMetrics(r.record.performance).cvr },
        { key: 'ctr',  getVal: r => calcRealMetrics(r.record.performance).ctr },
      ];
      // When a tier is tied, fall through to the NEXT tier in the same
      // fixed, existing priority (ROAS > CVR > CTR) — narrowed to only the
      // tied rows — to break it, rather than declaring a tie immediately.
      // This never invents a new metric (still only roas/cvr/ctr, in the
      // same order already used elsewhere), and if a later tier does
      // resolve it, `tieBrokenBy` records what was tied and on what value
      // so the caller can state the reason explicitly instead of silently
      // presenting the resolved row as though there was never a tie.
      let candidateRows = rows;
      let tieBrokenBy = null;
      for (const { key, getVal } of tiers) {
        const withVal = candidateRows.filter(r => isFiniteNum(getVal(r)));
        if (withVal.length < 2) continue;
        const max = Math.max(...withVal.map(getVal));
        const winners = withVal.filter(r => metricsAreTiedForDisplay(key, getVal(r), max));
        if (winners.length > 1) {
          tieBrokenBy = { metricKey: key, value: max, tiedRows: winners };
          candidateRows = winners;
          continue;
        }
        return {
          row: winners[0],
          metricKey: key,
          tie: false,
          tieBrokenBy: (tieBrokenBy && tieBrokenBy.metricKey !== key) ? tieBrokenBy : null,
        };
      }
      if (tieBrokenBy) return { tie: true, metricKey: tieBrokenBy.metricKey };
      return null;
    }

    // "BEAULIX PERFORMANCE DECISION" (spec STEP 4) — replaces the old
    // single-metric "Top observed" picker. Shows up to three independent
    // category winners (Return / Engagement / Conversion), each only when
    // its underlying real data exists, plus one "Recommended Next
    // Direction" chosen via a fixed, transparent priority
    // (ROAS > CVR > CTR). Reads ONLY the real rows already assembled by
    // refreshPerformanceComparison — never AI estimates, never a hidden
    // arbitrary score.
    function renderPerformanceInsights(allRealRows) {
      const section = document.getElementById('performanceInsightsSection');
      const body = document.getElementById('performanceInsightsBody');
      if (!section || !body) return;
      section.classList.remove('hidden');

      if (!allRealRows.length) {
        body.innerHTML = `<div class="pi-empty">No campaign data yet</div>`;
        return;
      }
      if (allRealRows.length < 2) {
        body.innerHTML = `<div class="pi-empty"><span class="pi-section-label">PERFORMANCE SIGNAL</span>More campaign data is needed before identifying a meaningful performance pattern.</div>`;
        return;
      }

      const getPerf = r => r.record.performance;
      const getLabel = r => r.label;

      // Titles name the actual metric being shown (spec: "BEST BY
      // ENGAGEMENT"/"BEST BY CONVERSION" were ambiguous — the card always
      // displayed CTR / CVR respectively, so the label now says so).
      const categories = [
        { key: 'roas', icon: '🏆', title: 'BEST BY ROAS',            unit: 'ROAS' },
        { key: 'ctr',  icon: '📈', title: 'BEST BY CTR',             unit: 'CTR' },
        { key: 'cvr',  icon: '🎯', title: 'BEST BY CONVERSION RATE', unit: 'CVR' },
      ].map(c => ({ ...c, result: computeCategoryWinner(allRealRows, c.key, getPerf, getLabel) }))
        .filter(c => c.result); // only show a category when the required data exists

      const cardsHtml = categories.map(c => {
        if (c.result.tie) {
          // Name every tied creative rather than an unlabeled "tied"
          // message — never arbitrarily present one of them as the winner.
          return `<div class="pd-card">
            <span class="pd-cat-label">${c.icon} ${c.title}</span>
            <div class="pd-cat-name">${escapeHtml(c.result.tieLabels.join(' & '))}</div>
            <div class="pd-cat-value">${c.unit}: ${formatMetric(c.key, c.result.value)}</div>
          </div>`;
        }
        return `<div class="pd-card">
          <span class="pd-cat-label">${c.icon} ${c.title}</span>
          <div class="pd-cat-name">${escapeHtml(c.result.label)}</div>
          <div class="pd-cat-value">${c.unit}: ${formatMetric(c.key, c.result.value)}</div>
        </div>`;
      }).join('');

      let html = cardsHtml ? `<div class="pd-grid">${cardsHtml}</div>` : '';

      // ── RECOMMENDED NEXT DIRECTION — priority: ROAS, then CVR, then CTR ──
      const result = computeBestPerformer(allRealRows);
      if (!result) {
        html += `<div class="pi-empty"><span class="pi-section-label">PERFORMANCE SIGNAL</span>More campaign data is needed before identifying a meaningful performance pattern.</div>`;
        body.innerHTML = html;
        return;
      }
      if (result.tie) {
        html += `<div class="pi-empty"><span class="pi-section-label">PERFORMANCE SIGNAL</span>Top creative directions currently share the highest recorded ${escapeHtml(METRIC_LABELS[result.metricKey] || result.metricKey)}. More campaign data is needed before identifying a meaningful performance pattern.</div>`;
        body.innerHTML = html;
        return;
      }

      const { row, metricKey, tieBrokenBy } = result;
      const m = calcRealMetrics(row.record.performance);
      const metricsHtml = Object.keys(METRIC_LABELS).filter(k => m[k] !== undefined)
        .map(k => `<span><b>${METRIC_LABELS[k]}</b> ${formatMetric(k, m[k])}</span>`).join('');

      const metricPhrase = { roas: 'ROAS', cvr: 'conversion rate', ctr: 'CTR' }[metricKey];

      // If an earlier tier (e.g. ROAS) was actually tied and this
      // recommendation was only resolved by falling through to the next
      // metric in the SAME existing priority order, say so explicitly
      // rather than silently presenting the resolved row as a clean,
      // unique winner on the tied metric.
      const tieBreakNote = tieBrokenBy
        ? `<div class="pi-learned">${escapeHtml(tieBrokenBy.tiedRows.map(r => getLabel(r)).join(' and '))} were tied on ${METRIC_LABELS[tieBrokenBy.metricKey]} (${formatMetric(tieBrokenBy.metricKey, tieBrokenBy.value)}); ${escapeHtml(row.label)} is recommended based on the higher ${METRIC_LABELS[metricKey]} (${formatMetric(metricKey, m[metricKey])}) among the tied creatives.</div>`
        : '';

      // Build the extra learning lines dynamically from the SAME per-category
      // winners computed above — never hardcoded — so we can call out when
      // a different row wins a different category (e.g. Original has the
      // best conversion rate even though a variation is the overall
      // recommendation) without ever mislabeling which row achieved what.
      const roasWinner = categories.find(c => c.key === 'roas' && !c.result.tie);
      const ctrWinner  = categories.find(c => c.key === 'ctr'  && !c.result.tie);
      const cvrWinner  = categories.find(c => c.key === 'cvr'  && !c.result.tie);
      const extraLines = [];
      if (row.isRoleVariation && roasWinner && ctrWinner && roasWinner.result.label === row.label && ctrWinner.result.label === row.label) {
        extraLines.push(`${escapeHtml(row.label)} variation generated the highest ROAS (${formatMetric('roas', roasWinner.result.value)}) and highest CTR (${formatMetric('ctr', ctrWinner.result.value)}) among the tested ${escapeHtml(row.conceptLabel || '')} variations.`);
      }
      if (cvrWinner && cvrWinner.result.label !== row.label) {
        extraLines.push(`${escapeHtml(cvrWinner.result.label)} generated the highest conversion rate (${formatMetric('cvr', cvrWinner.result.value)}).`);
      }

      const reasoning = tieBrokenBy
        ? `${escapeHtml(row.label)} has the strongest recorded ${metricPhrase} among the tied creatives.`
        : `${escapeHtml(row.label)} has the strongest recorded ${metricPhrase}.`;
      const learnedHtml = `<span class="pi-section-label">PERFORMANCE SIGNAL</span>` +
        [reasoning, ...extraLines].map(t => `<div class="pi-learned">${t}</div>`).join('') + tieBreakNote;

      // Distinguish a winning CREATIVE DIRECTION (e.g. "Beauty Lifestyle")
      // from a winning VARIATION within it (e.g. "Lighting"). Only show the
      // richer "next variation" framing when the winner is actually a
      // role-based variation — the base concept / plain "Original" case
      // keeps the existing "next direction" framing.
      if (row.isRoleVariation) {
        const roleIcon = { composition: '🧩', lighting: '💡', art_direction: '🎨' }[row.role] || '✨';
        html += `<div class="pi-card">
          <div class="pi-trophy-row"><span class="pi-trophy-label">RECOMMENDED NEXT VARIATION</span></div>
          <div class="pi-winner-name">✨ ${escapeHtml((row.conceptLabel || '').toUpperCase())}</div>
          <div class="pi-learned">Based on the strongest measured variation:</div>
          <div class="pi-winner-name">${roleIcon} ${escapeHtml(row.label.toUpperCase())}</div>
          <div class="pi-metrics">${metricsHtml}</div>
          ${learnedHtml}
          <div class="pi-learned">Create a new variation exploring this successful direction.</div>
          <button type="button" class="pi-next-btn" id="piCreateNextVariationBtn">Create Next Variation</button>
        </div>`;
      } else {
        html += `<div class="pi-card">
          <div class="pi-trophy-row"><span class="pi-trophy-label">RECOMMENDED NEXT DIRECTION</span></div>
          <div class="pi-winner-name">✨ ${escapeHtml(row.label)}</div>
          <div class="pi-metrics">${metricsHtml}</div>
          ${learnedHtml}
          <button type="button" class="pi-next-btn" id="piCreateNextVariationBtn">Create Next Variation</button>
        </div>`;
      }

      body.innerHTML = html;

      body.querySelector('#piCreateNextVariationBtn')?.addEventListener('click', async (e) => {
        const winnerCardEl = row.cardEl;

        // Winner is a specific VARIATION CHARACTERISTIC (e.g. Lighting) —
        // learn from it: generate ONE new creative that keeps the winning
        // direction + winning characteristic but explores a new execution
        // (spec STEP 8), instead of blindly re-running all 3 roles again.
        if (row.isRoleVariation) {
          const btn = e.currentTarget;
          const originalLabel = btn.textContent;
          btn.disabled = true;
          btn.textContent = 'Generating…';
          try {
            await createLearnedNextVariation(row);
          } finally {
            btn.disabled = false;
            btn.textContent = originalLabel;
          }
          return;
        }

        // Winner is just the best overall creative DIRECTION (no specific
        // variation characteristic identified yet) — keep the existing
        // behaviour of running the standard "Create Variation" batch on it.
        const varBtn = winnerCardEl?.querySelector(':scope > .variation-actions .v-variation');
        if (!varBtn || varBtn.disabled) {
          showToast('This creative is still generating — try again in a moment.', 'error');
          return;
        }
        winnerCardEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        varBtn.click();
      });
    }
    window.refreshPerformanceComparison = refreshPerformanceComparison;

    // ═══════════════════════════════════════════════════════════════════
    // BEAULIX CREATIVE LEARNING (spec items 9/14/15) — aggregates REAL,
    // stored performance across every campaign/session for THIS product
    // only (never across unrelated products), and summarizes observed
    // patterns by creative characteristics (style, type, variation role,
    // format). Transparent rule-based comparison — not an ML model, and
    // never invents a pattern without real data behind it.
    // ═══════════════════════════════════════════════════════════════════

    // Groups records by `keyFn`, keeps only groups with >=1 real CTR value,
    // and compares the two highest-average-CTR groups. Returns a sentence
    // or null if there isn't enough data to say anything.
    function comparePatternGroups(records, keyFn, describe) {
      const groups = new Map();
      records.forEach(rec => {
        const key = keyFn(rec);
        if (!key) return;
        const ctr = calcRealMetrics(rec.performance).ctr;
        if (!isFiniteNum(ctr)) return;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(ctr);
      });
      if (groups.size < 2) return null;
      const avgByGroup = [...groups.entries()].map(([key, vals]) => ({
        key, avg: vals.reduce((a, b) => a + b, 0) / vals.length, n: vals.length,
      })).sort((a, b) => b.avg - a.avg);
      const [top, second] = avgByGroup;
      if (top.avg === second.avg) return null;
      return describe(top, second);
    }

    // Finds the highest-value row on `metricKey` that is NOT the leader
    // (by label) — used only to phrase the "NEXT CREATIVE DECISION" as a
    // comparison against the real runner-up when one exists. Returns null
    // when there's no other labeled row with real data on this metric.
    function findRunnerUpRow(rows, metricKey, leaderLabel, getPerf, getLabel) {
      const withVal = rows
        .filter(r => getLabel(r) !== leaderLabel)
        .map(r => ({ label: getLabel(r), v: calcRealMetrics(getPerf(r))[metricKey] }))
        .filter(x => isFiniteNum(x.v));
      if (!withVal.length) return null;
      return withVal.reduce((best, x) => (x.v > best.v ? x : best));
    }

    // `preFetchedRecords`, when provided, is the exact same array a caller
    // (refreshPerformanceComparison) already retrieved via
    // fetchHistoricalPerformanceRecords for this product — reusing it here
    // avoids querying the database twice for identical historical data.
    async function refreshCreativeLearning(preFetchedRecords, canonicalRows) {
      const section = document.getElementById('creativeLearningSection');
      const body = document.getElementById('creativeLearningBody');
      if (!section || !body) return;

      const productId = window.getStableProductId ? window.getStableProductId() : (window._beaulixAssets?.product?.url || null);
      if (!productId) { section.classList.add('hidden'); return; }

      section.classList.remove('hidden');

      let records;
      if (preFetchedRecords) {
        records = preFetchedRecords;
      } else {
        // Show a loading state and reveal the section immediately so the
        // "not enough data" empty state can never flash before the
        // historical-performance query has actually completed (spec item 6).
        body.innerHTML = `<div class="cl-empty">Loading Beaulix Creative Learning…</div>`;
        records = await fetchHistoricalPerformanceRecords(productId);
      }

      if (records.length < 2) {
        body.innerHTML = `<div class="cl-empty">Beaulix will surface patterns after campaign data is recorded.</div>`;
        window._beaulixObservedPatterns = null;
        return;
      }

      const patterns = [];

      // ── Multiple-observation summary (spec STEP 4, item 4) — reports
      // the actual ROAS/CVR/CTR category winners among this product's
      // creative directions, not just a single CTR-based "winner". Only
      // states what the saved numbers show; no causal explanations.
      const clCategories = [
        { key: 'roas', label: 'ROAS' },
        { key: 'cvr',  label: 'conversion rate' },
        { key: 'ctr',  label: 'CTR' },
      ];

      // "Highest ROAS/CVR/CTR" and the recommendation MUST be derived from
      // the exact same rows the Creative Performance table just rendered
      // (canonicalRows — passed in by refreshPerformanceComparison), never
      // from an independently-scoped query. Using a different dataset here
      // is what previously let this panel claim numbers (e.g. a higher
      // ROAS/CTR/CVR) that didn't match, or didn't even appear in, the
      // table above it.
      const clRows = (canonicalRows && canonicalRows.length) ? canonicalRows : null;
      const clGetPerf = r => r.record.performance;
      const clGetLabel = r => r.conceptLabel || r.label;

      let prevWinnerLabel = null;
      const observationBullets = [];
      if (clRows) {
        clCategories.forEach(c => {
          const result = computeCategoryWinner(clRows, c.key, clGetPerf, clGetLabel);
          if (!result) return;
          if (result.tie) {
            // Ties (spec item 9): name every tied row rather than picking
            // an arbitrary "winner" that isn't supported by the data.
            observationBullets.push(`${escapeHtml(result.tieLabels.join(' and '))} recorded the highest ${c.label} (${formatMetric(c.key, result.value)}).`);
            prevWinnerLabel = null;
            return;
          }
          const also = result.label === prevWinnerLabel ? 'also ' : '';
          observationBullets.push(`${escapeHtml(result.label)} ${also}generated the highest ${c.label} (${formatMetric(c.key, result.value)}).`);
          prevWinnerLabel = result.label;
        });
      }
      if (observationBullets.length) patterns.push(...observationBullets);

      // ── NEXT CREATIVE DECISION (spec STEP 8) — a concise, evidence-based
      // testing suggestion, kept separate from the observed-pattern bullets
      // above and rendered in its own labeled block below. Never phrased as
      // a guaranteed prediction of future performance.
      let nextDecisionText = null;
      const clBest = clRows ? computeBestPerformer(clRows) : null;
      if (clBest && !clBest.tie) {
        const leaderLabel = clGetLabel(clBest.row);
        const runnerUp = findRunnerUpRow(clRows, clBest.metricKey, leaderLabel, clGetPerf, clGetLabel);
        if (runnerUp) {
          nextDecisionText = `${escapeHtml(runnerUp.label)} has not yet matched ${escapeHtml(leaderLabel)}'s recorded ${clCategories.find(c => c.key === clBest.metricKey)?.label || clBest.metricKey}. Consider testing additional ${escapeHtml(runnerUp.label)} variations before scaling the direction.`;
        } else {
          nextDecisionText = `Continue exploring ${escapeHtml(leaderLabel)} executions while testing new compositions.`;
        }
      } else if (clBest && clBest.tie) {
        nextDecisionText = `Top creative directions are currently tied — more campaign data is needed before recommending one over another.`;
      }

      const styleInsight = comparePatternGroups(records, r => r.style || null,
        (top, second) => `${escapeHtml(top.key)} creatives received a higher average CTR than ${escapeHtml(second.key)} creatives in the available campaign data.`);
      if (styleInsight) patterns.push(styleInsight);

      const typeInsight = comparePatternGroups(records, r => r.creativeType || null,
        (top, second) => `${escapeHtml(top.key)} concepts received a higher average CTR than ${escapeHtml(second.key)} concepts in the available campaign data.`);
      if (typeInsight) patterns.push(typeInsight);

      const roleInsight = comparePatternGroups(records, r => r.variationRole || 'original',
        (top, second) => `${escapeHtml(top.key === 'original' ? 'The original creative' : ROLE_META[top.key]?.label || top.key)} received a higher average CTR than ${escapeHtml(second.key === 'original' ? 'the original creative' : ROLE_META[second.key]?.label || second.key)} in ${top.n + second.n} recorded comparisons.`);
      if (roleInsight) patterns.push(roleInsight);

      const formatInsight = comparePatternGroups(records, r => r.format || null,
        (top, second) => `${escapeHtml(top.key)} creatives received a higher average CTR than ${escapeHtml(second.key)} creatives in the available campaign data.`);
      if (formatInsight) patterns.push(formatInsight);

      if (!patterns.length) {
        body.innerHTML = `<div class="cl-empty">Beaulix will surface patterns after campaign data is recorded.</div>`;
        window._beaulixObservedPatterns = null;
        return;
      }

      const nextDecisionHtml = nextDecisionText
        ? `<div class="cl-next"><span class="cl-next-label">NEXT CREATIVE DECISION</span><div class="cl-next-text">${nextDecisionText}</div></div>`
        : '';

      body.innerHTML = `<div class="cl-patterns">
        <ul>${patterns.map(p => `<li>${p}</li>`).join('')}</ul>
        ${renderConfidenceBadge(records.length)}
      </div>${nextDecisionHtml}`;

      // Stash a plain-text version for the generation flow (spec item 10) —
      // stripped of HTML, used only as OPTIONAL context, never to force a
      // style on the generator.
      window._beaulixObservedPatterns = patterns.concat(nextDecisionText ? [nextDecisionText] : [])
        .map(p => p.replace(/<[^>]+>/g, ''));
    }
    window.refreshCreativeLearning = refreshCreativeLearning;

    function renderVariationCard(container, cardState) {
      const { creativeId, format, style, index } = cardState;
      const concept = getConceptMeta(index, cardState.conceptKey);
      const brandStyle = brandStyleSelect?.value || '';
      const directionTags = getDirectionTags(concept.key, brandStyle);
      // Role-based "Create Variation" children (spec item 7) get a clear
      // "PARENT LABEL · ROLE" badge plus a one-line explanation of exactly
      // what changed; older refinement children ("Create More Like This")
      // keep their existing lettered badge.
      const roleMeta = cardState.variationRole ? ROLE_META[cardState.variationRole] : null;
      // "Create Next Variation" (spec STEP 8) children carry `learnedFrom`
      // — mark them clearly as learned from a measured winner, distinct
      // from an ordinary "Create Variation" child of the same role.
      // "Create More Like This" children (Select/Refine spec item 6) get a
      // distinct "VARIATION" category pill plus a "<Concept> · Variation NN"
      // name, instead of the role-based or plain-concept badges above.
      const badgeText = roleMeta
        ? `${concept.badge} · ${roleMeta.label}${cardState.learnedFrom ? '-LEARNED' : ''}`
        : (cardState.isRefinement && cardState.variationLabel
            ? `${concept.label || concept.subtitle} · Variation ${cardState.variationLabel}`
            : concept.badge);
      const learnedExplanation = cardState.learnedFrom
        ? `Generated from the strongest measured variation: ${escapeHtml(ROLE_META[cardState.learnedFrom.winningCharacteristic]?.label || cardState.learnedFrom.winningCharacteristic)} — ${[
            isFiniteNum(cardState.learnedFrom.sourceCTR) ? `${cardState.learnedFrom.sourceCTR.toFixed(1)}% CTR` : null,
            isFiniteNum(cardState.learnedFrom.sourceCVR) ? `${cardState.learnedFrom.sourceCVR.toFixed(1)}% CVR` : null,
            isFiniteNum(cardState.learnedFrom.sourceROAS) ? `${Math.round(cardState.learnedFrom.sourceROAS)}x ROAS` : null,
          ].filter(Boolean).join(' · ')}`
        : null;
      const card = document.createElement('div');
      card.className = 'variation-card is-loading';
      card.dataset.creativeId = creativeId;
      card.dataset.conceptKey = concept.key;
      if (cardState.variationRole) card.dataset.variationRole = cardState.variationRole;
      // Card number ("01") and category pill ("PRODUCT-FIRST") both come
      // straight from the existing concept data — nothing hard-coded here.
      // "Create More Like This" children instead show the variation number
      // as the corner badge and a plain "VARIATION" category pill.
      let cardNumber, cardName;
      if (cardState.isRefinement && cardState.variationLabel) {
        cardNumber = escapeHtml(cardState.variationLabel);
        cardName = escapeHtml(badgeText);
      } else {
        const badgeParts = badgeText.split('—');
        cardNumber = escapeHtml((badgeParts[0] || '').trim());
        cardName = escapeHtml((badgeParts.slice(1).join('—') || badgeText).trim());
      }
      const categoryPill = cardState.isRefinement
        ? 'VARIATION'
        : escapeHtml((directionTags[0] || concept.badge).toString().toUpperCase());
      card.innerHTML = `
        <div class="vc-image-wrap">
          <div class="variation-media"><div class="spinner"></div><span style="margin-left:8px;">Generating…</span></div>
          <span class="vc-index-badge">${cardNumber}</span>
          <span class="vc-category-pill">${categoryPill}</span>
          <div class="vc-image-actions">
            <button type="button" class="vc-view-btn">View</button>
            <button type="button" class="vc-quick-download">Download</button>
          </div>
        </div>
        <div class="variation-selected-badge">
          <span class="vsb-title">✓ CONCEPT SELECTED</span>
          <span class="vsb-sub">Ready to create more like this.</span>
        </div>
        <div class="vc-body">
          <div class="variation-concept">
            <span class="variation-concept-badge" title="${escapeHtml(badgeText)}">${cardName}</span>
            <span class="variation-concept-subtitle">${escapeHtml(concept.subtitle)}</span>
          </div>
          <div class="variation-direction">
            <span class="vd-label">Creative direction</span>
            <span>${directionTags.map(escapeHtml).join(' · ')}</span>
          </div>
          <div class="variation-copy-block">
            <span class="vc-copy-label">COPY</span>
            <div class="variation-copy"><span class="v-headline">-</span><span class="v-cta"></span></div>
          </div>
          <button type="button" class="vc-details-toggle" aria-expanded="false">View details</button>
          <div class="vc-secondary hidden">
            ${roleMeta ? `<span class="variation-role-explanation">${escapeHtml(roleMeta.explanation)}</span>` : ''}
            ${learnedExplanation ? `<span class="variation-role-explanation variation-learned-explanation">${learnedExplanation}</span>` : ''}
            ${cardState.learningStrategy ? `<span class="variation-strategy-badge${cardState.learningStrategy.type === 'exploration' ? ' vs-exploration' : ''}">${escapeHtml(cardState.learningStrategy.label)}</span><span class="variation-strategy-explanation">${escapeHtml(cardState.learningStrategy.explanation)}</span>` : ''}
            <span class="variation-best-for"><b>Best for:</b> ${escapeHtml(concept.bestFor)}</span>
            <div class="variation-tags"><span class="variation-tag">${escapeHtml(format)}</span><span class="variation-tag">${escapeHtml(style)}</span></div>
            <div class="variation-id">Creative ID · ${creativeId.slice(0, 8)}…</div>
          </div>
        </div>
        <div class="variation-actions">
          <button type="button" class="v-select" disabled>Select Concept</button>
          <div class="vc-actions-row">
            <button type="button" class="v-variation" disabled>Create Variation</button>
            <button type="button" class="v-regenerate" disabled>Regenerate</button>
            <button type="button" class="v-download" disabled>Download</button>
          </div>
        </div>
        ${renderPerformanceSectionHtml(null)}`;
      container.appendChild(card);
      const viewBtn = card.querySelector('.vc-view-btn');
      const quickDlBtn = card.querySelector('.vc-quick-download');
      viewBtn?.addEventListener('click', () => card.querySelector('.variation-media img, .variation-media video')?.requestFullscreen?.());
      quickDlBtn?.addEventListener('click', () => card.querySelector('.v-download')?.click());
      const detailsToggle = card.querySelector('.vc-details-toggle');
      const secondary = card.querySelector('.vc-secondary');
      detailsToggle?.addEventListener('click', () => {
        const isHidden = secondary.classList.toggle('hidden');
        detailsToggle.setAttribute('aria-expanded', String(!isHidden));
        detailsToggle.textContent = isHidden ? 'View details' : 'Hide details';
      });
      return card;
    }

    async function fillVariationCard(card, cardState) {
      // Regenerate reuses this same card element, so it may already carry
      // a previous blob URL — capture it now and only revoke it after the
      // new blob has successfully replaced it below (never before).
      const _previousCardBlobUrl = card.dataset.blobUrl || null;
      const { payload, creativeId, adCopy, normalizedAdCopy: cardNormalizedAdCopy } = cardState;
      // Defensive fallback: every current cardState builder sets
      // normalizedAdCopy, but derive it from adCopy here too so a future
      // caller that forgets it degrades to using stale/looser copy instead
      // of throwing (cardState.adCopy is the older, less-validated shape).
      const normalizedAdCopy = cardNormalizedAdCopy || {
        headline: String(adCopy?.headline || '').trim(),
        body:     String(adCopy?.description || adCopy?.body || '').trim(),
        cta:      String(adCopy?.cta || '').trim(),
        offer:    String(adCopy?.offer || '').trim(),
      };
      const media = card.querySelector('.variation-media');
      const regenBtn = card.querySelector('.v-regenerate');
      const varBtn   = card.querySelector('.v-variation');
      const dlBtn    = card.querySelector('.v-download');
      const selBtn   = card.querySelector('.v-select');
      card.classList.add('is-loading');
      media.innerHTML = `<div class="spinner"></div><span style="margin-left:8px;">Generating…</span>`;
      [regenBtn, varBtn, dlBtn, selBtn].forEach(b => b.disabled = true);
      try {
        console.log('[LOGO TEST] uploaded logo:', payload.logo_image_url || '(none uploaded for this card)');
        // Step 23: the intentional ad copy is sent to /generate so the SERVER
        // bakes it into the final JPEG (after scene → product → logo). It is
        // read from the SAME Ad Text fields (#adHeadline etc., populated by
        // updateAdTextFromAPI from the copy engine's ad_copy) so an edited
        // field + Regenerate re-renders with the new text; cardState.adCopy
        // is only the fallback if a field is empty. Never put in the SDXL prompt.
        //
        // STEP 26 fix: read lastPredictionData.ad_copy fresh, right here at
        // send-time, rather than trusting the batch-level `adCopy` snapshot
        // that generateCreativeVariations captured before any /generate call
        // went out. That snapshot can be null if /predict was still in
        // flight when the 12s silent-analysis race timed out; re-reading the
        // global here lets later cards in the same batch pick it up once it
        // actually lands, instead of every card in the batch permanently
        // inheriting the same too-early null.
        // getAdCopyForRender still reads the visible Ad Text fields first
        // (so an edited field + Regenerate re-renders with the new text),
        // falling back to this card's own normalizedAdCopy — the batch's
        // validated, guaranteed-non-empty copy — rather than a possibly-null
        // snapshot re-read from a global.
        // BUGFIX (category/data-flow): getAdCopyForRender() used to be called
        // here and its result was preferred over `normalizedAdCopy`. That
        // function reads the SHARED #adHeadline/#adDescription/#adCTA/
        // #adOffer DOM fields, which updateAdTextFromAPI() only ever sets
        // ONCE per batch, from the FIRST card's direction/category. Every
        // other card in the batch (different creative_direction, but same
        // product/category) was silently baking THAT single shared copy
        // into its image via this fallback chain, while the on-screen card
        // text was built straight from this card's own `normalizedAdCopy` —
        // so image copy and card copy could disagree, and any card besides
        // the first would even show a different creative direction's text
        // baked into its picture. There must be exactly ONE canonical
        // ad_copy object per card, driving both the card and the image it
        // generates, so we use `normalizedAdCopy` (this card's own,
        // direction- and category-correct copy) directly and only consult
        // the editable Ad Text fields as an explicit user-edit override for
        // a single, non-batch regenerate of the currently displayed card.
        const fieldCopy = cardState.isManualEditTarget ? getAdCopyForRender(normalizedAdCopy) : {};
        const normalizedForSend = {
          headline: fieldCopy.headline || normalizedAdCopy.headline,
          body:     fieldCopy.body     || normalizedAdCopy.body,
          cta:      fieldCopy.cta      || normalizedAdCopy.cta,
          offer:    fieldCopy.offer    || normalizedAdCopy.offer,
        };
        // STEP 8 — development safety guard. Never silently ship a
        // haircare creative with skincare wording baked in; fail loudly
        // instead so this class of bug can't reach production unnoticed.
        {
          // Use this card's OWN captured category (payload.product_category,
          // set at batch-build time) rather than the live productCategory.value
          // DOM field — that field is shared/global and can drift (cleared on
          // new product upload, or changed by the user) before this async
          // fillVariationCard call actually runs, causing the guard to compare
          // this card's real copy against a stale/wrong category.
          const guardCategory = payload.product_category || '(unknown)';
          const guardBlob = `${normalizedAdCopy.headline} ${normalizedAdCopy.body}`.toLowerCase();
          console.log('[BEAULIX COPY GUARD] direction =', cardState.conceptKey || cardState.index,
                       'category =', guardCategory, 'headline =', normalizedAdCopy.headline, 'body =', normalizedAdCopy.body);
          const bannedSkincareTerms = ['skincare routine', 'radiant skin', 'skincare', 'complexion', 'skin'];
          if (guardCategory === 'haircare' && bannedSkincareTerms.some(term => guardBlob.includes(term))) {
            console.error('[BEAULIX COPY GUARD] FAILED — HAIRCARE RECEIVED SKINCARE COPY', { category: guardCategory, headline: normalizedAdCopy.headline, body: normalizedAdCopy.body });
            throw new Error('Copy guard: a haircare product received skincare-flavoured ad copy — refusing to generate. Check console for [BEAULIX COPY GUARD] / [BEAULIX AD COPY REQUEST] logs.');
          }
        }
        console.log('[COPY TEST] frontend source ad_copy (at send-time):', normalizedForSend);
        console.log('[COPY TEST] frontend headline:', normalizedForSend.headline || null);
        console.log('[COPY TEST] frontend body:', normalizedForSend.body || null);
        console.log('[COPY TEST] frontend CTA:', normalizedForSend.cta || null);
        console.log('[COPY TEST] frontend offer:', normalizedForSend.offer || null);
        if (!normalizedForSend.headline || !normalizedForSend.body || !normalizedForSend.cta) {
          throw new Error('Ad copy is incomplete for this creative — not generating without headline/body/CTA.');
        }
        // Part 6 — send BOTH the flat fields (backward compatibility) AND a
        // nested ad_copy object, so the backend has zero ambiguity about
        // which shape carries the real copy.
        const genPayload = {
          ...payload,
          headline: normalizedForSend.headline,
          body:     normalizedForSend.body,
          cta:      normalizedForSend.cta,
          offer:    normalizedForSend.offer,
          ad_copy:  { ...normalizedForSend },
          concept: cardState.conceptKey || getConceptMeta(cardState.index, cardState.conceptKey).key,
          copy_layout: 'auto',
        };
        console.log('[COPY SYSTEM] copy sent to /generate:', { headline: genPayload.headline, body: genPayload.body, cta: genPayload.cta, offer: genPayload.offer, concept: genPayload.concept, brand_style: genPayload.brand_style });
        // [COPY TEST] trace point 3 — the exact copy object leaving the
        // frontend in the /generate request body (before fetch is sent).
        // These must NOT be null for a normal generation.
        console.log('[COPY TEST] generate payload ad_copy:', genPayload.ad_copy);
        console.log('[COPY TEST] payload headline:', genPayload.headline || null);
        console.log('[COPY TEST] payload body:', genPayload.body || null);
        console.log('[COPY TEST] payload CTA:', genPayload.cta || null);
        console.log('[COPY TEST] payload offer:', genPayload.offer || null);
        // [COPY TEST] exact-format trace required by the copy-rendering
        // debug pass — one line per field, immediately before the request
        // that will carry this copy to /generate.
        console.log('[COPY TEST] frontend ad_copy received:');
        console.log(`[COPY TEST] headline=${normalizedForSend.headline}`);
        console.log(`[COPY TEST] body=${normalizedForSend.body}`);
        console.log(`[COPY TEST] cta=${normalizedForSend.cta}`);
        console.log(`[COPY TEST] offer=${normalizedForSend.offer}`);
        console.log('[COPY TEST] sending ad_copy:', normalizedForSend);
        console.log('[COPY TEST] sending ad_copy_to_generate=true');
        const { fileUrl, filename, data } = await requestGenerationOnce(genPayload);
        console.log('[COPY SYSTEM] server report — copy_rendered:', data.copy_rendered, '| warning:', data.warning || null);
        console.log('[LOGO TEST] generated image (server-returned file, already composited server-side):', fileUrl);
        console.log('[LOGO TEST] server report — logo_applied:', data.logo_applied, '| identity_applied:', data.identity_applied, '| warning:', data.warning || null);
        card.classList.remove('is-loading');
        let blobUrl = null;
        console.log('[Beaulix] (6) fetching generated file bytes:', fileUrl);
        if (payload.output_type === 'video') {
          const resp = await fetchWithTimeout(fileUrl, { timeout: VIDEO_LOAD_TIMEOUT });
          const blob = await resp.blob();
          blobUrl = URL.createObjectURL(blob);
          media.innerHTML = `<video src="${blobUrl}" controls loop muted playsinline></video>`;
        } else {
          blobUrl = await loadImageAsBlob(fileUrl);
          media.innerHTML = `<img src="${blobUrl}" alt="Generated ${escapeHtml(cardState.style)} creative">`;
        }
        console.log('[Beaulix] (7) rendered to Creative Variations grid as blob:', blobUrl);
        card.dataset.blobUrl = blobUrl;
        card.dataset.filename = filename;
        card.dataset.fileUrl = fileUrl;
        // The new image/video is already in the DOM (media.innerHTML was
        // just set above) and dataset.blobUrl now points at it, so the
        // previous blob — if this was a regenerate — is no longer
        // referenced anywhere and is safe to release.
        if (_previousCardBlobUrl && _previousCardBlobUrl !== blobUrl) safeRevokeBlobUrl(_previousCardBlobUrl);
        console.log('[LOGO TEST] final creative image (card <img>/<video> src):', blobUrl, '— derived from', fileUrl);
        console.log('[LOGO TEST] download image (dlBtn will use cardEl.dataset.blobUrl):', card.dataset.blobUrl, '— SAME file as above, no separate pre-logo asset exists');

        const copyEl = card.querySelector('.variation-copy');
        if (adCopy) {
          copyEl.innerHTML = `<span class="v-headline">${escapeHtml(adCopy.headline || '-')}</span><span>${escapeHtml(adCopy.hook || '')}</span><br><span class="v-cta">${escapeHtml(adCopy.cta || '')}</span>`;
        }

        [regenBtn, varBtn, dlBtn, selBtn].forEach(b => b.disabled = false);

        // Persist with full Creative ID metadata for future consumer-response
        // learning (see item 10/11 of the Beaulix spec) — no fake analytics,
        // just the generation record itself. parentCreativeId/conceptType/
        // variationLabel carry the refinement lineage (item 10 of the
        // refinement spec) — null/absent for the original 3 concepts.
        window.saveToHistory?.(fileUrl, payload, {
          creativeId,
          parentCreativeId: cardState.parentCreativeId || null,
          conceptType: cardState.conceptKey || getConceptMeta(cardState.index, cardState.conceptKey).key,
          variationLabel: cardState.variationLabel || null,
          variationRole: cardState.variationRole || null,
          productId: window.getStableProductId ? window.getStableProductId() : (window._beaulixAssets?.product?.url || null),
          creativeVersion: cardState.creativeVersion || (cardState.regenCount || 0) + 1,
          format: cardState.format,
          style: cardState.style,
          generationConfig: payload,
          adCopy: adCopy || null,
          // Present only for "Create Next Variation" learned children
          // (spec STEP 8) — records which real, measured variation this
          // new creative learned from so the relationship is never lost.
          learningSource:        cardState.learnedFrom ? 'performance' : null,
          sourceVariationId:     cardState.learnedFrom?.sourceCreativeId || null,
          winningCharacteristic: cardState.learnedFrom?.winningCharacteristic || null,
          sourceROAS:            isFiniteNum(cardState.learnedFrom?.sourceROAS) ? cardState.learnedFrom.sourceROAS : null,
          sourceCTR:             isFiniteNum(cardState.learnedFrom?.sourceCTR) ? cardState.learnedFrom.sourceCTR : null,
          sourceCVR:             isFiniteNum(cardState.learnedFrom?.sourceCVR) ? cardState.learnedFrom.sourceCVR : null,
          // Step 10 — which generation-strategy slot (if any) this ORIGINAL
          // concept card came from, plus the exact structured learning
          // context that was attached to its generation request (null for
          // normal/fallback generation) — kept for auditability.
          generationStrategy:       cardState.learningStrategy?.type || null,
          generationStrategyConfidence: cardState.learningStrategy?.confidence || null,
          historicalLearningUsed:  payload.historicalLearning || null,
        }).catch(() => {});

        if (data.warning) showToast(data.warning, 'info');
      } catch (error) {
        console.error('[Beaulix] variation card failed:', error);
        card.classList.remove('is-loading');
        media.innerHTML = `<div class="image-error-box"><div class="error-icon">⚠️</div><p>${escapeHtml(error.message)}</p></div>`;
        regenBtn.disabled = false; varBtn.disabled = false;
        showToast(`Variation failed: ${error.message}`, 'error');
      }
    }

    async function generateCreativeVariations() {
      const contentTypeSelected = document.querySelector('input[name="content-type"]:checked');
      const styleSelected = document.querySelector('input[name="creative-style"]:checked');
      if (!contentTypeSelected) { showToast('Please choose what you\'d like to create', 'error'); return; }
      if (!styleSelected) { showToast('Please choose a creative style', 'error'); return; }

      await ensureCreativeDefaults();

      const productTypeVal = productType.value.trim();
      const aspectRatio = document.querySelector('input[name="aspect-ratio"]:checked')?.value || '1:1';
      const outputType = document.querySelector('input[name="output-type"]:checked')?.value || 'image';
      if (outputType === 'video' && !document.getElementById('duration')?.value) { showToast('Please select a video duration', 'error'); return; }

      const formatLabel = contentTypeSelected.closest('.content-type-option')?.querySelector('.ct-label')?.textContent || contentTypeSelected.value;
      const styleLabel = styleSelected.closest('.style-option')?.querySelector('.style-label')?.textContent || styleSelected.value;

      generateCreativeBtn.disabled = true;
      generateCreativeSpinner.classList.remove('hidden'); generateCreativeSpinner.style.display = 'block';
      document.getElementById('generationProgressLabel').textContent = `Generating ${BEAULIX_VARIATION_COUNT} variation${BEAULIX_VARIATION_COUNT > 1 ? 's' : ''}… 20–30s each for images, longer for videos`;
      generationProgress.classList.remove('hidden'); generationProgress.style.display = 'block';

      // The whole flow is now wrapped so that ANY failure — a bad GPU URL, a
      // hung /predict call, a malformed response, anything — resets the
      // button/spinner/progress bar and shows a real error instead of
      // leaving the UI stuck indefinitely (this was the actual bug).
      try {
        // Part 2/3 of the copy-pipeline fix: ad copy is REQUIRED for the
        // final creative, so it is no longer treated as best-effort or
        // raced against a UI timeout. The copy request is lightweight
        // (backend/copy_engine.py — no ML model involved) compared with the
        // 20-30s image-generation request, so correctness comes first: we
        // wait for it properly rather than starting image generation with
        // null copy. Full marketing analysis (/predict — CTR/targeting/etc,
        // used for the AI estimate panel) stays best-effort and runs in the
        // background without blocking generation, since only ad copy is
        // required for the creative itself.
        console.log('[Beaulix] fetching required ad copy before generation...');
        runMarketingAnalysis({ silent: true })
          .catch(e => { console.warn('[Beaulix] background marketing analysis failed (non-blocking; only affects AI estimate panel):', e); return false; });

        // Step 10 — historical learning informing this generation. This
        // must run BEFORE directionKeysForBatch below, since each slot's
        // learned concept determines that card's direction key. (Moved up
        // from its previous position further down in this function, which
        // referenced `learningSlots` here before its `let` declaration —
        // a temporal-dead-zone bug that threw "Cannot access 'learningSlots'
        // before initialization" on every generation attempt.) Best-effort
        // and never blocking: any failure here just falls back to normal
        // generation.
        let learningStrategy = null;
        let learningSlots = null;
        let historicalLearningPayload = null;
        try {
          const learningProductId = window.getStableProductId ? window.getStableProductId() : (window._beaulixAssets?.product?.url || null);
          learningStrategy = await computeGenerationLearningStrategy(learningProductId);
          if (learningStrategy) {
            learningSlots = buildLearningSlots(learningStrategy, aspectRatio);
            historicalLearningPayload = buildHistoricalLearningPayload(learningStrategy);
          }
        } catch (e) {
          console.warn('[Beaulix] learning-informed generation strategy failed (falling back to normal generation):', e);
          learningStrategy = null; learningSlots = null; historicalLearningPayload = null;
        }
        // Verification logging (Step 10 fix) — makes it possible to check
        // in devtools, per batch, exactly what was retrieved and whether
        // it was actually attached to the outgoing generation request.
        console.log('[Beaulix] Step 10 — historical learning retrieved:', !!learningStrategy, learningStrategy);
        console.log('[Beaulix] Step 10 — structured historicalLearning to attach to generation request:', historicalLearningPayload);

        // Direction-aware copy: each creative direction (hero/lifestyle/
        // social) gets its OWN ad copy request, so the three concepts in
        // this batch read as three different angles on the same product
        // instead of all three showing identical text. Fetched once per
        // distinct direction key actually used in this batch (learning
        // slots can repeat a direction across cards) and cached in
        // `adCopyByDirection` so we never fetch the same direction twice.
        const directionKeysForBatch = [];
        for (let i = 0; i < BEAULIX_VARIATION_COUNT; i++) {
          const slot = learningSlots ? learningSlots[i] : null;
          directionKeysForBatch.push(slot ? slot.conceptKey : getConceptMeta(i).key);
        }
        const uniqueDirections = [...new Set(directionKeysForBatch)];

        const adCopyByDirection = {};
        try {
          const fetched = await Promise.all(uniqueDirections.map(dir => fetchAdCopy(dir)));
          uniqueDirections.forEach((dir, idx) => { adCopyByDirection[dir] = fetched[idx]; });
          console.log('[BEAULIX BATCH COPY] directionKeys =', directionKeysForBatch, 'adCopyByDirection =', adCopyByDirection);
          const categoryAtFetchTime = productCategory.value || '(unknown)';
          for (const dir of uniqueDirections) {
            const c = adCopyByDirection[dir];
            console.log(`[BEAULIX DIRECTION COPY] direction=${dir} category=${categoryAtFetchTime} headline=${c?.headline} body=${c?.description || c?.body}`);
          }
        } catch (copyErr) {
          console.error('[COPY TEST] required ad copy fetch failed:', copyErr);
          throw new Error(`Couldn't generate ad copy: ${copyErr.message}`);
        }
        console.log('[COPY TEST] frontend source ad_copy by direction:', adCopyByDirection);

        // Keep the rest of the app's existing ad-copy display in sync (Ad
        // Text panel / #adHeadline etc.) using the first card's direction —
        // a Regenerate for that card later picks up the same copy that was
        // actually rendered into this batch.
        const adCopy = adCopyByDirection[directionKeysForBatch[0]];
        updateAdTextFromAPI(adCopy);
        if (lastPredictionData) lastPredictionData.ad_copy = adCopy; else lastPredictionData = { ad_copy: adCopy };
        console.log('[COPY DEBUG] lastPredictionData.ad_copy:', lastPredictionData.ad_copy);

        // Part 5 — one normalized object per direction, validated before
        // any /generate call goes out. headline/body/cta are required;
        // offer may be empty.
        function normalizeAdCopy(raw, dirForLog) {
          const output = {
            headline: String(raw?.headline || '').trim(),
            body:     String(raw?.description || raw?.body || '').trim(),
            cta:      String(raw?.cta || '').trim(),
            offer:    String(raw?.offer || '').trim(),
          };
          console.log('[BEAULIX NORMALIZE COPY] direction =', dirForLog, 'input =', raw, 'output =', output);
          console.log('[BEAULIX NORMALIZE COPY] input_description =', raw?.description);
          console.log('[BEAULIX NORMALIZE COPY] input_body =', raw?.body);
          console.log('[BEAULIX NORMALIZE COPY] input_hook =', raw?.hook);
          console.log('[BEAULIX NORMALIZE COPY] output_body =', output.body);
          return output;
        }
        const normalizedAdCopyByDirection = {};
        for (const dir of uniqueDirections) {
          const normalized = normalizeAdCopy(adCopyByDirection[dir], dir);
          console.log(`[COPY TEST] normalized ad_copy (${dir}):`, normalized);
          if (!normalized.headline || !normalized.body || !normalized.cta) {
            throw new Error(`Ad copy came back incomplete for the ${dir} direction (missing headline, body, or CTA) — not generating without it.`);
          }
          normalizedAdCopyByDirection[dir] = normalized;
        }
        // Real /predict output only — never fabricated — kept structurally
        // separate from the actual-performance panel (spec item 12).
        const aiEstimate = lastPredictionData ? {
          ctr:         isFiniteNum(lastPredictionData.ctr) ? lastPredictionData.ctr : null,
          conversion:  isFiniteNum(lastPredictionData.conversion_rate) ? lastPredictionData.conversion_rate : null,
          engagement:  isFiniteNum(lastPredictionData.engagement_rate) ? lastPredictionData.engagement_rate : null,
        } : null;

        const grid = document.getElementById('creativeVariationsGrid');
        const section = document.getElementById('variationsSection');
        if (!grid || !section) throw new Error('Variations grid elements missing from the page (creativeVariationsGrid/variationsSection) — check generator.html.');
        // Previous batch's cards are about to be discarded entirely — free
        // their blob URLs before wiping the grid (none of them are the
        // cards we're about to render, so this can never touch a URL
        // that's still on screen).
        revokeCardBlobUrls(grid);
        grid.innerHTML = '';
        section.classList.remove('hidden'); section.style.display = 'block';

        // Spec item 10 — surface any previously observed patterns for this
        // SAME product as optional, non-binding context. This is purely
        // informational: it is never injected into the GPU prompt/pipeline
        // and never restricts which style the user can pick below.
        const hintEl = document.getElementById('variationsHint');
        if (hintEl) {
          const patterns = window._beaulixObservedPatterns;
          const label = '<span class="ai-rec-label">AI Recommendation</span>';
          if (patterns?.length) {
            hintEl.innerHTML = `${label}${escapeHtml(patterns[0])} Use as guidance — you can still choose any creative direction.`;
          } else {
            hintEl.innerHTML = `${label}Three different ways to advertise the same beauty product.`;
          }
        }
        previewBox.style.display = 'none';
        generatedOutput.classList.add('hidden'); generatedOutput.style.display = 'none';

        // Fresh batch of 3 concepts — any previous selection/refinements no
        // longer correspond to what's on screen, so clear them.
        clearSelectedConcept();
        document.getElementById('refinementsSection')?.classList.remove('is-visible');
        const refinementsGrid = document.getElementById('creativeRefinementsGrid');
        if (refinementsGrid) { revokeCardBlobUrls(refinementsGrid); refinementsGrid.innerHTML = ''; }
        variationCounters = {};
        currentRefinementRootId = null;
        renderVariationHistory();

        const cards = [];
        for (let i = 0; i < BEAULIX_VARIATION_COUNT; i++) {
          const creativeId = uuidv4();
          const slot = learningSlots ? learningSlots[i] : null;
          const cardDirection = directionKeysForBatch[i];
          const cardAdCopy = adCopyByDirection[cardDirection];
          const cardNormalizedAdCopy = normalizedAdCopyByDirection[cardDirection];
          const payload = {
            prompt: slot ? slot.prompt : buildVariantPrompt(i),
            aspect_ratio: aspectRatio,
            output_type: outputType,
            brand_style: brandStyleSelect.value || '',
            duration: outputType === 'video' ? parseInt(document.getElementById('duration')?.value || 4) : 4,
            num_images: 1,
            creative_id: creativeId,
            _productType: productTypeVal,
            // Step 10 — structured, pre-summarized learning context passed
            // alongside the prompt (never raw historical records, and
            // never appended as free text into the image prompt itself —
            // its influence on the actual pixels comes entirely through
            // the concept/composition/lighting choice already baked into
            // `prompt` above). Present (non-null) whenever any real
            // historical data exists for this product, even on slots
            // where one specific signal fell back to a default — so a
            // caller can always see exactly what was known at generation
            // time, per spec's "CRITICAL GENERATION REQUIREMENT".
            historicalLearning: historicalLearningPayload,
            ...window.getBeaulixAssetPayload?.(),
          };
          const cardState = {
            creativeId, payload, format: formatLabel, style: styleLabel, index: i, adCopy: cardAdCopy, normalizedAdCopy: cardNormalizedAdCopy, aiEstimate, regenCount: 0, creativeVersion: 1, parentCreativeId: null, rootCreativeId: creativeId,
            conceptKey: slot ? slot.conceptKey : null,
            learningStrategy: slot ? { type: slot.strategyType, label: slot.strategyLabel, explanation: slot.strategyExplanation, confidence: learningStrategy.confidence } : null,
          };
          console.log(`[Beaulix] Step 10 — creative ${i + 1}/${BEAULIX_VARIATION_COUNT} strategy:`, slot ? `${slot.strategyLabel} (${slot.conceptKey})` : 'default (no learning)', '— prompt includes learning-informed scene text:', !!slot);
          const cardEl = renderVariationCard(grid, cardState);
          // Keep a live reference to this card's full state on the DOM node
          // itself (spec STEP 8) so later workflows — like learning from a
          // winning performance variation — can recover the original
          // payload/product/style/format without re-deriving it from markup.
          cardEl._cardState = cardState;

          cards.push({ cardEl, cardState });
        }

        // Sequential requests — the GPU server processes one generation at a
        // time, so this is more requests rather than one faked multi-output
        // request (see spec item 6). Each card's own try/catch (in
        // fillVariationCard) means one failing variation doesn't stop the
        // rest of the batch.
        for (const { cardEl, cardState } of cards) {
          await fillVariationCard(cardEl, cardState);
          wireVariationCardActions(cardEl, cardState);
        }
        refreshPerformanceComparison();
      } catch (error) {
        console.error('[Beaulix] generateCreativeVariations failed:', error);
        showToast(`Generation failed: ${error.message}`, 'error');
        // Surface the failure in the preview panel too, in case the grid
        // section never even became visible.
        previewBox.style.display = '';
        previewBox.innerHTML = `<div class="image-error-box"><div class="error-icon">⚠️</div><p>${escapeHtml(error.message)}</p></div>`;
      } finally {
        // Always runs, no matter where the flow above failed — this is what
        // guarantees the button/spinner/progress bar can never stay stuck.
        generateCreativeSpinner.classList.add('hidden'); generateCreativeSpinner.style.display = 'none';
        generateCreativeBtn.disabled = false;
        generationProgress.classList.add('hidden'); generationProgress.style.display = 'none';
        updateGenerateButtonState();
      }
    }

    function wireVariationCardActions(cardEl, cardState) {
      wirePerformancePanel(cardEl, cardState);
      const regenBtn = cardEl.querySelector('.v-regenerate');
      const varBtn   = cardEl.querySelector('.v-variation');
      const dlBtn    = cardEl.querySelector('.v-download');
      const selBtn   = cardEl.querySelector('.v-select');

      // "Regenerate" — try again for the exact same concept/execution this
      // card already represents. Distinct from "Create Variation" below,
      // which explores new interpretations (spec item 10).
      regenBtn.addEventListener('click', async () => {
        cardState.regenCount = (cardState.regenCount || 0) + 1;
        let nextPrompt;
        if (cardState.variationRole) {
          // Retry the SAME role (composition/lighting/art_direction) — a
          // regenerate must never silently change which dimension this
          // card represents (spec item 11).
          const aspectRatio = cardState.aspectRatio || document.querySelector('input[name="aspect-ratio"]:checked')?.value || '1:1';
          nextPrompt = buildRoleVariantPrompt(cardState.conceptKey, cardState.variationRole, aspectRatio, cardState.regenCount);
        } else if (cardState.isRefinement) {
          // Retry the same Variation with the SAME Refinements choices it
          // was created with (spec item — Regenerate must not silently
          // change Product Focus/Visual Treatment/Composition/Setting).
          nextPrompt = cardState.refinementChoices
            ? buildRefinementPromptFromChoices(cardState.conceptKey, cardState.refinementChoices, cardState.refinementIndex || 0)
            : buildRefinementPrompt(cardState.conceptKey, cardState.refinementIndex || 0);
        } else {
          nextPrompt = buildVariantPrompt(cardState.index);
        }
        cardState.payload = { ...cardState.payload, prompt: nextPrompt };
        await fillVariationCard(cardEl, cardState);
      });

      varBtn.addEventListener('click', () => createCardVariations(cardEl, cardState, varBtn));

      dlBtn.addEventListener('click', async () => {
        const blobUrl = cardEl.dataset.blobUrl;
        if (!blobUrl) { showToast('No visual to download yet', 'error'); return; }
        console.log('[LOGO TEST] download image:', blobUrl, '(source file:', cardEl.dataset.fileUrl, ')');
        const a = document.createElement('a');
        a.href = blobUrl; a.download = cardEl.dataset.filename || 'beaulix-visual.jpg'; a.style.display = 'none';
        document.body.appendChild(a); a.click();
        setTimeout(() => document.body.removeChild(a), 100);
        showToast('Download started!', 'success');
      });

      // "Select Concept" — purely a presentational/comparison choice: marks
      // this card as the chosen direction, unmarks any other selected card
      // ACROSS both the original grid and any refinements grid (only one
      // concept selected at a time, spec item 1), and does nothing else.
      // No generation, no request, no change to the image itself.
      selBtn.addEventListener('click', () => {
        if (cardEl.classList.contains('is-selected')) {
          // Clicking the already-selected card deselects it and hides the
          // refine bar — there is no "selected concept" to refine anymore.
          cardEl.classList.remove('is-selected');
          clearSelectedConcept();
          return;
        }
        selectConceptCard(cardEl, cardState);
      });
    }

    // ── "Create Variation" (Step 3): exactly 3 PURPOSEFUL child variations
    // of ONE specific card — composition, lighting & environment, and art
    // direction (spec item 1) — never a new unrelated concept. Uses
    // buildRoleVariantPrompt() so the parent's concept, brand style,
    // format/platform, and product/logo compositing all stay fixed — only
    // the one dimension assigned to each role changes. Recursive: a child
    // can itself become a parent (version keeps climbing: 1 → 2 → 3 → ...),
    // and clicking Create Variation on it again re-runs all 3 roles.
    async function createCardVariations(cardEl, cardState, varBtn) {
      if (cardState.childBatchInFlight) return; // guard against duplicate clicks
      cardState.childBatchInFlight = true;

      const regenBtn = cardEl.querySelector('.v-regenerate');
      const selBtn = cardEl.querySelector('.v-select');
      const originalLabel = varBtn.textContent;
      varBtn.disabled = true; regenBtn.disabled = true; selBtn.disabled = true;
      varBtn.textContent = 'Creating 3 variations…';

      try {
        const concept = getConceptMeta(cardState.index, cardState.conceptKey);
        const conceptKey = concept.key;
        const parentVersion = cardState.creativeVersion || 1;
        const aspectRatio = cardState.aspectRatio
          || cardState.payload?.aspect_ratio
          || document.querySelector('input[name="aspect-ratio"]:checked')?.value
          || '1:1';

        // A repeat click on the same card replaces its previous child set
        // rather than stacking endlessly — the parent creative itself is
        // never touched or hidden either way (spec item 6/9).
        if (cardEl._childWrapperEl) { revokeCardBlobUrls(cardEl._childWrapperEl); cardEl._childWrapperEl.remove(); }
        const wrapper = document.createElement('div');
        wrapper.className = 'variation-children-row';
        wrapper.innerHTML = `
          <div class="vcr-header">
            <span class="vcr-label">Variations of ${escapeHtml(concept.badge)}</span>
            <span class="vcr-sub">Same creative idea, explored 3 purposeful ways: composition, lighting, art direction.</span>
          </div>
          <div class="variation-children-grid"></div>`;
        cardEl.insertAdjacentElement('afterend', wrapper);
        cardEl._childWrapperEl = wrapper;
        const childGrid = wrapper.querySelector('.variation-children-grid');

        const cards = [];
        for (let i = 0; i < VARIATION_ROLES.length; i++) {
          const role = VARIATION_ROLES[i];
          const creativeId = uuidv4();
          const payload = { ...cardState.payload, prompt: buildRoleVariantPrompt(conceptKey, role, aspectRatio, 0), creative_id: creativeId };
          const childState = {
            creativeId,
            parentCreativeId: cardState.creativeId,
            creativeVersion: parentVersion + 1,
            conceptKey,
            isRoleVariation: true,
            variationRole: role,
            aspectRatio,
            payload,
            format: cardState.format,
            style: cardState.style,
            index: cardState.index,
            adCopy: cardState.adCopy,
            normalizedAdCopy: cardState.normalizedAdCopy,
            aiEstimate: cardState.aiEstimate,
            regenCount: 0,
          };
          const childEl = renderVariationCard(childGrid, childState);
          // Same live-state reference as the top-level cards, plus a link
          // back to the parent card element so the performance-learning
          // workflow can recover the parent's original payload/product
          // when this child later turns out to be the winning variation.
          childEl._cardState = childState;
          childEl._parentCardEl = cardEl;
          cards.push({ childEl, childState });
        }

        // Sequential + independently caught, same guarantee as the original
        // 3-concept batch: one failure never blocks or discards the rest.
        for (const { childEl, childState } of cards) {
          await fillVariationCard(childEl, childState);
          wireVariationCardActions(childEl, childState);
        }
        refreshPerformanceComparison();
      } finally {
        varBtn.disabled = false; regenBtn.disabled = false; selBtn.disabled = false;
        varBtn.textContent = originalLabel;
        cardState.childBatchInFlight = false;
      }
    }

    // ── "Create Next Variation" learned generation (spec STEP 8) ─────────
    // Triggered only when the Performance Decision winner is a specific
    // VARIATION CHARACTERISTIC (e.g. Lighting), not just a plain creative
    // direction. Generates exactly ONE new creative that inherits:
    //   1. the original product / creative direction / style / format
    //   2. the winning variation's characteristic (role)
    // ...while exploring a NEW visual execution of that same role, so the
    // winning image is never simply duplicated. Product fidelity is
    // untouched — this reuses the exact same payload/compositing path as
    // every other role variation (buildRoleVariantPrompt + the parent's
    // existing product/logo/reference assets).
    async function createLearnedNextVariation(row) {
      const winnerCardEl = row.cardEl;
      const winnerState = winnerCardEl?._cardState;
      if (!winnerState) {
        showToast('Could not find the winning creative on screen — try again.', 'error');
        return;
      }

      // The winning card IS the child that holds the role; its sibling
      // parent card holds the original product/style/format/payload that
      // must stay fixed (spec: "product fidelity must remain unchanged").
      const parentCardEl = winnerCardEl._parentCardEl || winnerCardEl;
      const parentState = parentCardEl._cardState || winnerState;
      const role = row.role || winnerState.variationRole;
      if (!role) {
        showToast('Add performance data to a variation before Beaulix can learn from it.', 'error');
        return;
      }

      const conceptKey = parentState.conceptKey || getConceptMeta(parentState.index, parentState.conceptKey).key;
      const concept = getConceptMeta(parentState.index, conceptKey);
      const aspectRatio = parentState.aspectRatio
        || parentState.payload?.aspect_ratio
        || document.querySelector('input[name="aspect-ratio"]:checked')?.value
        || '1:1';

      // Pick a NEW execution of the SAME winning role — never the exact
      // variant text the winning image itself used. Each parent/role pair
      // tracks its own running count so repeated learning cycles keep
      // exploring fresh executions instead of looping back to an earlier one.
      parentState._learnedRoleCounts = parentState._learnedRoleCounts || {};
      const winnerRegenIndex = winnerState.regenCount || 0;
      const listLen = getRoleVariantListLength(role, aspectRatio);
      let nextRegenIndex = Math.max(parentState._learnedRoleCounts[role] || 0, winnerRegenIndex) + 1;
      if (listLen > 1) {
        while (nextRegenIndex % listLen === winnerRegenIndex % listLen) nextRegenIndex++;
      }
      parentState._learnedRoleCounts[role] = nextRegenIndex;

      const creativeId = uuidv4();
      const prompt = buildRoleVariantPrompt(conceptKey, role, aspectRatio, nextRegenIndex);
      const payload = { ...parentState.payload, prompt, creative_id: creativeId };

      const m = calcRealMetrics(row.record?.performance || {});
      const childState = {
        creativeId,
        parentCreativeId: parentState.creativeId,
        creativeVersion: (parentState.creativeVersion || 1) + 1,
        conceptKey,
        isRoleVariation: true,
        variationRole: role,
        aspectRatio,
        payload,
        format: parentState.format,
        style: parentState.style,
        index: parentState.index,
        adCopy: parentState.adCopy,
        normalizedAdCopy: parentState.normalizedAdCopy,
        aiEstimate: parentState.aiEstimate,
        regenCount: 0,
        learnedFrom: {
          sourceCreativeId: winnerState.creativeId,
          winningCharacteristic: role,
          sourceROAS: isFiniteNum(m.roas) ? m.roas : null,
          sourceCTR:  isFiniteNum(m.ctr)  ? m.ctr  : null,
          sourceCVR:  isFiniteNum(m.cvr)  ? m.cvr  : null,
        },
      };

      // Reuse (or create) the SAME children row under the parent card so
      // the new learned creative sits alongside its siblings rather than
      // starting a disconnected new grid — this is additive, it never
      // removes the existing variations (spec: preserve existing
      // functionality).
      let wrapper = parentCardEl._childWrapperEl;
      let childGrid = wrapper?.querySelector('.variation-children-grid');
      if (!wrapper || !childGrid) {
        wrapper = document.createElement('div');
        wrapper.className = 'variation-children-row';
        wrapper.innerHTML = `
          <div class="vcr-header">
            <span class="vcr-label">Variations of ${escapeHtml(concept.badge)}</span>
            <span class="vcr-sub">Same creative idea, explored purposeful ways.</span>
          </div>
          <div class="variation-children-grid"></div>`;
        parentCardEl.insertAdjacentElement('afterend', wrapper);
        parentCardEl._childWrapperEl = wrapper;
        childGrid = wrapper.querySelector('.variation-children-grid');
      }

      const childEl = renderVariationCard(childGrid, childState);
      childEl._cardState = childState;
      childEl._parentCardEl = parentCardEl;

      try {
        await fillVariationCard(childEl, childState);
        wireVariationCardActions(childEl, childState);
        childEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        showToast(`Generated a new creative learning from ${ROLE_META[role]?.label || role}`, 'success');
        refreshPerformanceComparison();
      } catch (e) {
        console.error('[Beaulix] createLearnedNextVariation failed:', e);
        showToast(`Learned generation failed: ${e.message}`, 'error');
      }
    }

    // ── Selected-concept state + "Create More Like This" ─────────────────
    let selectedConceptState = null;
    // Per-lineage "Variation NN" counters (spec item 6), keyed by the
    // ORIGINAL card's creativeId so numbering stays sequential (01, 02, …)
    // no matter whether the parent of the next click is the original or a
    // prior variation. Reset whenever a fresh batch of 3 concepts is generated.
    let variationCounters = {};
    // Which lineage the on-screen refinements grid/history bar currently
    // belongs to — lets us clear and start over when the user selects a
    // DIFFERENT original concept, while leaving the grid alone when they
    // keep refining the same one (spec item 7/8: history + comparison).
    let currentRefinementRootId = null;

    function clearSelectedConcept() {
      selectedConceptState = null;
      document.querySelectorAll('.variation-card.is-selected').forEach(c => c.classList.remove('is-selected'));
      const bar = document.getElementById('conceptRefineBar');
      bar?.classList.remove('is-visible');
      document.getElementById('selectedDirectionSection')?.classList.remove('is-visible');
      renderVariationHistory();
    }

    // Compact "Selected Direction" panel (spec item 2) — text pulled
    // entirely from existing concept metadata (badge/tags) plus the static
    // DIRECTION_DESCRIPTIONS map above; nothing here is AI-generated.
    function renderSelectedDirection(concept, brandStyle) {
      const section = document.getElementById('selectedDirectionSection');
      if (!section) return;
      const tagsEl = document.getElementById('selectedDirectionTags');
      const nameEl = document.getElementById('selectedDirectionName');
      const descEl = document.getElementById('selectedDirectionDesc');
      if (nameEl) nameEl.textContent = (concept.label || concept.subtitle).toUpperCase();
      if (tagsEl) tagsEl.textContent = getDirectionTags(concept.key, brandStyle).join(' · ');
      if (descEl) descEl.textContent = DIRECTION_DESCRIPTIONS[concept.key] || concept.subtitle;
      section.classList.add('is-visible');
    }

    // Lightweight "Original → Variation 01 → Variation 02 …" sequence
    // (spec item 7). Rebuilt from the current refinements grid's own card
    // states, so there is no separate history data structure to keep in
    // sync — it always reflects exactly what's on screen. Clicking a pill
    // reuses the card's existing "Select Concept" button (no duplicate
    // selection logic).
    function renderVariationHistory() {
      const bar = document.getElementById('variationHistoryBar');
      if (!bar) return;
      if (!selectedConceptState || !currentRefinementRootId) {
        bar.classList.remove('is-visible');
        bar.innerHTML = '';
        return;
      }
      const grid = document.getElementById('creativeRefinementsGrid');
      const variationCards = grid ? Array.from(grid.querySelectorAll('.variation-card')) : [];
      const items = [{ label: 'Original', cardEl: null }];
      variationCards.forEach(cardEl => {
        const label = cardEl._cardState?.variationLabel;
        items.push({ label: label ? `Variation ${label}` : 'Variation', cardEl });
      });
      if (items.length < 2) { bar.classList.remove('is-visible'); bar.innerHTML = ''; return; }
      bar.innerHTML = items.map((it, i) => {
        const isCurrent = it.cardEl
          ? it.cardEl.classList.contains('is-selected')
          : !selectedConceptState.cardEl.closest('#creativeRefinementsGrid');
        return `<span class="vh-step${isCurrent ? ' is-current' : ''}" data-step-index="${i}">${escapeHtml(it.label)}</span>${i < items.length - 1 ? '<span class="vh-arrow">→</span>' : ''}`;
      }).join('');
      bar.querySelectorAll('.vh-step').forEach((el, i) => {
        el.addEventListener('click', () => {
          const it = items[i];
          if (it.cardEl) {
            it.cardEl.querySelector('.v-select')?.click();
          } else {
            // "Original" pill: reselect the original card directly.
            document.querySelector(`.variation-card[data-creative-id="${currentRefinementRootId}"] .v-select`)?.click();
          }
        });
      });
      bar.classList.add('is-visible');
    }

    function selectConceptCard(cardEl, cardState) {
      document.querySelectorAll('.variation-card.is-selected').forEach(other => {
        if (other !== cardEl) other.classList.remove('is-selected');
      });
      cardEl.classList.add('is-selected');

      const concept = getConceptMeta(cardState.index, cardState.conceptKey);
      selectedConceptState = {
        cardState,
        cardEl,
        conceptKey: concept.key,
        conceptBadge: concept.badge,
      };

      const bar = document.getElementById('conceptRefineBar');
      const label = document.getElementById('refineBarSelectedLabel');
      if (label) label.textContent = `✓ Concept selected — ${concept.badge}`;
      bar?.classList.add('is-visible');
      const btn = document.getElementById('createMoreLikeThisBtn');
      if (btn) btn.disabled = false;

      renderSelectedDirection(concept, brandStyleSelect?.value || '');

      // A different lineage than whatever the refinements grid currently
      // shows — start its history over (spec item 7 is per-lineage, not a
      // global mash of every concept ever refined in this session).
      const rootId = cardState.rootCreativeId || cardState.creativeId;
      if (rootId !== currentRefinementRootId) {
        currentRefinementRootId = rootId;
        const grid = document.getElementById('creativeRefinementsGrid');
        if (grid) { revokeCardBlobUrls(grid); grid.innerHTML = ''; }
        document.getElementById('refinementsSection')?.classList.remove('is-visible');
      }
      resetRefinementChoicesUi();
      renderVariationHistory();
    }

    let refinementBatchInFlight = false;

    // Generates exactly ONE new "Variation" using the user's four
    // Refinements choices (spec item 3/5) — not a fixed batch of three.
    // Reuses the same card-rendering/fill/wire pipeline as every other
    // card in the app; the only new thing is the prompt text assembled
    // from the chosen refinement options, and the sequential "Variation NN"
    // numbering/history bookkeeping.
    async function generateRefinements() {
      if (refinementBatchInFlight) return; // guard against duplicate clicks
      if (!selectedConceptState) { showToast('Select a concept first', 'error'); return; }
      refinementBatchInFlight = true;

      const { cardState: parentCardState, conceptKey, conceptBadge } = selectedConceptState;
      const concept = getConceptMeta(parentCardState.index, conceptKey);
      const parentCreativeId = parentCardState.creativeId;
      const rootCreativeId = parentCardState.rootCreativeId || parentCreativeId;
      const choices = getRefinementChoices();

      const createMoreBtn = document.getElementById('createMoreLikeThisBtn');
      const progressText = document.getElementById('refineProgressText');
      if (createMoreBtn) createMoreBtn.disabled = true;
      progressText?.classList.remove('hidden');
      if (progressText) progressText.textContent = `Creating a new variation of ${conceptBadge.replace(/^0\d\s*—\s*/, '')}…`;

      const section = document.getElementById('refinementsSection');
      const grid = document.getElementById('creativeRefinementsGrid');
      const parentTag = document.getElementById('refinementsParentTag');
      const heading = document.getElementById('refinementsHeading');
      if (!section || !grid) { refinementBatchInFlight = false; if (createMoreBtn) createMoreBtn.disabled = false; return; }

      if (parentTag) parentTag.textContent = `ORIGINAL DIRECTION: ${conceptBadge}`;
      if (heading) heading.textContent = `${conceptBadge} — Refinements`;
      section.classList.add('is-visible');

      variationCounters[rootCreativeId] = (variationCounters[rootCreativeId] || 0) + 1;
      const variationNumber = variationCounters[rootCreativeId];
      const variationLabel = String(variationNumber).padStart(2, '0');

      const creativeId = uuidv4();
      const payload = {
        ...parentCardState.payload,
        prompt: buildRefinementPromptFromChoices(conceptKey, choices, variationNumber - 1),
        creative_id: creativeId,
      };
      const cardState = {
        creativeId,
        parentCreativeId,
        rootCreativeId,
        conceptKey,
        isRefinement: true,
        refinementIndex: variationNumber - 1,
        variationLabel,
        refinementChoices: choices,
        payload,
        format: parentCardState.format,
        style: parentCardState.style,
        index: VARIATION_CONCEPTS.findIndex(c => c.key === conceptKey),
        adCopy: parentCardState.adCopy,
        normalizedAdCopy: parentCardState.normalizedAdCopy,
        aiEstimate: parentCardState.aiEstimate,
        regenCount: 0,
      };
      const cardEl = renderVariationCard(grid, cardState);
      cardEl._cardState = cardState;

      await fillVariationCard(cardEl, cardState);
      wireVariationCardActions(cardEl, cardState);
      renderVariationHistory();

      progressText?.classList.add('hidden');
      if (createMoreBtn) createMoreBtn.disabled = false;
      refinementBatchInFlight = false;
    }



    // ── Live Step 2 score update ─────────────────────────────────────────
    // Step 2 live scoring — logic lives in step2-module.js.
    // window.onStep2SelectionChange is registered by initStep2Module() in the
    // module script block below; this wrapper calls through once the module loads.
    function updateStep2ScoreWidget(data) {
      // Widget removed — step2PredictionData is still populated by the module
      // so the improvement banner always has real before/after delta after Generate.
    }

    function onStep2SelectionChange() {
      window.onStep2SelectionChange?.();
    }

    // Marketing analysis is now optional/secondary (see Marketing Intelligence
    // panel). `silent` mode is used when Generate Creative triggers it
    // automatically in the background using default field values, so it
    // never blocks the creative-first flow and never shows its own errors —
    // generation proceeds with graceful fallback either way.
    // NOTE: this must be declared at top level (not inside the
    // DOMContentLoaded callback below) — generateCreativeVariations() calls
    // it directly and is itself a top-level function, so it can't see into
    // that callback's nested scope. Declaring it here previously caused
    // "runMarketingAnalysis is not defined" when Generate Variations ran.
    //
    // Part 4 of the copy-pipeline fix: a small, ML-prediction-independent
    // way to get real ad copy (backend/copy_engine.py via /ad-copy) without
    // waiting on — or being at the mercy of — the full Random Forest
    // /predict call. Same auth pattern as runMarketingAnalysis. Never
    // fabricates copy: on failure, throws so the caller can show a real
    // error instead of silently generating with no copy.
    // Category-neutral fallback used ONLY when the category genuinely could
    // not be resolved (no filename keyword match, no user selection). Per
    // STEP 6/7: unknown must never silently become "skincare" — it gets
    // copy that doesn't claim any specific product category instead.
    const NEUTRAL_AD_COPY = {
      hook:         "Discover your next beauty essential.",
      headline:     "DISCOVER YOUR NEXT BEAUTY ESSENTIAL",
      description:  "Designed for your beauty routine.",
      cta:          "DISCOVER MORE ->",
      offer:        "Join our community",
      creative_direction: null,
    };

    async function fetchAdCopy(direction) {
      const payload = buildPayload(direction);
      console.log('[BEAULIX AD COPY REQUEST] direction =', direction,
                   'product_category =', payload.product_category,
                   'product_name =', document.getElementById('assetProductInput')?.files?.[0]?.name || null,
                   'product_description =', payload.decision_attribute_1 || payload.decision_attribute_2 || null,
                   'payload =', payload);
      console.log('[BEAULIX CATEGORY] fetchAdCopy.product_category =', payload.product_category, 'direction =', direction);
      if (!payload.product_category) {
        // STEP 6: category is genuinely unknown (resolver found no keyword
        // match and the user hasn't picked one). Do NOT call the backend
        // with an empty/invalid category and do NOT guess "skincare" —
        // return category-neutral copy directly.
        console.warn('[BEAULIX AD COPY REQUEST] product_category is unknown — skipping backend call, using category-neutral fallback copy for direction =', direction);
        const neutral = { ...NEUTRAL_AD_COPY, creative_direction: direction || 'hero' };
        console.log('[BEAULIX AD COPY RESPONSE] direction =', direction, 'product_category = (unknown)', 'returned_ad_copy =', neutral);
        return neutral;
      }
      if (!_mlBackendUrl) throw new Error('ML engine not configured — add config/backend doc in Firestore.');
      const authHeaders = await getMlAuthHeaders();
      const requestUrl = `${_mlBackendUrl}/ad-copy`;
      console.log('[COPY DEBUG] requesting ad copy:', requestUrl, payload);
      let res = await fetchWithTimeout(requestUrl, { method: 'POST', timeout: FETCH_TIMEOUT, headers: authHeaders, body: JSON.stringify(payload) });
      console.log('[COPY DEBUG] ad copy response status:', res.status);
      let source = '/ad-copy endpoint';
      if (res.status === 404) {
        // The running ML backend doesn't have /ad-copy (stale deploy of
        // backend/server.py). /predict is an existing route that already
        // returns the same copy_engine ad_copy object, so use it instead —
        // no new copy source, no hardcoded text.
        console.error('[COPY DEBUG] AD COPY ENDPOINT NOT FOUND:', requestUrl, '— falling back to existing /predict');
        const predictUrl = `${_mlBackendUrl}/predict`;
        console.log('[COPY DEBUG] requesting ad copy:', predictUrl, payload);
        res = await fetchWithTimeout(predictUrl, { method: 'POST', timeout: FETCH_TIMEOUT, headers: authHeaders, body: JSON.stringify(payload) });
        console.log('[COPY DEBUG] ad copy response status:', res.status);
        source = '/predict (fallback)';
      }
      if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(`${err.detail || 'Ad copy request failed'} (${res.status} from ${res.url || requestUrl})`); }
      const data = await res.json();
      if (!data || !data.ad_copy) throw new Error('Ad copy request returned no ad_copy.');
      console.log('[COPY DEBUG] generated ad_copy:', data.ad_copy);
      console.log('[BEAULIX COPY] /ad-copy response — headline =', data.ad_copy.headline, 'body =', data.ad_copy.description || data.ad_copy.body, 'cta =', data.ad_copy.cta);
      console.log('[BEAULIX AD COPY RESPONSE] direction =', direction, 'product_category =', payload.product_category, 'returned_ad_copy =', data.ad_copy);
      console.log('[COPY TEST] copy source:', source);
      return data.ad_copy;
    }

    async function runMarketingAnalysis({ silent = false } = {}) {
      improvementBanner.classList.add('hidden'); improvementBanner.style.display = 'none';
      step2PredictionData = null;
      if (!validateMarketingProfile()) {
        if (!silent) showToast('Please fill all required fields in Marketing Intelligence','error');
        return false;
      }
      if (!silent) { loadingStages.classList.remove('hidden'); loadingStages.style.display = 'block'; }
      analysisResults.classList.add('hidden'); analysisResults.style.display = 'none';
      analyzeBtn.disabled = true;
      if (!silent) analyzeBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="btn-spinner"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg> Analyzing...`;
      try {
        if (!silent) await runStagedLoading();
        const payload = buildPayload();
        if (!_mlBackendUrl) throw new Error('ML engine not configured — add config/backend doc in Firestore.');
        const mlRes = await fetchWithTimeout(`${_mlBackendUrl}/predict`, {
          method: 'POST', timeout: FETCH_TIMEOUT,
          headers: await getMlAuthHeaders(),
          body: JSON.stringify(payload),
        });
        if (!mlRes.ok) { const err = await mlRes.json().catch(() => ({})); throw new Error(err.detail || `ML error ${mlRes.status}`); }
        const responseData = await mlRes.json();
        if (!responseData) throw new Error('Empty response from ML engine.');
        analysisResults.classList.remove('hidden'); analysisResults.style.display = 'block';
        applyAnalysisPredictions(responseData);
        lastPredictionData = responseData;

        // Apply ad copy & targeting immediately after analysis
        if (responseData.ad_copy)  updateAdTextFromAPI(responseData.ad_copy);
        if (responseData.targeting) updateTargetingFromAPI(responseData.targeting);

        step2Header.classList.remove('collapsed'); step2Content.classList.remove('collapsed'); step2Header.setAttribute('aria-expanded','true');
        updateGenerateButtonState();
        if (!silent) showToast('Marketing analysis complete!','success');
        return true;

      } catch (error) {
        if (!silent) showToast(`Error: ${error.message}`,'error');
        analysisResults.classList.add('hidden'); analysisResults.style.display='none';
        return false;
      } finally {
        if (!silent) { loadingStages.classList.add('hidden'); loadingStages.style.display='none'; }
        analyzeBtn.disabled=false;
        if (!silent) analyzeBtn.innerHTML=`<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline></svg> Analyze Marketing Profile <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"></polyline></svg>`;
        updateAnalyzeButtonState();
      }
    }

    document.addEventListener('DOMContentLoaded', function() {
      // Delegated handler for all copy buttons
      document.addEventListener('click', function(e) {
        const btn = e.target.closest('.copy-btn');
        if (!btn) return;
        const targetId = btn.dataset.copyTarget;
        if (!targetId) return;
        const el = document.getElementById(targetId);
        if (!el) return;
        const text = el.textContent.trim();
        if (!text || text === '-') { showToast('Nothing to copy yet', 'error'); return; }
        navigator.clipboard.writeText(text)
          .then(() => {
            showToast('Copied!', 'success');
            btn.classList.add('copied');
            setTimeout(() => btn.classList.remove('copied'), 1500);
          })
          .catch(() => showToast('Failed to copy', 'error'));
      });
      checkGPUConnection(); checkMLEngine();
      // activeBenchmarks is updated from the API response after each /predict call
      productCategory.addEventListener('change', () => { delete productCategory.dataset.autoResolved; updateCategoryFields(); updateDecisionLogic(); updateProfileSummary(); updateAnalyzeButtonState(); populateProductTypeDropdown(productCategory.value); });
      occasion.addEventListener('change', () => { updateAnalyzeButtonState(); updateProfileSummary(); });
      ageRangeSelect.addEventListener('change', () => { updateDecisionLogic(); updateAnalyzeButtonState(); updateProfileSummary(); const humanAgeField = document.getElementById('humanAge'); if (humanAgeField) humanAgeField.value = ageRangeSelect.value; });
      genderSelect.addEventListener('change', () => { updateDecisionLogic(); updateAnalyzeButtonState(); updateProfileSummary(); const gd = document.getElementById('gender-disclaimer'); if (gd) gd.style.display = ['non-binary','all-genders'].includes(genderSelect.value) ? 'block' : 'none'; });
      document.querySelectorAll('input[name="funnelStage"]').forEach(r => r.addEventListener('change', () => { updateDecisionLogic(); updateAnalyzeButtonState(); updateProfileSummary(); }));
      setupSectionToggle(step1Header, step1Content);
      setupSectionToggle(step2Header, step2Content);
      step2Header.classList.add('collapsed'); step2Content.classList.add('collapsed');
      humanOptionsSection.classList.add('hidden'); humanOptionsSection.style.display = 'none';
      const humanAgeField = document.getElementById('humanAge'); if (humanAgeField && ageRangeSelect.value) humanAgeField.value = ageRangeSelect.value;
      includeHumanFace.addEventListener('change', () => { if (includeHumanFace.checked) { humanOptionsSection.classList.remove('hidden'); humanOptionsSection.style.display = 'block'; } else { humanOptionsSection.classList.add('hidden'); humanOptionsSection.classList.add('hidden'); humanOptionsSection.style.display = 'none'; } });
      productType.addEventListener('change', updateGenerateButtonState);
      productColor.addEventListener('input', updateGenerateButtonState);
      sceneDescription.addEventListener('input', updateGenerateButtonState);
      brandStyleSelect.addEventListener('change', () => { updateGenerateButtonState(); onStep2SelectionChange(); });
      durationSelect.addEventListener('change', updateGenerateButtonState);
      document.querySelectorAll('input[name="output-type"]').forEach(radio => {
        radio.addEventListener('change', () => { const dg = document.getElementById('duration-group'); if(radio.value==='video'){dg.classList.remove('hidden');dg.style.display='block';}else{dg.classList.add('hidden');dg.style.display='none';}; updateGenerateButtonState(); onStep2SelectionChange(); });
      });
      document.querySelectorAll('input[name="aspect-ratio"]').forEach(radio => {
        radio.addEventListener('change', onStep2SelectionChange);
      });
      setInterval(checkMLEngine, 30000); setInterval(checkGPUConnection, 60000);
      updateAnalyzeButtonState(); updateGenerateButtonState();
      // Exposed so the creative-first cards (content type / style, wired lower
      // in this file) can re-check Generate Creative's enabled state.
      window.updateGenerateButtonState = updateGenerateButtonState;

    analyzeBtn.addEventListener('click', () => runMarketingAnalysis({ silent: false }));

    // Primary action: "Generate Variations" — produces several genuinely
    // different creative concepts for the same product/shade/style in one
    // click (spec item 6). The legacy single-shot runGeneration() path below
    // is kept only for the old regenerateBtn wiring on the single preview
    // panel (unused by this button, but left intact so nothing that depended
    // on it breaks).
    generateCreativeBtn.addEventListener('click', function() {
      generateCreativeVariations();
    });

    // "Create More Like This" — refines the currently selected concept into
    // 3 new executions. Button itself is also disabled during the run (see
    // generateRefinements) as a second guard against duplicate requests.
    document.getElementById('createMoreLikeThisBtn')?.addEventListener('click', function() {
      generateRefinements();
    });

    regenerateBtn.addEventListener('click', async function() {
      if (!retryPayload) { showToast('Please generate a visual first','error'); return; }
      document.getElementById('regenerateText').textContent = 'Regenerating...'; regenerateBtn.disabled = true;
      await runGeneration({ ...retryPayload, prompt: buildSilentPrompt() });
      document.getElementById('regenerateText').textContent = 'Regenerate All'; regenerateBtn.disabled = false;
    });

    downloadBtn.addEventListener('click', async function() {
      if (!lastGeneratedBlobUrl && !lastGeneratedFileUrl) { showToast('No visual to download yet','error'); return; }
      downloadBtn.disabled = true; document.getElementById('downloadText').textContent = 'Downloading...';
      try {
        let blobUrl = lastGeneratedBlobUrl;
        if (!blobUrl && lastGeneratedFileUrl) { blobUrl = await loadImageAsBlob(lastGeneratedFileUrl); lastGeneratedBlobUrl = blobUrl; }
        const a = document.createElement('a'); a.href=blobUrl; a.download=lastGeneratedFilename; a.style.display='none';
        document.body.appendChild(a); a.click(); setTimeout(() => document.body.removeChild(a), 100);
        showToast('Download started!','success');
      } catch (error) { showToast('Download failed','error'); }
      finally { downloadBtn.disabled=false; document.getElementById('downloadText').textContent='Download Visual'; }
    });

  // ── Toast on load — handles flags from password-reset.html and reset-action.html ──
  const _pwUpdated = sessionStorage.getItem('beaulix_pw_updated');
  const _toastRaw  = sessionStorage.getItem('beaulix_toast');
  if (_pwUpdated) {
    sessionStorage.removeItem('beaulix_pw_updated');
    setTimeout(() => showToast('Password updated successfully!', 'success'), 800);
  } else if (_toastRaw) {
    sessionStorage.removeItem('beaulix_toast');
    try {
      const _t = JSON.parse(_toastRaw);
      setTimeout(() => showToast(_t.message || 'Password updated!', _t.type || 'success'), 800);
    } catch(e) {
      setTimeout(() => showToast('Password updated!', 'success'), 800);
    }
  }

    }); // end DOMContentLoaded

// ═══════════════════════════════════════════════════════════════════════
// V2 CREATIVE-FIRST STUDIO — UI layer only.
// Does not call any API directly; only wires the new upload/card UI to the
// existing form fields (productType category deps, aspect-ratio, output-type,
// brandStyle) and existing buttons (regenerateBtn), so all original
// validation / payload-building / fetch logic in this file is untouched.
// ═══════════════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', function () {

  // ---- Brand asset upload: local preview + real upload to Cloudinary so the
  // product/logo/reference images become actual generation inputs. Uses the
  // existing uploadBeaulixAsset() bridge (added to cloudinary-module.js) —
  // no new storage infrastructure. ----
  // assetKey: 'product' | 'logo' | 'reference' — matches the payload fields
  // read by getBeaulixAssetPayload() below.
  window._beaulixAssets = window._beaulixAssets || {};

  // ── Stable product identity (fixes STEP 9B) ──────────────────────────
  // The Cloudinary URL returned by uploadBeaulixAsset() is NOT a stable
  // product identity: Cloudinary mints a brand-new random public_id (and
  // therefore a brand-new secure_url) on every single upload call, even
  // when the exact same file bytes are uploaded again. Since
  // window._beaulixAssets lives only in memory and is wiped on every page
  // refresh, re-opening the generator for "the same product" always meant
  // re-uploading the photo — which produced a NEW url, which was then used
  // as `productId` both when performance was saved and when it was read
  // back. That's why the historical-performance query always returned 0
  // records after a refresh: it was silently searching for a productId
  // that had never existed.
  //
  // Fix: derive productId from a SHA-256 hash of the raw file bytes
  // instead of the Cloudinary URL. Hashing the same image (same bytes)
  // always yields the same hex digest, so the SAME uploaded product keeps
  // the SAME productId across reloads, browser sessions, and repeat
  // uploads — with zero backend/schema changes, since `productId` was
  // already a plain string field.
  async function computeStableProductKey(file) {
    try {
      const buf = await file.arrayBuffer();
      const digest = await crypto.subtle.digest('SHA-256', buf);
      return 'pid_' + Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
    } catch (e) {
      console.warn('[Beaulix] computeStableProductKey failed, falling back to URL identity:', e);
      return null;
    }
  }
  // Single source of truth for "what productId do we use right now" —
  // called at BOTH save time and read time so they can never drift apart.
  // Prefers the content-hash productKey; only falls back to the (unstable)
  // Cloudinary URL if hashing itself failed for some reason.
  window.getStableProductId = function () {
    const p = window._beaulixAssets?.product;
    return p?.productKey || p?.url || null;
  };

  function wireAssetUpload(inputId, dropId, previewId, imgId, removeId, assetKey) {
    const input = document.getElementById(inputId);
    const drop = document.getElementById(dropId);
    const preview = document.getElementById(previewId);
    const img = document.getElementById(imgId);
    const removeBtn = document.getElementById(removeId);
    if (!input || !preview || !img || !removeBtn) return;

    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      if (!file) return;
      if (!file.type.startsWith('image/')) { document.dispatchEvent(new CustomEvent('beaulix-toast', { detail: { message: 'Please choose an image file', type: 'error' } })); input.value = ''; return; }
      if (file.size > 10 * 1024 * 1024) { document.dispatchEvent(new CustomEvent('beaulix-toast', { detail: { message: 'Image is larger than 10MB', type: 'error' } })); input.value = ''; return; }

      // A NEW product image invalidates any category we auto-resolved for
      // the PREVIOUS product — without this, ensureCreativeDefaults() would
      // see productCategory.value already non-empty (from the last product)
      // and never re-resolve, so every product uploaded after the first one
      // in a session silently kept the first product's category/copy. Only
      // clear it when we're the ones who set it (dataset.autoResolved) — a
      // category the user deliberately picked in Marketing Intelligence is
      // left alone even across a product swap.
      if (assetKey === 'product' && productCategory && productCategory.dataset.autoResolved === '1') {
        console.log('[BEAULIX CATEGORY] new product image uploaded — clearing previously auto-resolved category:', productCategory.value, '->', '(unset)');
        productCategory.value = '';
        delete productCategory.dataset.autoResolved;
        document.querySelectorAll('#categoryFieldsContainer select').forEach(sel => { sel.value = ''; });
        if (typeof productType !== 'undefined' && productType) { productType.value = ''; productType.disabled = true; productType.innerHTML = '<option value="" disabled selected>Select a category first</option>'; }
      }

      const reader = new FileReader();
      reader.onload = (e) => {
        img.src = e.target.result;
        preview.classList.remove('hidden');
        if (drop) drop.style.display = 'none';
      };
      reader.readAsDataURL(file);

      // Upload the real file to Cloudinary in the background so it can be
      // passed to the generation request as an actual input. If this fails
      // (offline, Cloudinary not configured, etc.) we keep the local preview
      // and simply fall back to prompt-only generation — see
      // getBeaulixAssetPayload().
      if (assetKey) {
        window._beaulixAssets[assetKey] = { status: 'uploading', url: null, productKey: null };
        // Compute the stable content-hash identity in parallel with the
        // Cloudinary upload — it only needs the local file, not the network.
        const productKeyPromise = assetKey === 'product' ? computeStableProductKey(file) : Promise.resolve(null);
        (window.uploadBeaulixAsset ? window.uploadBeaulixAsset(file) : Promise.reject(new Error('upload bridge not ready')))
          .then(async url => {
            const productKey = await productKeyPromise;
            window._beaulixAssets[assetKey] = { status: 'ready', url, productKey };
            if (assetKey === 'product') {
              console.log('[Beaulix] product identity ready — productId:', productKey || url, productKey ? '(content-hash)' : '(url fallback)');
              // STEP 9C: before reading history, pull forward any historical
              // performance records that were saved under this same product's
              // OLD (Cloudinary-URL) identity, so they become visible under
              // the new stable id. Safe to call every time — it only ever
              // migrates records it can verify belong to this exact product,
              // and does nothing if there's nothing left to migrate.
              if (productKey && window.migrateLegacyProductPerformance) {
                try {
                  await window.migrateLegacyProductPerformance(productKey);
                } catch (e) {
                  console.warn('[Beaulix] legacy performance migration failed:', e);
                }
              }
              // Warm the "Beaulix Creative Learning" cache as soon as we know
              // the product identity (spec item 10), so any observed patterns
              // are ready to show before the user even clicks Generate.
              refreshCreativeLearning?.();
            }
          })
          .catch(err => {
            window._beaulixAssets[assetKey] = { status: 'failed', url: null };
            if (window.DEBUG) console.warn(`Beaulix asset upload (${assetKey}) failed, will fall back:`, err);
          });
      }
    });

    // Drag & drop support
    if (drop) {
      ['dragover', 'dragenter'].forEach(evt => drop.addEventListener(evt, e => { e.preventDefault(); drop.style.borderColor = 'var(--primary)'; }));
      ['dragleave', 'drop'].forEach(evt => drop.addEventListener(evt, e => { e.preventDefault(); drop.style.borderColor = ''; }));
      drop.addEventListener('drop', e => {
        const file = e.dataTransfer.files && e.dataTransfer.files[0];
        if (!file) return;
        const dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
        input.dispatchEvent(new Event('change'));
      });
    }

    removeBtn.addEventListener('click', () => {
      input.value = '';
      img.src = '';
      preview.classList.add('hidden');
      if (drop) drop.style.display = '';
      if (assetKey) delete window._beaulixAssets[assetKey];
    });
  }
  wireAssetUpload('assetProductInput', 'assetProductDrop', 'assetProductPreview', 'assetProductImg', 'assetProductRemove', 'product');
  wireAssetUpload('assetLogoInput', 'assetLogoDrop', 'assetLogoPreview', 'assetLogoImg', 'assetLogoRemove', 'logo');
  wireAssetUpload('assetReferenceInput', 'assetReferenceDrop', 'assetReferencePreview', 'assetReferenceImg', 'assetReferenceRemove', 'reference');

  // Builds the optional image fields for the /generate payload. Only assets
  // that finished uploading to Cloudinary are included — a still-uploading
  // or failed asset is simply omitted, so generation always proceeds
  // (graceful fallback to prompt-only generation).
  window.getBeaulixAssetPayload = function () {
    const a = window._beaulixAssets || {};
    const payload = {};
    if (a.product?.status === 'ready')   payload.product_image_url   = a.product.url;
    if (a.logo?.status === 'ready')      payload.logo_image_url      = a.logo.url;
    if (a.reference?.status === 'ready') payload.reference_image_url = a.reference.url;
    return payload;
  };

  // Minimal toast bridge (the page's own showToast() is a closured function
  // inside the DOMContentLoaded above and isn't reachable here, so this
  // small independent toast keeps the asset validation messages visible).
  document.addEventListener('beaulix-toast', (e) => {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast-notification toast-${e.detail.type || 'info'}`;
    toast.innerHTML = `<span>${e.detail.message}</span>`;
    container.appendChild(toast);
    setTimeout(() => toast.classList.add('show'), 10);
    setTimeout(() => { toast.classList.remove('show'); setTimeout(() => toast.remove(), 300); }, 3500);
  });

  // ---- "What would you like to create?" cards → existing aspect-ratio / output-type radios ----
  document.querySelectorAll('#contentTypeGrid input[name="content-type"]').forEach(radio => {
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      const ratio = radio.dataset.ratio;
      const output = radio.dataset.output;
      const ratioRadio = document.querySelector(`input[name="aspect-ratio"][value="${ratio}"]`);
      const outputRadio = document.querySelector(`input[name="output-type"][value="${output}"]`);
      if (ratioRadio) { ratioRadio.checked = true; ratioRadio.dispatchEvent(new Event('change', { bubbles: true })); }
      if (outputRadio) { outputRadio.checked = true; outputRadio.dispatchEvent(new Event('change', { bubbles: true })); }
      window.updateGenerateButtonState?.();
    });
  });

  // ---- Creative style cards → existing #brandStyle select ----
  const brandStyleSelectEl = document.getElementById('brandStyle');
  document.querySelectorAll('#styleGrid input[name="creative-style"]').forEach(radio => {
    radio.addEventListener('change', () => {
      if (!radio.checked || !brandStyleSelectEl) return;
      brandStyleSelectEl.value = radio.value;
      brandStyleSelectEl.dispatchEvent(new Event('change', { bubbles: true }));
      window.updateGenerateButtonState?.();
    });
  });
  // Keep the cards in sync if someone changes the Advanced Options override select directly.
  if (brandStyleSelectEl) {
    brandStyleSelectEl.addEventListener('change', () => {
      const matching = document.querySelector(`#styleGrid input[name="creative-style"][value="${brandStyleSelectEl.value}"]`);
      if (matching) matching.checked = true;
    });
  }

  // ---- Auto-reveal "Advanced Marketing Insights" once analysis results exist ----
  const analysisResultsEl = document.getElementById('analysisResults');
  const insightsHeader = document.getElementById('insightsHeader');
  const insightsBody = document.getElementById('insightsBody');
  if (analysisResultsEl && insightsHeader && insightsBody) {
    const toggleInsights = () => {
      const expanded = insightsHeader.getAttribute('aria-expanded') === 'true';
      insightsHeader.classList.toggle('collapsed');
      insightsBody.classList.toggle('collapsed');
      insightsHeader.setAttribute('aria-expanded', String(!expanded));
    };
    insightsHeader.addEventListener('click', toggleInsights);
    insightsHeader.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleInsights(); } });

    const observer = new MutationObserver(() => {
      if (!analysisResultsEl.classList.contains('hidden')) {
        insightsHeader.classList.remove('hidden');
      }
    });
    observer.observe(analysisResultsEl, { attributes: true, attributeFilter: ['class'] });
  }

  // ---- Output workspace actions: Create Variation / Change Style / Change Format ----
  const createVariationBtn = document.getElementById('createVariationBtn');
  const regenerateBtnEl = document.getElementById('regenerateBtn');
  if (createVariationBtn && regenerateBtnEl) {
    createVariationBtn.addEventListener('click', () => regenerateBtnEl.click());
  }
  const changeStyleBtn = document.getElementById('changeStyleBtn');
  if (changeStyleBtn) {
    changeStyleBtn.addEventListener('click', () => {
      const target = document.getElementById('styleGrid');
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }
  const changeFormatBtn = document.getElementById('changeFormatBtn');
  if (changeFormatBtn) {
    changeFormatBtn.addEventListener('click', () => {
      const target = document.getElementById('contentTypeGrid');
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }

});
