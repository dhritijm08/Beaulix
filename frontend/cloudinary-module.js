/**
 * cloudinary-module.js
 * Handles Cloudinary upload, local fallback encoding, and Firestore history saves.
 * Imported as an ES module by generator.html.
 *
 * Usage:
 *   import { initCloudinaryModule } from './cloudinary-module.js';
 *   initCloudinaryModule({ app, currentUserIdRef, ngrokHeaders, debug });
 *   // then call window.saveToHistory(fileUrl, payload) as before
 */

import { getFirestore, collection, addDoc, serverTimestamp, getDoc, doc, setDoc, query, where, getDocs, runTransaction }
  from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
// Cloudinary credentials are read from Firestore config/cloudinary (no Cloud Functions needed).
let CLOUDINARY_CLOUD = null;
let CLOUDINARY_PRESET = null;
async function _ensureCloudinaryConfig() {
  if (CLOUDINARY_CLOUD && CLOUDINARY_PRESET) return;
  const { app } = await import('./firebase-config.js');
  const db = getFirestore(app);
  const snap = await getDoc(doc(db, 'config', 'cloudinary'));
  if (!snap.exists()) throw new Error('config/cloudinary doc missing in Firestore');
  CLOUDINARY_CLOUD  = snap.data().cloud_name;
  CLOUDINARY_PRESET = snap.data().upload_preset;
}

async function uploadToCloudinary(blob, isVideo, debug) {
  await _ensureCloudinaryConfig();
  const formData    = new FormData();
  const filename    = isVideo ? 'beaulix_video.mp4' : 'beaulix_image.jpg';
  const resourceType = isVideo ? 'video' : 'image';
  const folder      = isVideo ? 'beaulix/videos' : 'beaulix/images';
  formData.append('file',           blob, filename);
  formData.append('upload_preset',  CLOUDINARY_PRESET);
  formData.append('folder',         folder);
  const res = await fetch(
    `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD}/${resourceType}/upload`,
    { method: 'POST', body: formData }
  );
  if (!res.ok) throw new Error(`Cloudinary upload failed: ${res.status}`);
  const data = await res.json();
  if (debug) console.log('✅ Cloudinary URL:', data.secure_url);
  return data.secure_url;
}

function extractVideoThumbnail(blob) {
  return new Promise(resolve => {
    const vid = document.createElement('video');
    vid.muted = true; vid.playsInline = true;
    const objUrl = URL.createObjectURL(blob);
    vid.src = objUrl; vid.currentTime = 0.5;
    vid.addEventListener('seeked', () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width  = 320;
        canvas.height = Math.round(320 * vid.videoHeight / (vid.videoWidth || 320)) || 180;
        canvas.getContext('2d').drawImage(vid, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(objUrl);
        resolve(canvas.toDataURL('image/jpeg', 0.5));
      } catch { URL.revokeObjectURL(objUrl); resolve('video'); }
    }, { once: true });
    vid.addEventListener('error', () => { URL.revokeObjectURL(objUrl); resolve('video'); }, { once: true });
    setTimeout(() => { URL.revokeObjectURL(objUrl); resolve('video'); }, 8000);
    vid.load();
  });
}

async function compressImageToBase64(blob) {
  const rawBase64 = await new Promise((res, rej) => {
    const r = new FileReader();
    r.onload  = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(blob);
  });
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const MAX = 480, ratio = Math.min(MAX / img.width, MAX / img.height, 1);
      const canvas = document.createElement('canvas');
      canvas.width  = Math.round(img.width  * ratio);
      canvas.height = Math.round(img.height * ratio);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', 0.55));
    };
    img.onerror = () => resolve(rawBase64);
    img.src = rawBase64;
  });
}

/**
 * Initialise the module. Call once after Firebase app is ready.
 * @param {object} opts
 * @param {import('firebase/app').FirebaseApp} opts.app  - Firebase app instance
 * @param {{ current: string|null }} opts.currentUserIdRef - mutable ref updated by onAuthStateChanged
 * @param {object} opts.ngrokHeaders  - headers for fetching files from the Colab/ngrok server
 * @param {boolean} [opts.debug]      - enable verbose console output
 */
