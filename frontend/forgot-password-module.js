
  import { app } from './firebase-config.js';
  import { getAuth, sendPasswordResetEmail } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js';

  const auth = getAuth(app);

  const resetForm = document.getElementById('resetForm');
  const emailInput = document.getElementById('email');
  const emailError = document.getElementById('email-error');
  const resetBtn = document.getElementById('resetBtn');
  const formState = document.getElementById('formState');
  const successState = document.getElementById('successState');
  const sentEmailDisplay = document.getElementById('sentEmailDisplay');
  const resendBtn = document.getElementById('resendBtn');
  const cooldownText = document.getElementById('cooldownText');
  const successToast = document.getElementById('successToast');
  const toastMessage = document.getElementById('toastMessage');
  const toastIcon = document.getElementById('toastIcon');

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

  function setLoading(button, loading, originalText) {
    if (loading) {
      button.disabled = true;
      button.innerHTML = '<span class="btn-spinner"></span> Sending...';
    } else {
      button.disabled = false;
      button.innerHTML = originalText;
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
      default:
        return 'Unable to send reset link. Please try again later.';
    }
  }

  async function handlePasswordReset(email) {
    setLoading(resetBtn, true, 'Send Reset Link');

    try {
      const actionCodeSettings = {
        url: window.location.origin + '/reset-action.html',
        handleCodeInApp: false
      };
      await sendPasswordResetEmail(auth, email, actionCodeSettings);
      lastSentEmail = email;
      formState.style.display = 'none';
      successState.classList.add('show');
      sentEmailDisplay.textContent = email;
      startCooldown(60);
    } catch (error) {
      console.error('Reset error:', error.code);
      
      if (error.code === 'auth/user-not-found') {
        showError(getFirebaseErrorMessage(error.code));
        emailInput.focus();
      } else if (error.code === 'auth/invalid-email') {
        showError(getFirebaseErrorMessage(error.code));
        emailInput.focus();
      } else if (error.code === 'auth/too-many-requests') {
        showToast(getFirebaseErrorMessage(error.code), 'error');
      } else if (error.code === 'auth/network-request-failed') {
        showToast(getFirebaseErrorMessage(error.code), 'error');
      } else {
        showError(getFirebaseErrorMessage(error.code));
        emailInput.focus();
      }
      
      setLoading(resetBtn, false, 'Send Reset Link');
    }
  }

  // Clear error only when user starts typing valid input
  emailInput.addEventListener('input', () => {
    const email = emailInput.value.trim();
    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    
    if (email !== '' && emailPattern.test(email)) {
      clearError();
    }
  });

  // Validate on blur - show error if empty or invalid
  emailInput.addEventListener('blur', () => {
    validateEmail();
  });

  // DO NOT clear error on focus - this was causing the error to disappear
  // Instead, we only clear when typing valid input

  resetForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    // Validate before proceeding
    const isValid = validateEmail();
    
    if (!isValid) {
      emailInput.focus();
      return;
    }
    
    await handlePasswordReset(emailInput.value.trim());
  });

  resendBtn.addEventListener('click', async () => {
    if (!lastSentEmail || resendBtn.disabled) return;

    resendBtn.disabled = true;
    resendBtn.textContent = 'Sending...';

    try {
      const actionCodeSettings = {
        url: window.location.origin + '/reset-action.html',
        handleCodeInApp: false
      };
      await sendPasswordResetEmail(auth, lastSentEmail, actionCodeSettings);
      showToast('Reset link resent! Check your inbox or spam folder.');
      startCooldown(60);
    } catch (error) {
      console.error('Resend error:', error.code);
      
      if (error.code === 'auth/too-many-requests') {
        showToast('Too many attempts. Please wait a few minutes.', 'error');
        startCooldown(120);
        resendBtn.disabled = false;
        resendBtn.textContent = 'Resend Reset Link';
      } else if (error.code === 'auth/user-not-found') {
        showToast('No account found with this email. Please sign up first.', 'error');
        // Go back to form state
        formState.style.display = 'block';
        successState.classList.remove('show');
        resendBtn.disabled = false;
        resendBtn.textContent = 'Resend Reset Link';
        if (cooldownTimer) {
          clearInterval(cooldownTimer);
          cooldownTimer = null;
        }
        cooldownText.textContent = '';
      } else if (error.code === 'auth/network-request-failed') {
        showToast('Network error. Please check your connection.', 'error');
        resendBtn.disabled = false;
        resendBtn.textContent = 'Resend Reset Link';
      } else {
        showToast('Failed to resend. Please try again.', 'error');
        resendBtn.disabled = false;
        resendBtn.textContent = 'Resend Reset Link';
      }
    }
  });

  emailInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (validateEmail()) {
        resetForm.dispatchEvent(new Event('submit'));
      }
    }
  });
