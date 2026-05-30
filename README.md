# Beaulix ✨

AI-powered beauty and wellness recommendation platform. Enter your audience profile and product category; Beaulix returns predicted performance metrics (CTR, conversion, engagement), AI-generated ad copy, audience targeting suggestions, and visual brief recommendations — all powered by Random Forest models trained on a 97,920+ row dataset.

---

## Features

- **Two-step recommendation flow** — Step 1 predicts baseline performance; Step 2 refines predictions after the user selects creative choices (brand style, aspect ratio, output type) and returns a before/after improvement delta
- **AI-generated ad copy** — hook, headline, description, CTA, and offer per request
- **Audience targeting** — platform suggestions, tone, and demographic targeting
- **Visual brief** — shot type, lighting, colour palette, and styling recommendations
- **Confidence scoring** — percentile rank against similar profiles in the dataset
- **Recommendation history** — per-user history stored in Firestore
- **User auth** — login, signup, password reset via Firebase Authentication
- **Avatar uploads** — Cloudinary integration via Firebase Cloud Functions (API key never exposed to browser)
- **Rate limiting** — SlowAPI (30 req/min on prediction endpoints)
- **Background retraining** — model retrains in a dedicated thread pool on new predictions without blocking inference

---

## How It Works

1. **Step 1** — User fills in product category, audience profile, and marketing attributes. The FastAPI backend runs Random Forest inference and returns predicted CTR, conversion rate, engagement rate, ad copy, audience targeting, and visual brief recommendations.

2. **Step 2** — User selects creative choices (brand style, aspect ratio, output type) from the Step 1 recommendations. The backend re-runs predictions with these additional inputs and returns a delta showing the improvement over baseline.

3. **Visual Generation (optional)** — The GPU-hosted Colab server generates images and videos via SDXL based on the visual brief. The ngrok tunnel URL is written to Firestore by Colab on startup; the frontend reads it via the `getGpuUrl` Cloud Function.

---

## System Architecture

```
Browser (Firebase Hosting)
    │
    ├── Firebase Auth          ← login / signup / password reset
    ├── Firestore              ← history, user data, GPU URL
    └── Firebase Functions     ← Cloudinary proxy, ML key relay
             │
             └── FastAPI Backend (Render)
                      │
                      ├── Random Forest Models
                      ├── Excel Data Cache
                      └── Background Retrain Pool

GPU (Google Colab + ngrok)
    └── SDXL image/video generation (optional)
```

---

## Project Structure

