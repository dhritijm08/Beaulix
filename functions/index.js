const functions = require("firebase-functions");
const {v2: cloudinary} = require("cloudinary");
const logger = require("firebase-functions/logger");
const https = require("https");
const http = require("http");

// ── Firebase Admin — initialised once at module load ─────────────────────────
const {initializeApp, getApps} = require("firebase-admin/app");
const {getAuth} = require("firebase-admin/auth");
if (!getApps().length) initializeApp();

// ── Allowed CORS origins ──────────────────────────────────────────────────────
const ALLOWED_ORIGINS = [
  "https://beaulix-model.web.app",
  "https://beaulix-model.firebaseapp.com",
];

// ── CORS helper for onRequest functions ──────────────────────────────────────
function _setCorsHeaders(req, res) {
  const origin = req.headers.origin || "";
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
  }
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.set("Access-Control-Max-Age", "3600");
}

/**
 * Verify a Firebase ID token from an Authorization: Bearer <token> header.
 * @param {string} authHeader - value of req.headers.authorization
 */
async function _verifyFirebaseToken(authHeader) {
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new functions.https.HttpsError("unauthenticated", "Unauthorized: missing Bearer token");
  }
  try {
    await getAuth().verifyIdToken(authHeader.slice(7));
  } catch (_err) {
    throw new functions.https.HttpsError("unauthenticated", "Unauthorized: invalid or expired token");
  }
}

// ── Secret helpers — read from Firebase environment config ───────────────────
// Set with: firebase functions:config:set beaulix.gpu_url="https://..."
//           firebase functions:config:set beaulix.backend_url="https://..."
//           firebase functions:config:set beaulix.api_key="..."
//           firebase functions:config:set cloudinary.cloud_name="..."
//           firebase functions:config:set cloudinary.api_key="..."
//           firebase functions:config:set cloudinary.api_secret="..."
//           firebase functions:config:set cloudinary.upload_preset="..."
function _cfg() {
  return functions.config();
}

/**
 * cloudinaryConfig — returns the Cloudinary cloud name and unsigned upload
 * preset to the authenticated frontend.
 */
exports.cloudinaryConfig = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError(
        "unauthenticated", "Must be signed in to fetch Cloudinary config.");
  }
  const cfg = _cfg();
  return {
    cloud: cfg.cloudinary && cfg.cloudinary.cloud_name,
    preset: cfg.cloudinary && cfg.cloudinary.upload_preset,
  };
});

/**
 * Forward a JSON body to the ML backend and return the response.
 * @param {string} backendUrl - base URL, e.g. "https://1.2.3.4:8000"
 * @param {string} path       - e.g. "/predict"
 * @param {string} apiKey     - value for X-Beaulix-API-Key header
 * @param {object} body       - JSON-serialisable request body
 * @return {Promise<object>} parsed JSON response
 */
function _forwardToBackend(backendUrl, path, apiKey, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const url = new URL(path, backendUrl);

    if (url.protocol !== "https:" && process.env.NODE_ENV !== "development") {
      reject(new Error(
          `BEAULIX_BACKEND_URL must use HTTPS in production. Got: ${url.protocol}//...`,
      ));
      return;
    }

    const transport = url.protocol === "https:" ? https : http;
    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname + url.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        "X-Beaulix-API-Key": apiKey,
      },
    };
    const req = transport.request(options, (res) => {
      let responseData = "";
      res.on("data", (chunk) => {
        responseData += chunk;
      });
      res.on("end", () => {
        try {
          resolve({status: res.statusCode, body: JSON.parse(responseData)});
        } catch (e) {
          reject(new Error(
              `Backend returned non-JSON (status ${res.statusCode}): ${responseData.slice(0, 200)}`,
          ));
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(30000, () => {
      req.destroy(new Error("Backend request timed out after 30s"));
    });
    req.write(payload);
    req.end();
  });
}

/**
 * getGpuUrl — returns the current GPU (Colab/ngrok) base URL to the
 * authenticated frontend. Reads from Firebase environment config.
 */
exports.getGpuUrl = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError(
        "unauthenticated", "Must be signed in to fetch GPU URL.");
  }
  const url = _cfg().beaulix && _cfg().beaulix.gpu_url;
  if (!url) {
    logger.error("beaulix.gpu_url config not set. Run: firebase functions:config:set beaulix.gpu_url=\"https://...\"");
    throw new functions.https.HttpsError(
        "failed-precondition", "GPU URL is not configured.");
  }
  return {url};
});

