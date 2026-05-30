
  import { app } from './firebase-config.js';
  import { getAuth, createUserWithEmailAndPassword, updateProfile } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js';

  const auth = getAuth(app);

  // ── DOM refs ──────────────────────────────────────────────
  const form                 = document.getElementById('signupForm');
  const fullnameInput        = document.getElementById('fullname');
  const emailInput           = document.getElementById('email');
  const passwordInput        = document.getElementById('password');
  const confirmPasswordInput = document.getElementById('confirm-password');
  const termsCheckbox        = document.getElementById('terms');
  const fullnameError        = document.getElementById('fullname-error');
  const emailError           = document.getElementById('email-error');
  const passwordError        = document.getElementById('password-error');
  const confirmPasswordError = document.getElementById('confirm-password-error');
  const termsError           = document.getElementById('terms-error');
  const signupBtn            = document.getElementById('signupBtn');
  const successToast         = document.getElementById('successToast');
  const toastMessage         = document.getElementById('toastMessage');
  const toastIcon            = document.getElementById('toastIcon');

  // ── Redirect helper ───────────────────────────────────────
  function goToLogin() {
    const path = window.location.pathname;
    const dir  = path.substring(0, path.lastIndexOf('/') + 1);
    window.location.replace(dir + 'login.html');
  }

  // ── Helpers ───────────────────────────────────────────────
  function showError(input, errorEl, msg) {
    if (input?.parentElement) { input.parentElement.classList.add('error'); input.parentElement.classList.remove('success'); }
    if (errorEl) { errorEl.textContent = msg; errorEl.classList.add('show'); }
  }
  function clearError(input, errorEl) {
    if (input?.parentElement) { input.parentElement.classList.remove('error', 'success'); }
    if (errorEl) { errorEl.textContent = ''; errorEl.classList.remove('show'); }
  }
  function showSuccess(input) {
    if (input?.parentElement) { input.parentElement.classList.remove('error'); input.parentElement.classList.add('success'); }
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
  function getFirebaseErrorMessage(code) {
    const map = {
      'auth/email-already-in-use':  'This email is already registered. Try signing in instead.',
      'auth/invalid-email':         'Invalid email address format.',
      'auth/operation-not-allowed': 'Email/password sign up is not enabled.',
      'auth/weak-password':         'Password is too weak. Use at least 6 characters.',
      'auth/network-request-failed':'Network error. Please check your internet connection.',
      'auth/too-many-requests':     'Too many attempts. Please try again later.',
    };
    return map[code] || 'An unexpected error occurred: ' + code;
  }

  // ── Validators ────────────────────────────────────────────
  function validateFullname() {
    const v = fullnameInput.value.trim();
    if (!v)           { showError(fullnameInput, fullnameError, 'Please enter your full name'); return false; }
    if (v.length < 2) { showError(fullnameInput, fullnameError, 'Name must be at least 2 characters'); return false; }
    if (!/^[a-zA-Z\s'\-]+$/.test(v)) { showError(fullnameInput, fullnameError, 'Name can only contain letters'); return false; }
    clearError(fullnameInput, fullnameError); showSuccess(fullnameInput); return true;
  }
  function validateEmail() {
    const v = emailInput.value.trim();
    if (!v) { showError(emailInput, emailError, 'Please enter your email address'); return false; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) { showError(emailInput, emailError, 'Please enter a valid email address'); return false; }
    clearError(emailInput, emailError); showSuccess(emailInput); return true;
  }
  function validatePassword() {
    const v = passwordInput.value;
    if (!v)           { showError(passwordInput, passwordError, 'Please create a password'); return false; }
    if (v.length < 8) { showError(passwordInput, passwordError, 'Password must be at least 8 characters'); return false; }
    if (!/[A-Z]/.test(v)) { showError(passwordInput, passwordError, 'Include at least one uppercase letter (A-Z)'); return false; }
    if (!/[a-z]/.test(v)) { showError(passwordInput, passwordError, 'Include at least one lowercase letter (a-z)'); return false; }
    if (!/[0-9]/.test(v)) { showError(passwordInput, passwordError, 'Include at least one number (0-9)'); return false; }
    if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(v)) { showError(passwordInput, passwordError, 'Include at least one special character (!@#$%^&* etc.)'); return false; }
    clearError(passwordInput, passwordError); showSuccess(passwordInput); return true;
  }
  function validateConfirmPassword() {
    const v = confirmPasswordInput.value;
    if (!v) { showError(confirmPasswordInput, confirmPasswordError, 'Please confirm your password'); return false; }
    if (passwordInput.value !== v) { showError(confirmPasswordInput, confirmPasswordError, 'Passwords do not match'); return false; }
    clearError(confirmPasswordInput, confirmPasswordError); showSuccess(confirmPasswordInput); return true;
  }
  function validateTerms() {
    if (!termsCheckbox.checked) { termsError.textContent = 'You must agree to the Terms and Privacy Policy'; termsError.classList.add('show'); return false; }
    termsError.textContent = ''; termsError.classList.remove('show'); return true;
  }

  // ── Signup ────────────────────────────────────────────────
  async function handleSignup(fullname, email, password) {
    signupBtn.disabled = true;
    signupBtn.innerHTML = '<span class="btn-spinner"></span> Creating Account...';
    try {
      const cred = await createUserWithEmailAndPassword(auth, email, password);
      await updateProfile(cred.user, { displayName: fullname });

      showToast('Welcome to Beaulix, ' + fullname + '! Redirecting...');

      form.reset();
      document.querySelectorAll('.input-wrapper').forEach(w => w.classList.remove('success', 'error'));
      document.querySelectorAll('.error-message').forEach(e => { e.classList.remove('show'); e.textContent = ''; });

      setTimeout(goToLogin, 2500);

    } catch (error) {
      const msg = getFirebaseErrorMessage(error.code);
      if (error.code === 'auth/email-already-in-use' || error.code === 'auth/invalid-email') {
        showError(emailInput, emailError, msg); emailInput.focus();
      } else if (error.code === 'auth/weak-password') {
        showError(passwordInput, passwordError, msg); passwordInput.focus();
      } else {
        showToast(msg, 'error');
      }
      signupBtn.disabled = false;
      signupBtn.innerHTML = 'Create Account';
    }
  }

  // ── Form submit ───────────────────────────────────────────
  form.addEventListener('submit', function(e) {
    e.preventDefault();
    const v1 = validateFullname();
    const v2 = validateEmail();
    const v3 = validatePassword();
    const v4 = validateConfirmPassword();
    const v5 = validateTerms();
    if (!v1) { fullnameInput.focus(); return; }
    if (!v2) { emailInput.focus(); return; }
    if (!v3) { passwordInput.focus(); return; }
    if (!v4) { confirmPasswordInput.focus(); return; }
    if (!v5) return;
    handleSignup(fullnameInput.value.trim(), emailInput.value.trim(), passwordInput.value);
  });

  // ── Real-time validation ──────────────────────────────────
  fullnameInput.addEventListener('blur', validateFullname);
  emailInput.addEventListener('blur', validateEmail);
  passwordInput.addEventListener('blur', validatePassword);
  confirmPasswordInput.addEventListener('blur', validateConfirmPassword);

  fullnameInput.addEventListener('input', () => clearError(fullnameInput, fullnameError));
  emailInput.addEventListener('input', () => clearError(emailInput, emailError));
  passwordInput.addEventListener('input', () => {
    clearError(passwordInput, passwordError);
    if (confirmPasswordInput.value !== '') validateConfirmPassword();
  });
  confirmPasswordInput.addEventListener('input', () => clearError(confirmPasswordInput, confirmPasswordError));

  termsCheckbox.addEventListener('change', () => {
    if (termsCheckbox.checked) { termsError.textContent = ''; termsError.classList.remove('show'); }
  });

  // ── Toggle password ───────────────────────────────────────
  document.querySelectorAll('.toggle-password').forEach(btn => {
    btn.addEventListener('click', function() {
      const input = document.getElementById(this.getAttribute('data-target'));
      const eyeOpen = this.querySelector('.eye-open');
      const eyeClosed = this.querySelector('.eye-closed');
      if (input.type === 'password') { input.type = 'text'; eyeOpen.style.display = 'none'; eyeClosed.style.display = 'block'; }
      else { input.type = 'password'; eyeOpen.style.display = 'block'; eyeClosed.style.display = 'none'; }
      input.focus();
    });
  });

  // ── Enter key navigation ──────────────────────────────────
  [fullnameInput, emailInput, passwordInput, confirmPasswordInput].forEach((input, i, arr) => {
    input.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (i < arr.length - 1) arr[i + 1].focus();
        else form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      }
    });
  });
