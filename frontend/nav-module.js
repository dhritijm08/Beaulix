/**
 * nav-module.js
 * Shared navbar auth logic for generator.html, history.html, and profile.html.
 *
 * Usage (ES module):
 *   import { initNavAuth } from './nav-module.js';
 *   initNavAuth({ onUser, onNoUser });
 *
 * The host page must have in its DOM:
 *   #userProfile, #userDropdown, #userName, #userEmail, #signOutBtn
 *
 * generator.html and history.html also need profile/history links injected into
 * the dropdown — pass injectDropdownLinks: true for those pages.
 *
 * profile.html already has those links hardcoded in HTML, so pass false (default).
 */

import { getAuth, onAuthStateChanged, signOut }
  from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js';
import { app } from './firebase-config.js';

const auth = getAuth(app);

/**
 * Return avatar URL stored in localStorage, falling back to Firebase photoURL.
 *
 * Storage contract: only Cloudinary URLs (≈100 chars) are written to localStorage.
 * Base64 strings must NOT be stored here — a single high-res image exceeds the
 * 5 MB per-origin localStorage cap and silently breaks all other storage features.
 *
 * Migration checklist (profile.html):
 *   1. On avatar select, upload to Cloudinary via cloudinary-module.js.
 *   2. Write only the returned URL: localStorage.setItem(`beaulix_avatar_${uid}`, url)
 *   3. Optionally persist to Firestore under users/{uid}.photoURL for cross-device sync.
 *   4. Remove any base64 write path from profile.html entirely.
 *   See: deleteCloudinaryAsset in functions/index.js for server-side cleanup.
 */
export function getLocalAvatar(uid, photoURL) {
  const stored = localStorage.getItem(`beaulix_avatar_${uid}`);
  if (stored) {
    // Migration band-aid: reject base64 blobs written by old code paths that stored
    // avatar images directly in localStorage.  That code path no longer exists, but
    // existing sessions may still have stale base64 data until they log in and trigger
    // this cleanup.
    // REMOVAL CRITERIA: once all active users have logged in at least once after this
    // guard was deployed (verify via Firestore — no beaulix_avatar_<uid> keys longer
    // than 500 chars remain in any user session), this entire if-block can be deleted.
    // A Cloudinary URL is always <500 chars; base64 images are typically >50 000.
    if (stored.length > 2000 || stored.startsWith("data:")) {
      console.warn(
        "[nav-module] Detected oversized base64 avatar in localStorage — removing. " +
        "Upload avatars to Cloudinary and store only the URL."
      );
      localStorage.removeItem(`beaulix_avatar_${uid}`);
      return photoURL || null;
    }
    return stored;
  }
  return photoURL || null;
}

/** Return two-character initials from a display name. */
export function getInitials(name) {
  if (!name) return '?';
  const parts = name.trim().split(' ');
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return parts[0][0].toUpperCase();
}

/**
 * Render the navbar avatar circle for the authenticated user.
 * @param {HTMLElement} userProfile - The clickable avatar container element.
 * @param {Object} user - Firebase User object.
 */
export function renderNavAvatar(userProfile, user) {
  const avatarUrl = getLocalAvatar(user.uid, user.photoURL);
  if (avatarUrl) {
    userProfile.innerHTML = `<img src="${avatarUrl}" alt="Profile"
      style="width:100%;height:100%;object-fit:cover;border-radius:50%;cursor:pointer;"
      referrerpolicy="no-referrer" />`;
  } else {
    const initials = getInitials(user.displayName || 'U');
    userProfile.innerHTML = `<div style="width:100%;height:100%;border-radius:50%;
      background:linear-gradient(135deg,#B5A89F,#8C6A4A);display:flex;
      align-items:center;justify-content:center;color:white;font-weight:700;
      font-size:14px;font-family:'Playfair Display',serif;">${initials}</div>`;
  }
}

/**
 * Initialise navbar dropdown toggle + auth-state listener.
 *
 * @param {Object} options
 * @param {Function} [options.onUser]    - Called with the Firebase user when signed in.
 * @param {Function} [options.onNoUser] - Called when no user is signed in.
 * @param {boolean}  [options.injectDropdownLinks=false]
 *   When true, Profile and History <a> elements are created and inserted before
 *   #signOutBtn (used by generator.html and history.html whose dropdown HTML only
 *   contains a sign-out button).
 */
export function initNavAuth({ onUser, onNoUser, injectDropdownLinks = false } = {}) {
  const userProfile  = document.getElementById('userProfile');
  const userDropdown = document.getElementById('userDropdown');
  const userName     = document.getElementById('userName');
  const userEmailEl  = document.getElementById('userEmail');
  const signOutBtn   = document.getElementById('signOutBtn');

  // ── Dropdown toggle ────────────────────────────────────────────
  userProfile.addEventListener('click', e => {
    e.stopPropagation();
    userDropdown.classList.toggle('show');
  });

  document.addEventListener('click', e => {
    if (!userDropdown.contains(e.target) && !userProfile.contains(e.target)) {
      userDropdown.classList.remove('show');
    }
  });

  userDropdown.addEventListener('click', e => e.stopPropagation());

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') userDropdown.classList.remove('show');
  });

  // ── Inject profile / history links into dropdown (generator & history pages) ──
  if (injectDropdownLinks) {
    const profileLink = document.createElement('a');
    profileLink.href = 'profile.html';
    profileLink.className = 'profile-link-btn';
    profileLink.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" stroke-width="2">
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
      <circle cx="12" cy="7" r="4"/></svg> My Profile`;
    signOutBtn.parentNode.insertBefore(profileLink, signOutBtn);

    const historyLink = document.createElement('a');
    historyLink.href = 'history.html';
    historyLink.className = 'profile-link-btn';
    historyLink.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" stroke-width="2">
      <path d="M12 8v4l3 3"/>
      <circle cx="12" cy="12" r="10"/></svg> History`;
    signOutBtn.parentNode.insertBefore(historyLink, signOutBtn);
  }

  // ── Sign-out button ────────────────────────────────────────────
  signOutBtn.addEventListener('click', async () => {
    try {
      await signOut(auth);
      window.location.href = 'login.html';
    } catch (err) {
      console.error('Sign out error:', err);
    }
  });

  // ── Auth state listener ────────────────────────────────────────
  onAuthStateChanged(auth, user => {
    if (user) {
      userName.textContent   = user.displayName || 'Beaulix User';
      if (userName.tagName === 'A') userName.href = 'profile.html';
      userEmailEl.textContent = user.email || '';
      renderNavAvatar(userProfile, user);

      if (typeof onUser === 'function') onUser(user);
    } else {
      if (typeof onNoUser === 'function') onNoUser();
      else window.location.href = 'login.html';
    }
  });
}
