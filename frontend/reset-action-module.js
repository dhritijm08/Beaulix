
  import { app } from './firebase-config.js';
  import { getAuth, verifyPasswordResetCode, confirmPasswordReset } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';

  const auth = getAuth(app);

  const loadingDiv   = document.getElementById('loadingState');
  const formDiv      = document.getElementById('resetFormState');
  const successDiv   = document.getElementById('successState');
  const errorDiv     = document.getElementById('errorState');
  const userEmailEl  = document.getElementById('userEmail');
  const newPwd       = document.getElementById('new-password');
  const confirmPwd   = document.getElementById('confirm-password');
  const newPwdError  = document.getElementById('newPasswordError');
  const confirmError = document.getElementById('confirmError');
  const resetBtn     = document.getElementById('resetBtn');
  const countdownEl  = document.getElementById('countdown');
  const errorDesc    = document.getElementById('errorDescription');
  const successMsg   = document.getElementById('successMsg');
  const successBtn   = document.getElementById('successBtn');
  const formBackLink     = document.getElementById('formBackLink');
  const formBackLinkText = document.getElementById('formBackLinkText');
  const toast        = document.getElementById('successToast');
  const toastMsg     = document.getElementById('toastMessage');
  const toastIcon    = toast.querySelector('svg');

  // Detect source via two signals — whichever is available:
  // Detect profile flow via hash fragment set by reset-bridge.html.
  // The bridge appends #source=profile — this survives redirects and works
  // across all tabs, windows, and incognito since it's in the URL itself.
  const urlParams    = new URLSearchParams(window.location.search);
  const hashSource   = window.location.hash.includes('source=profile');
  const lsSource     = (() => { try { return localStorage.getItem('beaulix_pw_source') || ''; } catch(e) { return ''; } })();
  const fromProfile  = hashSource || lsSource === 'profile';
  const redirectDest = fromProfile ? 'profile.html' : 'login.html';
  // Clean up localStorage flag if present
  try { localStorage.removeItem('beaulix_pw_source'); } catch(e) {}

  let actionCode = null;
  let isResetting = false;

  const showPage = (id) => {
    [loadingDiv, formDiv, successDiv, errorDiv].forEach(d => d.classList.remove('active'));
    document.getElementById(id).classList.add('active');
  };

  const showToast = (msg, isError = false) => {
    toastMsg.textContent = msg;
    toast.classList.toggle('error-toast', isError);
    toastIcon.innerHTML = isError
      ? '<line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line>'
      : '<polyline points="20 6 9 17 4 12"></polyline>';
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 3500);
  };

  const setError = (input, errEl, msg) => {
    input.parentElement.classList.add('error');
    input.parentElement.classList.remove('success');
    errEl.textContent = msg;
    errEl.classList.add('show');
  };
  const clearErr = (input, errEl) => {
    input.parentElement.classList.remove('error', 'success');
    errEl.textContent = '';
    errEl.classList.remove('show');
  };
  const setSuccess = (input) => {
    input.parentElement.classList.remove('error');
    input.parentElement.classList.add('success');
  };

  const updateHints = (pwd) => ({
    length:  pwd.length >= 8,
    upper:   /[A-Z]/.test(pwd),
    lower:   /[a-z]/.test(pwd),
    number:  /[0-9]/.test(pwd),
    special: /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?~`]/.test(pwd),
  });

  const validateNew = () => {
    const val = newPwd.value;
    if (!val) { setError(newPwd, newPwdError, 'Please enter a new password'); return false; }
    const c = updateHints(val);
    if (!c.length)  { setError(newPwd, newPwdError, 'At least 8 characters'); return false; }
    if (!c.upper)   { setError(newPwd, newPwdError, 'Include an uppercase letter'); return false; }
    if (!c.lower)   { setError(newPwd, newPwdError, 'Include a lowercase letter'); return false; }
    if (!c.number)  { setError(newPwd, newPwdError, 'Include a number'); return false; }
    if (!c.special) { setError(newPwd, newPwdError, 'Include a special character (!@#$%^&*)'); return false; }
    clearErr(newPwd, newPwdError); setSuccess(newPwd); return true;
  };

  const validateConfirm = () => {
    const val = confirmPwd.value;
    if (!val) { setError(confirmPwd, confirmError, 'Please confirm your password'); return false; }
    if (newPwd.value !== val) { setError(confirmPwd, confirmError, 'Passwords do not match'); return false; }
    clearErr(confirmPwd, confirmError); setSuccess(confirmPwd); return true;
  };

  newPwd.addEventListener('input', () => {
    newPwd.value ? validateNew() : clearErr(newPwd, newPwdError);
    if (confirmPwd.value) validateConfirm();
  });
  confirmPwd.addEventListener('input', () => {
    confirmPwd.value ? validateConfirm() : clearErr(confirmPwd, confirmError);
  });
  newPwd.addEventListener('blur', () => newPwd.value && validateNew());
  confirmPwd.addEventListener('blur', () => confirmPwd.value && validateConfirm());

  document.querySelectorAll('.toggle-password').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const input = document.getElementById(btn.getAttribute('data-target'));
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.querySelector('svg').innerHTML = show
        ? '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line>'
        : '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle>';
      input.focus();
    });
  });

  const init = async () => {
    const params = new URLSearchParams(window.location.search);
    const mode = params.get('mode');
    const code = params.get('oobCode');

    if (mode !== 'resetPassword' || !code) {
      errorDesc.textContent = 'Invalid or missing reset link parameters.';
      showPage('errorState');
      document.body.style.visibility = 'visible';
      return;
    }
    actionCode = code;
    try {
      const email = await verifyPasswordResetCode(auth, actionCode);
      userEmailEl.textContent = email;
      newPwd.value = ''; confirmPwd.value = '';
      clearErr(newPwd, newPwdError); clearErr(confirmPwd, confirmError);
      // Update the back link based on source
      if (fromProfile) {
        formBackLink.href = 'profile.html';
        formBackLinkText.textContent = 'Back to Profile';
      }
      showPage('resetFormState');
      newPwd.focus();
    } catch (err) {
      console.error('Reset error:', err.code, err.message);
      errorDesc.textContent = {
        'auth/expired-action-code': 'This password reset link has expired.',
        'auth/invalid-action-code': 'This link has already been used or is invalid.',
        'auth/user-disabled':       'This account has been disabled.',
      }[err.code] || `Unable to verify reset link (${err.code || err.message}). Please request a new one.`;
      showPage('errorState');
    }
    document.body.style.visibility = 'visible';
  };

  const handleReset = async () => {
    if (isResetting) return;
    isResetting = true;
    resetBtn.disabled = true;
    resetBtn.innerHTML = '<span class="btn-spinner"></span> Resetting...';
    try {
      await confirmPasswordReset(auth, actionCode, newPwd.value);

      // After password reset Firebase signs the user out.
      // Both flows redirect to login.html — profile flow shows a "sign back in" message.
      if (fromProfile) {
        successMsg.textContent = 'Your password has been changed. Please sign in with your new password.';
        successBtn.textContent = 'Sign In Now';
        successBtn.href = 'login.html';
      } else {
        successMsg.textContent = 'Your password has been reset successfully. Sign in with your new password.';
        successBtn.textContent = 'Sign In Now';
        successBtn.href = 'login.html';
      }

      // Set a toast so login page shows a confirmation message
      sessionStorage.setItem('beaulix_toast', JSON.stringify({
        message: fromProfile ? 'Password changed! Please sign in again.' : 'Password reset! Please sign in.',
        type: 'success'
      }));

      showToast('Password updated! Redirecting...');
      showPage('successState');
      let count = 5;
      const timer = setInterval(() => {
        count--;
        if (countdownEl) countdownEl.textContent = count;
        if (count <= 0) {
          clearInterval(timer);
          window.location.href = 'login.html';
        }
      }, 1000);
    } catch (err) {
      resetBtn.disabled = false;
      resetBtn.innerHTML = 'Reset Password';
      isResetting = false;
      if (err.code === 'auth/weak-password') {
        setError(newPwd, newPwdError, 'Password too weak. Use 8+ chars with upper, lower, number & special char.');
        newPwd.focus();
      } else if (err.code === 'auth/expired-action-code') {
        showToast('Reset link expired.', true);
        setTimeout(() => { errorDesc.textContent = 'This link has expired. Please request a new one.'; showPage('errorState'); }, 1200);
      } else if (err.code === 'auth/invalid-action-code') {
        showToast('Invalid reset link.', true);
        setTimeout(() => { errorDesc.textContent = 'This link is no longer valid. Please request a new reset.'; showPage('errorState'); }, 1200);
      } else {
        showToast('Failed to reset password. Try again.', true);
      }
    }
  };

  document.getElementById('newPasswordForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!validateNew())     { newPwd.focus();     return; }
    if (!validateConfirm()) { confirmPwd.focus();  return; }
    await handleReset();
  });

  init();
