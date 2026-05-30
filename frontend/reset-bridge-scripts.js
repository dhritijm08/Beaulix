  // Bridge page — receives all Firebase reset email links.
  // Reads apiKey from URL to detect if this came from the profile flow
  // by checking sessionStorage written on the same origin before email was sent.
  // Since bridge and password-reset.html are same origin, sessionStorage persists
  // across same-window navigations but NOT across new tabs/incognito.
  //
  // Most reliable approach: encode source in the URL itself via continueUrl hash,
  // then read it here and append as #source=profile to reset-action.html URL.
  //
  // Since Firebase forwards continueUrl as a URL param, check for it:
  const params = new URLSearchParams(window.location.search);
  
  // Try all possible ways to detect profile flow:
  // 1. continueUrl param (if Firebase passes it)
  const continueUrl = params.get('continueUrl') || '';
  // 2. localStorage (same tab/window same origin)
  let lsSource = '';
  try { lsSource = localStorage.getItem('beaulix_pw_source') || ''; } catch(e) {}
  // 3. sessionStorage (more reliable within same browsing session)
  let ssSource = '';
  try { ssSource = sessionStorage.getItem('beaulix_pw_source') || ''; } catch(e) {}

  const fromProfile = continueUrl.includes('profile') || lsSource === 'profile' || ssSource === 'profile';

  // Forward to reset-action.html with source encoded in hash (survives redirect)
  const hash = fromProfile ? '#source=profile' : '';
  window.location.replace('reset-action.html' + window.location.search + hash);
