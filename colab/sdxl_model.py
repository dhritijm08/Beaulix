import subprocess
import os
import time
import gc

# Free memory before anything starts
gc.collect()
try:
    import torch as _torch
    _torch.cuda.empty_cache()
except Exception:
    pass

# Kill anything already on port 8000
subprocess.run(['fuser', '-k', '8000/tcp'], capture_output=True)
subprocess.run(['pkill', '-f', 'uvicorn'], capture_output=True)
subprocess.run(['pkill', '-f', 'ngrok'], capture_output=True)

time.sleep(3)
print("✅ Cleanup done — starting fresh")

# ============================================================
# STEP 1: Install dependencies
# ============================================================
subprocess.run(['pip', 'install', '-q', 'diffusers', 'transformers', 'accelerate'], check=False)
subprocess.run(['pip', 'install', '-q', 'pillow', 'numpy', 'fastapi', 'uvicorn'], check=False)
subprocess.run(['pip', 'install', '-q', 'imageio[ffmpeg]', 'imageio-ffmpeg'], check=False)
subprocess.run(['apt-get', 'install', '-q', '-y', 'ffmpeg'], check=False)
subprocess.run(['pip', 'install', '-q', 'python-multipart', 'pyngrok'], check=False)

print("✅ Dependencies installed!")

# ============================================================
# STEP 2: Imports
# ============================================================
import torch
import numpy as np
import requests
import threading
import mimetypes
from PIL import Image
from datetime import datetime
import uvicorn
from fastapi import FastAPI, HTTPException, Response, Header, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel
from typing import Optional, List
import imageio
from diffusers import StableDiffusionXLPipeline, AutoencoderKL, EulerAncestralDiscreteScheduler

print(f"✅ PyTorch {torch.__version__} | CUDA: {torch.cuda.is_available()}")
if torch.cuda.is_available():
    print(f"   GPU: {torch.cuda.get_device_name(0)} | VRAM: {torch.cuda.get_device_properties(0).total_memory/1e9:.1f}GB")
else:
    print("   ⚠️  No GPU — go to Runtime → Change runtime type → T4 GPU!")

# ============================================================
# STEP 3: Directories
# ============================================================
os.makedirs('/content/beaulix_outputs/images', exist_ok=True)
os.makedirs('/content/beaulix_outputs/videos', exist_ok=True)
IMAGES_DIR = "/content/beaulix_outputs/images"
VIDEOS_DIR = "/content/beaulix_outputs/videos"
mimetypes.init()
mimetypes.add_type('video/mp4', '.mp4')

# ============================================================
# STEP 4: Image Model
# ============================================================
class ImageModelManager:
    def __init__(self):
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self.dtype  = torch.float16 if torch.cuda.is_available() else torch.float32
        self.pipe   = None
        self.model_loaded = False

    def load_sdxl(self):
        if self.model_loaded:
            return
        print(f"📦 Loading SDXL on {self.device.upper()} ({self.dtype})...")

        vae = AutoencoderKL.from_pretrained(
            "madebyollin/sdxl-vae-fp16-fix",
            torch_dtype=self.dtype
        ).to(self.device)

        pipe_kwargs = {
            "vae": vae,
            "torch_dtype": self.dtype,
            "use_safetensors": True,
        }
        if self.dtype == torch.float16:
            pipe_kwargs["variant"] = "fp16"

        self.pipe = StableDiffusionXLPipeline.from_pretrained(
            "stabilityai/stable-diffusion-xl-base-1.0",
            **pipe_kwargs
        )
        # Offloads model layers to CPU when not in use — prevents OOM crash on Colab
        self.pipe.enable_model_cpu_offload()

        self.pipe.scheduler = EulerAncestralDiscreteScheduler.from_config(
            self.pipe.scheduler.config
        )
        self.pipe.enable_attention_slicing()
        self.pipe.vae.enable_slicing()

        self.model_loaded = True
        print(f"✅ Image model loaded on {self.device.upper()}!")