/**
 * Validate the backend URL from config.
 * @param {string} backendUrl
 */
function _validateBackendUrl(backendUrl) {
  if (!backendUrl) {
    throw new functions.https.HttpsError("internal", "beaulix.backend_url config is not set.");
  }
  if (process.env.NODE_ENV !== "development") {
    let parsed;
    try {
      parsed = new URL(backendUrl);
    } catch (_) {
      throw new functions.https.HttpsError("internal", "beaulix.backend_url is not a valid URL.");
    }
    if (parsed.protocol !== "https:") {
      throw new functions.https.HttpsError(
          "internal",
          `beaulix.backend_url must use HTTPS in production. Got: ${parsed.protocol}//...`,
      );
    }
  }
}

/**
 * _createMlProxy — factory for ML backend proxy onRequest handlers.
 * @param {string} backendPath - e.g. "/predict"
 * @param {string} exportName
 */
function _createMlProxy(backendPath, exportName) {
  return functions.runWith({timeoutSeconds: 60}).https.onRequest(async (req, res) => {
    _setCorsHeaders(req, res);

    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }

    if (req.method !== "POST") {
      res.status(405).json({error: "Method not allowed"});
      return;
    }

    try {
      await _verifyFirebaseToken(req.headers.authorization || "");
    } catch (err) {
      res.status(401).json({error: err.message});
      return;
    }

    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
      res.status(400).json({error: "Request body must be a JSON object."});
      return;
    }

    try {
      const cfg = _cfg();
      const backendUrl = cfg.beaulix && cfg.beaulix.backend_url;
      const apiKey = cfg.beaulix && cfg.beaulix.api_key;
      _validateBackendUrl(backendUrl);
      const {status, body} = await _forwardToBackend(backendUrl, backendPath, apiKey, req.body);
      res.status(status).json(body);
    } catch (err) {
      logger.error(`${exportName} proxy error`, {error: err.message});
      res.status(502).json({error: "ML backend unavailable. Please try again."});
    }
  });
}

/** Proxy /predict — Step 1 performance prediction. */
exports.mlPredict = _createMlProxy("/predict", "mlPredict");

/** Proxy /predict-step2 — Step 2 updated score after creative choices. */
exports.mlPredictStep2 = _createMlProxy("/predict-step2", "mlPredictStep2");

/**
 * deleteCloudinaryAsset — deletes a Cloudinary asset by URL.
 * Called by history.html and profile.html.
 */
exports.deleteCloudinaryAsset = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "You must be logged in.");
  }

  const cfg = _cfg();
  cloudinary.config({
    cloud_name: cfg.cloudinary && cfg.cloudinary.cloud_name,
    api_key: cfg.cloudinary && cfg.cloudinary.api_key,
    api_secret: cfg.cloudinary && cfg.cloudinary.api_secret,
  });

  const {cloudinaryUrl, resourceType} = data;

  if (!cloudinaryUrl) {
    throw new functions.https.HttpsError("invalid-argument", "cloudinaryUrl is required.");
  }

  try {
    const urlParts = cloudinaryUrl.split("/upload/");
    if (urlParts.length < 2) throw new Error("Invalid Cloudinary URL format");

    const publicIdWithExt = urlParts[1].replace(/^v\d+\//, "");
    const publicId = publicIdWithExt.replace(/\.[^/.]+$/, "");
    const type = resourceType === "video" ? "video" : "image";

    const result = await cloudinary.uploader.destroy(publicId, {resource_type: type});

    logger.info("Cloudinary asset deleted", {resourceType: type, result: result.result});

    if (result.result === "ok" || result.result === "not found") {
      return {success: true, result: result.result};
    } else {
      throw new Error(`Cloudinary delete failed: ${result.result}`);
    }
  } catch (e) {
    logger.error("Cloudinary delete error", {error: e.message});
    throw new functions.https.HttpsError("internal", e.message);
  }
});
