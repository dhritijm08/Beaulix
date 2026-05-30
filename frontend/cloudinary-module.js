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

import { getFirestore, collection, addDoc, serverTimestamp }
  from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';
// Cloudinary credentials are fetched at runtime from the cloudinaryConfig
// Firebase Function so they are never hardcoded in static source.
// cloudinary-config.js has been removed.
let CLOUDINARY_CLOUD = null;
let CLOUDINARY_PRESET = null;
async function _ensureCloudinaryConfig() {
  if (CLOUDINARY_CLOUD && CLOUDINARY_PRESET) return;
  const { getFunctions, httpsCallable } = await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-functions.js');
  const { app } = await import('./firebase-config.js');
  const fns = getFunctions(app);
  const cloudinaryConfig = httpsCallable(fns, 'cloudinaryConfig');
  const result = await cloudinaryConfig();
  CLOUDINARY_CLOUD = result.data.cloud;
  CLOUDINARY_PRESET = result.data.preset;
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

  window.saveToHistory = async function(fileUrl, payload) {
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
          ? cloudinaryUrl.replace('/upload/', '/upload/so_0.5,w_480,f_jpg/').replace(/\.mp4$/, '.jpg')
          : await extractVideoThumbnail(blob);
        if (debug) console.log('🖼 Video thumbnail:', cloudinaryUrl ? 'from Cloudinary' : 'from canvas');
      } else {
        if (debug) console.log('⬆️ Uploading image to Cloudinary...');
        try { cloudinaryUrl = await uploadToCloudinary(blob, false, debug); }
        catch (e) { console.warn('⚠️ Cloudinary image upload failed:', e.message); }
        imageData = cloudinaryUrl
          ? cloudinaryUrl.replace('/upload/', '/upload/w_480,c_limit,f_jpg,q_70/')
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
      });
      if (debug) console.log('✅ Saved to Firestore history successfully');
    } catch (e) {
      console.error('❌ History save failed:', e);
    }
  };
}
