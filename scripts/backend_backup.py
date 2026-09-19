"""Validate a host-owned backup receipt and restore evidence before production changes."""
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re

from backend_artifact import digest_file


def trusted_file(path):
    info = path.lstat()
    if path.is_symlink() or not path.is_file() or info.st_uid not in (0, os.getuid()) or info.st_mode & 0o022:
        raise ValueError("Backup files must be regular, host-owned, and not writable by other users")


def verify_backup(root, backup_id, now=None):
    now = now or datetime.now(timezone.utc)
    if not root.is_absolute() or root.is_symlink() or root.stat().st_mode & 0o022:
        raise ValueError("A protected absolute backup directory is required")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,95}", backup_id):
        raise ValueError("Invalid backup identifier")
    receipt_path = root / (backup_id + ".json")
    trusted_file(receipt_path)
    receipt = json.loads(receipt_path.read_text())
    if receipt.get("version") != 1 or receipt.get("environment") != "production":
        raise ValueError("Backup receipt is not for production")
    filename = receipt.get("file", "")
    if not filename or Path(filename).name != filename or filename in (".", ".."):
        raise ValueError("Backup data must be a file in the protected directory")
    backup = root / filename
    trusted_file(backup)
    if backup.stat().st_size <= 0 or backup.stat().st_size != receipt.get("size"):
        raise ValueError("Backup is empty or has changed size")
    actual = digest_file(backup)
    if actual != receipt.get("sha256"):
        raise ValueError("Backup checksum mismatch")
    created = datetime.fromisoformat(receipt["createdAt"].replace("Z", "+00:00"))
    restored = receipt.get("restoreVerification", {})
    verified = datetime.fromisoformat(restored["completedAt"].replace("Z", "+00:00"))
    if created.tzinfo is None or verified.tzinfo is None:
        raise ValueError("Backup evidence requires timezone-aware timestamps")
    if not (0 <= (now - created).total_seconds() <= 86400 and created <= verified <= now):
        raise ValueError("Backup or restore evidence is stale or from the future")
    if restored.get("success") is not True or restored.get("backupSha256") != actual:
        raise ValueError("A successful restore of this exact backup is required")
    return {"backupVerified": True, "backupSha256": actual, "restoreVerifiedAt": restored["completedAt"]}
