"""Exercise self-hosted configuration and generated resources without any cloud."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

from vps_config import ROOT, caddyfile, initialize, load, manifests, outside_repository, validate

spec = importlib.util.spec_from_file_location("vps_deploy", ROOT / "scripts/vps-deploy.py")
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


class VPSConfigTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "config.json"
        initialize(self.path)
        self.config = json.loads(self.path.read_text())
        self.config["images"] = {name: f"example.test/{name}@sha256:" + "a" * 64
                                 for name in self.config["images"]}
        self.config["server"]["KORDI_AUTH_SMTP_HOST"] = "smtp.example.test"
        self.config["server"]["KORDI_AUTH_SMTP_FROM"] = "accounts@example.test"

    def test_init_is_private_and_cannot_replace_credentials(self):
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)
        before = self.path.read_bytes()
        with self.assertRaises(FileExistsError):
            initialize(self.path)
        self.assertEqual(self.path.read_bytes(), before)

    def test_config_file_permissions_are_checked(self):
        self.path.write_text(json.dumps(self.config))
        self.assertEqual(load(self.path)["storage_id"], self.config["storage_id"])
        self.path.chmod(0o644)
        with self.assertRaises(ValueError):
            load(self.path)

    def test_private_paths_cannot_be_inside_source_checkout(self):
        with self.assertRaises(ValueError):
            outside_repository(ROOT / "operator-config.json")
        outside_repository(self.path)

    def test_upgrades_retain_encryption_keys_and_restart_for_config_changes(self):
        before = manifests(self.config)
        self.config["generated"]["provider"] = "YQ=="
        with self.assertRaises(ValueError):
            deploy.assert_owned_namespace(before[0], self.config)
        self.config["generated"] = json.loads(self.path.read_text())["generated"]
        self.config["server"]["KORDI_AUTH_SMTP_HOST"] = "new-smtp.example.test"
        after = manifests(validate(self.config))
        deploy.assert_owned_namespace(before[0], self.config)
        templates = lambda docs: [d["spec"]["template"]["metadata"]["annotations"]
                                  for d in docs if d["kind"] == "Deployment"]
        self.assertNotEqual(templates(before), templates(after))

    def test_policies_and_permissions_precede_workloads(self):
        prerequisites, infrastructure, applications = deploy.deployment_stages(manifests(self.config))
        self.assertIn("NetworkPolicy", {d["kind"] for d in prerequisites})
        self.assertIn("RoleBinding", {d["kind"] for d in prerequisites})
        self.assertTrue(all(d["kind"] != "Deployment" for d in prerequisites + infrastructure))
        self.assertEqual(len(applications), 3)
        policy = next(d for d in prerequisites if d["metadata"]["name"] == "vps-sandbox-boundary")
        self.assertEqual(policy["spec"]["ingress"], [])
        self.assertIn("169.254.0.0/16", policy["spec"]["egress"][1]["to"][0]["ipBlock"]["except"])

    def test_shared_origins_keep_one_database_and_account_namespace(self):
        self.config["additional_origins"] = ["https://backup.example.test"]
        docs = manifests(validate(self.config))
        namespaces = [d for d in docs if d["kind"] == "Namespace"]
        self.assertEqual(len(namespaces), 1)
        self.assertEqual(len([d for d in docs if d["kind"] == "StatefulSet" and d["metadata"]["name"] == "postgres"]), 1)
        caddy = caddyfile(self.config)
        self.assertIn("https://chat.example.com, https://backup.example.test", caddy)
        self.assertEqual(caddy.count("127.0.0.1:30081"), 1)
        server = next(d for d in docs if d["kind"] == "Deployment" and d["metadata"]["name"] == "kordi-cloud-server")
        container = server["spec"]["template"]["spec"]["containers"][0]
        self.assertEqual(container["env"], [])
        self.assertEqual(container["envFrom"], [{"secretRef": {"name": "kordi-vps-settings"}}])
        settings = next(d["stringData"] for d in docs if d["kind"] == "Secret" and d["metadata"]["name"] == "kordi-vps-settings")
        self.assertEqual(settings["S3_ENDPOINT"], "https://files.example.com")
        self.assertNotIn("kordi.ai", json.dumps(docs))
        self.assertNotIn("GOOGLE_APPLICATION_CREDENTIALS", json.dumps(docs))

    def test_all_referenced_secrets_are_generated(self):
        docs = manifests(validate(self.config))
        secrets = {d["metadata"]["name"]: d["stringData"] for d in docs if d["kind"] == "Secret"}
        def visit(value):
            if isinstance(value, dict):
                if "secretKeyRef" in value:
                    ref = value["secretKeyRef"]
                    self.assertIn(ref["key"], secrets[ref["name"]])
                for item in value.values():
                    visit(item)
            elif isinstance(value, list):
                for item in value:
                    visit(item)
        visit(docs)

    def test_internal_services_have_no_load_balancers_or_host_ports(self):
        docs = manifests(validate(self.config))
        exposed = [d["metadata"]["name"] for d in docs if d["kind"] == "Service" and d["spec"].get("type") == "NodePort"]
        self.assertEqual(set(exposed), {"kordi-cloud-server", "minio-edge"})
        self.assertNotIn('"hostPort"', json.dumps(docs))
        runner = next(d for d in docs if d["kind"] == "Deployment" and d["metadata"]["name"] == "kordi-cloud-agent-runner")
        env = runner["spec"]["template"]["spec"]["containers"][0]["env"]
        self.assertIn({"name": "KORDI_CLOUD_SANDBOX_BACKEND", "value": "k8s"}, env)

    def test_rejects_domain_injection_and_mutable_images(self):
        for value in ("http://example.test", "https://user:password@example.test", "https://example.test/other", "https://example.test\n}"):
            with self.subTest(origin=value):
                self.config["public_origin"] = value
                with self.assertRaises(ValueError):
                    validate(self.config)
        self.config["public_origin"] = "https://chat.example.test"
        self.config["images"]["cloud-server"] = "example.test/server:latest"
        with self.assertRaises(ValueError):
            validate(self.config)

    def test_model_credentials_are_optional_until_feature_enabled(self):
        validate(self.config)
        server = self.config["server"]
        server["KORDI_SYSTEM_AGENT_ENABLED"] = "true"
        with self.assertRaises(ValueError):
            validate(self.config)
        server["KORDI_SERVICE_MODEL_API_KEY"] = "synthetic-test-key"
        server["KORDI_SERVICE_MODEL_MODEL"] = "operator-model"
        validate(self.config)
        server["KORDI_SERVICE_MODEL_BASE_URL"] = "https://user:secret@models.example.test/v1"
        with self.assertRaises(ValueError):
            validate(self.config)

    def test_bootstrap_refuses_another_installation_even_with_same_namespace(self):
        deploy.assert_owned_namespace(None, self.config)
        current = manifests(self.config)[0]
        deploy.assert_owned_namespace(current, self.config)
        current["metadata"]["annotations"]["kordi.cloud/storage-id"] = "another-installation"
        with self.assertRaises(ValueError):
            deploy.assert_owned_namespace(current, self.config)


if __name__ == "__main__":
    unittest.main()
