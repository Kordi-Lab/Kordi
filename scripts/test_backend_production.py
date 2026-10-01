"""Production safety regressions run entirely against synthetic local fixtures."""
from argparse import Namespace
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from backend_artifact import PRODUCTION_SERVICES, digest_file
from backend_backup import verify_backup
from backend_deploy_common import lock
from backend_deploy_production import (KUBECTL, SANDBOX_EXCLUDED_RANGES, SANDBOX_POLICY, capture_previous, deploy,
                                       sandbox_policy_problem, verify_sandbox_network_policy)
from test_backend_deploy import ROOT, SHA, bundle


def sandbox_policy():
    """The stored form of the repository's agent sandbox NetworkPolicy."""
    return {"spec": {
        "podSelector": {"matchLabels": {"app.kubernetes.io/component": "agent-sandbox"}},
        "policyTypes": ["Ingress", "Egress"],
        "egress": [
            {"to": [{"namespaceSelector": {"matchLabels": {"kubernetes.io/metadata.name": "kube-system"}},
                     "podSelector": {"matchLabels": {"k8s-app": "kube-dns"}}}],
             "ports": [{"port": 53, "protocol": "UDP"}, {"port": 53, "protocol": "TCP"}]},
            {"to": [{"ipBlock": {"cidr": "0.0.0.0/0", "except": [
                "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16",
                "172.16.0.0/12", "192.168.0.0/16", "224.0.0.0/4", "240.0.0.0/4"]}}]},
        ],
    }}


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
        policy_check = patch("backend_deploy_production.verify_sandbox_network_policy")
        self.verify_policy = policy_check.start()
        self.addCleanup(policy_check.stop)

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
        store = {f"docker.io/library/kordi-{s}:old": "sha256:" + "b" * 64 for s in PRODUCTION_SERVICES}
        with patch("backend_deploy_production.run", side_effect=command), patch("backend_deploy_production.image_store", return_value=store):
            self.assertEqual(capture_previous(), self.previous)

    def test_promotion_applies_only_production_services(self):
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
        self.assertFalse(any("omp-route-worker" in " ".join(call) for call in calls))
        self.verify_policy.assert_called_once_with()

    def test_missing_sandbox_policy_stops_promotion_before_any_image_changes(self):
        self.verify_policy.side_effect = verify_sandbox_network_policy
        calls = []

        def command(arguments):
            calls.append(arguments)
            if "networkpolicy" in arguments:
                raise subprocess.CalledProcessError(1, arguments, output="NotFound")
            return ""

        with patch("backend_deploy_production.run", side_effect=command), \
             patch("backend_deploy_production.capture_previous") as previous, \
             patch("backend_deploy_production.apply_images") as apply:
            with self.assertRaises(ValueError):
                deploy(self.args())
        previous.assert_not_called()
        apply.assert_not_called()
        self.assertEqual(calls, [[*KUBECTL, "get", "networkpolicy", SANDBOX_POLICY, "-o", "json"]])
        self.assertEqual((self.result()["outcome"], self.result()["stage"]),
                         ("failure", "sandbox network policy verification"))

    def test_a_policy_that_does_not_isolate_sandbox_pods_stops_promotion(self):
        self.verify_policy.side_effect = verify_sandbox_network_policy
        weakened = sandbox_policy()
        weakened["spec"]["egress"][1]["to"][0]["ipBlock"]["except"].remove("169.254.0.0/16")
        with patch("backend_deploy_production.run", return_value=json.dumps(weakened)), \
             patch("backend_deploy_production.apply_images") as apply:
            with self.assertRaises(ValueError):
                deploy(self.args())
        apply.assert_not_called()
        self.assertEqual(self.result()["stage"], "sandbox network policy verification")

    def test_the_repository_sandbox_policy_passes_and_weakened_ones_fail(self):
        self.assertIsNone(sandbox_policy_problem(sandbox_policy()))
        with patch("backend_deploy_production.run", return_value=json.dumps(sandbox_policy())):
            verify_sandbox_network_policy()

        def weakened(change):
            policy = sandbox_policy()
            change(policy["spec"])
            return sandbox_policy_problem(policy)

        for change in [
            lambda spec: spec["podSelector"]["matchLabels"].update({"app.kubernetes.io/component": "other"}),
            lambda spec: spec["podSelector"].update({"matchLabels": {}}),
            lambda spec: spec.update({"policyTypes": ["Ingress"]}),
            lambda spec: spec.update({"ingress": [{}]}),
            lambda spec: spec["egress"].append({}),
            lambda spec: spec["egress"].append({"to": [{"podSelector": {}}]}),
            lambda spec: spec["egress"][0]["ports"].append({"port": 5432, "protocol": "TCP"}),
            lambda spec: spec["egress"][1]["to"][0]["ipBlock"].update({"except": []}),
            lambda spec: spec["egress"].append({"to": [{"ipBlock": {"cidr": "10.42.0.0/16"}}]}),
            lambda spec: spec["egress"].append({"to": [{"ipBlock": {"cidr": "::/0"}}]}),
            lambda spec: spec["egress"].append({"to": [{"ipBlock": {"cidr": "::/0", "except": ["fc00::/7"]}}]}),
            lambda spec: spec["egress"][0]["to"][0]["podSelector"]["matchLabels"].update({"k8s-app": "other"}),
            lambda spec: spec["egress"][0]["to"][0].pop("namespaceSelector"),
        ]:
            self.assertIsNotNone(weakened(change))
        self.assertIsNone(weakened(lambda spec: spec["egress"].append(
            {"to": [{"ipBlock": {"cidr": "10.0.0.0/8", "except": ["10.0.0.0/8"]}}]})))
        self.assertIsNone(weakened(lambda spec: spec["egress"].append({"to": [{"ipBlock": {
            "cidr": "::/0", "except": ["::1/128", "fc00::/7", "fe80::/10", "::ffff:0:0/96", "64:ff9b::/96"]}}]})))

    def test_other_policies_cannot_allow_traffic_for_sandbox_pods(self):
        named = dict(sandbox_policy(), metadata={"name": SANDBOX_POLICY})

        def listed(*others):
            return {"items": [named, *others]}

        allow_all = {"egress": [{}], "policyTypes": ["Egress"]}
        for selector in [{}, {"matchLabels": {"app.kubernetes.io/component": "agent-sandbox"}},
                         {"matchLabels": {"kordi.ai/sandbox-id": "sandbox-a"}},
                         {"matchExpressions": [{"key": "tier", "operator": "Exists"}]}]:
            other = {"metadata": {"name": "extra"}, "spec": dict(allow_all, podSelector=selector)}
            with patch("backend_deploy_production.run",
                       side_effect=[json.dumps(sandbox_policy()), json.dumps(listed(other))]):
                with self.assertRaises(ValueError, msg=str(selector)):
                    verify_sandbox_network_policy()
        server_selector = {"matchLabels": {"app.kubernetes.io/name": "kordi-cloud-server"}}
        unrelated = {"metadata": {"name": "server"}, "spec": dict(allow_all, podSelector=server_selector)}
        deny_all = {"metadata": {"name": "default-deny"},
                    "spec": {"podSelector": {}, "policyTypes": ["Ingress", "Egress"]}}
        with patch("backend_deploy_production.run",
                   side_effect=[json.dumps(sandbox_policy()), json.dumps(listed(unrelated, deny_all))]):
            verify_sandbox_network_policy()

    def test_the_policy_manifest_matches_what_promotion_requires(self):
        manifest = (ROOT / "bridges/cloud-server/deploy/k3s/manifests/agent-sandbox-network-policy.yaml").read_text()
        self.assertIn(f"name: {SANDBOX_POLICY}\n", manifest)
        self.assertIn("app.kubernetes.io/component: agent-sandbox\n", manifest)
        for internal in SANDBOX_EXCLUDED_RANGES:
            self.assertIn(f"- {internal}\n", manifest)

    def test_independent_deployments_contend_for_the_same_host_lock(self):
        with lock("host-wide", self.directory / "locks", timeout=0):
            with self.assertRaises(TimeoutError):
                with lock("host-wide", self.directory / "locks", timeout=0):
                    self.fail("Second deployment acquired a held lock")


if __name__ == "__main__":
    unittest.main()
