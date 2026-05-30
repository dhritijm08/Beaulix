/**
 * step2-module.js
 * Step 2 scoring: live predict-step2 on selection change (debounced),
 * and improvement-banner rendering after Generate.
 *
 * Usage:
 *   import { initStep2Module, renderImprovementBanner } from './step2-module.js';
 *   initStep2Module({ mlApiBase, mlHeaders, getLastPredictionData,
 *                     getActiveBenchmarks, getStep2PredictionData,
 *                     setStep2PredictionData, brandStyleSelect, debug });
 *   // Call renderImprovementBanner() after a successful Generate.
 */

/**
 * Initialise the Step 2 live-scoring debouncer.
 *
 * @param {object} opts
 * @param {string}   opts.mlApiBase              - e.g. "http://localhost:8000"
 * @param {object}   opts.mlHeaders              - ML_HEADERS with Content-Type + optional API key
 * @param {function} opts.buildStep2Payload      - () => payload object for /predict-step2
 * @param {function} opts.getLastPredictionData  - () => step1 prediction data or null
 * @param {function} opts.setStep2PredictionData - (data) => void, updates caller's state
 * @param {boolean}  [opts.debug]
 * @returns {{ onStep2SelectionChange: function }}
 */
export function initStep2Module({
  mlApiBase,
  mlHeaders,
  buildStep2Payload,
  getLastPredictionData,
  setStep2PredictionData,
  debug = false,
}) {
  let debounceTimer = null;
  let activeController = null;  // AbortController for the in-flight request

  async function onStep2SelectionChange() {
    if (!getLastPredictionData()) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      // Cancel any request that is still in flight from the previous selection.
      if (activeController) {
        activeController.abort();
      }
      activeController = new AbortController();
      const signal = activeController.signal;
      try {
        const payload = buildStep2Payload();
        const res = await fetch(`${mlApiBase}/predict-step2`, {
          method:  'POST',
          headers: mlHeaders,
          body:    JSON.stringify(payload),
          signal,
        });
        if (res.ok) {
          const data = await res.json();
          setStep2PredictionData(data);
          // updateStep2ScoreWidget is intentionally a no-op (widget removed);
          // data is kept in state so renderImprovementBanner has real before/after delta.
        }
      } catch (e) {
        if (e.name === 'AbortError') {
          if (debug) console.debug('step2 fetch aborted (superseded by newer selection)');
          return;
        }
        console.warn('Live step2 score update failed:', e);
      } finally {
        activeController = null;
      }
    }, 350); // 350ms debounce — avoids hammering the API on rapid changes
  }

  return { onStep2SelectionChange };
}

/**
 * Render the improvement banner after a successful Generate.
 * Call this after /predict-step2 resolves on the Generate click.
 *
 * @param {object} opts
 * @param {object|null} opts.step2PredictionData  - result from /predict-step2, or null
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
    if (html) { improvementDetails.innerHTML = html; improvementBanner.style.display = 'flex'; }

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
    if (html) { improvementDetails.innerHTML = html; improvementBanner.style.display = 'flex'; }
  }
}
