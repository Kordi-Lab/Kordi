"""Legacy deployment must stop before overwriting a managed service identity."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from backend_manifest_reapply import main, requires_image_promotion

ROOT = Path(__file__).resolve().parent.parent


def deployment(env=(), env_from=()):
    return {"spec": {"template": {"spec": {"containers": [
        {"name": "server", "env": list(env), "envFrom": list(env_from)},
    ]}}}}


class ManifestReapplyTests(unittest.TestCase):
    def test_managed_or_unresolved_identity_requires_image_promotion(self):
        for name in ("KORDI_SUPPORT_PROVIDER", "KORDI_SYSTEM_AGENT_PROVIDER", "KORDI_PIP_PROVIDER"):
            self.assertTrue(requires_image_promotion(deployment([{"name": name, "value": "vertex-ai"}])))
            self.assertTrue(requires_image_promotion(deployment([{"name": name, "valueFrom": {"secretKeyRef": {}}}])))
        self.assertTrue(requires_image_promotion(deployment([{"name": "GOOGLE_APPLICATION_CREDENTIALS", "value": "/identity/config.json"}])))
        self.assertTrue(requires_image_promotion(deployment(env_from=[{"secretRef": {"name": "synthetic"}}])))
        self.assertFalse(requires_image_promotion(deployment([{"name": "KORDI_SUPPORT_PROVIDER", "value": "openai"}])))

    def test_missing_deployment_allows_bootstrap_but_inspection_failure_does_not(self):
        with patch("backend_manifest_reapply.subprocess.run", return_value=subprocess.CompletedProcess([], 0, "", "")):
            main()
        with patch("backend_manifest_reapply.subprocess.run", return_value=subprocess.CompletedProcess([], 1, "", "private diagnostic")):
            with self.assertRaisesRegex(ValueError, "no changes made"):
                main()

    def test_legacy_shell_exits_before_any_mutation_for_google_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fixture = root / "deployment.json"
            fixture.write_text(json.dumps(deployment([{"name": "KORDI_SUPPORT_PROVIDER", "value": "vertex-ai"}])))
            trace = root / "trace.jsonl"
            gcloud = root / "gcloud"
            gcloud.write_text("""#!/usr/bin/env python3
import json, os, subprocess, sys
with open(os.environ['TRACE_FILE'], 'a') as f: f.write(json.dumps(['gcloud', *sys.argv[1:4]])+'\\n')
assert sys.argv[1:3] == ['compute', 'ssh']
command = sys.argv[sys.argv.index('--command')+1]
sys.exit(subprocess.run(command, shell=True).returncode)
""")
            sudo = root / "sudo"
            sudo.write_text("""#!/usr/bin/env python3
import json, os, pathlib, sys
with open(os.environ['TRACE_FILE'], 'a') as f: f.write(json.dumps(sys.argv[1:])+'\\n')
assert sys.argv[1:] == ['k3s','kubectl','--namespace','kordi-cloud','get','deployment','kordi-cloud-server','--ignore-not-found','-o','json']
print(pathlib.Path(os.environ['DEPLOYMENT_FIXTURE']).read_text())
""")
            gcloud.chmod(0o700)
            sudo.chmod(0o700)
            env = {**os.environ, "PATH": str(root) + os.pathsep + os.environ["PATH"],
                   "TRACE_FILE": str(trace), "DEPLOYMENT_FIXTURE": str(fixture),
                   "KORDI_CLOUD_SSH_TARGET": "synthetic-host", "KORDI_CLOUD_SSH_ZONE": "synthetic-zone",
                   "KORDI_CLOUD_GCP_PROJECT": "synthetic-project", "KORDI_CLOUD_IMAGE_TAG": "synthetic"}
            result = subprocess.run(["bash", str(ROOT / "bridges/cloud-server/deploy/k3s/deploy-cloud-server.sh")],
                                    env=env, capture_output=True, text=True, timeout=15)
            self.assertEqual(result.returncode, 2)
            self.assertIn("protected Deploy production workflow", result.stderr)
            self.assertNotIn("syncing", result.stdout)
            self.assertNotIn("vertex-ai", result.stdout + result.stderr)
            commands = [json.loads(line) for line in trace.read_text().splitlines()]
            self.assertEqual(len(commands), 2)
            self.assertEqual(commands[1][4:6], ["get", "deployment"])


if __name__ == "__main__":
    unittest.main()
