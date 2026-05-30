/**
 * step2-module.js
 * Step 2 scoring: live predict-step2 on selection change (debounced),
 * and improvement-banner rendering after Generate.
 *
 * Usage:
 *   import { initStep2Module, renderImprovementBanner } from './step2-module.js';
 *   initStep2Module({ mlPredictStep2Fn, buildStep2Payload,
 *                     getLastPredictionData, setStep2PredictionData, debug });
 *   // Call renderImprovementBanner() after a successful Generate.
 *
 * Security: ML calls go through the Firebase Cloud Function httpsCallable
 * (mlPredictStep2Fn) — the FastAPI backend URL and API key never reach the
 * browser.  Do NOT add raw fetch() calls to the backend here.
 */

/**
 * Initialise the Step 2 live-scoring debouncer.
 *
 * @param {object}   opts
 * @param {function} opts.mlPredictStep2Fn       - () => httpsCallable ref for mlPredictStep2
 * @param {function} opts.buildStep2Payload      - () => payload object for predict-step2
 * @param {function} opts.getLastPredictionData  - () => step1 prediction data or null
 * @param {function} opts.setStep2PredictionData - (data) => void, updates caller's state
 * @param {boolean}  [opts.debug]
 * @returns {{ onStep2SelectionChange: function }}
 */
export function initStep2Module({
  mlPredictStep2Fn,
  buildStep2Payload,
  getLastPredictionData,
  setStep2PredictionData,
  debug = false,
}) {
  let debounceTimer = null;
  let activeRequestId = 0;  // monotonic counter — cheap in-flight cancellation

  async function onStep2SelectionChange() {
    if (!getLastPredictionData()) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      const thisId = ++activeRequestId;
      try {
        const callable = mlPredictStep2Fn?.();
        if (!callable) return; // Functions not yet initialised
        const payload = buildStep2Payload();
        const result  = await callable(payload);
        // Discard if a newer request has already started.
        if (thisId !== activeRequestId) {
          if (debug) console.debug('step2 response discarded (superseded by newer selection)');
          return;
        }
        if (result.data) {
          setStep2PredictionData(result.data);
          // updateStep2ScoreWidget is intentionally a no-op (widget removed);
          // data is kept in state so renderImprovementBanner has real before/after delta.
        }
      } catch (e) {
        if (debug) console.warn('Live step2 score update failed:', e);
      }
    }, 350); // 350ms debounce — avoids hammering the API on rapid changes
  }

  return { onStep2SelectionChange };
}

/**
 * Render the improvement banner after a successful Generate.
 * Call this after predict-step2 resolves on the Generate click.
 *
 * @param {object} opts
 * @param {object|null} opts.step2PredictionData  - result from predict-step2, or null
 * @param {object|null} opts.lastPredictionData   - step 1 prediction result
 * @param {object}      opts.activeBenchmarks     - { conversion, ctr, engagement }
 * @param {HTMLElement} opts.improvementBanner
 * @param {HTMLElement} opts.improvementDetails
 */
export function renderImprovementBanner({
  step2PredictionData,
  lastPredictionData,
  activeBenchmarks,
  improvementBanner,
  improvementDetails,
}) {
  if (!improvementBanner || !improvementDetails) return;

  if (step2PredictionData) {
    const s1   = step2PredictionData.step1;
    const s2   = step2PredictionData.step2;
    const pct  = step2PredictionData.pct_change;
    const bench = step2PredictionData.benchmarks || activeBenchmarks;
    let html = '';

    // Primary: step1 → step2 lift from the user's creative choices
    const hasLift = pct.conversion_rate > 0 || pct.ctr > 0 || pct.engagement_rate > 0;
    if (pct.conversion_rate > 0) html += `<span class="improvement-detail-item conversion">📈 Conv +${pct.conversion_rate.toFixed(1)}% from creative choices</span>`;
    if (pct.ctr > 0)             html += `<span class="improvement-detail-item ctr">👆 CTR +${pct.ctr.toFixed(1)}% from creative choices</span>`;
    if (pct.engagement_rate > 0) html += `<span class="improvement-detail-item engagement">❤️ Eng +${pct.engagement_rate.toFixed(1)}% from creative choices</span>`;

    // Secondary: step2 values vs industry average
    const benchConv = bench.conversion || activeBenchmarks.conversion;
    const benchCtr  = bench.ctr        || activeBenchmarks.ctr;
    const benchEng  = bench.engagement || activeBenchmarks.engagement;
    const convVsInd = ((s2.conversion_rate / benchConv - 1) * 100).toFixed(0);
    const ctrVsInd  = ((s2.ctr             / benchCtr  - 1) * 100).toFixed(0);
    const engVsInd  = ((s2.engagement_rate / benchEng  - 1) * 100).toFixed(0);
    if (s2.conversion_rate > benchConv) html += `<span class="improvement-detail-item conversion" style="opacity:0.7;font-size:0.72rem;">Conv +${convVsInd}% vs avg</span>`;
    if (s2.ctr             > benchCtr)  html += `<span class="improvement-detail-item ctr"        style="opacity:0.7;font-size:0.72rem;">CTR +${ctrVsInd}% vs avg</span>`;
    if (s2.engagement_rate > benchEng)  html += `<span class="improvement-detail-item engagement" style="opacity:0.7;font-size:0.72rem;">Eng +${engVsInd}% vs avg</span>`;

    document.querySelector('.improvement-title').textContent =
      hasLift ? 'Your creative choices improved performance! 🎯' : 'Your creative is performing well! ✨';
    if (html) { improvementDetails.innerHTML = html; improvementBanner.classList.remove('hidden'); improvementBanner.style.display = 'flex'; }

  } else if (lastPredictionData) {
    // Fallback: no step2 data — compare Step 1 result vs industry average
    const bench = activeBenchmarks;
    let html = '';
    if (lastPredictionData.conversion_rate > bench.conversion) {
      const c = ((lastPredictionData.conversion_rate - bench.conversion) / bench.conversion * 100).toFixed(0);
      html += `<span class="improvement-detail-item conversion">📈 Conversion +${c}% vs avg</span>`;
    }
    if (lastPredictionData.ctr > bench.ctr) {
      const c = ((lastPredictionData.ctr - bench.ctr) / bench.ctr * 100).toFixed(0);
      html += `<span class="improvement-detail-item ctr">👆 CTR +${c}% vs avg</span>`;
    }
    if (lastPredictionData.engagement_rate > bench.engagement) {
      const c = ((lastPredictionData.engagement_rate - bench.engagement) / bench.engagement * 100).toFixed(0);
      html += `<span class="improvement-detail-item engagement">❤️ Engagement +${c}% vs avg</span>`;
    }
    if (html) { improvementDetails.innerHTML = html; improvementBanner.classList.remove('hidden'); improvementBanner.style.display = 'flex'; }
  }
}
