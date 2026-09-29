# Meta Ads Integration — Phase 2A (Connect Only)

Scope: Meta OAuth, a secure server-side connection record, and ad-account
selection. **No campaign/ad/insights import, no campaign creation, no
media buying** — see "Phase 2B" at the bottom for what comes next.

> Note on architecture: `docs/performance-architecture.md` (Phase 1)
> sketched this as a Firebase Cloud Function. This phase instead adds it to
> the existing FastAPI backend (`backend/server.py`), per the explicit
> `backend/integrations/meta/{oauth,client,models,routes}.py` layout this
> phase was scoped against — that backend already has the Firebase
> ID-token verification (`require_firebase_user`) and the rate limiter
> (`limiter`) this integration reuses. Worth a quick sanity check with
> whoever owns deploy topology before Phase 2B, since a Cloud Function
> would need its own copy of both.

## Architecture

```
frontend/performance.html         Meta Ads card: connect / status / disconnect UI
frontend/performance-module.js    calls the endpoints below with a Firebase ID token

backend/server.py                 mounts the router below (one added include_router call)
backend/integrations/meta/
  state.py     signed, self-contained OAuth `state` tokens (CSRF protection)
  client.py    Meta Graph API calls: authorize URL, token exchange, ad-account list, revoke
  store.py     Firestore Admin read/write of users/{uid}/platformConnections/meta
  oauth.py     orchestrates state -> client -> store for connect/callback/disconnect
  routes.py    the 4 HTTP endpoints, reusing server.py's require_firebase_user + limiter
```

Nothing here modifies `/predict`, `/ad-copy`, `/classify-product-category`,
`/generate`, category classification, or V4 copy rendering — the only
change to `server.py` is one `app.include_router(...)` call.

## OAuth flow

1. Frontend calls `GET /integrations/meta/connect` with `Authorization: Bearer <Firebase ID token>`.
   Returns `{"authorizeUrl": "..."}` — **JSON, not a redirect**, because a
   plain top-level browser navigation can't carry a custom `Authorization`
   header. The frontend does the navigation itself:
   `window.location.href = authorizeUrl`.
2. The user authorizes on Meta's consent screen (scope: `ads_read` only —
   see "Permissions" below).
3. Meta redirects the browser to `GET /integrations/meta/callback?code=...&state=...`.
   This is a plain browser navigation from facebook.com — it cannot carry a
   Bearer token, so this endpoint is intentionally NOT behind
   `require_firebase_user`. Instead, the signed `state` value (created in
   step 1, bound to the authenticated uid) is what proves which Beaulix
   user this connection belongs to. See "CSRF / state" below.
4. The backend exchanges the code for a short-lived token, exchanges that
   for a long-lived (~60 day) token, fetches the user's Meta ad accounts,
   and stores the connection (see "Storage" below).
5. The backend redirects the browser back to
   `{BEAULIX_FRONTEND_URL}{META_FRONTEND_RETURN_PATH}?meta=connected` (or
   `?meta=error&reason=<code>` on failure). `performance-module.js` reads
   this query string once on load and then removes it from the URL.

## CSRF / state

`integrations/meta/state.py` signs `uid:nonce:expiry` with HMAC-SHA256
(`META_OAUTH_STATE_SECRET`, falling back to `META_APP_SECRET`) and verifies
the signature + a 10-minute expiry on the way back. No server-side session
store is needed — the state token carries everything it needs to verify
itself. Because the uid is inside the *signed* payload, the callback can
never be tricked into attaching a connection to a different Firebase user
than the one who started the flow (covered by
`test_handle_callback_cannot_associate_with_another_user` in
`backend/test_meta_integration.py`).

## Permissions

Phase 2A requests **`ads_read` only** — enough to list the accessible ad
accounts. `ads_management` (needed to create or modify campaigns/ads) is
intentionally not requested; add it only when Phase 2B actually needs it,
and re-run Meta App Review if the app isn't already approved for it.

## Storage

Reuses the Phase 1 Firestore location
`users/{uid}/platformConnections/meta`, which `firestore.rules` already
locks down completely:

```
match /users/{userId}/platformConnections/{docId} {
  allow read, write: if false;   // Admin SDK bypasses this — no rule change needed
}
```