export function initCloudinaryModule({ app, currentUserIdRef, ngrokHeaders, debug = false }) {
  const db = getFirestore(app);

  // Uploads a user-provided asset (product photo, brand logo, reference
  // creative) straight to Cloudinary using the existing preset/config, so
  // uploaded product images become a real, referenceable input for
  // generation instead of a local-only preview. Reuses uploadToCloudinary()
  // below — no new storage infrastructure.
  window.uploadBeaulixAsset = async function(file) {
    return uploadToCloudinary(file, false, debug);
  };

  // meta (optional): { creativeId, productId, creativeVersion, format, style,
  // generationConfig, adCopy } — extra fields used to give every generated
  // creative a durable identity so real-world consumer response can later be
  // associated with the exact creative that produced it (see Beaulix spec
  // items 10/11). No consumer-response/CTR data is invented here — this is
  // purely the generation record.
  window.saveToHistory = async function(fileUrl, payload, meta = {}) {
    const currentUserId = currentUserIdRef.current;
    if (!currentUserId) { console.warn('saveToHistory: no user logged in'); return; }
    const isVideo = payload.output_type === 'video';
    if (debug) console.log(`💾 Saving ${isVideo ? 'video' : 'image'} to history from: ${fileUrl}`);
    try {
      const blobResp = await fetch(fileUrl, { headers: ngrokHeaders });
      if (!blobResp.ok) throw new Error(`Failed to fetch file from Colab: ${blobResp.status}`);
      const blob = await blobResp.blob();
      if (debug) console.log(`📦 Blob size: ${(blob.size / 1024 / 1024).toFixed(2)} MB`);

      let imageData    = '';
      let cloudinaryUrl = '';
      if (isVideo) {
        if (debug) console.log('⬆️ Uploading video to Cloudinary...');
        try { cloudinaryUrl = await uploadToCloudinary(blob, true, debug); }
        catch (e) { console.warn('⚠️ Cloudinary video upload failed:', e.message); }
        imageData = cloudinaryUrl
          ? cloudinaryUrl.replace('/upload/', '/upload/so_0.5,w_480,h_480,c_fill,f_jpg/').replace(/\.mp4$/, '.jpg')
          : await extractVideoThumbnail(blob);
        if (debug) console.log('🖼 Video thumbnail:', cloudinaryUrl ? 'from Cloudinary' : 'from canvas');
      } else {
        if (debug) console.log('⬆️ Uploading image to Cloudinary...');
        try { cloudinaryUrl = await uploadToCloudinary(blob, false, debug); }
        catch (e) { console.warn('⚠️ Cloudinary image upload failed:', e.message); }
        imageData = cloudinaryUrl
          ? cloudinaryUrl.replace('/upload/', '/upload/w_480,h_480,c_fill,f_jpg,q_70/')
          : await compressImageToBase64(blob);
        if (debug) console.log('🖼 Image:', cloudinaryUrl ? 'uploaded to Cloudinary' : 'compressed to base64');
      }

      await addDoc(collection(db, 'users', currentUserId, 'history'), {
        imageData,
        cloudinaryUrl,
        outputType:  payload.output_type  || 'image',
        prompt:      payload.prompt       || '',
        category:    document.getElementById('productCategory')?.value || '',
        funnel:      document.querySelector('input[name="funnelStage"]:checked')?.value || '',
        brandStyle:  payload.brand_style  || '',
        aspectRatio: payload.aspect_ratio || '',
        productType: payload._productType || '',
        timestamp:   serverTimestamp(),
        // ── Creative learning foundation (spec items 10/11) ──────────────
        // Populated whenever the caller has it (the new Generate Variations
        // flow always passes these); left blank for any older call site so
        // this never becomes a required field.
        creativeId:       meta.creativeId       || payload.creative_id || '',
        parentCreativeId: meta.parentCreativeId || null,
        conceptType:      meta.conceptType      || null,
        variationLabel:   meta.variationLabel   || null,
        // variationRole: one of 'composition' | 'lighting' | 'art_direction'
        // for children created via "Create Variation" (Step 3); null for
        // the original 3 concepts and for "Create More Like This" children.
        variationRole:    meta.variationRole    || null,
        productId:        meta.productId        || '',
        creativeVersion:  meta.creativeVersion  || 1,
        format:           meta.format           || '',
        style:            meta.style            || '',
        generationConfig: meta.generationConfig || payload,
        adCopy:            meta.adCopy || null,
        // ── Performance-learning lineage (Beaulix spec STEP 8) ───────────
        // Populated only for creatives generated by "Create Next
        // Variation" learning from a measured winning variation; null for
        // every other generation path. Never invented — sourced directly
        // from the real saved performance record of the winner.
        learningSource:        meta.learningSource        || null,
        sourceVariationId:     meta.sourceVariationId     || null,
        winningCharacteristic: meta.winningCharacteristic || null,
        sourceROAS: typeof meta.sourceROAS === 'number' && isFinite(meta.sourceROAS) ? meta.sourceROAS : null,
        sourceCTR:  typeof meta.sourceCTR  === 'number' && isFinite(meta.sourceCTR)  ? meta.sourceCTR  : null,
        sourceCVR:  typeof meta.sourceCVR  === 'number' && isFinite(meta.sourceCVR)  ? meta.sourceCVR  : null,
        // consumerResponse intentionally omitted — no real-world response
        // data exists yet. Attach it here later, keyed by creativeId, once
        // a real feedback channel exists. Never populate with fake values.
      });
      if (debug) console.log('✅ Saved to Firestore history successfully');
    } catch (e) {
      console.error('❌ History save failed:', e);
    }
  };

  // ═══════════════════════════════════════════════════════════════════
  // CREATIVE PERFORMANCE — Step 4 learning foundation. Stores REAL,
  // user-entered campaign results only (never fabricated), keyed by the
  // SAME Creative ID already used throughout generation/history, together
  // with the lineage fields needed to compare creatives/variations later.
  // One document per creativeId in users/{uid}/creativePerformance — a
  // separate collection from the per-generation `history` docs above, so
  // saving performance never overwrites a creative's generation metadata.
  // ═══════════════════════════════════════════════════════════════════

  // meta: { creativeId, parentCreativeId, creativeVersion, variationRole,
  //         productId, creativeType, style, format }
  // perf: { impressions, clicks, conversions, spend, revenue } — numeric,
  //        spend/revenue may be null (optional per spec item 1). Caller
  //        (generator-init.js validatePerformanceInput) is responsible for
  //        validation before this is called; this function does not
  //        second-guess or invent values.
  window.saveCreativePerformance = async function(meta, perf) {
    const currentUserId = currentUserIdRef.current;
    // Guard BEFORE ever touching Firestore, so an unauthenticated/expired
    // session always surfaces this friendly message in the form's error
    // slot — never a raw Firebase "Missing or insufficient permissions"
    // error, which is confusing to a user who has no idea what a
    // security rule is.
    if (!currentUserId) throw new Error('You must be signed in to save performance data. Please sign in and try again.');
    if (!meta?.creativeId) throw new Error('This creative is missing its ID, so performance data cannot be saved for it.');
    // Ownership is expressed purely by the path (users/{uid}/creativePerformance/{creativeId}),
    // matching Firestore rules exactly — no duplicate "ownerId"/"userId" field is
    // written into the document body; the existing per-user subcollection path IS
    // the ownership record, same as users/{uid}/history above.
    const ref = doc(db, 'users', currentUserId, 'creativePerformance', meta.creativeId);
    console.log('[Beaulix] Saving creative performance — productId:', meta.productId, 'creativeId:', meta.creativeId);
    try {
      await setDoc(ref, {
        creativeId:       meta.creativeId,
        parentCreativeId: meta.parentCreativeId || null,
        creativeVersion:  meta.creativeVersion  || 1,
        variationRole:    meta.variationRole    || null,
        productId:        meta.productId        || null,
        creativeType:     meta.creativeType     || null,
        style:            meta.style            || null,
        format:           meta.format           || null,
        performance: {
          impressions: perf.impressions ?? null,
          clicks:      perf.clicks      ?? null,
          conversions: perf.conversions ?? null,
          spend:       perf.spend       ?? null,
          revenue:     perf.revenue     ?? null,
        },
        updatedAt: serverTimestamp(),
      }, { merge: true });
    } catch (e) {
      // Firestore's own "permission-denied" text is meaningless to an
      // end user (and, in this app, virtually always means the security
      // rules deployed to the project don't yet match this code — see
      // firestore.rules). Surface something actionable instead.
      if (e?.code === 'permission-denied') {
        throw new Error("You don't have permission to save this. If you're signed in and this keeps happening, the app's data rules may need to be updated — contact support.");
      }
      throw e;
    }
    if (debug) console.log('✅ Saved creative performance for', meta.creativeId);
  };

  // Returns the stored record (lineage + performance) for one creativeId,
  // or null if none has ever been entered — a missing doc simply means
  // "no data yet" (spec item 8), never treated as zero.
  window.getCreativePerformance = async function(creativeId) {
    const currentUserId = currentUserIdRef.current;
    if (!currentUserId || !creativeId) return null;
    const snap = await getDoc(doc(db, 'users', currentUserId, 'creativePerformance', creativeId));
    return snap.exists() ? snap.data() : null;
  };

  // Batch lookup for comparison views (spec items 5/6) — plain parallel
  // getDoc calls keyed by creativeId; no composite Firestore index needed
  // for this V1 scope (spec item 13).
  window.getCreativePerformanceBatch = async function(creativeIds) {
    const currentUserId = currentUserIdRef.current;
    if (!currentUserId || !creativeIds?.length) return {};
    const uniqueIds = [...new Set(creativeIds.filter(Boolean))];
    const results = await Promise.all(uniqueIds.map(id =>
      getDoc(doc(db, 'users', currentUserId, 'creativePerformance', id)).catch(() => null)
    ));
    const out = {};
    uniqueIds.forEach((id, i) => { out[id] = (results[i] && results[i].exists()) ? results[i].data() : null; });
    return out;
  };

  // ── Product-level performance history (spec items 9/14) ──────────────
  // Returns EVERY real creativePerformance record ever saved for this
  // productId, across ALL generation sessions/campaigns — not just the
  // creatives currently on screen. This is what lets "Beaulix Creative
  // Learning" observe patterns that persist across sessions instead of
  // resetting every time the grid is cleared. Never aggregates across
  // different productIds (a lipstick must never inherit conclusions from
  // an unrelated skincare product) — the query is scoped by productId only.
  window.getProductCreativePerformance = async function(productId) {
    const currentUserId = currentUserIdRef.current;
    if (!currentUserId || !productId) return [];
    try {
      const q = query(
        collection(db, 'users', currentUserId, 'creativePerformance'),
        where('productId', '==', productId)
      );
      const snap = await getDocs(q);
      return snap.docs.map(d => d.data());
    } catch (e) {
      console.warn('[Beaulix] getProductCreativePerformance failed:', e);
      return [];
    }
  };

  // ── STEP 9C: legacy (Cloudinary-URL) productId → stable-hash productId ──
  // Historical creativePerformance records saved before the STEP 9B fix used
  // the (unstable) Cloudinary URL as productId, so getProductCreativePerformance
  // above — which now queries by the stable content-hash id — can never see
  // them. This migrates just the `productId` field on those old records, in
  // place (same document / same creativeId), so they become reachable again.
  //
  // Scope: only THIS user's own creativePerformance subcollection is ever
  // read (users/{uid}/creativePerformance) — never other users or products.
  //
  // Safety: a Cloudinary URL productId does not, by itself, prove the record
  // belongs to the product currently open (Cloudinary mints a new URL per
  // upload, but two *different* products could each have been saved under
  // their own old URL). So before touching anything we fetch the bytes the
  // legacy URL actually points to and re-hash them; we only migrate a record
  // when that hash matches the stable id of the product currently loaded.
  window.migrateLegacyProductPerformance = async function(stableProductId) {
    const currentUserId = currentUserIdRef.current;
    if (!currentUserId || !stableProductId) return { found: 0, migrated: 0 };
    const expectedHash = stableProductId.startsWith('pid_') ? stableProductId.slice(4) : null;
    if (!expectedHash) return { found: 0, migrated: 0 }; // can't safely verify → don't touch anything

    let candidates;
    try {
      const snap = await getDocs(collection(db, 'users', currentUserId, 'creativePerformance'));
      candidates = snap.docs.filter(d => {
        const pid = d.data()?.productId;
        // "Legacy-shaped" = looks like a Cloudinary/http(s) URL, not one of
        // our own stable pid_<hash> ids and not already this product's id.
        return typeof pid === 'string' && /^https?:\/\//i.test(pid) && pid !== stableProductId;
      });
    } catch (e) {
      console.warn('[Beaulix] migrateLegacyProductPerformance: could not list records:', e);
      return { found: 0, migrated: 0 };
    }
    if (!candidates.length) return { found: 0, migrated: 0 };

    let migrated = 0;
    for (const d of candidates) {
      const legacyUrl = d.data().productId;
      try {
        // Verify this legacy URL is really the same product's image before
        // migrating — never assume every old Cloudinary URL is this product.
        const res = await fetch(legacyUrl);
        if (!res.ok) continue;
        const buf = await res.arrayBuffer();
        const digest = await crypto.subtle.digest('SHA-256', buf);
        const hex = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
        if (hex !== expectedHash) continue; // different product — leave untouched

        // Idempotent, conflict-safe update: re-check the live doc inside a
        // transaction (in case it was migrated by a concurrent call/tab
        // since we listed it) and only ever touch the productId field —
        // every other field (performance numbers, creativeId, lineage,
        // timestamps, etc.) is preserved exactly as-is.
        await runTransaction(db, async (tx) => {
          const ref = doc(db, 'users', currentUserId, 'creativePerformance', d.id);
          const fresh = await tx.get(ref);
          if (!fresh.exists()) return;
          const data = fresh.data();
          if (data.productId === stableProductId) return; // already migrated
          if (typeof data.productId !== 'string' || !/^https?:\/\//i.test(data.productId)) return; // no longer legacy
          tx.update(ref, { productId: stableProductId });
        });
        migrated++;
      } catch (e) {
        console.warn('[Beaulix] legacy performance migration skipped for record', d.id, e);
      }
    }
    if (migrated > 0) console.log(`[Beaulix] Legacy performance records migrated: ${migrated}`);
    return { found: candidates.length, migrated };
  };
}
