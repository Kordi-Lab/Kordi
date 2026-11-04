"""Synthetic checkpoint tests; does not invoke guest privilege setup or shell."""
import base64
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('guest', Path(__file__).with_name('guest.py'))
guest = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guest)


class CheckpointTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        guest.ROOT = Path(self.temp.name) / 'workspace'
        guest.ROOT.mkdir()
        guest.CHECKPOINT = Path(self.temp.name) / 'checkpoint.json'

    def test_binary_and_executable_roundtrip(self):
        (guest.ROOT / 'folder').mkdir()
        data = bytes(range(256))
        file = guest.ROOT / 'folder' / 'data'
        file.write_bytes(data)
        file.chmod(0o700)
        guest.checkpoint()
        file.unlink()
        (guest.ROOT / 'folder').rmdir()
        guest.restore(guest.CHECKPOINT.read_bytes())
        self.assertEqual(file.read_bytes(), data)
        self.assertEqual(file.stat().st_mode & 0o777, 0o700)

    def test_links_and_special_files_are_rejected(self):
        link = guest.ROOT / 'escape'
        link.symlink_to('/etc/passwd')
        with self.assertRaises(ValueError):
            guest.checkpoint()
        link.unlink()
        import os
        os.mkfifo(guest.ROOT / 'pipe')
        with self.assertRaises(ValueError):
            guest.checkpoint()

    def test_restore_rejects_traversal_and_duplicate_paths(self):
        for path in ['../escape', '/absolute', '']:
            with self.assertRaises(ValueError):
                guest.restore(json.dumps([{'path': path, 'kind': 'directory'}]))
        with self.assertRaises(ValueError):
            guest.restore(json.dumps([{'path':'a', 'kind':'directory'}] * 2))

    def test_checkpoint_capacity_is_enforced(self):
        original = guest.LIMIT
        self.addCleanup(setattr, guest, 'LIMIT', original)
        guest.LIMIT = 4
        (guest.ROOT / 'large').write_bytes(b'12345')
        with self.assertRaises(ValueError):
            guest.checkpoint()
        with self.assertRaises(ValueError):
            guest.restore(json.dumps([{'path':'other', 'kind':'file', 'data':base64.b64encode(b'12345').decode(), 'executable':False}]))


if __name__ == '__main__':
    unittest.main()
