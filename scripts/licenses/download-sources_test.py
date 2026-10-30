"""Exercise source reconstruction and hostile output/manifest handling offline."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('downloader', Path(__file__).with_name('download-sources.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class DownloadTests(unittest.TestCase):
    def fixture(self):
        data = b'synthetic source archive'
        digest = hashlib.sha256(data).hexdigest()
        manifest = {'schemaVersion': 1, 'files': [{'fileName': 'bun.part0000', 'sizeBytes': len(data), 'sha256': digest}], 'materials': [{'archiveName': 'bun.tar.gz', 'files': ['bun.part0000'], 'sha256': digest}]}
        def fetch(url, **kwargs):
            return io.BytesIO(json.dumps(manifest).encode() if url.endswith('manifest.json') else data)
        return data, manifest, fetch

    def test_reassemble_and_preserve_existing_files(self):
        data, _, fetch = self.fixture()
        with tempfile.TemporaryDirectory() as directory, patch.object(module.urllib.request, 'urlopen', fetch):
            output = Path(directory) / 'sources'
            module.download('https://example.org/1.0.0/sources/manifest.json', output)
            self.assertEqual((output / 'bun.tar.gz').read_bytes(), data)
            with self.assertRaisesRegex(ValueError, 'empty output'):
                module.download('https://example.org/1.0.0/sources/manifest.json', output)
            self.assertEqual((output / 'bun.tar.gz').read_bytes(), data)

    def test_reject_path_escape_and_part_reuse_before_writing(self):
        for name in ['../escape', 'manifest.json', 'bun.part0000']:
            _, manifest, fetch = self.fixture()
            manifest['materials'][0]['archiveName'] = name
            with tempfile.TemporaryDirectory() as directory, patch.object(module.urllib.request, 'urlopen', fetch):
                output = Path(directory) / 'sources'
                with self.assertRaises(ValueError):module.download('https://example.org/sources/manifest.json', output)
                self.assertFalse(output.exists())
        _, manifest, fetch = self.fixture()
        manifest['materials'][0]['files'] *= 2
        with tempfile.TemporaryDirectory() as directory, patch.object(module.urllib.request, 'urlopen', fetch):
            with self.assertRaisesRegex(ValueError, 'reused'):module.download('https://example.org/sources/manifest.json', Path(directory) / 'sources')

    def test_reject_tampered_part_and_symlink_output(self):
        _, manifest, fetch = self.fixture()
        manifest['files'][0]['sha256'] = '0' * 64
        with tempfile.TemporaryDirectory() as directory, patch.object(module.urllib.request, 'urlopen', fetch):
            output = Path(directory) / 'sources'
            with self.assertRaisesRegex(ValueError, 'checksum'):module.download('https://example.org/sources/manifest.json', output)
            self.assertFalse((output / 'bun.tar.gz').exists())
            link = Path(directory) / 'symlink'
            link.symlink_to(output, target_is_directory=True)
            with self.assertRaisesRegex(ValueError, 'empty output'):module.download('https://example.org/sources/manifest.json', link)

if __name__ == '__main__':unittest.main()