The document holds both the safe metadata (`connectionId`, `brandId`,
`platform`, `accountId`, `accountName`, `status`, `lastSyncedAt`,
`createdAt`, `updatedAt`) **and** the OAuth credentials, under a
`credentials` field (`accessToken`, `tokenType`, `expiresAt`). Every read
that could reach an API response goes through
`store.to_safe_dict()`, which is the one place that turns a stored doc
into a response — and it always drops `credentials`. This is defense in
depth on top of the Firestore rule above, not a substitute for it.

`GET /integrations/meta/status` is how the frontend reads connection state
— not a direct Firestore read, since the rule above blocks that for every
client, by design.

## Security checklist (all Phase 2A requirements)

- [x] Every endpoint except `/callback` requires the authenticated Firebase user (`require_firebase_user`).
- [x] OAuth `state` is signed and time-boxed — CSRF-safe, and the callback cannot associate a connection with the wrong Firebase user.
- [x] `META_APP_SECRET` and the OAuth access token never reach the browser — both are read/used only inside `backend/integrations/meta/`.
- [x] The access token is never written to browser storage — it only exists server-side, in the Firestore doc described above.
- [x] The access token is never in a client-readable Firestore field (see "Storage").
- [x] Disconnect always removes the local record, even if Meta's own revoke call fails or times out (`oauth.disconnect`).
- [x] Meta authorization denial/cancellation is handled cleanly — redirects with `?meta=error&reason=denied`, no stack trace or raw Meta error text ever reaches the browser.
- [x] No token, code, or Meta error body is ever logged — only `type(exc).__name__`-style or explicit `reason` codes.

## Environment variables

See `.env.example` for the full block. Required:
`META_APP_ID`, `META_APP_SECRET`, `META_REDIRECT_URI`,
`GOOGLE_SERVICE_ACCOUNT_JSON` (or `GOOGLE_APPLICATION_CREDENTIALS` /
Application Default Credentials, for the Firestore Admin SDK). Optional:
`META_OAUTH_STATE_SECRET`, `META_GRAPH_API_VERSION` (default `v26.0`),
`META_FRONTEND_RETURN_PATH` (default `/performance.html`).

`META_REDIRECT_URI` must exactly match a redirect URI registered under
**Facebook Login for Business > Settings** in the Meta App Dashboard.

## Meta Developer Console configuration still required (manual, one-time)

1. Create a Meta app (or use an existing one) and add the **Marketing API** use case.
2. Under **Facebook Login for Business > Settings**, add `META_REDIRECT_URI` to the allowed redirect URIs, and set Client OAuth Login + Web OAuth Login to Yes.
3. Under **Permissions and Features**, confirm `ads_read` is available (standard/basic access is enough for testing against your own ad account; advanced access + App Review is only needed to connect *other* businesses' ad accounts).
4. Copy the App ID and App Secret into `META_APP_ID` / `META_APP_SECRET` on the backend host (never commit them).
5. If any test users will connect ad accounts that aren't your own, complete Business Verification (see Meta's Marketing API Access Tier docs) — not required for connecting your own account during development.

## How Phase 2B will build on this

- Ad-account **picker**: `oauth.handle_callback` currently auto-selects the
  first ad account `GET /me/adaccounts` returns. Multi-account users need a
  picker — either a second callback step, or an
  `/integrations/meta/accounts` + `/integrations/meta/select-account`
  pair.
- Campaign/ad/insights **import**: populate `campaigns`, `ads`,
  `performanceMetrics` (already defined in `frontend/performance/model.js`)
  from the Meta Marketing API, using the stored long-lived token.
- **Refresh**: long-lived tokens last ~60 days; Phase 2B needs a refresh or
  re-auth path before they expire, plus handling for a token Meta reports
  as already invalidated (password change, permission change, etc.).
- **Automatic creative attribution**: link an imported Meta ad to the
  Beaulix `creativeId` that produced it (`createCreativeAttribution` in
  `model.js` already has the shape for this).
- Wire `frontend/performance/performance-service.js`'s
  `imported_platform_data` source (currently a throwing stub) to the
  imported data once it exists.
