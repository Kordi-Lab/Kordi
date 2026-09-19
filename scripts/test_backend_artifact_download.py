"""Downloaded archives must match GitHub's digest and contain only the approved files."""
import hashlib
from pathlib import Path
import tempfile
import unittest
import zipfile

from fetch_backend_artifact import FILES, extract_verified


class ArtifactDownloadTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.archive = self.root / "artifact.zip"

    def make_archive(self, extra=None):
        with zipfile.ZipFile(self.archive, "w") as archive:
            for name in FILES:
                archive.writestr(name, "synthetic fixture")
            if extra:
                archive.writestr(extra, "unexpected fixture")
        return "sha256:" + hashlib.sha256(self.archive.read_bytes()).hexdigest()

    def test_verified_archive_extracts_only_expected_files(self):
        digest = self.make_archive()
        target = self.root / "bundle"
        extract_verified(self.archive, target, digest)
        self.assertEqual({p.name for p in target.iterdir()}, FILES)

    def test_checksum_mismatch_writes_no_bundle(self):
        self.make_archive()
        target = self.root / "bundle"
        with self.assertRaises(ValueError):
            extract_verified(self.archive, target, "sha256:" + "0" * 64)
        self.assertFalse(target.exists())

    def test_unexpected_or_traversing_member_writes_no_bundle(self):
        for name in ["../escaped", "credentials.json"]:
            digest = self.make_archive(name)
            target = self.root / "bundle"
            with self.assertRaises(ValueError):
                extract_verified(self.archive, target, digest)
            self.assertFalse(target.exists())