# ============================================================
# STEP 5: Image Generator
# ============================================================
class ImageGenerator:
    def __init__(self, model_manager):
        self.models = model_manager
        self.count  = 0

    def _get_size(self, aspect_ratio):
        sizes = {
            "1:1":  (768, 768),
            "9:16": (432, 768),
            "16:9": (768, 432),
            "4:5":  (640, 768),
            "3:4":  (576, 768),
        }
        w, h = sizes.get(aspect_ratio, (768, 768))
        w = ((w + 7) // 8) * 8
        h = ((h + 7) // 8) * 8
        return w, h

    def generate(self, prompt, aspect_ratio="1:1", num_images=1, steps=25):
        if not self.models.model_loaded:
            self.models.load_sdxl()
        w, h = self._get_size(aspect_ratio)
        print(f"\n🎨 Generating {w}×{h} image on {self.models.device.upper()}...")

        with torch.inference_mode():
            result = self.models.pipe(
                prompt=prompt,
                negative_prompt="ugly, blurry, low quality, deformed",
                width=w, height=h,
                num_images_per_prompt=num_images,
                num_inference_steps=steps,
                guidance_scale=7.5,
                output_type="pil",
            )

        saved = []
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        for i, img in enumerate(result.images):
            fn = f"beaulix_image_{ts}_{self.count}_{i}.jpg"
            img.convert("RGB").save(f"{IMAGES_DIR}/{fn}", "JPEG", quality=90)
            saved.append(fn)
        self.count += 1
        return {"success": True, "files": saved, "prompt": prompt}

    def generate_pil(self, prompt, aspect_ratio="1:1", steps=20):
        if not self.models.model_loaded:
            self.models.load_sdxl()
        w, h = self._get_size(aspect_ratio)
        with torch.inference_mode():
            result = self.models.pipe(
                prompt=prompt,
                negative_prompt="ugly, blurry, low quality, deformed",
                width=w, height=h,
                num_images_per_prompt=1,
                num_inference_steps=steps,
                guidance_scale=7.5,
                output_type="pil",
            )
        return result.images[0], w, h

# ============================================================
# STEP 6: Video Generator
# ============================================================
class VideoGenerator:
    SECS_PER_IMAGE = 0.5

    def __init__(self, image_generator):
        self.image_gen = image_generator
        self.count = 0

    @classmethod
    def _keyframe_count(cls, duration):
        return int(duration / cls.SECS_PER_IMAGE) + 1

    @staticmethod
    def _crossfade(a, b, n):
        return [((1 - i/max(n-1,1))*a + (i/max(n-1,1))*b).astype(np.uint8) for i in range(n)]

    @staticmethod
    def _variant_prompts(base, n):
        suffixes = ["", ", close-up detail shot", ", wider angle lifestyle",
                    ", macro texture detail", ", soft bokeh background",
                    ", dramatic side lighting", ", overhead flat lay",
                    ", editorial beauty shot", ", natural window light",
                    ", product hero shot", ", glowing skin close-up", ", vibrant colour pop"]
        return [base + suffixes[i % len(suffixes)] for i in range(n)]

    def generate(self, prompt, duration=4, fps=24, aspect_ratio="1:1"):
        duration = max(2, min(duration, 6))
        fps      = max(12, min(fps, 30))
        n_keys   = self._keyframe_count(duration)
        prompts  = self._variant_prompts(prompt, n_keys)

        frames_per_image = int(fps * self.SECS_PER_IMAGE)
        crossfade_frames = max(2, fps // 8)
        hold_frames      = max(1, frames_per_image - crossfade_frames)

        print(f"\n🎬 VIDEO | {duration}s · {fps}fps · {n_keys} keyframes")
        keyframes = []
        ref_w = ref_h = None

        for idx, p in enumerate(prompts):
            print(f"   🖼  Keyframe {idx+1}/{n_keys}…")
            pil_img, w, h = self.image_gen.generate_pil(p, aspect_ratio=aspect_ratio, steps=20)
            if ref_w is None:
                ref_w, ref_h = w, h
            else:
                pil_img = pil_img.resize((ref_w, ref_h), Image.LANCZOS)
            keyframes.append(np.array(pil_img.convert("RGB")))

        total_frames = duration * fps
        video_frames = []
        for i in range(len(keyframes) - 1):
            video_frames.extend([keyframes[i]] * hold_frames)
            video_frames.extend(self._crossfade(keyframes[i], keyframes[i+1], crossfade_frames))
        while len(video_frames) < total_frames:
            video_frames.append(keyframes[-1])
        video_frames = video_frames[:total_frames]

        ts       = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"beaulix_video_{ts}_{self.count}.mp4"
        out_path = f"{VIDEOS_DIR}/{filename}"

        def ensure_size(f):
            if f.shape[1] != ref_w or f.shape[0] != ref_h:
                return np.array(Image.fromarray(f).resize((ref_w, ref_h), Image.LANCZOS))
            return f

        writer = imageio.get_writer(out_path, fps=fps, codec="libx264", quality=8,
                                    macro_block_size=None,
                                    output_params=["-vf", f"scale={ref_w}:{ref_h}"])
        for frame in video_frames:
            writer.append_data(ensure_size(frame))
        writer.close()

        final_filename = filename
        try:
            import glob, random
            _music_dir = os.environ.get("BEAULIX_MUSIC_DIR", "/content")
            tracks = glob.glob(os.path.join(_music_dir, "bg_music_*.mp3"))
            if tracks:
                music = random.choice(tracks)
                final_filename = f"beaulix_video_audio_{ts}_{self.count}.mp4"
                final_path = f"{VIDEOS_DIR}/{final_filename}"
                result = subprocess.run(
                    [
                        "ffmpeg", "-y",
                        "-i", out_path,
                        "-stream_loop", "-1",
                        "-i", music,
                        "-map", "0:v:0", "-map", "1:a:0",
                        "-c:v", "copy", "-c:a", "aac", "-b:a", "128k",
                        "-t", str(duration), "-shortest",
                        final_path,
                        "-loglevel", "error",
                    ],
                    capture_output=True,
                )
                if result.returncode == 0 and os.path.exists(final_path):
                    os.remove(out_path)
                else:
                    final_filename = filename
        except Exception as e:
            print(f"   ⚠️  Audio merge error: {e}")

        self.count += 1
        return {"success": True, "files": [final_filename], "prompt": prompt}

# ============================================================
# STEP 7: Initialize models
# ============================================================
print("\n" + "="*60)
image_models    = ImageModelManager()
image_models.load_sdxl()
image_generator = ImageGenerator(image_models)
video_generator = VideoGenerator(image_generator)
print("✅ Generators ready")

# ============================================================
# STEP 8: FastAPI App
# ============================================================
app = FastAPI(title="Beaulix")

# ⚠️  SECURITY: Restrict CORS to known origins.
# Add every origin your frontend might be served from.
# VS Code Live Server defaults to port 5500; adjust if yours differs.
_gpu_allowed_origins = list(filter(None, [
    os.environ.get("BEAULIX_FRONTEND_URL", ""),  # set this in production
    "http://localhost:5000",
    "http://127.0.0.1:5000",
    "http://localhost:5500",       # VS Code Live Server
    "http://127.0.0.1:5500",      # VS Code Live Server (127 variant)
    "http://localhost:3000",       # common dev servers
    "http://127.0.0.1:3000",
    "http://localhost:8080",
    "http://127.0.0.1:8080",
]))

if not any(os.environ.get("BEAULIX_FRONTEND_URL", "")):
    import sys as _sdxl_sys
    _sdxl_sys.stderr.write(
        "WARNING: BEAULIX_FRONTEND_URL is not set. CORS is restricted to localhost only.\n"
        "Set os.environ['BEAULIX_FRONTEND_URL'] = 'https://your-project.web.app' before starting.\n"
    )

app.add_middleware(
    CORSMiddleware,
    allow_origins=_gpu_allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Shared-secret authentication ──────────────────────────────────────────────
# Set BEAULIX_API_KEY in Colab Secrets (userdata) before starting the server.
# The frontend must send the same value in the X-Beaulix-API-Key header.
_GPU_API_KEY: str = ""
try:
    from google.colab import userdata as _colab_userdata
    _GPU_API_KEY = _colab_userdata.get("BEAULIX_API_KEY") or ""
except Exception:
    pass  # running outside Colab; key can also be set via os.environ

if not _GPU_API_KEY:
    _GPU_API_KEY = os.environ.get("BEAULIX_API_KEY", "")

if not _GPU_API_KEY:
    import sys as _auth_sys
    _auth_sys.stderr.write(
        "WARNING: BEAULIX_API_KEY is not set. The /generate endpoint is unprotected.\n"
        "Add BEAULIX_API_KEY to Colab Secrets or set os.environ['BEAULIX_API_KEY'] before starting.\n"
    )


def _require_api_key(x_beaulix_api_key: str = Header(default="")):
    """Dependency that rejects requests without the correct shared secret."""
    if not _GPU_API_KEY:
        # Key not configured — warn but allow (avoids hard lock-out during setup).
        return
    if x_beaulix_api_key != _GPU_API_KEY:
        raise HTTPException(status_code=401, detail="Invalid or missing API key.")

class GenRequest(BaseModel):
    prompt: str
    aspect_ratio: Optional[str] = "1:1"
    output_type: Optional[str] = "image"
    duration: Optional[int] = 4
    fps: Optional[int] = 24
    num_images: Optional[int] = 1
    steps: Optional[int] = 20

class GenResponse(BaseModel):
    success: bool
    output_type: str
    files: List[str]
    message: Optional[str] = None

@app.get("/health")
async def health():
    free_gb = 0
    if torch.cuda.is_available():
        free_gb = (torch.cuda.get_device_properties(0).total_memory - torch.cuda.memory_allocated(0)) / 1e9
    return {
        "status": "healthy",
        "gpu_available": torch.cuda.is_available(),
        "gpu_name": torch.cuda.get_device_name(0) if torch.cuda.is_available() else "CPU",
        "vram_free_gb": round(free_gb, 1),
        "images_generated": len(os.listdir(IMAGES_DIR)) if os.path.exists(IMAGES_DIR) else 0,
        "videos_generated": len(os.listdir(VIDEOS_DIR)) if os.path.exists(VIDEOS_DIR) else 0,
    }

@app.post("/generate", response_model=GenResponse, dependencies=[Depends(_require_api_key)])
async def generate(req: GenRequest):
    try:
        if req.output_type == "video":
            result = video_generator.generate(
                prompt=req.prompt,
                duration=min(max(req.duration or 4, 2), 6),
                fps=min(max(req.fps or 24, 12), 30),
                aspect_ratio=req.aspect_ratio or "1:1",
            )
            files = [f"/files/{f}" for f in result["files"]]
            return GenResponse(success=True, output_type="video", files=files, message="Video generated")
        else:
            result = image_generator.generate(
                prompt=req.prompt, aspect_ratio=req.aspect_ratio,
                num_images=req.num_images or 1, steps=req.steps or 20,
            )
            files = [f"/files/{f}" for f in result["files"]]
            return GenResponse(success=True, output_type="image", files=files,
                               message=f"Generated {len(result['files'])} image(s)")
    except Exception as e:
        import traceback; traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/files/{filename}")
async def get_file(filename: str):
    for path, mime in [(f"{IMAGES_DIR}/{filename}", "image/jpeg"),
                       (f"{VIDEOS_DIR}/{filename}", "video/mp4")]:
        if os.path.exists(path):
            return FileResponse(path, media_type=mime,
                                headers={"Cache-Control": "public, max-age=3600",
                                         "Access-Control-Allow-Origin": "*",
                                         "Accept-Ranges": "bytes"})
    raise HTTPException(status_code=404, detail="File not found")

@app.head("/files/{filename}")
async def head_file(filename: str):
    for path, mime in [(f"{IMAGES_DIR}/{filename}", "image/jpeg"),
                       (f"{VIDEOS_DIR}/{filename}", "video/mp4")]:
        if os.path.exists(path):
            return Response(status_code=200, headers={
                "Content-Type": mime,
                "Content-Length": str(os.path.getsize(path)),
                "Access-Control-Allow-Origin": "*"})
    raise HTTPException(status_code=404, detail="File not found")

@app.get("/files")
async def list_files():
    images = os.listdir(IMAGES_DIR) if os.path.exists(IMAGES_DIR) else []
    videos = os.listdir(VIDEOS_DIR) if os.path.exists(VIDEOS_DIR) else []
    return {"images": images[-10:], "videos": videos[-10:],
            "images_count": len(images), "videos_count": len(videos)}

# ============================================================
# STEP 9: Start server
# ============================================================
threading.Thread(
    target=lambda: uvicorn.run(app, host="0.0.0.0", port=8000, log_level="info"),
    daemon=True
).start()
print("⏳ Server starting...")
time.sleep(3)

# ============================================================
# STEP 10: ngrok Tunnel
# ============================================================
print("\n" + "="*60)
print("🔌 STARTING TUNNEL")
print("="*60)

from pyngrok import ngrok
# google.colab.userdata already imported above for BEAULIX_API_KEY
ngrok.set_auth_token(_colab_userdata.get("NGROK_AUTH_TOKEN"))
tunnel = ngrok.connect(8000)
public_url = tunnel.public_url
print(f"✅ Tunnel live: {public_url}")

# ============================================================
# STEP 11: Summary
# ============================================================
print("\n" + "="*60)
print("🚀 SERVER READY!")
print("="*60)
print(f"\n📱 YOUR FRONTEND URL (already hardcoded — no action needed):")
print(f"   {public_url}")
print(f"\n   Health:   {public_url}/health")
print(f"   Generate: {public_url}/generate")
print(f"   Files:    {public_url}/files")
print(f"\n⚠️  Remember to update GPU_API_BASE in generator.html if the ngrok URL changed:")
print(f'   const GPU_API_BASE = "{public_url}";')

# ============================================================
# STEP 12: Keep-alive monitor
# ============================================================
def keep_alive():
    while True:
        try:
            time.sleep(60)
            r = requests.get(f"{public_url}/health", timeout=5)
            if r.ok:
                d = r.json()
                print(f"📊 [{datetime.now().strftime('%H:%M')}] "
                      f"GPU:{d.get('gpu_name','?')[:15]} | "
                      f"Imgs:{d['images_generated']} | Vids:{d['videos_generated']}")
        except: pass

threading.Thread(target=keep_alive, daemon=True).start()

# Health check
try:
    r = requests.get(f"{public_url}/health", timeout=10)
    print(f"\n✅ Health check passed: {r.json()}")
except Exception as e:
    print(f"❌ Health check failed: {e}")

# Keep cell alive
try:
    while True:
        time.sleep(10)
except KeyboardInterrupt:
    print("\n🛑 Stopping...")