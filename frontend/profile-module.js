
  import { app } from './firebase-config.js';
  import { getAuth, onAuthStateChanged, updateProfile, signOut } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js';
  import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-functions.js';
  import { initNavAuth, getLocalAvatar, getInitials, renderNavAvatar } from './nav-module.js';
  // Cloudinary credentials fetched at runtime
  let CLOUDINARY_CLOUD = null;
  let CLOUDINARY_PRESET = null;
  async function _ensureCloudinaryConfig() {
    if (CLOUDINARY_CLOUD && CLOUDINARY_PRESET) return;
    const { getFunctions: _getFns, httpsCallable: _call } = await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-functions.js');
    const fns = _getFns(app);
    const result = await _call(fns, 'cloudinaryConfig')();
    CLOUDINARY_CLOUD = result.data.cloud;
    CLOUDINARY_PRESET = result.data.preset;
  }

  const auth = getAuth(app);

  const successToast = document.getElementById('successToast');
  const toastMessage = document.getElementById('toastMessage');
  const toastIcon = document.getElementById('toastIcon');
  const avatarDisplay = document.getElementById('avatarDisplay');
  const avatarUploadBtn = document.getElementById('avatarUploadBtn');
  const avatarFileInput = document.getElementById('avatarFileInput');
  const displayNameLarge = document.getElementById('displayNameLarge');
  const memberSince = document.getElementById('memberSince');
  const nameValue = document.getElementById('nameValue');
  const emailValue = document.getElementById('emailValue');
  const providerValue = document.getElementById('providerValue');
  const uidValue = document.getElementById('uidValue');
  const editToggleBtn = document.getElementById('editToggleBtn');
  const nameEditWrapper = document.getElementById('nameEditWrapper');
  const nameEditInput = document.getElementById('nameEditInput');
  const nameEditError = document.getElementById('nameEditError');
  const editActions = document.getElementById('editActions');
  const saveBtn = document.getElementById('saveBtn');
  const cancelEditBtn = document.getElementById('cancelEditBtn');
  const logoutBtn = document.getElementById('logoutBtn');
  const logoutModal = document.getElementById('logoutModal');
  let isLoggingOut = false;
  const confirmLogoutBtn = document.getElementById('confirmLogoutBtn');
  const cancelLogoutBtn = document.getElementById('cancelLogoutBtn');
  let isEditMode = false;
  let currentUser = null;

  function showToast(message, type = 'success', duration = 4000) {
    toastMessage.textContent = message;
    if (type === 'error') { successToast.classList.add('error-toast'); toastIcon.innerHTML = '<line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line>'; }
    else { successToast.classList.remove('error-toast'); toastIcon.innerHTML = '<polyline points="20 6 9 17 4 12"></polyline>'; }
    successToast.classList.add('show');
    setTimeout(() => successToast.classList.remove('show'), duration);
  }

  // getInitials imported from nav-module.js
  function formatDate(timestamp) { if (!timestamp) return '—'; return new Date(timestamp).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }); }
  function getProviderName(user) { return user.providerData.some(p => p.providerId === 'google.com') ? 'Google' : 'Email & Password'; }
  function isGoogleUser(user) { return user.providerData.some(p => p.providerId === 'google.com'); }
  function getAvatarUrl(user) { return getLocalAvatar(user.uid, user.photoURL); }

  function renderProfile(user) {
    const name = user.displayName || 'Beaulix User';
    const email = user.email || 'Not available';
    const photoURL = getAvatarUrl(user);
    if (photoURL) { avatarDisplay.innerHTML = `<img src="${photoURL}" alt="Profile" class="profile-avatar" referrerpolicy="no-referrer" />`; }
    else { avatarDisplay.innerHTML = `<div class="avatar-placeholder">${getInitials(name)}</div>`; }
    displayNameLarge.textContent = name;
    memberSince.textContent = formatDate(user.metadata?.creationTime);
    nameValue.textContent = name;
    emailValue.innerHTML = `${email} <span class="info-badge verified"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"></polyline></svg>Verified</span>`;
    providerValue.innerHTML = isGoogleUser(user) ? `<span class="info-badge google"><svg width="12" height="12" viewBox="0 0 24 24"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>Google</span>` : `<span class="info-badge verified"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="14" rx="2"></rect><path d="M3 7l9 6 9-6"></path></svg>Email & Password</span>`;
    uidValue.textContent = user.uid;
    nameEditInput.value = user.displayName || '';
  }

  function updateNavAvatar(user) {
    renderNavAvatar(document.getElementById('userProfile'), user);
  }

  function enterEditMode() {
    isEditMode = true;
    nameValue.classList.add('hidden');
    nameEditWrapper.classList.add('show');
    editActions.classList.add('show');
    avatarUploadBtn.classList.add('show');
    nameEditInput.value = currentUser.displayName || '';
    nameEditInput.focus();
    editToggleBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>Cancel`;
    editToggleBtn.classList.add('cancel');
  }

  function exitEditMode() {
    isEditMode = false;
    nameValue.classList.remove('hidden');
    nameEditWrapper.classList.remove('show');
    editActions.classList.remove('show');
    avatarUploadBtn.classList.remove('show');
    nameEditError.classList.remove('show');
    nameEditInput.classList.remove('error');
    editToggleBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>Edit Profile`;
    editToggleBtn.classList.remove('cancel');
  }

  async function saveProfile() {
    const newName = nameEditInput.value.trim();
    if (!newName) { nameEditInput.classList.add('error'); nameEditError.textContent = 'Name cannot be empty'; nameEditError.classList.add('show'); nameEditInput.focus(); return; }
    if (newName.length < 2) { nameEditInput.classList.add('error'); nameEditError.textContent = 'Name must be at least 2 characters'; nameEditError.classList.add('show'); nameEditInput.focus(); return; }
    if (!/^[a-zA-Z\s'-]+$/.test(newName)) { nameEditInput.classList.add('error'); nameEditError.textContent = 'Name can only contain letters, spaces, hyphens'; nameEditError.classList.add('show'); nameEditInput.focus(); return; }
    if (newName === currentUser.displayName) { exitEditMode(); return; }
    saveBtn.disabled = true; saveBtn.innerHTML = '<span class="btn-spinner"></span> Saving...';
    try { await updateProfile(currentUser, { displayName: newName }); showToast('Profile updated successfully!'); renderProfile(currentUser); updateNavAvatar(currentUser); exitEditMode(); } 
    catch (error) { showToast('Failed to update profile. Please try again.', 'error'); }
    saveBtn.disabled = false; saveBtn.innerHTML = 'Save Changes';
  }

  function openLogoutModal() { logoutModal.classList.add('show'); document.body.style.overflow = 'hidden'; }
  function closeLogoutModal() { logoutModal.classList.remove('show'); document.body.style.overflow = ''; }
  async function handleLogout() { confirmLogoutBtn.disabled = true; confirmLogoutBtn.textContent = 'Signing out...'; try { isLoggingOut = true; await signOut(auth); window.location.href = 'index.html'; } catch (error) { showToast('Failed to sign out. Please try again.', 'error'); confirmLogoutBtn.disabled = false; confirmLogoutBtn.textContent = 'Yes, Sign Out'; closeLogoutModal(); } }

  editToggleBtn.addEventListener('click', () => { if (isEditMode) exitEditMode(); else enterEditMode(); });
  saveBtn.addEventListener('click', saveProfile);
  cancelEditBtn.addEventListener('click', exitEditMode);
  nameEditInput.addEventListener('focus', () => { nameEditInput.classList.remove('error'); nameEditError.classList.remove('show'); });
  nameEditInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveProfile(); } });
  logoutBtn.addEventListener('click', openLogoutModal);
  confirmLogoutBtn.addEventListener('click', handleLogout);
  cancelLogoutBtn.addEventListener('click', closeLogoutModal);
  logoutModal.addEventListener('click', (e) => { if (e.target === logoutModal) closeLogoutModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && logoutModal.classList.contains('show')) closeLogoutModal(); });

  avatarFileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) { showToast('Please select an image file.', 'error'); return; }
    if (file.size > 5 * 1024 * 1024) { showToast('Image must be less than 5MB.', 'error'); return; }

    showToast('Uploading avatar…', 'info');
    try {
      // Capture old Cloudinary URL before overwriting, so we can clean it up after upload.
      const oldAvatarUrl = localStorage.getItem(`beaulix_avatar_${currentUser.uid}`) || '';

      await _ensureCloudinaryConfig();
      // Upload to Cloudinary — stores a URL (~100 chars) instead of raw base64
      // (~2.7 MB), avoiding the localStorage 5 MB exhaustion documented in nav-module.js.
      const formData = new FormData();
      formData.append('file', file, 'beaulix_avatar.jpg');
      formData.append('upload_preset', CLOUDINARY_PRESET);
      formData.append('folder', 'beaulix/avatars');
      const res = await fetch(
        `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD}/image/upload`,
        { method: 'POST', body: formData }
      );
      if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
      const data = await res.json();
      const avatarUrl = data.secure_url;

      // Persist the URL (not base64) so localStorage stays well under its 5 MB cap.
      localStorage.setItem(`beaulix_avatar_${currentUser.uid}`, avatarUrl);
      avatarDisplay.innerHTML = `<img src="${avatarUrl}" alt="Profile" class="profile-avatar" />`;
      updateNavAvatar(currentUser);
      showToast('Profile photo saved!', 'success');

      // Delete the previous avatar from Cloudinary storage to avoid accumulation.
      if (oldAvatarUrl && oldAvatarUrl.includes('cloudinary.com')) {
        try {
          const functions = getFunctions(app);
          const deleteAsset = httpsCallable(functions, 'deleteCloudinaryAsset');
          await deleteAsset({ cloudinaryUrl: oldAvatarUrl, resourceType: 'image' });
        } catch (deleteErr) {
          // Non-fatal: log but don't surface to the user.
          console.warn('Failed to delete old avatar from Cloudinary:', deleteErr.message);
        }
      }
    } catch (err) {
      console.error('Avatar upload error:', err);
      showToast('Upload failed — please try again.', 'error');
    }
    avatarFileInput.value = '';
  });

  initNavAuth({ injectDropdownLinks: false });

  onAuthStateChanged(auth, (user) => { 
    if (user) { 
      currentUser = user; 
      renderProfile(user); 
      updateNavAvatar(user);
      // Show toast from password-change flow (set by reset-action.html)
      const _toastRaw = sessionStorage.getItem('beaulix_toast');
      if (_toastRaw) {
        try {
          const { message, type } = JSON.parse(_toastRaw);
          sessionStorage.removeItem('beaulix_toast');
          setTimeout(() => showToast(message, type), 400);
        } catch {}
      }
    } else { 
      if (!isLoggingOut) { window.location.href = 'login.html'; }
    } 
  });