```
Beaulix/
│
├── backend/
│   ├── server.py                         # FastAPI app, all endpoints, lifespan management
│   ├── model.py                          # RecommendationModel: Random Forest inference & retraining
│   ├── confidence.py                     # Confidence score & percentile calculation
│   ├── targeting.py                      # Audience targeting logic
│   ├── copy_engine.py                    # Ad copy generation
│   ├── copy_constants.py                 # Copy templates and tone constants
│   ├── visual_lookup.py                  # Visual brief lookup from Excel cache
│   ├── excel_cache.py                    # In-memory Excel data cache
│   ├── cache_manager.py                  # Cache loading and refresh logic
│   ├── build_visual_cache.py             # Build-time script to pre-build visual_data.pkl
│   ├── constants.py                      # Shared constants (categories, funnel stages, etc.)
│   ├── step2_engine.py                   # Step 2 delta/improvement calculation
│   ├── step2_constants.py                # Step 2 brand styles, aspect ratios, output types
│   ├── dataset.py                        # Dataset loading and append helpers
│   ├── download_data.py                  # Build-time script to pull Excel files from Google Drive
│   ├── retrain.py                        # Background retrain orchestration
│   ├── locks.py                          # Retrain concurrency lock
│   ├── train_simple_model.py             # Standalone script to generate random_forest_models.pkl
│   ├── start.sh                          # Startup script with supervised restart loop
│   ├── requirements.txt                  # Production dependencies
│   ├── requirements-dev.txt              # Dev/test dependencies (pytest, httpx)
│   ├── requirements-build.txt            # Build-time dependencies (download_data.py)
│   ├── .python-version                   # Pinned Python version
│   ├── beaulix_combinatorial_predictions.xlsx  # Training dataset (~97,920 rows)
│   ├── beaulix_step2_recommendations.xlsx      # Step 2 recommendation data
│   ├── beaulix_visual_brief.xlsx               # Visual brief lookup data
│   └── tests/
│       ├── test_endpoints.py
│       ├── test_copy_engine.py
│       └── test_targeting.py
│
├── colab/
│   ├── sdxl_model.py                     # SDXL image/video generation (GPU/Colab only)
│   └── tune/                             # Background music assets (bg_music_01–10.mp3)
│
├── frontend/
│   ├── index.html / index-init.js / index-module.js            # Landing page
│   ├── generator.html / generator-init.js / generator-module.js # Recommendation generator (Step 1 + 2)
│   ├── history.html / history-module.js                         # Recommendation history
│   ├── login.html / login-module.js                             # Login
│   ├── signup.html / signup-module.js                           # Signup
│   ├── profile.html / profile-module.js                         # User profile & avatar upload
│   ├── password-reset.html / password-reset-module.js           # Password reset request
│   ├── reset-action.html / reset-action-module.js               # Password reset action handler
│   ├── reset-bridge.html / reset-bridge-scripts.js              # Firebase reset bridge
│   ├── 404.html                                                  # Custom 404 page
│   ├── nav-module.js                                             # Shared navigation
│   ├── step2-module.js                                           # Step 2 UI and logic
│   ├── cloudinary-module.js                                      # Cloudinary upload (via Cloud Functions)
│   ├── firebase-config.js                                        # Firebase SDK initialisation
│   ├── suppress-firebase-warn.js                                 # Suppresses noisy SDK console warnings
│   ├── auth.css / generator.css / layout.css / theme.css        # Stylesheets
│   └── *.jpg / *.webp / *.png / *.mp4 / favicon.ico            # Static media assets
│
├── functions/
│   ├── index.js                          # Firebase Cloud Functions (Cloudinary proxy, ML key relay, GPU URL)
│   └── package.json                      # Node 18, firebase-functions ^4.9.0, cloudinary ^2.10.0
│
├── firebase.json                         # Firebase Hosting + Functions + 404 config
├── firestore.rules                       # Firestore security rules
├── .firebaserc                           # Firebase project alias (beaulix-model)
└── .env.example                          # All required environment variables (copy to .env)
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | HTML5, CSS3, vanilla JavaScript (ES modules) |
| Backend | Python 3, FastAPI, Uvicorn |
| ML | Scikit-learn (Random Forest), Pandas, NumPy |
| Auth & DB | Firebase Authentication, Firestore |
| Hosting | Firebase Hosting (frontend), Render (backend) |
| Media | Cloudinary (avatar uploads) |
| Cloud Functions | Node 18, Firebase Functions v4 |
| Rate Limiting | SlowAPI |
| Image Generation | Stable Diffusion XL (optional, Colab/GPU only) |

---

## Installation & Setup

### 1. Clone the Repository

```bash
git clone <your-repository-url>
cd Beaulix
```

### 2. Backend Setup

```bash
cd backend
python3 -m venv venv
source venv/bin/activate          # Windows: venv\Scripts\activate
pip install -r requirements.txt
```

Copy and fill in environment variables:

```bash
cp ../.env.example .env
# Edit .env — at minimum set BEAULIX_API_KEY and BEAULIX_FRONTEND_URL
```

Train the model (first time only):

```bash
python train_simple_model.py
```

Start the server:

```bash
bash start.sh
# or directly:
uvicorn server:app --reload
```

Backend runs at `http://127.0.0.1:8000`.

> **Note:** On first start the server loads `beaulix_combinatorial_predictions.xlsx` (~14 MB) and three Random Forest models. This takes 30–90 seconds. The port binds immediately; requests during this window receive HTTP 503.

### 3. Frontend Setup (Local Dev)

Serve the `frontend/` directory via a proper local server (not by opening HTML files directly — ES modules require HTTP):

```bash
# Python
python -m http.server 5500 --directory frontend

# npx (also supports proper 404 routing)
npx serve frontend

# VS Code: use the Live Server extension
```

