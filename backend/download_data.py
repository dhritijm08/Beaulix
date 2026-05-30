"""
download_data.py  —  Beaulix build-time data downloader
Downloads private Excel files from Google Drive using a service account.

Env vars required:
  GOOGLE_SERVICE_ACCOUNT_JSON   full JSON key for the service account
  GDRIVE_FILE_COMBINATORIAL     file ID for beaulix_combinatorial_predictions.xlsx
  GDRIVE_FILE_VISUAL            file ID for beaulix_visual_brief.xlsx
  GDRIVE_FILE_STEP2             file ID for beaulix_step2_recommendations.xlsx
"""

import io
import json
import os
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).parent.resolve()

FILES = {
    "GDRIVE_FILE_COMBINATORIAL": "beaulix_combinatorial_predictions.xlsx",
    "GDRIVE_FILE_VISUAL":        "beaulix_visual_brief.xlsx",
    "GDRIVE_FILE_STEP2":         "beaulix_step2_recommendations.xlsx",
}

XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
GSHEETS_MIME = "application/vnd.google-apps.spreadsheet"


def get_drive_service():
    try:
        from google.oauth2 import service_account
        from googleapiclient.discovery import build
    except ImportError:
        print("ERROR: google-auth / google-api-python-client not installed.")
        sys.exit(1)

    sa_json = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON")
    if not sa_json:
        print("ERROR: GOOGLE_SERVICE_ACCOUNT_JSON env var is not set.")
        sys.exit(1)

    try:
        sa_info = json.loads(sa_json)
    except json.JSONDecodeError as exc:
        print(f"ERROR: Invalid JSON in GOOGLE_SERVICE_ACCOUNT_JSON: {exc}")
        sys.exit(1)

    creds = service_account.Credentials.from_service_account_info(
        sa_info, scopes=["https://www.googleapis.com/auth/drive.readonly"]
    )
    from googleapiclient.discovery import build
    return build("drive", "v3", credentials=creds, cache_discovery=False)


def download_file(service, file_id, dest_path):
    from googleapiclient.http import MediaIoBaseDownload

    print(f"  [{file_id}] -> {dest_path.name}")

    # Get metadata
    meta = service.files().get(
        fileId=file_id,
        fields="mimeType,name",
        supportsAllDrives=True
    ).execute()
    mime = meta.get("mimeType", "")
    name = meta.get("name", "")
    print(f"    Drive name: {name!r}  MIME: {mime}")

    if mime == GSHEETS_MIME:
        # Pure Google Sheets — export all sheets as xlsx
        print("    Using export_media (Google Sheets -> xlsx) ...")
        request = service.files().export_media(fileId=file_id, mimeType=XLSX_MIME)
    else:
        # Uploaded binary file (.xlsx) — download the original bytes directly
        print("    Using get_media (binary xlsx download) ...")
        request = service.files().get_media(fileId=file_id)

    buf = io.BytesIO()
    downloader = MediaIoBaseDownload(buf, request)
    done = False
    while not done:
        status, done = downloader.next_chunk()

    dest_path.write_bytes(buf.getvalue())
    size_mb = dest_path.stat().st_size / 1_048_576

    # Verify sheet names
    try:
        import openpyxl
        wb = openpyxl.load_workbook(str(dest_path), read_only=True)
        sheets = wb.sheetnames
        wb.close()
        print(f"    OK  ({size_mb:.1f} MB)  sheets: {sheets}")
    except Exception as e:
        print(f"    OK  ({size_mb:.1f} MB)  [could not verify sheets: {e}]")


def main():
    print("=" * 60)
    print("Beaulix -- downloading private data files from Google Drive")
    print("=" * 60)

    service = get_drive_service()

    for env_var, filename in FILES.items():
        file_id = os.environ.get(env_var)
        if not file_id:
            print(f"  SKIP: {env_var} not set -- {filename} skipped.")
            continue

        dest = BACKEND_DIR / filename
        if dest.exists():
            dest.unlink()  # always re-download to ensure fresh copy
            print(f"  Removed stale {filename}, re-downloading...")

        download_file(service, file_id, dest)

    print("\nAll data files ready.")
    print("=" * 60)


if __name__ == "__main__":
    main()
