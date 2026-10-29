import importlib.util
from pathlib import Path
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'bridges/cloud-agent-runner/src/fly_sandbox/operation.py'
spec = importlib.util.spec_from_file_location('fly_operation', SCRIPT)
operation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(operation)


class WorkspaceOperations(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        operation.ROOT = Path(self.temp.name).resolve() / 'workspace'
        operation.ROOT.mkdir()

    def test_roundtrip_and_bounded_reads(self):
        operation.execute({'kind': 'write_text', 'path': 'nested/note.txt', 'content': 'hello'})
        self.assertEqual(operation.execute({'kind': 'read_text', 'path': 'nested/note.txt'})['stdout'], 'hello')
        with self.assertRaises(ValueError):
            operation.execute({'kind': 'read_bytes', 'path': 'nested/note.txt', 'max_bytes': 2})

    def test_external_symlink_and_parent_traversal_rejected(self):
        outside = Path(self.temp.name) / 'outside'
        outside.write_text('private fixture')
        (operation.ROOT / 'link').symlink_to(outside)
        for path in ['link', '../outside', str(outside)]:
            with self.assertRaises(ValueError):
                operation.execute({'kind': 'read_text', 'path': path})
            with self.assertRaises(ValueError):
                operation.execute({'kind': 'write_text', 'path': path, 'content': 'overwrite'})
        self.assertEqual(outside.read_text(), 'private fixture')

    def test_shell_exit_status_and_environment(self):
        result = operation.execute({'kind': 'bash', 'command': 'printf test; printf error >&2; exit 7'})
        self.assertEqual(result, {'exit_code': 7, 'stdout': 'test', 'stderr': 'error'})
        result = operation.execute({'kind': 'bash', 'command': 'env'})
        self.assertNotIn('TOKEN=', result['stdout'])

    def test_output_limit_and_background_children_are_bounded(self):
        with self.assertRaises(ValueError):
            operation.execute({'kind': 'bash', 'command': 'yes output'})
        result = operation.execute({'kind': 'bash', 'command': 'sleep 60 >/dev/null 2>&1 & echo $!'})
        self.assertEqual(result['exit_code'], 0)
        import os
        import time
        pid = int(result['stdout'].strip())
        for _ in range(30):
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                break
            time.sleep(.1)
        else:
            self.fail('Background process survived operation cleanup')


if __name__ == '__main__':
    unittest.main()