Open `http://127.0.0.1:5500`.

> **Important:** Do not open HTML files directly from the filesystem (`file://`). ES module imports and canvas operations are blocked by the browser under `file://` origins.

### 4. Firebase Setup

1. Create a Firebase project and enable Authentication and Firestore.
2. Deploy Cloud Functions:
   ```bash
   cd functions
   npm install
   firebase deploy --only functions
   ```
3. Set required Firebase Secrets:
   ```bash
   firebase functions:secrets:set BEAULIX_API_KEY
   firebase functions:secrets:set CLOUDINARY_CLOUD_NAME
   firebase functions:secrets:set CLOUDINARY_API_KEY
   firebase functions:secrets:set CLOUDINARY_API_SECRET
   ```
4. Deploy the frontend:
   ```bash
   firebase deploy --only hosting
   ```

### 5. Running Tests

```bash
cd backend
pip install -r requirements.txt -r requirements-dev.txt
pytest
```

---

## GPU / Colab Setup (Optional)

Image and video generation requires a GPU. The recommended setup is Google Colab + ngrok:

1. Open `colab/sdxl_model.py` in Google Colab (use a T4 or A100 runtime).
2. Run all cells. The script starts an ngrok tunnel and writes the tunnel URL to Firestore at `config/gpu`.
3. The frontend reads this URL via the `getGpuUrl` Cloud Function when the generator page loads.

Expected generation times: ~20–30 seconds for images, ~1–2 minutes for videos.

---

## Environment Variables

All variables are documented in `.env.example`. Required variables for production:

| Variable | Required | Description |
|---|---|---|
| `BEAULIX_API_KEY` | **Yes (prod)** | Shared secret sent as `X-Beaulix-API-Key` header. Server refuses to start in production without it. |
| `BEAULIX_FRONTEND_URL` | **Yes (prod)** | Exact Firebase Hosting URL for CORS allow-list. |
| `BEAULIX_ENV` | No | `production` / `development` / `staging` / `test`. Defaults to dev mode. |
| `CLOUDINARY_CLOUD_NAME` | For uploads | From Firebase Secrets / Cloudinary dashboard. |
| `CLOUDINARY_API_KEY` | For uploads | From Firebase Secrets. |
| `CLOUDINARY_API_SECRET` | For uploads | From Firebase Secrets. |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | For Firebase Admin | Full JSON content of the Admin SDK key. Never commit as a file. |
| `MANAGED_DEPLOY` | Managed hosts | Set to `1` on Render / Railway / Fly.io. **Required** — without it health checks see the shell script, not uvicorn. |
| `BEAULIX_MUSIC_DIR` | Colab only | Directory for audio assets. Defaults to `/content`. |

---

## API Reference

All prediction endpoints require the header `X-Beaulix-API-Key: <your_key>`.  
Rate limit: **30 requests/minute** per IP.

### `GET /health`
Returns server status and model load state. No auth required.

### `GET /`
Root health check. No auth required.

### `POST /predict`
Step 1 — baseline prediction.

**Request body:**
```json
{
  "product_category": "skincare",
  "decision_attribute_1": "sensitive",
  "decision_attribute_2": "hydration",
  "funnel_stage": "awareness",
  "age_range": "25-34",
  "gender": "female",
  "occasion": "daily"
}
```

Valid values:

| Field | Valid values |
|---|---|
| `product_category` | `skincare` `makeup` `haircare` `fragrance` `bodycare` |
| `funnel_stage` | `awareness` `consideration` `conversion` `retention` |
| `age_range` | `13-17` `18-24` `25-34` `35-44` `45-60` `60+` |
| `gender` | `female` `male` `non-binary` `all-genders` |
| `occasion` | `daily` `wedding` `party` `gym` `vacation` `work` `selfcare` (optional) |
| `decision_attribute_1` | Skin type or benefit (varies by category; see `constants.py`) |
| `decision_attribute_2` | Product attribute (varies by category; see `constants.py`) |

