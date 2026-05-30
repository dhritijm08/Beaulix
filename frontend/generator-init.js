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
    const DEBUG = false; // set true locally to enable verbose console output

    // ML backend base URL — read from Firestore config/backend on load.
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
    const categoryFieldTemplates = {
      skincare: `<div class="category-field"><label for="skinType">Skin Type *</label><select id="skinType" class="form-control" required><option value="" disabled selected>Select skin type</option><option value="oily">Oily</option><option value="dry">Dry</option><option value="combination">Combination</option><option value="normal">Normal</option><option value="sensitive">Sensitive</option><option value="mature">Mature</option></select></div><div class="category-field"><label for="primaryConcern">Primary Concern *</label><select id="primaryConcern" class="form-control" required><option value="" disabled selected>Select concern</option><option value="acne">Acne / Breakouts</option><option value="aging">Aging / Wrinkles</option><option value="pigmentation">Pigmentation / Dark Spots</option><option value="dryness">Dryness</option><option value="dullness">Dullness / Uneven Tone</option><option value="sensitivity">Sensitivity</option><option value="oil-control">Oil Control</option><option value="pores">Large Pores</option></select></div>`,
      makeup: `<div class="category-field"><label for="skinType">Skin Type *</label><select id="skinType" class="form-control" required><option value="" disabled selected>Select skin type</option><option value="oily">Oily</option><option value="dry">Dry</option><option value="combination">Combination</option><option value="normal">Normal</option><option value="sensitive">Sensitive</option><option value="mature">Mature</option></select></div><div class="category-field"><label for="primaryConcern">Makeup Focus *</label><select id="primaryConcern" class="form-control" required><option value="" disabled selected>Select focus</option><option value="coverage">Coverage / Full Face</option><option value="natural">Natural Look</option><option value="bold">Bold / Dramatic</option><option value="longwear">Long-wear</option><option value="skincare">Skincare-infused</option><option value="fresh">Fresh / Lightweight</option><option value="clean">Clean Beauty</option></select></div>`,
      fragrance: `<div class="category-field"><label for="fragranceMood">Mood / Vibe *</label><select id="fragranceMood" class="form-control" required><option value="" disabled selected>Select mood</option><option value="romantic">Romantic / Sensual</option><option value="bold">Bold / Confident</option><option value="fresh">Fresh / Clean</option><option value="warm">Warm / Cozy</option><option value="calm">Calm / Serene</option><option value="energetic">Energetic / Uplifting</option></select></div><div class="category-field"><label for="scentProfile">Scent Profile *</label><select id="scentProfile" class="form-control" required><option value="" disabled selected>Select scent</option><option value="floral">Floral</option><option value="woody">Woody</option><option value="citrus">Citrus</option><option value="oriental">Oriental</option><option value="fresh">Fresh / Aquatic</option><option value="gourmand">Gourmand</option></select></div>`,
      haircare: `<div class="category-field"><label for="hairType">Hair Type *</label><select id="hairType" class="form-control" required><option value="" disabled selected>Select hair type</option><option value="straight">Straight</option><option value="wavy">Wavy</option><option value="curly">Curly</option><option value="coily">Coily</option></select></div><div class="category-field"><label for="hairConcern">Hair Concern *</label><select id="hairConcern" class="form-control" required><option value="" disabled selected>Select concern</option><option value="damage">Damage / Breakage</option><option value="frizz">Frizz Control</option><option value="volume">Volume / Thinning</option><option value="dryness">Dryness</option><option value="color">Colour Treated</option><option value="scalp">Scalp Health</option></select></div>`,
      bodycare: `<div class="category-field"><label for="bodyConcern">Body Concern *</label><select id="bodyConcern" class="form-control" required><option value="" disabled selected>Select concern</option><option value="dryness">Dryness</option><option value="firming">Firming</option><option value="smoothing">Smoothing</option><option value="relaxation">Relaxation</option><option value="energizing">Energizing</option></select></div><div class="category-field"><label for="bodyFormat">Product Format *</label><select id="bodyFormat" class="form-control" required><option value="" disabled selected>Select format</option><option value="lotion">Lotion</option><option value="cream">Cream</option><option value="oil">Oil</option><option value="scrub">Scrub</option><option value="butter">Butter</option></select></div>`
    };

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

    function updateGenerateButtonState() {
      const analysisComplete = !analysisResults.classList.contains('hidden') && analysisResults.style.display === 'block';
      const productTypeFilled = productType.value.trim() !== '';
      const outputType = document.querySelector('input[name="output-type"]:checked')?.value;
      const durationSelected = outputType === 'video' ? durationSelect?.value : true;
      generateCreativeBtn.disabled = !(analysisComplete && productTypeFilled && durationSelected);
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

    function buildPayload() {
      const category = productCategory.value;
      let attr1='', attr2='';
      if (category==='skincare'||category==='makeup') { attr1=document.getElementById('skinType')?.value||''; attr2=document.getElementById('primaryConcern')?.value||''; }
      else if (category==='fragrance') { attr1=document.getElementById('fragranceMood')?.value||''; attr2=document.getElementById('scentProfile')?.value||''; }
      else if (category==='haircare') { attr1=document.getElementById('hairType')?.value||''; attr2=document.getElementById('hairConcern')?.value||''; }
      else if (category==='bodycare') { attr1=document.getElementById('bodyConcern')?.value||''; attr2=document.getElementById('bodyFormat')?.value||''; }
      const funnelRadio = document.querySelector('input[name="funnelStage"]:checked');
      return { product_category:category, decision_attribute_1:attr1, decision_attribute_2:attr2, funnel_stage:funnelRadio?funnelRadio.value:'', age_range:ageRangeSelect.value, gender:genderSelect.value, occasion:occasion.value, brand_style:brandStyleSelect.value||'' };
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
      const actionMap = {serum:'applying serum to face with dropper',moisturizer:'applying moisturizer to face',cream:'applying cream to face',oil:'applying oil to face',lotion:'applying lotion to skin',cleanser:'washing face with cleanser',foundation:'applying foundation with brush',lipstick:'applying lipstick to lips',perfume:'spraying perfume on neck',shampoo:'washing hair with shampoo'};
      const parts = [];
      const productSubject = productColorVal ? `${productColorVal} ${productTypeVal}` : productTypeVal;
      if (includeHuman && productTypeVal) {
        const hg = document.getElementById('humanGender')?.value||'';
        const ha = document.getElementById('humanAge')?.value||'';
        const st = document.querySelector('input[name="skin-tone"]:checked')?.value||'';
        const hr = document.getElementById('humanRegion')?.value?.trim()||'';
        const genderWord = hg==='woman'?'woman':hg==='man'?'man':'person';
        const humanDesc = [hr, genderWord, skinToneMap[st]||'', ha?`age ${ha}`:''].filter(Boolean).join(' ');
        const pl = productTypeVal.toLowerCase();
        const matchedAction = Object.entries(actionMap).find(([k]) => pl.includes(k));
        parts.push(`${productSubject} held by ${humanDesc}, ${matchedAction?matchedAction[1]:`holding ${productTypeVal}`}`);
      } else if (productTypeVal) {
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

    async function renderVisualContent(remoteUrl, outputType, retryFn) {
      const vc = document.getElementById('visualContainer');
      if (vc) vc.classList.remove('placeholder-mode');
      visualContent.innerHTML = `<div class="image-loading-wrapper loading" id="imgWrapper"><div class="image-loading-overlay" id="imgLoadingOverlay"><div class="spinner"></div><span>Loading ${outputType}...</span></div></div>`;

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
          img.onload = () => { document.getElementById('imgLoadingOverlay')?.remove(); document.getElementById('imgWrapper')?.classList.remove('loading'); downloadBtn.disabled = false; };
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
      if (category==='fragrance'){scene='Luxury fragrance';badge='Luxury Scent';}
      else if (category==='haircare'){scene='Hair care';badge='Hair Solution';}
      else if (category==='bodycare'){scene='Body care';badge='Body Care';}
      else if (category==='makeup'){scene='Makeup';badge='Makeup Look';}
      else{scene='Skincare';badge=productTypeVal||'Skincare';}
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

        showToast(`${payload.output_type === 'video' ? 'Video' : 'Image'} generated successfully!`, 'success');
      } catch (error) {
        clearInterval(interval);
        showToast(`Error: ${error.message}`, 'error');
        visualContent.innerHTML = `<div class="image-error-box"><div class="error-icon">⚠️</div><p>${error.message}</p><small>Check that your Colab notebook is still running</small><button class="retry-btn" id="retryGenBtn">Retry</button></div>`;
        document.getElementById('retryGenBtn')?.addEventListener('click', () => runGeneration(payload));
        previewBox.style.display = 'none'; generatedOutput.classList.remove('hidden'); generatedOutput.style.display = 'flex'; downloadBtn.disabled = true;
      } finally {
        generateCreativeSpinner.classList.add('hidden'); generateCreativeSpinner.style.display = 'none'; generateCreativeBtn.disabled = false;
        generationProgress.classList.add('hidden'); generationProgress.style.display = 'none'; progressBar.style.width = '0%';
        updateGenerateButtonState();
      }
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

    document.addEventListener('DOMContentLoaded', function() {
      checkGPUConnection(); checkMLEngine();
      productCategory.addEventListener('change', () => { updateCategoryFields(); updateDecisionLogic(); updateProfileSummary(); updateAnalyzeButtonState(); // activeBenchmarks is updated from the API response after each /predict call });
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
      productType.addEventListener('input', updateGenerateButtonState);
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
    });

    analyzeBtn.addEventListener('click', async function() {
      improvementBanner.classList.add('hidden'); improvementBanner.style.display = 'none';
      step2PredictionData = null;
      if (!validateMarketingProfile()) { showToast('Please fill all required fields in Step 1','error'); return; }
      loadingStages.classList.remove('hidden'); loadingStages.style.display = 'block'; analysisResults.classList.add('hidden'); analysisResults.style.display = 'none'; analyzeBtn.disabled = true;
      analyzeBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="btn-spinner"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg> Analyzing...`;
      try {
        await runStagedLoading();
        const payload = buildPayload();
        if (!_mlBackendUrl) throw new Error('ML engine not configured — add config/backend doc in Firestore.');
        const { getAuth } = await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js');
        const { app } = await import('./firebase-config.js');
        const token = await getAuth(app).currentUser?.getIdToken();
        const mlRes = await fetchWithTimeout(`${_mlBackendUrl}/predict`, {
          method: 'POST', timeout: FETCH_TIMEOUT,
          headers: { 'Content-Type': 'application/json', ...(token ? { 'Authorization': `Bearer ${token}` } : {}) },
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
        showToast('Marketing analysis complete!','success');

      } catch (error) { showToast(`Error: ${error.message}`,'error'); analysisResults.classList.add('hidden'); analysisResults.style.display='none'; }
      finally {
        loadingStages.classList.add('hidden'); loadingStages.style.display='none'; analyzeBtn.disabled=false;
        analyzeBtn.innerHTML=`<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline></svg> Analyze Marketing Profile <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"></polyline></svg>`;
        updateAnalyzeButtonState();
      }
    });

    generateCreativeBtn.addEventListener('click', async function() {
      if (analysisResults.classList.contains('hidden') || analysisResults.style.display==='none') { showToast('Please complete marketing profile analysis first','error'); return; }
      const productTypeVal = productType.value.trim();
      if (!productTypeVal) { showToast('Please enter a product type in Step 2','error'); return; }
      const aspectRatio = document.querySelector('input[name="aspect-ratio"]:checked')?.value;
      if (!aspectRatio) { showToast('Please select an aspect ratio','error'); return; }
      const outputType = document.querySelector('input[name="output-type"]:checked')?.value;
      if (!outputType) { showToast('Please select output type','error'); return; }
      if (outputType==='video' && !document.getElementById('duration')?.value) { showToast('Please select a video duration','error'); return; }

      // ── Call predict-step2 first to get a real before/after delta ───
      step2PredictionData = null; // reset
      try {
        const step2Payload = buildStep2Payload();
        if (_mlBackendUrl) {
          const { getAuth } = await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js');
          const { app } = await import('./firebase-config.js');
          const token = await getAuth(app).currentUser?.getIdToken();
          const s2Res = await fetchWithTimeout(`${_mlBackendUrl}/predict-step2`, {
            method: 'POST', timeout: FETCH_TIMEOUT,
            headers: { 'Content-Type': 'application/json', ...(token ? { 'Authorization': `Bearer ${token}` } : {}) },
            body: JSON.stringify(step2Payload),
          });
          if (s2Res.ok) step2PredictionData = await s2Res.json();
        }
      } catch (e) {
        if (DEBUG) console.warn('predict-step2 failed, falling back to step1 data:', e);
      }

      const payload = { prompt:buildSilentPrompt(), aspect_ratio:aspectRatio, output_type:outputType, brand_style:brandStyleSelect.value||'', duration:outputType==='video'?parseInt(document.getElementById('duration')?.value||4):4, num_images:1, _productType:productTypeVal };
      retryPayload = payload;
      await runGeneration(payload);
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
