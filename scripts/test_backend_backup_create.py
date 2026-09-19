"""Backup creation tests never connect to a live database."""
import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch

from backend_backup_create import create_backup
from backend_backup import verify_backup


class BackupCreationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "backups"
        self.calls = []

    def command(self, arguments, **kwargs):
        self.calls.append((arguments, kwargs))
        if "printenv" in arguments:
            return "postgresql://fixture@postgres/fixture"
        if any("printf %s" in a for a in arguments):
            return "fixture"
        if any("pg_database_size" in a for a in arguments):
            return "1024"
        if "get" in arguments:
            return json.dumps({"spec": {"nodeName": "fixture-node", "containers": [{"name": "postgres", "image": "postgres:16-alpine"}]}})
        return "1"

    def test_receipt_requires_actual_restore_and_keeps_data_on_the_same_node(self):
        def process(arguments, **kwargs):
            if any("pg_dump" in a for a in arguments):
                kwargs["stdout"].write(b"synthetic database backup")
            else:
                self.assertIn("pg_restore", arguments)
                self.assertIn("--exit-on-error", arguments)
                self.assertEqual(kwargs["stdin"].read(), b"synthetic database backup")
            return SimpleNamespace(returncode=0)
        with patch("backend_backup_create.run", side_effect=self.command), patch("backend_backup_create.subprocess.run", side_effect=process):
            backup_id = create_backup(self.root, "123")
        self.assertTrue(verify_backup(self.root, backup_id)["backupVerified"])
        resources = [json.loads(kwargs["input"]) for _, kwargs in self.calls if "input" in kwargs]
        policy, pod = resources
        self.assertEqual(policy["spec"]["policyTypes"], ["Ingress", "Egress"])
        self.assertEqual(pod["spec"]["nodeName"], "fixture-node")
        self.assertFalse(pod["spec"]["automountServiceAccountToken"])
        self.assertIn("listen_addresses=", pod["spec"]["containers"][0]["args"])
        self.assertTrue(any("delete" in args and "namespace" in args for args, _ in self.calls))

    def test_failed_restore_never_produces_success_evidence(self):
        def process(arguments, **kwargs):
            if any("pg_dump" in a for a in arguments):
                kwargs["stdout"].write(b"synthetic database backup")
                return SimpleNamespace(returncode=0)
            return SimpleNamespace(returncode=1)
        with patch("backend_backup_create.run", side_effect=self.command), patch("backend_backup_create.subprocess.run", side_effect=process):
            with self.assertRaises(RuntimeError):
                create_backup(self.root, "123")
        self.assertEqual(list(self.root.glob("*.json")), [])
        self.assertTrue(any("delete" in args and "namespace" in args for args, _ in self.calls))

    def test_low_disk_stops_before_dump_or_cluster_changes(self):
        with patch("backend_backup_create.run", side_effect=self.command), \
             patch("backend_backup_create.shutil.disk_usage", return_value=SimpleNamespace(free=1)), \
             patch("backend_backup_create.subprocess.run") as process:
            with self.assertRaises(ValueError):
                create_backup(self.root, "123")
        process.assert_not_called()
        self.assertEqual(len(self.calls), 3)
