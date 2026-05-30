
  import { app } from './firebase-config.js';
  import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js';

  const auth = getAuth(app);

  const navLoginBtn     = document.getElementById('navLoginBtn');
  const navGeneratorBtn = document.getElementById('navGeneratorBtn');
  const heroCtaBtn      = document.getElementById('heroCtaBtn');
  const ctaBtn          = document.getElementById('ctaBtn');

  onAuthStateChanged(auth, (user) => {
    document.body.style.visibility = 'visible';
    if (user) {
      navLoginBtn.style.display = 'none';
      navGeneratorBtn.style.display = 'inline';
      heroCtaBtn.onclick = () => window.location.href = 'generator.html';
      ctaBtn.onclick     = () => window.location.href = 'generator.html';
    } else {
      navLoginBtn.style.display = 'inline';
      navGeneratorBtn.style.display = 'none';
      heroCtaBtn.onclick = () => window.location.href = 'login.html';
      ctaBtn.onclick     = () => window.location.href = 'login.html';
    }
  });
