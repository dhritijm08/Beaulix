
  import { app } from './firebase-config.js';
  import { getAuth, sendPasswordResetEmail } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js';

  const auth = getAuth(app);

  // ── Mode detection (?mode=change → change-password flow; default → forgot-password flow) ──
  const params = new URLSearchParams(window.location.search);
  const isChangeMode = params.get('mode') === 'change';

  // Customise copy based on mode
  if (isChangeMode) {
    document.title = 'Beaulix - Change Password';
    document.getElementById('pageHeading').textContent = 'Change your password';
    document.getElementById('pageSubheading').textContent =
      'Enter your account email and we\'ll send you a link to set a new password.';
    document.getElementById('resetBtn').textContent = 'Send Change Link';
    document.getElementById('resendBtn').textContent = 'Resend Change Link';
    document.getElementById('backLink').href = 'profile.html';
    document.getElementById('backLinkText').textContent = 'Back to Profile';
    document.getElementById('successBackLink').href = 'profile.html';
    document.getElementById('successBackLinkText').textContent = 'Back to Profile';
  } else {
    document.title = 'Beaulix - Reset Password';
    document.getElementById('pageHeading').textContent = 'Forgot your password?';
    document.getElementById('pageSubheading').textContent =
      'No worries! Enter the email address associated with your account and we\'ll send you a link to reset your password.';
    document.getElementById('resetBtn').textContent = 'Send Reset Link';
    document.getElementById('resendBtn').textContent = 'Resend Reset Link';
  }

  const btnLabel = document.getElementById('resetBtn').textContent;

  // ── DOM refs ──
  const resetForm        = document.getElementById('resetForm');
  const emailInput       = document.getElementById('email');
  const emailError       = document.getElementById('email-error');
  const resetBtn         = document.getElementById('resetBtn');
  const formState        = document.getElementById('formState');
  const successState     = document.getElementById('successState');
  const sentEmailDisplay = document.getElementById('sentEmailDisplay');
  const resendBtn        = document.getElementById('resendBtn');
  const cooldownText     = document.getElementById('cooldownText');
  const successToast     = document.getElementById('successToast');
  const toastMessage     = document.getElementById('toastMessage');
  const toastIcon        = document.getElementById('toastIcon');

  let lastSentEmail = '';
  let cooldownTimer = null;

  function showError(message) {
    emailInput.parentElement.classList.add('error');
    emailError.textContent = message;
    emailError.classList.add('show');
  }

  function clearError() {
    emailInput.parentElement.classList.remove('error');
    emailError.textContent = '';
    emailError.classList.remove('show');
  }

  function showToast(message, type = 'success', duration = 4000) {
    toastMessage.textContent = message;
    if (type === 'error') {
      successToast.classList.add('error-toast');
      toastIcon.innerHTML = '<line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line>';
    } else {
      successToast.classList.remove('error-toast');
      toastIcon.innerHTML = '<polyline points="20 6 9 17 4 12"></polyline>';
    }
    successToast.classList.add('show');
    setTimeout(() => successToast.classList.remove('show'), duration);
  }

  function setLoading(loading) {
    if (loading) {
      resetBtn.disabled = true;
      resetBtn.innerHTML = '<span class="btn-spinner"></span> Sending...';
    } else {
      resetBtn.disabled = false;
      resetBtn.innerHTML = btnLabel;
    }
  }

  function startCooldown(seconds) {
    resendBtn.disabled = true;
    let remaining = seconds;
    cooldownText.textContent = `You can resend in ${remaining}s`;

    if (cooldownTimer) clearInterval(cooldownTimer);

    cooldownTimer = setInterval(() => {
      remaining--;
      if (remaining <= 0) {
        clearInterval(cooldownTimer);
        cooldownTimer = null;
        resendBtn.disabled = false;
        cooldownText.textContent = '';
      } else {
        cooldownText.textContent = `You can resend in ${remaining}s`;
      }
    }, 1000);
  }

  function validateEmail() {
    const email = emailInput.value.trim();
    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    if (!email) {
      showError('Please enter your email address');
      return false;
    }
    if (!emailPattern.test(email)) {
      showError('Please enter a valid email address');
      return false;
    }
    clearError();
    return true;
  }

  function getFirebaseErrorMessage(code) {
    switch (code) {
      case 'auth/user-not-found':
        return 'No account found with this email address. Please check and try again.';
      case 'auth/invalid-email':
        return 'Please enter a valid email address.';
      case 'auth/too-many-requests':
        return 'Too many attempts. Please wait a few minutes before trying again.';
      case 'auth/network-request-failed':
        return 'Network error. Please check your internet connection and try again.';
      case 'auth/unauthorized-domain':
      case 'auth/operation-not-allowed':
        return 'This domain is not authorised to send password reset emails. Add it in the Firebase console under Authentication → Settings → Authorised domains.';
      default:
        // Surface the raw code in development so it's easy to diagnose
        if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
          return `Unable to send reset link (${code || 'unknown error'}). Tip: make sure this domain is listed under Firebase → Authentication → Settings → Authorised domains.`;
        }
        return 'Unable to send reset link. Please try again later.';
    }
  }

  async function handlePasswordReset(email) {
    setLoading(true);

    // Write the source flag to localStorage AND sessionStorage BEFORE sending the email.
    if (isChangeMode) {
      try { localStorage.setItem('beaulix_pw_source', 'profile'); } catch(e) {}
      try { sessionStorage.setItem('beaulix_pw_source', 'profile'); } catch(e) {}
    } else {
      try { localStorage.removeItem('beaulix_pw_source'); } catch(e) {}
      try { sessionStorage.removeItem('beaulix_pw_source'); } catch(e) {}
    }

    try {
      await sendPasswordResetEmail(auth, email);
      lastSentEmail = email;

      // Always show the "Check Your Email" success screen
      formState.style.display = 'none';
      successState.classList.add('show');
      sentEmailDisplay.textContent = email;
      startCooldown(60);
    } catch (error) {
      console.error('Reset error:', error.code);

      if (error.code === 'auth/user-not-found' || error.code === 'auth/invalid-email') {
        showError(getFirebaseErrorMessage(error.code));
        emailInput.focus();
      } else if (
        error.code === 'auth/too-many-requests' ||
        error.code === 'auth/network-request-failed' ||
        error.code === 'auth/unauthorized-domain' ||
        error.code === 'auth/operation-not-allowed'
      ) {
        showToast(getFirebaseErrorMessage(error.code), 'error', 8000);
      } else {
        showError(getFirebaseErrorMessage(error.code));
        emailInput.focus();
      }

      setLoading(false);
    }
  }

  // Clear error only when user types valid input
  emailInput.addEventListener('input', () => {
    const email = emailInput.value.trim();
    if (email !== '' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      clearError();
    }
  });

  emailInput.addEventListener('blur', () => {
    validateEmail();
  });

  resetForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!validateEmail()) { emailInput.focus(); return; }
    await handlePasswordReset(emailInput.value.trim());
  });

  emailInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (validateEmail()) resetForm.dispatchEvent(new Event('submit'));
    }
  });

  resendBtn.addEventListener('click', async () => {
    if (!lastSentEmail || resendBtn.disabled) return;

    resendBtn.disabled = true;
    resendBtn.textContent = 'Sending...';

    // Re-write the flag in case it was cleared
    if (isChangeMode) {
      try { localStorage.setItem('beaulix_pw_source', 'profile'); } catch(e) {}
      try { sessionStorage.setItem('beaulix_pw_source', 'profile'); } catch(e) {}
    } else {
      try { localStorage.removeItem('beaulix_pw_source'); } catch(e) {}
      try { sessionStorage.removeItem('beaulix_pw_source'); } catch(e) {}
    }
    try {
      await sendPasswordResetEmail(auth, lastSentEmail);
      showToast('Link resent! Check your inbox or spam folder.');
      startCooldown(60);
    } catch (error) {
      console.error('Resend error:', error.code);

      if (error.code === 'auth/too-many-requests') {
        showToast('Too many attempts. Please wait a few minutes.', 'error');
        startCooldown(120);
        resendBtn.disabled = false;
        resendBtn.textContent = document.getElementById('resendBtn').dataset.label || 'Resend Link';
      } else if (error.code === 'auth/user-not-found') {
        showToast('No account found with this email. Please sign up first.', 'error');
        formState.style.display = 'block';
        successState.classList.remove('show');
        resendBtn.disabled = false;
        resendBtn.textContent = document.getElementById('resendBtn').dataset.label || 'Resend Link';
        if (cooldownTimer) { clearInterval(cooldownTimer); cooldownTimer = null; }
        cooldownText.textContent = '';
      } else if (error.code === 'auth/network-request-failed') {
        showToast('Network error. Please check your connection.', 'error');
        resendBtn.disabled = false;
        resendBtn.textContent = document.getElementById('resendBtn').dataset.label || 'Resend Link';
      } else {
        showToast('Failed to resend. Please try again.', 'error');
        resendBtn.disabled = false;
        resendBtn.textContent = document.getElementById('resendBtn').dataset.label || 'Resend Link';
      }
    }
  });
