"""Production safety regressions run entirely against synthetic local fixtures."""
from argparse import Namespace
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from backend_artifact import SERVICES, digest_file
from backend_backup import verify_backup
from backend_deploy_common import lock
from backend_deploy_production import capture_previous, deploy
from test_backend_deploy import SHA, bundle


class ProductionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.manifest = bundle(self.directory)
        self.backups = self.directory / "backups"
        self.backups.mkdir(mode=0o700)
        data = self.backups / "backup.dump"
        data.write_bytes(b"synthetic backup")
        self.now = datetime.now(timezone.utc)
        self.receipt = {"version": 1, "environment": "production", "file": data.name,
                        "size": data.stat().st_size, "sha256": digest_file(data),
                        "createdAt": (self.now - timedelta(minutes=5)).isoformat(),
                        "restoreVerification": {"success": True, "backupSha256": digest_file(data),
                                                "completedAt": (self.now - timedelta(minutes=1)).isoformat()}}
        self.save_receipt()
        self.previous = {service: f"docker.io/library/kordi-{service}@sha256:{'b' * 64}" for service in SERVICES}

    def save_receipt(self):
        (self.backups / "snapshot.json").write_text(json.dumps(self.receipt))

    def args(self, compatibility="backward-compatible"):
        state = self.directory / "state"
        state.mkdir(exist_ok=True)
        return Namespace(bundle=self.directory, sha=SHA, run_id="123", state=state,
                         backup_root=self.backups, backup_id="snapshot", schema_compatibility=compatibility,
                         lock_dir=self.directory / "locks")

    def result(self):
        return json.loads((self.directory / "deployment-result.json").read_text())

    def store(self):
        return {image["tag"]: image["digest"] for image in self.manifest["images"].values()}

    def test_backup_requires_fresh_restore_of_unchanged_data(self):
        self.assertTrue(verify_backup(self.backups, "snapshot", self.now)["backupVerified"])
        for change in [
            {"createdAt": (self.now - timedelta(days=2)).isoformat()},
            {"restoreVerification": {**self.receipt["restoreVerification"], "success": False}},
            {"sha256": "sha256:" + "0" * 64},
            {"file": "../backup.dump"},
        ]:
            original = dict(self.receipt)
            self.receipt.update(change)
            self.save_receipt()
            with self.assertRaises(ValueError):
                verify_backup(self.backups, "snapshot", self.now)
            self.receipt = original
        self.save_receipt()
        (self.backups / "backup.dump").write_bytes(b"changed")
        with self.assertRaises(ValueError):
            verify_backup(self.backups, "snapshot", self.now)

    def test_invalid_backup_prevents_every_host_command(self):
        (self.backups / "snapshot.json").unlink()
        with patch("backend_deploy_production.run") as command:
            with self.assertRaises(FileNotFoundError):
                deploy(self.args())
        command.assert_not_called()
        self.assertEqual(self.result()["stage"], "backup verification")

    def test_imported_digest_mismatch_never_changes_a_deployment(self):
        with patch("backend_deploy_production.capture_previous", return_value=self.previous), \
             patch("backend_deploy_production.run"), \
             patch("backend_deploy_production.image_store", return_value={}), \
             patch("backend_deploy_production.apply_images") as apply:
            with self.assertRaises(ValueError):
                deploy(self.args())
        apply.assert_not_called()
        self.assertEqual(self.result()["stage"], "import approved images")

    def test_compatible_failure_restores_and_verifies_previous_images(self):
        with patch("backend_deploy_production.capture_previous", return_value=self.previous), \
             patch("backend_deploy_production.run"), \
             patch("backend_deploy_production.image_store", side_effect=self.store), \
             patch("backend_deploy_production.apply_images") as apply, \
             patch("backend_deploy_production.verify_running", side_effect=[RuntimeError("smoke failed"), None]):
            with self.assertRaises(RuntimeError):
                deploy(self.args())
        self.assertEqual(apply.call_count, 2)
        self.assertEqual(apply.call_args.args[0], self.previous)
        self.assertEqual(self.result()["rollback"], "previous images restored and verified")

    def test_forward_only_failure_does_not_roll_back_an_incompatible_application(self):
        with patch("backend_deploy_production.capture_previous", return_value=self.previous), \
             patch("backend_deploy_production.run"), \
             patch("backend_deploy_production.image_store", side_effect=self.store), \
             patch("backend_deploy_production.apply_images") as apply, \
             patch("backend_deploy_production.verify_running", side_effect=RuntimeError("smoke failed")):
            with self.assertRaises(RuntimeError):
                deploy(self.args("forward-only"))
        self.assertEqual(apply.call_count, 1)
        self.assertIn("forward fix required", self.result()["rollback"])

    def test_previous_images_use_the_real_server_and_runner_container_names(self):
        def command(arguments):
            service = "cloud-agent-runner" if "kordi-cloud-agent-runner" in arguments else "cloud-server"
            name = "runner" if service == "cloud-agent-runner" else "server"
            if "get" in arguments:
                return json.dumps({"spec": {"template": {"spec": {"containers": [
                    {"name": name, "image": f"kordi-{service}:old"}]}}}})
            return ""
        store = {f"docker.io/library/kordi-{s}:old": "sha256:" + "b" * 64 for s in SERVICES}
        with patch("backend_deploy_production.run", side_effect=command), patch("backend_deploy_production.image_store", return_value=store):
            self.assertEqual(capture_previous(), self.previous)

    def test_independent_deployments_contend_for_the_same_host_lock(self):
        with lock("host-wide", self.directory / "locks", timeout=0):
            with self.assertRaises(TimeoutError):
                with lock("host-wide", self.directory / "locks", timeout=0):
                    self.fail("Second deployment acquired a held lock")


if __name__ == "__main__":
    unittest.main()
