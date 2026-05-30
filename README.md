
# Beaulix ✨

Beaulix is an AI-powered beauty and wellness recommendation platform that provides personalized suggestions based on user preferences and analysis.  
The project combines a **FastAPI backend** with a responsive frontend to deliver an interactive recommendation experience.

---

# Features

- Personalized beauty and wellness recommendations
- AI/ML-based recommendation engine
- FastAPI backend with REST APIs
- Responsive frontend interface
- Firebase integration
- Cloudinary media support
- Recommendation history tracking
- Authentication pages (login, signup, password reset)
- Rate limiting and API protection
- Dataset-driven prediction system

---

# Project Structure

```bash
Beaulix/
│
├── backend/
│   ├── server.py                 # Main FastAPI server
│   ├── model.py                  # Recommendation model logic
│   ├── constants.py              # Project constants
│   ├── train_simple_model.py     # Initial model training script
│   ├── dataset.csv               # Dataset used for predictions
│   ├── requirements.txt          # Backend dependencies
│   ├── models/
│   │   └── random_forest_models.pkl
│   └── start.sh                  # Backend startup script
│
├── colab/
│   └── sdxl_model.py             # SDXL image generation (Colab/GPU server)
│
├── frontend/
│   ├── index.html                # Landing page
│   ├── generator.html            # Recommendation generator
│   ├── history.html              # User history page
│   ├── login.html                # Login page
│   ├── profile.html              # User profile page
│   ├── firebase-config.js        # Firebase configuration
│   ├── cloudinary-config.js      # Cloudinary configuration
│   └── *.css / *.js              # Styling and scripts
│
├── firebase.json
├── .firebaserc
└── .env.example
```

---

# Tech Stack

## Frontend
- HTML5
- CSS3
- JavaScript

## Backend
- Python
- FastAPI
- Uvicorn
- Scikit-learn
- Pandas
- NumPy

## Services & Integrations
- Firebase
- Cloudinary

---

# Installation & Setup

## 1. Clone the Repository

```bash
git clone <your-repository-url>
cd Beaulix
```

---

## 2. Backend Setup

Navigate to the backend folder:

```bash
cd backend
```

Create a virtual environment:

### Windows
```bash
python -m venv venv
venv\Scripts\activate
```

### macOS/Linux
```bash
python3 -m venv venv
source venv/bin/activate
```

Install dependencies:

```bash
pip install -r requirements.txt
```

Run the backend server:

```bash
python server.py
```

or

```bash
uvicorn server:app --reload
```

Backend runs at:

```bash
http://127.0.0.1:8000
```

---

## 3. Frontend Setup

Open the `frontend` folder.

You can run the frontend using:

### VS Code Live Server
OR

### Python HTTP Server

```bash
python -m http.server 5500
```

Then open:

```bash
http://127.0.0.1:5500/frontend
```

---

# Environment Variables

Create a `.env` file based on `.env.example`.

Example:

```env
BEAULIX_ENV=development
BEAULIX_FRONTEND_URL=http://127.0.0.1:5500
```

Add Firebase and Cloudinary credentials where required.

---

# API Overview

## Main Recommendation Endpoint

```http
POST /predict
```

Requires header: `X-Beaulix-API-Key: <your_key>`

### Example Request

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

### Example Response

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
  "visual_recommendations": { "VISUAL_SHOT": "...", "LIGHTING": "...", ... },
  "step2_recommendations": { "recommended_brand_style": "...", ... }
}
```

---

# Deployment

## Backend

**Minimum recommended spec: 2 vCPUs, 4 GB RAM.**
The server retrains 3 Random Forest models (97,920 + N rows) in a background thread on new predictions. On a single-core or memory-constrained instance (e.g. t2.micro / free tier), retrains will peg CPU and may degrade prediction latency under sustained load. Consider moving retraining to an async job queue (Celery/RQ) if latency becomes an issue.

You can deploy the backend using:
- Render
- Railway
- AWS
- Azure
- Google Cloud

> **⚠️ Managed platforms (Render, Railway, Fly.io): you MUST set `MANAGED_DEPLOY=1`**
> in your platform's environment variables before deploying. Without it, the platform
> sees `start.sh` as the running process (not uvicorn), health checks pass even when
> the server has crashed, and zero-downtime deploys behave incorrectly. This setting
> is **not optional** on managed hosts.

## Frontend
You can deploy the frontend using:
- Firebase Hosting
- Netlify
- Vercel

---

# Security Features

- API rate limiting using SlowAPI
- Environment-based configuration
- CORS protection
- Secure API key handling support

---

# Future Improvements

- User dashboard analytics
- AI-generated beauty reports
- Product recommendation marketplace
- Social media sharing
- Mobile app support
- Advanced AI personalization

---

# Contributors

Developed as part of the Beaulix project.

---

# License

This project is intended for educational and development purposes.
