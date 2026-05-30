
  /**
   * generateVideoThumbnail(videoEl, loadingEl)
   * Loads the video up to the 1-second mark, draws that frame onto a hidden
   * canvas, converts it to a data-URL, and sets it as the video's poster.
   * The spinner overlay is hidden once the thumbnail is ready.
   */
  function generateVideoThumbnail(videoEl, loadingEl) {
    const canvas = document.getElementById('thumbCanvas');
    const ctx    = canvas.getContext('2d');

    // Seek to 1 second (or 0 if video is shorter) to get a representative frame
    videoEl.currentTime = 1;

    const onSeeked = () => {
      videoEl.removeEventListener('seeked', onSeeked);
      canvas.width  = videoEl.videoWidth  || 640;
      canvas.height = videoEl.videoHeight || 360;
      ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
      try {
        videoEl.poster = canvas.toDataURL('image/jpeg', 0.85);
      } catch (e) {
        // Cross-origin guard: if canvas is tainted, poster stays empty — no crash
        console.warn('Could not capture thumbnail (cross-origin?):', e);
      }
      // Hide the loading spinner
      if (loadingEl) loadingEl.classList.add('hidden');
      // Reset so playback starts from the beginning
      videoEl.currentTime = 0;
    };

    videoEl.addEventListener('seeked', onSeeked);
  }

  function toggleVideo(cardId) {
    const card  = document.getElementById(cardId);
    const video = card.querySelector('video');
    // Set src from data-src on first click (lazy load)
    if (!video.src && video.dataset.src) { video.src = video.dataset.src; }
    if (video.paused) { video.play(); card.classList.add('playing'); }
    else { video.pause(); card.classList.remove('playing'); }
  }

  // ── Lazy load videos + generate thumbnail on metadata load ──
  (function initVideos() {
    const videos = document.querySelectorAll('video[data-src]');
    if (!videos.length) return;

    videos.forEach(videoEl => {
      const card       = videoEl.closest('.video-card');
      const loadingEl  = card ? card.querySelector('.video-thumb-loading') : null;

      // Set src immediately so metadata (dimensions, duration) loads in background.
      // preload="metadata" ensures only a small header is fetched — not the whole file.
      videoEl.src = videoEl.dataset.src;

      videoEl.addEventListener('loadedmetadata', () => {
        generateVideoThumbnail(videoEl, loadingEl);
      });

      // Safety fallback: hide spinner after 6 s even if metadata never fires
      setTimeout(() => {
        if (loadingEl && !loadingEl.classList.contains('hidden')) {
          loadingEl.classList.add('hidden');
        }
      }, 6000);
    });
  })();

  // ── Playback event wiring ──
  document.querySelectorAll('.video-card').forEach(card => {
    const video = card.querySelector('video');
    if (video) {
      video.removeAttribute('loop');
      video.addEventListener('ended',  () => { card.classList.remove('playing'); video.currentTime = 0; });
      video.addEventListener('pause',  () => { card.classList.remove('playing'); });
      video.addEventListener('play',   () => { card.classList.add('playing'); });
    }
  });

  // ── Smooth scroll ──
  document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function(e) {
      e.preventDefault();
      const target = document.querySelector(this.getAttribute('href'));
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });

  // ── Video card click handlers ──
  const vc1 = document.getElementById('video1');
  const vc2 = document.getElementById('video2');
  if (vc1) vc1.addEventListener('click', () => toggleVideo('video1'));
  if (vc2) vc2.addEventListener('click', () => toggleVideo('video2'));

  // ── See Examples button ──
  const seeExamplesBtn = document.getElementById('seeExamplesBtn');
  if (seeExamplesBtn) seeExamplesBtn.addEventListener('click', () => { window.location.href = '#examples'; });
