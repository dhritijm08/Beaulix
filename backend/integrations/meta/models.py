"""Response shapes for the Meta integration API. Kept separate from
store.py's dict-based Firestore document shape so the two can diverge
safely (e.g. the API response never gains a field just because the stored
document does)."""
from typing import Optional

from pydantic import BaseModel


class MetaConnectionStatus(BaseModel):
    """Safe, client-facing view of a Meta platform connection. Never
    includes the access token — see store.to_safe_dict()."""

    connected: bool
    platform: str = "meta"
    connectionId: Optional[str] = None
    brandId: Optional[str] = None
    accountId: Optional[str] = None
    accountName: Optional[str] = None
    status: Optional[str] = None
    lastSyncedAt: Optional[str] = None
    createdAt: Optional[str] = None
    updatedAt: Optional[str] = None
