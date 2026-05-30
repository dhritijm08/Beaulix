
  import { app } from './firebase-config.js';
  import { getAuth } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js';
  import { getFirestore, collection, getDocs, deleteDoc, doc, orderBy, query } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';
  import { initNavAuth } from './nav-module.js';

  const auth = getAuth(app);
  const db = getFirestore(app);

  const pageLoader = document.getElementById('pageLoader');
  const historyContainer = document.getElementById('historyContainer');
  const itemCount = document.getElementById('itemCount');
  const toast = document.getElementById('toast');
  const toastMsg = document.getElementById('toastMsg');
  const deleteModal = document.getElementById('deleteModal');
  const confirmDeleteBtn = document.getElementById('confirmDeleteBtn');
  const cancelDeleteBtn = document.getElementById('cancelDeleteBtn');
  const lightbox = document.getElementById('lightbox');
  const lightboxClose = document.getElementById('lightboxClose');
  const lightboxMedia = document.getElementById('lightboxMedia');
  const lightboxMeta = document.getElementById('lightboxMeta');
  const lightboxPrompt = document.getElementById('lightboxPrompt');
  const lbDownload = document.getElementById('lbDownload');
  const lbDelete = document.getElementById('lbDelete');

  let historyItems = [];
  let activeItem = null;
  let pendingDeleteId = null;
  let currentUserId = null;

  function showToast(msg, type = 'success') {
    toastMsg.textContent = msg;
    toast.className = `toast ${type} show`;
    setTimeout(() => toast.classList.remove('show'), 3500);
  }

  function formatDate(ts) {
    if (!ts) return '';
    const d = ts.toDate ? ts.toDate() : new Date(ts);
    return d.toLocaleDateString('en-US', { day:'numeric', month:'short', year:'numeric' }) + ' · ' + d.toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit' });
  }

  function renderGrid(items) {
    itemCount.textContent = `${items.length} visual${items.length !== 1 ? 's' : ''}`;

    if (items.length === 0) {
      historyContainer.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 8v4l3 3"/><circle cx="12" cy="12" r="10"/></svg>
          </div>
          <h2>No history yet</h2>
          <p>Generate your first visual and it will appear here automatically.</p>
          <a href="generator.html" class="go-generate-btn">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
            Go to Generator
          </a>
        </div>`;
      return;
    }

    historyContainer.innerHTML = `<div class="history-grid" id="historyGrid"></div>`;
    const grid = document.getElementById('historyGrid');

    items.forEach(item => {
      const card = document.createElement('div');
      card.className = 'history-card';
      card.dataset.id = item.id;

      const isVideo = item.outputType === 'video';
      // imageData is now a Cloudinary thumbnail URL or base64 fallback
      const imgSrc = item.imageData && item.imageData !== 'video' && item.imageData !== ''
        ? item.imageData : null;

      const thumbHtml = imgSrc
        ? `<img src="${imgSrc}" alt="Generated visual" loading="lazy" />`
        : `<div class="thumb-placeholder"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polygon points="5 3 19 12 5 21 5 3"/></svg><span>${isVideo ? 'Video' : 'No preview'}</span></div>`;

      const tags = [item.category, item.funnel, item.aspectRatio].filter(Boolean);

      card.innerHTML = `
        <div class="card-thumb">
          ${thumbHtml}
          <span class="output-badge">${isVideo ? '▶ Video' : '🖼 Image'}</span>
          <div class="card-overlay">
            <button class="overlay-btn view" title="View" data-action="view" data-id="${item.id}">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
            </button>
            <button class="overlay-btn download" title="Download" data-action="download" data-id="${item.id}">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            </button>
            <button class="overlay-btn delete" title="Delete" data-action="delete" data-id="${item.id}">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>
            </button>
          </div>
        </div>
        <div class="card-info">
          <div class="card-meta">${tags.map(t => `<span class="meta-tag">${t}</span>`).join('')}</div>
          <div class="card-date">${formatDate(item.timestamp)}</div>
          ${item.prompt ? `<div class="card-prompt">${item.prompt}</div>` : ''}
        </div>`;

      grid.appendChild(card);
    });
  }

  // Event delegation for card overlay buttons
  historyContainer.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    e.stopPropagation();
    const id = btn.dataset.id;
    const action = btn.dataset.action;
    if (action === 'view') openLightbox(id);
    else if (action === 'download') downloadItem(id);
    else if (action === 'delete') promptDelete(id);
  });

  window.openLightbox = function(id) {
    const item = historyItems.find(i => i.id === id);
    if (!item) return;
    activeItem = item;

    const isVideo = item.outputType === 'video';
    if (isVideo && item.cloudinaryUrl) {
      lightboxMedia.innerHTML = `
        <video controls autoplay muted playsinline
          style="width:100%;max-height:65vh;object-fit:contain;display:block;background:#000;"
          src="${item.cloudinaryUrl}">
          Your browser doesn't support HTML5 video.
        </video>`;
    } else if (!isVideo && item.cloudinaryUrl) {
      lightboxMedia.innerHTML = `<img src="${item.cloudinaryUrl}" class="lightbox-img" alt="Generated visual" />`;
    } else if (item.imageData && item.imageData !== 'video' && item.imageData !== '') {
      lightboxMedia.innerHTML = `<img src="${item.imageData}" class="lightbox-img" alt="Generated visual" />`;
    } else {
      lightboxMedia.innerHTML = `<div style="color:var(--primary-light);text-align:center;padding:40px;font-size:14px;">Preview not available for this ${item.outputType}</div>`;
    }

    const tags = [item.category, item.funnel, item.brandStyle, item.aspectRatio, item.productType].filter(Boolean);
    lightboxMeta.innerHTML = tags.map(t => `<span class="meta-tag">${t}</span>`).join('');
    lightboxPrompt.textContent = item.prompt || '';
    lightbox.classList.add('show');
    document.body.style.overflow = 'hidden';
  };

  function closeLightbox() {
    lightbox.classList.remove('show');
    document.body.style.overflow = '';
    lightboxMedia.innerHTML = '';
    activeItem = null;
  }

  lightboxClose.addEventListener('click', closeLightbox);
  lightbox.addEventListener('click', e => { if (e.target === lightbox) closeLightbox(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeLightbox(); });

  window.downloadItem = async function(id) {
    const item = historyItems.find(i => i.id === id);
    if (!item) return;

    const isVideo = item.outputType === 'video';
    const ext = isVideo ? 'mp4' : 'jpg';
    const filename = `beaulix-${item.outputType}-${Date.now()}.${ext}`;

    // Always prefer cloudinaryUrl — it's the full-quality file
    const downloadUrl = item.cloudinaryUrl || null;

    if (downloadUrl) {
      try {
        showToast('Preparing download...');
        const resp = await fetch(downloadUrl);
        if (!resp.ok) throw new Error('Fetch failed');
        const blob = await resp.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = filename;
        document.body.appendChild(a); a.click();
        setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
        showToast('Download started!');
      } catch (e) {
        // Fallback to base64 thumbnail for images only
        if (!isVideo && item.imageData && item.imageData !== 'video' && item.imageData !== '') {
          fetch(item.imageData).then(r => r.blob()).then(blob => {
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = filename;
            document.body.appendChild(a); a.click();
            setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
            showToast('Download started!');
          }).catch(() => showToast('Download failed', 'error'));
        } else {
          showToast('Download failed', 'error');
        }
      }
    } else {
      showToast('No file available to download', 'error');
    }
  };

  lbDownload.addEventListener('click', () => { if (activeItem) downloadItem(activeItem.id); });

  window.promptDelete = function(id) {
    pendingDeleteId = id;
    deleteModal.classList.add('show');
  };

  lbDelete.addEventListener('click', () => {
    if (!activeItem) return;
    const id = activeItem.id;
    closeLightbox();
    promptDelete(id);
  });

  cancelDeleteBtn.addEventListener('click', () => {
    deleteModal.classList.remove('show');
    pendingDeleteId = null;
  });

  deleteModal.addEventListener('click', (e) => {
    if (e.target === deleteModal) {
      deleteModal.classList.remove('show');
      pendingDeleteId = null;
    }
  });

  document.querySelector('.modal-box').addEventListener('click', (e) => {
    e.stopPropagation();
  });

  // ── Cloudinary deletion via Cloud Function ────────────────────────
  // The API secret must NEVER live in browser JS.  All deletions are
  // routed through the authenticated deleteCloudinaryAsset Cloud Function.
  async function deleteFromCloudinary(cloudinaryUrl) {
    if (!cloudinaryUrl) return;
    try {
      const { getFunctions, httpsCallable } = await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-functions.js');
      const functions = getFunctions(app);
      const deleteAsset = httpsCallable(functions, 'deleteCloudinaryAsset');
      const resourceType = cloudinaryUrl.includes('/video/') ? 'video' : 'image';
      await deleteAsset({ cloudinaryUrl, resourceType });
    } catch (e) {
      console.error('Cloudinary delete failed:', e);
    }
  }

  confirmDeleteBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!pendingDeleteId) return;
    const userId = currentUserId || auth.currentUser?.uid;
    if (!userId) { showToast('Not logged in. Please refresh.', 'error'); return; }
    confirmDeleteBtn.textContent = 'Deleting...';
    confirmDeleteBtn.disabled = true;
    try {
      const item = historyItems.find(i => i.id === pendingDeleteId);
      await deleteDoc(doc(db, 'users', userId, 'history', pendingDeleteId));
      if (item && item.cloudinaryUrl) {
        await deleteFromCloudinary(item.cloudinaryUrl);
      }
      historyItems = historyItems.filter(i => i.id !== pendingDeleteId);
      renderGrid(historyItems);
      showToast('Deleted successfully');
    } catch (e) {
      console.error(e);
      showToast('Delete failed. Please try again.', 'error');
    }
    deleteModal.classList.remove('show');
    pendingDeleteId = null;
    confirmDeleteBtn.textContent = 'Yes, Delete';
    confirmDeleteBtn.disabled = false;
  });

  async function loadHistory(userId) {
    try {
      const q = query(collection(db, 'users', userId, 'history'), orderBy('timestamp', 'desc'));
      const snapshot = await getDocs(q);
      historyItems = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
      renderGrid(historyItems);
    } catch (e) {
      console.error('Failed to load history:', e);
      historyContainer.innerHTML = `<div class="empty-state"><p style="color:#ef4444;">Failed to load history. Please refresh.</p></div>`;
      itemCount.textContent = '0 visuals';
    }
  }

  initNavAuth({
    injectDropdownLinks: true,
    onUser: user => {
      document.body.style.visibility = 'visible';
      currentUserId = user.uid;
      loadHistory(user.uid).then(() => {
        setTimeout(() => pageLoader.classList.add('hidden'), 400);
      });
    },
    onNoUser: () => {
      window.location.href = 'login.html';
    }
  });
