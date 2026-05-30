const {onCall, onRequest, HttpsError} = require("firebase-functions/v2/https");
const {v2: cloudinary} = require("cloudinary");
const {defineSecret} = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const https = require("https");
const http = require("http");
const corsLib = require("cors");

// ── Firebase Admin — initialised once at module load ─────────────────────────
const {initializeApp, getApps} = require("firebase-admin/app");
const {getAuth} = require("firebase-admin/auth");
if (!getApps().length) initializeApp();

// ── CORS — restrict ML endpoints to the known frontend origin ────────────────
// Set BEAULIX_FRONTEND_URL as a Firebase environment variable:
//   firebase functions:config:set app.frontend_url="https://your-app.web.app"
// Falls back to false (no CORS) rather than wildcard if the variable is unset,
// so a misconfigured deploy fails closed instead of open.
// Known frontend origins. BEAULIX_FRONTEND_URL env var adds extras at runtime.
// Hardcoding the production origin here ensures CORS works even without the
// env var set, which was the cause of the header being missing on preflight.
const ALLOWED_ORIGINS = [
  "https://beaulix-model.web.app",
  "https://beaulix-model.firebaseapp.com",
  ...(process.env.BEAULIX_FRONTEND_URL ? [process.env.BEAULIX_FRONTEND_URL] : []),
];

/**
 * Verify a Firebase ID token from an Authorization: Bearer <token> header.
 * Throws with a 401-appropriate message on any failure.
 * @param {string} authHeader - value of req.headers.authorization
 */
async function _verifyFirebaseToken(authHeader) {
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new HttpsError("unauthenticated", "Unauthorized: missing Bearer token");
  }
  try {
    await getAuth().verifyIdToken(authHeader.slice(7));
  } catch (_err) {
    throw new HttpsError("unauthenticated", "Unauthorized: invalid or expired token");
  }
}

// ── ML backend proxy ──────────────────────────────────────────────────────────
// The frontend must call Firebase Functions (/mlPredict, /mlPredictStep2) rather
// than the FastAPI backend directly.  Benefits:
//   • Backend URL never reaches the browser (hidden from DevTools).
//   • BEAULIX_API_KEY never reaches the browser.
//   • CSP connect-src only needs *.cloudfunctions.net / *.run.app.
//   • Firebase auth is enforced here — unauthenticated callers are rejected.
//
// Deploy secrets:
//   firebase functions:secrets:set BEAULIX_API_KEY
//   firebase functions:secrets:set BEAULIX_BACKEND_URL   # e.g. https://1.2.3.4:8000
// ─────────────────────────────────────────────────────────────────────────────

const _beaulixApiKey     = defineSecret("BEAULIX_API_KEY");
const _beaulixBackendUrl = defineSecret("BEAULIX_BACKEND_URL");
const _beaulixGpuUrl     = defineSecret("BEAULIX_GPU_URL");

// ── Cloudinary secrets ────────────────────────────────────────────────────────
// Migrate from plain env vars to Firebase Secrets so credentials are available
// in all deployment configurations (including Functions v2 cold starts).
// Deploy with:
//   firebase functions:secrets:set CLOUDINARY_CLOUD_NAME
//   firebase functions:secrets:set CLOUDINARY_API_KEY
//   firebase functions:secrets:set CLOUDINARY_API_SECRET
//   firebase functions:secrets:set CLOUDINARY_UPLOAD_PRESET
const _cloudinaryCloudName   = defineSecret("CLOUDINARY_CLOUD_NAME");
const _cloudinaryApiKey      = defineSecret("CLOUDINARY_API_KEY");
const _cloudinaryApiSecret   = defineSecret("CLOUDINARY_API_SECRET");
const _cloudinaryUploadPreset = defineSecret("CLOUDINARY_UPLOAD_PRESET");

/**
 * cloudinaryConfig — returns the Cloudinary cloud name and unsigned upload preset
 * to the authenticated frontend so window.__CLOUDINARY_CONFIG__ can be set at
 * runtime without hardcoding credentials in static HTML.
 *
 * Firebase Hosting is static and cannot server-render a <script> snippet, so
 * this thin Cloud Function acts as the injection point.  The frontend calls it
 * once on load (see cloudinary-config.js) and caches the result in memory.
 *
 * Only the cloud name and upload preset (both non-sensitive for unsigned uploads)
 * are returned.  The API key and secret never leave the Functions runtime.
 */
