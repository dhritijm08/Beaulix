
  import { app } from './firebase-config.js';
  import { getAuth, signInWithEmailAndPassword, signInWithPopup, GoogleAuthProvider, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';

  const auth = getAuth(app);
  const googleProvider = new GoogleAuthProvider();

  const form = document.getElementById('loginForm');
  const emailInput = document.getElementById('email');
  const passwordInput = document.getElementById('password');
  const emailError = document.getElementById('email-error');
  const passwordError = document.getElementById('password-error');
  const loginBtn = document.querySelector('.login-btn');
  const googleBtn = document.getElementById('googleBtn');
  const successToast = document.getElementById('successToast');
  const toastMessage = document.getElementById('toastMessage');

  // ── Helpers ───────────────────────────────────────────────
  function showError(inputElement, errorElement, message) {
    inputElement.parentElement.classList.add('error');
    inputElement.parentElement.classList.remove('success');
    errorElement.textContent = message;
    errorElement.classList.add('show');
  }
  function clearError(inputElement, errorElement) {
    inputElement.parentElement.classList.remove('error', 'success');
    errorElement.textContent = '';
    errorElement.classList.remove('show');
  }
  function showSuccess(inputElement) {
    inputElement.parentElement.classList.remove('error');
    inputElement.parentElement.classList.add('success');
  }
  function showToast(message, duration = 3000) {
    toastMessage.textContent = message;
    successToast.classList.add('show');
    setTimeout(() => successToast.classList.remove('show'), duration);
  }
  function getFirebaseErrorMessage(errorCode) {
    const map = {
      'auth/invalid-email':           'Invalid email address',
      'auth/user-disabled':           'This account has been disabled',
      'auth/user-not-found':          'No account found with this email',
      'auth/wrong-password':          'Incorrect password',
      'auth/invalid-credential':      'Invalid email or password',
      'auth/too-many-requests':       'Too many failed attempts. Please try again later',
      'auth/network-request-failed':  'Network error. Please check your connection',
      'auth/popup-closed-by-user':    'Sign-in popup was closed',
      'auth/cancelled-popup-request': 'Only one popup request is allowed at a time',
    };
    return map[errorCode] || 'An error occurred. Please try again';
  }

  // ── Validators ────────────────────────────────────────────
  function validateEmail() {
    const email = emailInput.value.trim();
    if (!email) { showError(emailInput, emailError, 'Please enter your email address'); return false; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { showError(emailInput, emailError, 'Please enter a valid email address'); return false; }
    clearError(emailInput, emailError); showSuccess(emailInput); return true;
  }
  function validatePassword() {
    const password = passwordInput.value;
    if (!password) { showError(passwordInput, passwordError, 'Please enter your password'); return false; }
    if (password.length < 8) { showError(passwordInput, passwordError, 'Password must be at least 8 characters'); return false; }
    clearError(passwordInput, passwordError); showSuccess(passwordInput); return true;
  }

  // ── Auth functions ────────────────────────────────────────
  async function handleEmailLogin(email, password) {
    try {
      const userCredential = await signInWithEmailAndPassword(auth, email, password);
      showToast(`Welcome back, ${userCredential.user.email}!`);
      form.reset();
      document.querySelectorAll('.input-wrapper').forEach(w => w.classList.remove('success', 'error'));
      setTimeout(() => { window.location.href = 'generator.html'; }, 1500);
    } catch (error) {
      showError(passwordInput, passwordError, getFirebaseErrorMessage(error.code));
    }
  }
  async function handleGoogleLogin() {
    try {
      const result = await signInWithPopup(auth, googleProvider);
      showToast(`Welcome, ${result.user.displayName || result.user.email}!`);
      setTimeout(() => { window.location.href = 'generator.html'; }, 1500);
    } catch (error) {
      showToast(getFirebaseErrorMessage(error.code), 4000);
    }
  }

  // ── Event listeners ───────────────────────────────────────
  document.querySelector('.toggle-password').addEventListener('click', function() {
    const pwInput = document.getElementById(this.getAttribute('data-target'));
    const svg = this.querySelector('svg');
    const type = pwInput.getAttribute('type') === 'password' ? 'text' : 'password';
    pwInput.setAttribute('type', type);
    svg.innerHTML = type === 'text'
      ? '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line>'
      : '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle>';
  });

  emailInput.addEventListener('input', () => emailInput.value.trim() ? validateEmail() : clearError(emailInput, emailError));
  emailInput.addEventListener('blur', validateEmail);
  passwordInput.addEventListener('input', () => passwordInput.value ? validatePassword() : clearError(passwordInput, passwordError));
  passwordInput.addEventListener('blur', validatePassword);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (validateEmail() && validatePassword()) {
      const originalText = loginBtn.textContent;
      loginBtn.textContent = 'Signing In...';
      loginBtn.disabled = true;
      await handleEmailLogin(emailInput.value.trim(), passwordInput.value);
      loginBtn.textContent = originalText;
      loginBtn.disabled = false;
    }
  });

  googleBtn.addEventListener('click', async () => {
    const originalHTML = googleBtn.innerHTML;
    googleBtn.textContent = 'Signing in...';
    googleBtn.disabled = true;
    await handleGoogleLogin();
    googleBtn.innerHTML = originalHTML;
    googleBtn.disabled = false;
  });

  // ── Auth state check ──────────────────────────────────────
  onAuthStateChanged(auth, (user) => {
    if (user) { window.location.href = 'generator.html'; }
    else { document.body.style.visibility = 'visible'; }
  });

  document.addEventListener('DOMContentLoaded', () => {
    if (emailInput.value) validateEmail();
    if (passwordInput.value) validatePassword();
  });
