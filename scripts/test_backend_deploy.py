"""Regression tests use synthetic images and mocked host commands only."""
from argparse import Namespace
import hashlib
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

from backend_artifact import SERVICES, create_manifest, verify_bundle
from backend_deploy_dev import deploy

SHA = "a" * 40


def add(archive, name, data):
    info = tarfile.TarInfo(name)
    info.size = len(data)
    archive.addfile(info, io.BytesIO(data))


def bundle(directory):
    config = json.dumps({"os": "linux", "architecture": "amd64", "config": {
        "Labels": {"org.opencontainers.image.revision": SHA}}}).encode()
    config_id = hashlib.sha256(config).hexdigest()
    manifest = json.dumps({"config": {"digest": "sha256:" + config_id}, "layers": []}).encode()
    manifest_id = hashlib.sha256(manifest).hexdigest()
    for service in SERVICES:
        with tarfile.open(directory / f"{service}.oci.tar", "w") as archive:
            add(archive, "index.json", json.dumps({"manifests": [{"digest": "sha256:" + manifest_id}]}).encode())
            add(archive, "blobs/sha256/" + manifest_id, manifest)
            add(archive, "blobs/sha256/" + config_id, config)
        with tarfile.open(directory / f"{service}.docker.tar", "w") as archive:
            add(archive, "manifest.json", json.dumps([{"Config": "config.json"}]).encode())
            add(archive, "config.json", config)
    result = create_manifest(directory, SHA, "123")
    (directory / "backend-manifest.json").write_text(json.dumps(result))
    return result


class BackendTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.manifest = bundle(self.directory)

    def test_verified_bundle_binds_revision_run_and_images(self):
        self.assertEqual(verify_bundle(self.directory, SHA, "123"), self.manifest)
        for sha, run in [("b" * 40, "123"), (SHA, "124")]:
            with self.assertRaises(ValueError):
                verify_bundle(self.directory, sha, run)

    def test_archive_corruption_fails_before_deployment(self):
        with (self.directory / "cloud-server.docker.tar").open("ab") as stream:
            stream.write(b"tampered")
        with self.assertRaises(ValueError):
            verify_bundle(self.directory, SHA, "123")

    def args(self):
        env = self.directory / "dev.env"
        env.write_text("# Synthetic environment\n")
        return Namespace(bundle=self.directory, sha=SHA, run_id="123", project="kordi-test",
                         state=self.directory / "state", env_file=env, compose=self.directory / "compose.yaml",
                         lock_dir=self.directory / "locks")

    def test_loaded_image_mismatch_never_updates_running_stack(self):
        calls = []

        def command(arguments, **_):
            calls.append(arguments)
            return "sha256:" + "0" * 64

        with patch("backend_deploy_dev.run", side_effect=command):
            with self.assertRaises(ValueError):
                deploy(self.args())
        self.assertFalse(any("up" in call for call in calls))
        record = json.loads((self.directory / "deployment-result.json").read_text())
        self.assertEqual(record["outcome"], "failure")
        self.assertEqual(len(list((self.directory / "state/records").glob("*.json"))), 1)

    def test_success_updates_both_images_without_building(self):
        calls = []
        image_id = self.manifest["images"]["cloud-server"]["imageId"]

        def command(arguments, **_):
            calls.append(arguments)
            return image_id

        with patch("backend_deploy_dev.run", side_effect=command), patch("backend_deploy_dev.health"):
            deploy(self.args())
        updates = [call for call in calls if "up" in call]
        self.assertEqual(len(updates), 1)
        self.assertIn("--no-build", updates[0])
        self.assertEqual(json.loads((self.directory / "deployment-result.json").read_text())["outcome"], "success")


if __name__ == "__main__":
    unittest.main()