exports.cloudinaryConfig = onCall(
  {secrets: [_cloudinaryCloudName, _cloudinaryUploadPreset], cors: ALLOWED_ORIGINS || true},
  async (request) => {
    // Require the caller to be authenticated — prevents anonymous enumeration.
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Must be signed in to fetch Cloudinary config.");
    }
    return {
      cloud:  _cloudinaryCloudName.value(),
      preset: _cloudinaryUploadPreset.value(),
    };
  },
);

/**
 * Forward a JSON body to the ML backend and return the response.
 * @param {string} backendUrl - base URL, e.g. "https://1.2.3.4:8000"
 * @param {string} path       - e.g. "/predict"
 * @param {string} apiKey     - value for X-Beaulix-API-Key header
 * @param {object} body       - JSON-serialisable request body
 * @returns {Promise<object>} parsed JSON response
 */
function _forwardToBackend(backendUrl, path, apiKey, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const url = new URL(path, backendUrl);

    // Enforce HTTPS in production to protect the API key in transit.
    // If BEAULIX_BACKEND_URL is accidentally set to an http:// URL in
    // a non-development environment, reject the request immediately.
    if (url.protocol !== "https:" && process.env.NODE_ENV !== "development") {
      reject(new Error(
        `BEAULIX_BACKEND_URL must use HTTPS in production. Got: ${url.protocol}//... ` +
        "Update the secret with an https:// URL."
      ));
      return;
    }

    const transport = url.protocol === "https:" ? https : http;
    const options = {
      hostname: url.hostname,
      port:     url.port || (url.protocol === "https:" ? 443 : 80),
      path:     url.pathname + url.search,
      method:   "POST",
      headers:  {
        "Content-Type":       "application/json",
        "Content-Length":     Buffer.byteLength(payload),
        "X-Beaulix-API-Key":  apiKey,
      },
    };
    const req = transport.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (e) {
          reject(new Error(`Backend returned non-JSON (status ${res.statusCode}): ${data.slice(0, 200)}`));
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(30000, () => { req.destroy(new Error("Backend request timed out after 30s")); });
    req.write(payload);
    req.end();
  });
}

/**
 * getGpuUrl — returns the current GPU (Colab/ngrok) base URL to the authenticated
 * frontend so the URL is never hardcoded in static HTML and automatically updates
 * when the Colab session restarts and generates a new ngrok URL.
 *
 * Implemented as onRequest (not onCall) so CORS preflight is handled reliably.
 * The firebase-functions v2 onCall cors option has a known issue where it does
 * not add Access-Control-Allow-Origin on OPTIONS preflight responses in some
 * configurations. onRequest with manual CORS headers is the guaranteed fix.
 *
 * Deploy the secret once:
 *   firebase functions:secrets:set BEAULIX_GPU_URL   # e.g. https://abc123.ngrok.io
 * Update it after each Colab restart:
 *   firebase functions:secrets:set BEAULIX_GPU_URL
 */
// Build a cors middleware instance once so it is reused across warm invocations.
// Using the `cors` npm package is the only reliable way to handle OPTIONS
// preflight in Firebase Functions v7 onRequest handlers — the built-in `cors`
// option no longer guarantees preflight responses include the required headers.
const _gpuUrlCors = corsLib({
  origin: ALLOWED_ORIGINS,
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  optionsSuccessStatus: 204,
});

exports.getGpuUrl = onRequest(
  // Pass cors: false so the framework does NOT intercept preflight before our
  // middleware runs — the corsLib instance above owns the full CORS lifecycle.
  {secrets: [_beaulixGpuUrl], timeoutSeconds: 10, cors: false},
  (req, res) => {
    _gpuUrlCors(req, res, async () => {
      // Auth: verify Firebase ID token
      try {
        await _verifyFirebaseToken(req.headers.authorization || "");
      } catch (err) {
        res.status(401).json({error: err.message});
        return;
      }

      // Return GPU URL from secret
      const url = _beaulixGpuUrl.value();
      if (!url) { res.status(404).json({error: "BEAULIX_GPU_URL secret is not set."}); return; }
      res.status(200).json({url});
    });
  },
);

/**
 * Validate the BEAULIX_BACKEND_URL secret at request time (before forwarding).
 * This surfaces a clear error rather than an unhandled rejection inside
 * _forwardToBackend if the secret is missing or misconfigured.
 *
 * @param {string} backendUrl - value of _beaulixBackendUrl.value()
 * @throws {HttpsError} if the URL is empty or not HTTPS in production
 */
