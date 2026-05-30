"""
Run during Render build to pre-process Excel files into a pkl.
This eliminates in-memory Excel parsing on first request, saving ~100MB RAM.
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

import excel_cache
excel_cache.build_visual_pkl(BASE_DIR)
print("✅ visual_data.pkl built successfully")
