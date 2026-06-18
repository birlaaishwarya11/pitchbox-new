"""Storage backends for voiceover artifacts.

Replaces the legacy Tigris (S3-compatible) client with two simple options:

- Local filesystem (default): reads ``script.txt`` from ``./scripts/`` and keeps
  uploaded files under ``./audio/``.
- Vercel Blob (optional): uploads a file via Vercel's Blob HTTP API when the
  ``BLOB_READ_WRITE_TOKEN`` environment variable is configured.

Both functions expose the same call signatures the rest of the backend already
uses, so the switch from Tigris requires no changes at the call sites beyond
the import path.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Optional

import requests

DEFAULT_SCRIPT_DIR = Path(__file__).resolve().parent / "scripts"
DEFAULT_AUDIO_DIR = Path(__file__).resolve().parent / "audio"
VERCEL_BLOB_API = "https://blob.vercel-storage.com"


def _resolve_script_path(bucket_name: str, key: str = "script.txt") -> Path:
    # ``bucket_name`` is kept for signature parity with the old Tigris helper;
    # locally we just treat it as a subdirectory inside ``scripts/``.
    base = DEFAULT_SCRIPT_DIR / bucket_name if bucket_name else DEFAULT_SCRIPT_DIR
    candidate = base / key
    if candidate.exists():
        return candidate
    # Fall back to scripts/<key> so a single shared script still works.
    return DEFAULT_SCRIPT_DIR / key


def list_and_read_script(bucket_name: str, **_: object) -> str:
    """Return the contents of ``script.txt`` from the local scripts directory."""

    script_path = _resolve_script_path(bucket_name)
    if not script_path.exists():
        raise FileNotFoundError(
            f"Script not found at {script_path}. Place script.txt under backend/scripts/."
        )
    return script_path.read_text(encoding="utf-8")


def _upload_to_vercel_blob(file_path: str, object_name: str, token: str) -> str:
    with open(file_path, "rb") as fh:
        response = requests.put(
            f"{VERCEL_BLOB_API}/{object_name}",
            data=fh,
            headers={
                "authorization": f"Bearer {token}",
                "x-api-version": "7",
            },
            timeout=120,
        )
    response.raise_for_status()
    payload = response.json()
    return payload.get("url", "")


def upload_to_tigris(
    file_path: str,
    bucket_name: str,
    object_name: str,
    endpoint_url: Optional[str] = None,
) -> str:
    """Persist ``file_path`` locally and optionally mirror to Vercel Blob.

    The original Tigris helper returned ``None``; this version returns the
    canonical URI (Vercel Blob URL when available, otherwise the local path)
    so callers can surface it in responses.
    """

    del endpoint_url  # kept for signature parity with the old helper

    DEFAULT_AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    destination_dir = DEFAULT_AUDIO_DIR / bucket_name if bucket_name else DEFAULT_AUDIO_DIR
    destination_dir.mkdir(parents=True, exist_ok=True)
    destination = destination_dir / object_name

    source = Path(file_path)
    if source.resolve() != destination.resolve():
        destination.write_bytes(source.read_bytes())

    token = os.getenv("BLOB_READ_WRITE_TOKEN")
    if token:
        try:
            blob_url = _upload_to_vercel_blob(str(destination), object_name, token)
            if blob_url:
                print(f"Uploaded {object_name} to Vercel Blob: {blob_url}")
                return blob_url
        except Exception as exc:  # noqa: BLE001 - surface but don't crash the flow
            print(f"Vercel Blob upload failed, falling back to local storage: {exc}")

    print(f"Stored {object_name} locally at {destination}")
    return str(destination)
