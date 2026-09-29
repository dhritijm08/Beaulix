// performance-module.js
// Phase 2A: Meta Ads account connection UI for performance.html.
//
// Does NOT touch the generator flow, /predict, /ad-copy, or classification —
// this only talks to the new /integrations/meta/* endpoints on the same ML
// backend, using the same Firebase-ID-token auth pattern generator-init.js
// already uses (config/backend Firestore doc -> backend base URL, then a
// Bearer token on every request). No campaign/ad import happens here yet —
// see docs/meta-integration.md for what Phase 2B adds.

import { app } from './firebase-config.js';
import { getAuth }
  from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import { getFirestore, doc, getDoc }
  from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { initNavAuth } from './nav-module.js';

const auth = getAuth(app);

const metaCard = document.getElementById('metaCard');
const metaStatusPill = document.getElementById('metaStatusPill');
const metaStatusLabel = document.getElementById('metaStatusLabel');
const metaAlert = document.getElementById('metaAlert');
const metaAccountName = document.getElementById('metaAccountName');
const metaAccountId = document.getElementById('metaAccountId');
const metaLastSynced = document.getElementById('metaLastSynced');
const connectMetaBtn = document.getElementById('connectMetaBtn');
const disconnectMetaBtn = document.getElementById('disconnectMetaBtn');
const syncMetaBtn = document.getElementById('syncMetaBtn');

let _mlBackendUrl = null;

function setCardState(state) {
  metaCard.dataset.activeState = state;
}

function setStatusPill(kind, label) {
  metaStatusPill.className = `status-pill ${kind}`;
  metaStatusLabel.textContent = label;
}

function showAlert(kind, message) {
  metaAlert.className = `inline-alert ${kind}`;
  metaAlert.textContent = message;
}

function clearAlert() {
  metaAlert.className = 'inline-alert';
  metaAlert.textContent = '';
}

function formatTimestamp(iso) {
  if (!iso) return 'Never';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

async function getAuthHeaders() {
  const token = await auth.currentUser?.getIdToken();
  if (!token) throw new Error('You must be signed in to manage platform connections.');
  return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` };
}

async function resolveBackendUrl() {
  if (_mlBackendUrl) return _mlBackendUrl;
  const db = getFirestore(app);
  const snap = await getDoc(doc(db, 'config', 'backend'));
  _mlBackendUrl = snap.exists() ? snap.data()?.url : null;
  if (!_mlBackendUrl) throw new Error('Backend configuration is unavailable right now.');
  return _mlBackendUrl;
}

function renderStatus(data) {
  if (data.connected) {
    setStatusPill('connected', 'Connected');
    metaAccountName.textContent = data.accountName || '—';
    metaAccountId.textContent = data.accountId || '—';
    metaLastSynced.textContent = formatTimestamp(data.lastSyncedAt);
    setCardState('connected');
  } else {
    setStatusPill('disconnected', 'Not connected');
    setCardState('disconnected');
  }
}

async function refreshStatus() {
  try {
    const backend = await resolveBackendUrl();
    const headers = await getAuthHeaders();
    const res = await fetch(`${backend}/integrations/meta/status`, { headers });
    if (!res.ok) throw new Error(`Status check failed (${res.status})`);
    renderStatus(await res.json());
  } catch (err) {
    setStatusPill('error', 'Unavailable');
    setCardState('disconnected');
    showAlert('error', err.message || 'Could not check Meta connection status.');
  }
}

async function handleConnectClick() {
  clearAlert();
  connectMetaBtn.disabled = true;
  connectMetaBtn.textContent = 'Redirecting to Meta…';
  try {
    const backend = await resolveBackendUrl();
    const headers = await getAuthHeaders();
    const res = await fetch(`${backend}/integrations/meta/connect`, { headers });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.detail || `Could not start Meta connection (${res.status}).`);
    }
    const { authorizeUrl } = await res.json();
    window.location.href = authorizeUrl; // top-level navigation to Meta's consent screen
  } catch (err) {
    connectMetaBtn.disabled = false;
    connectMetaBtn.textContent = 'Connect Meta';
    showAlert('error', err.message || 'Could not start the Meta connection.');
  }
}

async function handleDisconnectClick() {
  if (!window.confirm('Disconnect your Meta ad account from Beaulix?')) return;
  clearAlert();
  disconnectMetaBtn.disabled = true;
  try {
    const backend = await resolveBackendUrl();
    const headers = await getAuthHeaders();
    const res = await fetch(`${backend}/integrations/meta/disconnect`, { method: 'POST', headers });
    if (!res.ok) throw new Error(`Disconnect failed (${res.status}).`);
    showAlert('success', 'Meta account disconnected.');
    await refreshStatus();
  } catch (err) {
    showAlert('error', err.message || 'Could not disconnect the Meta account.');
  } finally {
    disconnectMetaBtn.disabled = false;
  }
}

function handleSyncClick() {
  // Phase 2A is connection-only — campaign/ad/insights import is Phase 2B.
  showAlert('success', 'Importing performance data from Meta is coming in a later phase. Your connection is saved.');
}

function handleReturnFromMeta() {
  const params = new URLSearchParams(window.location.search);
  const result = params.get('meta');
  if (!result) return;
  if (result === 'connected') {
    showAlert('success', 'Meta account connected.');
  } else if (result === 'error') {
    const reasons = {
      denied: 'You cancelled the Meta authorization.',
      invalid_state: 'The connection attempt could not be verified. Please try again.',
      missing_code: 'Meta did not return an authorization code. Please try again.',
      no_ad_account: 'No Meta ad account is accessible to this account. Add one in Meta Business Manager and try again.',
      meta_api_error: 'Meta reported an error while connecting. Please try again.',
      server_error: 'Something went wrong while connecting. Please try again.',
    };
    showAlert('error', reasons[params.get('reason')] || 'Could not connect to Meta.');
  }
  // Clean the query string so a page refresh doesn't re-show the banner.
  const url = new URL(window.location.href);
  url.searchParams.delete('meta');
  url.searchParams.delete('reason');
  window.history.replaceState({}, '', url.toString());
}

connectMetaBtn.addEventListener('click', handleConnectClick);
disconnectMetaBtn.addEventListener('click', handleDisconnectClick);
syncMetaBtn.addEventListener('click', handleSyncClick);

initNavAuth({
  onUser: () => {
    handleReturnFromMeta();
    refreshStatus();
  },
  onNoUser: () => {
    window.location.href = 'login.html';
  },
});
