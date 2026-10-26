"""Production safety regressions run entirely against synthetic local fixtures."""
from argparse import Namespace
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from backend_artifact import PRODUCTION_SERVICES, SERVICES, digest_file
from backend_backup import verify_backup
from backend_deploy_common import lock
from backend_deploy_production import CONTAINERS, MissingDeployment, apply_images, capture_previous, deploy
from test_backend_deploy import ROOT, SHA, bundle

MANIFESTS = ROOT / "bridges/cloud-server/deploy/k3s/manifests"


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
        self.previous = {service: f"docker.io/library/kordi-{service}@sha256:{'b' * 64}" for service in PRODUCTION_SERVICES}

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

    def deployment_command(self, missing=(), calls=None):
        def command(arguments):
            if calls is not None:
                calls.append(arguments)
            if "get" in arguments:
                service = arguments[arguments.index("deployment") + 1][len("kordi-"):]
                if service in missing:
                    raise subprocess.CalledProcessError(1, arguments, output=f'deployments.apps "kordi-{service}" not found (NotFound)')
                return json.dumps({"spec": {"template": {"spec": {"containers": [
                    {"name": CONTAINERS[service], "image": f"kordi-{service}:old"}]}}}})
            return ""
        return command

    def test_previous_images_use_the_real_worker_server_and_runner_container_names(self):
        self.assertEqual(CONTAINERS, {"omp-route-worker": "worker", "cloud-server": "server", "cloud-agent-runner": "runner"})
        store = {f"docker.io/library/kordi-{s}:old": "sha256:" + "b" * 64 for s in PRODUCTION_SERVICES}
        with patch("backend_deploy_production.run", side_effect=self.deployment_command()), \
             patch("backend_deploy_production.image_store", return_value=store):
            self.assertEqual(capture_previous(), self.previous)

    def test_every_production_manifest_names_the_promoted_container(self):
        for service in PRODUCTION_SERVICES:
            manifest = (MANIFESTS / f"{service}-deployment.yaml").read_text()
            self.assertIn(f"kind: Deployment\nmetadata:\n  name: kordi-{service}\n", manifest)
            self.assertIn(f"        - name: {CONTAINERS[service]}\n          image: kordi-{service}:dev\n", manifest)

    def test_missing_worker_deployment_fails_before_any_image_changes(self):
        calls = []
        store = {f"docker.io/library/kordi-{s}:old": "sha256:" + "b" * 64 for s in PRODUCTION_SERVICES}
        with patch("backend_deploy_production.run", side_effect=self.deployment_command({"omp-route-worker"}, calls)), \
             patch("backend_deploy_production.image_store", return_value=store), \
             patch("backend_deploy_production.apply_images") as apply:
            with self.assertRaises(MissingDeployment):
                deploy(self.args())
        apply.assert_not_called()
        self.assertFalse(any(word in call for call in calls for word in ("import", "tag", "set")))
        result = self.result()
        self.assertEqual((result["stage"], result["rollback"]), ("capture previous images", "not attempted"))
        self.assertIn("kordi-omp-route-worker does not exist", result["operatorAction"])
        self.assertIn("bridges/cloud-server/deploy/k3s/README.md", result["operatorAction"])

    def test_other_kubectl_failures_are_not_reported_as_a_missing_deployment(self):
        def command(arguments):
            raise subprocess.CalledProcessError(1, arguments, output="connection refused")
        with patch("backend_deploy_production.run", side_effect=command), \
             patch("backend_deploy_production.image_store", return_value={}):
            with self.assertRaises(subprocess.CalledProcessError):
                capture_previous()

    def test_worker_rolls_out_before_the_server_and_restores_after_it(self):
        self.assertEqual(set(PRODUCTION_SERVICES), set(SERVICES))
        calls = []
        with patch("backend_deploy_production.run", side_effect=lambda arguments: calls.append(arguments) or ""):
            apply_images(self.previous)
            forward, calls[:] = list(calls), []
            apply_images(self.previous, restore=True)
        order = ["omp-route-worker", "cloud-server", "cloud-agent-runner"]
        expected = []
        for service in order:
            expected.append(["set", "image", f"deployment/kordi-{service}", f"{CONTAINERS[service]}={self.previous[service]}"])
            expected.append(["rollout", "status", f"deployment/kordi-{service}", "--timeout=180s"])
        self.assertEqual([call[5:] for call in forward], expected)
        restored = [pair for index in range(len(order) - 1, -1, -1) for pair in expected[2 * index:2 * index + 2]]
        self.assertEqual([call[5:] for call in calls], restored)

    def test_promotion_applies_every_production_service(self):
        calls = []

        def command(arguments):
            calls.append(arguments)
            return ""

        with patch("backend_deploy_production.capture_previous", return_value=self.previous), \
             patch("backend_deploy_production.run", side_effect=command), \
             patch("backend_deploy_production.image_store", side_effect=self.store), \
             patch("backend_deploy_production.verify_running"):
            deploy(self.args())
        self.assertEqual(self.result()["outcome"], "success")
        self.assertEqual(sorted(self.result()["images"]), sorted(PRODUCTION_SERVICES))
        imported = [call[-1] for call in calls if "import" in call]
        self.assertEqual(imported, [str(self.directory / f"{service}.oci.tar") for service in PRODUCTION_SERVICES])
        changed = [call[-1] for call in calls if "set" in call]
        self.assertEqual(changed, [f"{CONTAINERS[service]}=docker.io/library/kordi-{service}@"
                                   f"{self.manifest['images'][service]['digest']}" for service in PRODUCTION_SERVICES])

    def test_image_promotion_preserves_google_identity_and_environment(self):
        specs = {service: {"serviceAccountName": "synthetic-service", "automountServiceAccountToken": False,
                          "volumes": [{"name": "identity", "projected": {"sources": []}}],
                          "containers": [{"name": CONTAINERS[service], "image": "old",
                                          "env": [{"name": "KORDI_SUPPORT_PROVIDER", "value": "vertex-ai"}],
                                          "volumeMounts": [{"name": "identity", "mountPath": "/identity", "readOnly": True}]}]}
                 for service in PRODUCTION_SERVICES}
        expected = deepcopy(specs)

        def command(arguments):
            if arguments[5:7] == ["set", "image"]:
                service = arguments[7].removeprefix("deployment/kordi-")
                specs[service]["containers"][0]["image"] = arguments[8].split("=", 1)[1]
            else:
                self.assertEqual(arguments[5:7], ["rollout", "status"])
            return ""

        with patch("backend_deploy_production.run", side_effect=command):
            apply_images(self.previous)
        for service in PRODUCTION_SERVICES:
            expected[service]["containers"][0]["image"] = self.previous[service]
        self.assertEqual(specs, expected)

    def test_independent_deployments_contend_for_the_same_host_lock(self):
        with lock("host-wide", self.directory / "locks", timeout=0):
            with self.assertRaises(TimeoutError):
                with lock("host-wide", self.directory / "locks", timeout=0):
                    self.fail("Second deployment acquired a held lock")


if __name__ == "__main__":
    unittest.main()