**Response:**
```json
{
  "success": true,
  "ctr": 2.41,
  "conversion_rate": 1.18,
  "engagement_rate": 4.03,
  "confidence_score": 89.5,
  "similar_profiles": 1632,
  "benchmarks": { "ctr": 1.892, "conversion": 1.168, "engagement": 4.015 },
  "ad_copy": { "hook": "...", "headline": "...", "description": "...", "cta": "...", "offer": "..." },
  "targeting": { "targeting": [...], "platforms": [...], "tone": "..." },
  "visual_recommendations": { "VISUAL_SHOT": "...", "LIGHTING": "...", "COLOR_PALETTE": "...", "STYLING": "..." },
  "step2_recommendations": { "recommended_brand_style": "...", "recommended_aspect_ratio": "...", "recommended_output_type": "..." }
}
```

### `POST /predict-step2`
Step 2 — re-predicts after creative choices are made. Extends the Step 1 body with:

```json
{
  "...all Step 1 fields...",
  "brand_style": "luxury-elegant",
  "aspect_ratio": "1:1",
  "output_type": "image"
}
```

Returns Step 1 baseline, Step 2 updated scores, absolute delta, and percentage change for the frontend improvement banner.

### `GET /visual-recommendations`
Returns visual brief data filtered by query parameters (same fields as `PredictionRequest`).

### `POST /step2-recommendations`
Returns Step 2 creative recommendations (brand styles, aspect ratios, output types) for a given profile.

### `GET /dataset-stats`
Returns row count, column names, and category distribution from the training dataset.

---

## Deployment

### Backend

**Minimum spec: 2 vCPUs, 4 GB RAM.**  
The server retrains three Random Forest models in a background thread on each new prediction. On single-core or memory-constrained instances, retraining will peg CPU and may degrade prediction latency under sustained load. Consider Celery/RQ for async retraining at scale.

Supported platforms: Render, Railway, AWS, Azure, Google Cloud.

**⚠️ Managed platforms (Render, Railway, Fly.io): always set `MANAGED_DEPLOY=1`.**  
Without it, the platform health checks see the shell script wrapper, not uvicorn — zero-downtime deploys and restart policies will behave incorrectly.

```bash
# Render / Railway: add to environment variables
MANAGED_DEPLOY=1
```

For VPS deployments, prefer systemd or supervisord over `start.sh`.

### Frontend

```bash
firebase deploy --only hosting
```

The `firebase.json` is configured with `"404": "404.html"`, `cleanUrls: true`, and `trailingSlash: false` — Firebase Hosting serves the custom 404 page for any unknown URL with a real HTTP 404 status code.

---

## Security Features

- API key authentication on all prediction endpoints (`X-Beaulix-API-Key` header)
- Rate limiting via SlowAPI (30 req/min per IP)
- CORS restricted to `BEAULIX_FRONTEND_URL` in production
- Input validation allowlists on all prediction fields (prevents dataset poisoning)
- Separate thread pools for inference and retraining (inference never starved)
- Firebase Admin SDK key never stored in repo — Render environment variable only
- ML API key managed via Firebase Secrets (`BEAULIX_API_KEY`) — never sent to browser
- Firebase warning suppressor loaded via `firebase-config.js` import so every page gets it automatically

---

## Testing Summary

12 automated test cases across three modules, 100% pass rate:

| Module | Tests |
|---|---|
| `test_endpoints.py` | Health check, predict, step2, dataset stats |
| `test_copy_engine.py` | Ad copy generation per category |
| `test_targeting.py` | Platform and audience targeting |

---

## Known Limitations

- Dataset is synthetic (97,920 generated rows); not sourced from live ad platform data.
- Image/video generation requires a GPU and Google Colab — the backend itself has no GPU dependency.
- Colab sessions disconnect after ~12 hours; the ngrok URL must be refreshed by re-running the notebook.
- Model retrains synchronously in a background thread; under high load, retrain latency can impact inference slightly.

---

## Future Improvements

- User dashboard analytics
- AI-generated beauty reports
- Product recommendation marketplace
- Social media sharing
- Mobile app
- Advanced AI personalization
- Async retraining via job queue (Celery/RQ)

---

## License

This project is intended for educational and development purposes.
