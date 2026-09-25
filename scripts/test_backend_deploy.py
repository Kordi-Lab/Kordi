"""Regression tests use synthetic images and mocked host commands only."""
from argparse import Namespace
from contextlib import redirect_stdout
import hashlib
import io
import json
from pathlib import Path
import re
import tarfile
import tempfile
import subprocess
import unittest
from unittest.mock import patch

from backend_artifact import SERVICES, create_manifest, verify_bundle
from backend_deploy_dev import deploy
from fetch_backend_artifact import FILES

SHA = "a" * 40
ROOT = Path(__file__).resolve().parent.parent
HEALTH_FORMAT = "{{if .State.Health}}{{.State.Health.Status}}{{end}}"


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

    def host(self, calls=None, identifier=None, worker_health="healthy"):
        identifier = identifier or self.manifest["images"]["cloud-server"]["imageId"]

        def command(arguments, **_):
            if calls is not None:
                calls.append(arguments)
            return worker_health if HEALTH_FORMAT in arguments else identifier
        return command

    def args(self, env_text="# Synthetic environment\n"):
        env = self.directory / "dev.env"
        env.write_text(env_text)
        return Namespace(bundle=self.directory, sha=SHA, run_id="123", project="kordi-test",
                         state=self.directory / "state", api_port=17181, env_file=env, compose=self.directory / "compose.yaml",
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

    def test_containerd_docker_manifest_identifiers_are_verified_against_the_approved_digest(self):
        digest = self.manifest["images"]["cloud-server"]["digest"]
        with patch("backend_deploy_dev.run", side_effect=self.host(identifier=digest)), patch("backend_deploy_dev.health"):
            deploy(self.args())
        self.assertEqual(json.loads((self.directory / "deployment-result.json").read_text())["outcome"], "success")

    def test_command_diagnostics_stay_in_private_host_logs(self):
        error = subprocess.CalledProcessError(1, ["fixture"], output="synthetic-private-diagnostic")
        with patch("backend_deploy_dev.run", side_effect=error):
            with self.assertRaises(subprocess.CalledProcessError):
                deploy(self.args())
        self.assertNotIn("synthetic-private-diagnostic", (self.directory / "deployment-result.json").read_text())
        log = next((self.directory / "state/logs").glob("*.log"))
        self.assertIn("synthetic-private-diagnostic", log.read_text())
        self.assertEqual(log.stat().st_mode & 0o777, 0o600)

    def test_ordering_state_is_rechecked_under_the_host_lock(self):
        args = self.args()
        args.expected_current_sha = "b" * 40
        with patch("backend_deploy_dev.run") as command:
            with self.assertRaises(ValueError):
                deploy(args)
        command.assert_not_called()

    def test_success_updates_every_bundled_image_without_building(self):
        calls = []
        with patch("backend_deploy_dev.run", side_effect=self.host(calls)), patch("backend_deploy_dev.health"):
            deploy(self.args())
        updates = [call for call in calls if "up" in call]
        self.assertEqual(len(updates), 1)
        self.assertIn("--no-build", updates[0])
        loaded = [call[-1] for call in calls if call[:2] == ["docker", "load"]]
        self.assertEqual(loaded, [str(self.directory / f"{service}.docker.tar") for service in SERVICES])
        override = json.loads((self.directory / "state/images.json").read_text())
        self.assertEqual(sorted(override["services"]), sorted(SERVICES))
        self.assertEqual(json.loads((self.directory / "deployment-result.json").read_text())["outcome"], "success")

    def test_missing_worker_token_is_generated_privately_before_compose_starts(self):
        calls = []
        output = io.StringIO()
        with patch("backend_deploy_dev.run", side_effect=self.host(calls)), patch("backend_deploy_dev.health"), \
             redirect_stdout(output):
            args = self.args("KORDI_CLOUD_RUNNER_TOKEN=synthetic-runner")
            deploy(args)
        content = args.env_file.read_text()
        tokens = re.findall(r"^KORDI_OMP_ROUTE_WORKER_TOKEN=([0-9a-f]{64})$", content, re.MULTILINE)
        self.assertEqual(len(tokens), 1)
        self.assertTrue(content.startswith("KORDI_CLOUD_RUNNER_TOKEN=synthetic-runner\n"))
        self.assertEqual(args.env_file.stat().st_mode & 0o777, 0o600)
        result = json.loads((self.directory / "deployment-result.json").read_text())
        self.assertIs(result["workerTokenProvisioned"], True)
        published = [output.getvalue(), json.dumps(result), json.dumps(calls)]
        published += [path.read_text() for path in (self.directory / "state/records").glob("*.json")]
        self.assertFalse(any(tokens[0] in text for text in published))

    def test_existing_worker_token_is_kept(self):
        env_text = "KORDI_OMP_ROUTE_WORKER_TOKEN=synthetic-existing-token\n"
        with patch("backend_deploy_dev.run", side_effect=self.host()), patch("backend_deploy_dev.health"):
            args = self.args(env_text)
            deploy(args)
        self.assertEqual(args.env_file.read_text(), env_text)
        self.assertIs(json.loads((self.directory / "deployment-result.json").read_text())["workerTokenProvisioned"], False)

    def test_empty_worker_token_fails_before_compose_starts(self):
        calls = []
        with patch("backend_deploy_dev.run", side_effect=self.host(calls)), patch("backend_deploy_dev.health"):
            with self.assertRaises(ValueError):
                deploy(self.args("KORDI_OMP_ROUTE_WORKER_TOKEN=\n"))
        self.assertFalse(any("up" in call for call in calls))
        self.assertEqual(json.loads((self.directory / "deployment-result.json").read_text())["stage"], "provision worker token")

    def test_unhealthy_worker_fails_the_deployment(self):
        with patch("backend_deploy_dev.run", side_effect=self.host(worker_health="starting")), patch("backend_deploy_dev.health"):
            with self.assertRaises(RuntimeError):
                deploy(self.args())
        result = json.loads((self.directory / "deployment-result.json").read_text())
        self.assertEqual((result["outcome"], result["stage"]), ("failure", "health verification"))
        self.assertFalse((self.directory / "state/current.json").exists())

    def test_every_bundled_service_is_built_fetched_exported_and_health_checked(self):
        workflow = (ROOT / ".github/workflows/backend-delivery.yml").read_text()
        for service in SERVICES:
            self.assertIn(f"tags: docker.io/library/kordi-{service}:${{{{ steps.revision.outputs.sha }}}}", workflow)
            for kind in ("docker", "oci"):
                self.assertIn(f"type={kind},dest=${{{{ runner.temp }}}}/backend-bundle/{service}.{kind}.tar", workflow)
        self.assertIn("file: source/experiments/omp-provider-routing/Dockerfile", workflow)
        self.assertEqual(FILES, {"backend-manifest.json"} | {f"{s}.{k}.tar" for s in SERVICES for k in ("docker", "oci")})
        self.assertIn("from backend_artifact import SERVICES", (ROOT / "scripts/test-backend-export.sh").read_text())
        compose = (ROOT / "deploy/dev/compose.yaml").read_text()
        worker = compose[compose.index("  omp-route-worker:"):]
        self.assertIn("http://127.0.0.1:17331/health", worker[:worker.index("restart:")])


if __name__ == "__main__":
    unittest.main()
