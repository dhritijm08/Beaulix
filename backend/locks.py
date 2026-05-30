"""
locks.py
========
Shared threading locks used across model.py and step2_engine.py.

Extracted to avoid a circular import: model.py -> step2_engine.py -> model.py.
Both modules import from this standalone module instead.
"""

import threading

# Protects model weight reads/writes during hot-swaps.
# RLock allows model.py to re-acquire within the same thread (e.g. during
# _apply_model_data called from both _load_model and the retrain task).
model_swap_lock: threading.RLock = threading.RLock()