function _validateBackendUrl(backendUrl) {
  if (!backendUrl) {
    throw new HttpsError("internal", "BEAULIX_BACKEND_URL secret is not set.");
  }
  if (process.env.NODE_ENV !== "development") {
    let parsed;
    try { parsed = new URL(backendUrl); } catch (_) {
      throw new HttpsError("internal", "BEAULIX_BACKEND_URL is not a valid URL.");
    }
    if (parsed.protocol !== "https:") {
      throw new HttpsError(
        "internal",
        `BEAULIX_BACKEND_URL must use HTTPS in production. Got: ${parsed.protocol}//...`
      );
    }
  }
}

/**
 * _createMlProxy — factory that creates an onRequest handler forwarding POST
 * requests to a given ML backend path.  Both mlPredict and mlPredictStep2 are
 * structurally identical; this factory eliminates the duplication and ensures
 * both endpoints always have identical auth/validation behaviour.
 *
 * @param {string} backendPath - e.g. "/predict" or "/predict-step2"
 * @param {string} exportName  - used in error log messages
 */
function _createMlProxy(backendPath, exportName) {
  return onRequest(
    { secrets: [_beaulixApiKey, _beaulixBackendUrl], cors: ALLOWED_ORIGINS, timeoutSeconds: 60 },
    async (req, res) => {
      if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }

      try {
        await _verifyFirebaseToken(req.headers.authorization || "");
      } catch (err) {
        res.status(401).json({ error: err.message });
        return;
      }

      if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
        res.status(400).json({ error: "Request body must be a JSON object." });
        return;
      }

      try {
        _validateBackendUrl(_beaulixBackendUrl.value());
        const { status, body } = await _forwardToBackend(
          _beaulixBackendUrl.value(), backendPath,
          _beaulixApiKey.value(), req.body,
        );
        res.status(status).json(body);
      } catch (err) {
        logger.error(`${exportName} proxy error`, {error: err.message});
        res.status(502).json({ error: "ML backend unavailable. Please try again." });
      }
    },
  );
}

/** Proxy /predict — Step 1 performance prediction. */
exports.mlPredict = _createMlProxy("/predict", "mlPredict");

/** Proxy /predict-step2 — Step 2 updated score after creative choices. */
exports.mlPredictStep2 = _createMlProxy("/predict-step2", "mlPredictStep2");


// deleteCloudinaryAsset — called by:
//   • history.html (lines 445-449) via firebase-functions.js when a user deletes a generated asset.
//   • profile.html (lines 375-383) when a user replaces their avatar, to clean up the old asset.
// Do NOT remove this function — it is actively wired up in both frontend pages.
exports.deleteCloudinaryAsset = onCall(
  { secrets: [_cloudinaryCloudName, _cloudinaryApiKey, _cloudinaryApiSecret], cors: ALLOWED_ORIGINS || true },
  async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "You must be logged in.");
  }

  // Configure Cloudinary from secrets at call time (not module load time)
  // so credentials are guaranteed to be injected by the Functions v2 runtime.
  cloudinary.config({
    cloud_name: _cloudinaryCloudName.value(),
    api_key:    _cloudinaryApiKey.value(),
    api_secret: _cloudinaryApiSecret.value(),
  });

  const {cloudinaryUrl, resourceType} = request.data;

  if (!cloudinaryUrl) {
    throw new HttpsError("invalid-argument", "cloudinaryUrl is required.");
  }

  try {
    const urlParts = cloudinaryUrl.split("/upload/");
    if (urlParts.length < 2) throw new Error("Invalid Cloudinary URL format");

    const publicIdWithExt = urlParts[1].replace(/^v\d+\//, "");
    const publicId = publicIdWithExt.replace(/\.[^/.]+$/, "");
    const type = resourceType === "video" ? "video" : "image";

    const result = await cloudinary.uploader.destroy(publicId, {
      resource_type: type,
    });

    logger.info("Cloudinary asset deleted", {resourceType: type, result: result.result});

    if (result.result === "ok" || result.result === "not found") {
      return {success: true, result: result.result};
    } else {
      throw new Error(`Cloudinary delete failed: ${result.result}`);
    }
  } catch (e) {
    logger.error("Cloudinary delete error", {error: e.message});
    throw new HttpsError("internal", e.message);
  }
});
