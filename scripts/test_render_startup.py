"""Exercise the Render entrypoint without cloud credentials or network calls."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
START = ROOT / 'deploy/render/start-api.sh'


class RenderStartupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.output = self.root / 'calls.jsonl'
        executable = self.root / 'kordi-cloud-server'
        executable.write_text('''#!/usr/bin/env python3
import json, os, sys
with open(os.environ['TEST_CALLS'], 'a') as f:
    f.write(json.dumps({'args': sys.argv[1:], 'nats': os.environ.get('NATS_URL'),
      'nats_token': os.environ.get('KORDI_NATS_TOKEN'),
      'worker': os.environ.get('KORDI_OMP_ROUTE_WORKER_URL'),
      'origin': os.environ.get('KORDI_CLOUD_PUBLIC_BASE_URL'),
      'strict': os.environ.get('KORDI_REQUIRE_CORE_SERVICES')}) + '\\n')
if sys.argv[1] == 'initialize-event-stream' and os.environ.get('TEST_INIT_FAIL'):
    sys.exit(1)
''')
        executable.chmod(0o700)
        self.env = dict(PATH=str(self.root) + os.pathsep + os.environ['PATH'],
                        TEST_CALLS=str(self.output), PORT='12345',
                        RENDER_EXTERNAL_URL='https://validation.example.com')
        for key in ['DATABASE_URL', 'REDIS_URL', 'KORDI_OMP_ROUTE_WORKER_TOKEN',
                    'KORDI_CHAT_SYNC_CURSOR_SECRET', 'KORDI_AUTH_EMAIL_CODE_SECRET',
                    'KORDI_CLOUD_PROVIDER_AUTH_ENCRYPTION_KEY', 'S3_BUCKET', 'S3_REGION',
                    'S3_ACCESS_KEY', 'S3_SECRET_KEY', 'KORDI_AUTH_SMTP_HOST',
                    'KORDI_AUTH_SMTP_USERNAME', 'KORDI_AUTH_SMTP_PASSWORD',
                    'KORDI_AUTH_SMTP_FROM']:
            self.env[key] = 'synthetic-test-value'
        self.env.update(KORDI_NATS_TOKEN='syntheticTestToken',
                        KORDI_NATS_HOSTPORT='events.internal:4222',
                        KORDI_OMP_HOSTPORT='providers.internal:17331',
                        S3_ENDPOINT='https://storage.example.com')

    def run_start(self):
        return subprocess.run(['/bin/sh', str(START)], env=self.env,
                              capture_output=True, text=True, timeout=5)

    def calls(self):
        return [json.loads(line) for line in self.output.read_text().splitlines()]

    def test_private_wiring_and_platform_port(self):
        result = self.run_start()
        self.assertEqual(result.returncode, 0, result.stderr)
        init, serve = self.calls()
        self.assertEqual(init['args'], ['initialize-event-stream'])
        self.assertEqual(serve['args'], ['serve', '--port', '12345'])
        self.assertEqual(serve['nats'], 'nats://events.internal:4222')
        self.assertEqual(serve['nats_token'], 'syntheticTestToken')
        self.assertEqual(serve['worker'], 'http://providers.internal:17331')
        self.assertEqual(serve['origin'], 'https://validation.example.com')
        self.assertEqual(serve['strict'], 'true')
        self.assertNotIn('synthetic', result.stdout + result.stderr)

    def test_missing_required_dependencies_fail_before_start(self):
        for key in ['DATABASE_URL', 'REDIS_URL', 'S3_SECRET_KEY',
                    'KORDI_AUTH_SMTP_PASSWORD', 'KORDI_NATS_TOKEN']:
            with self.subTest(key=key):
                original = self.env.pop(key)
                result = self.run_start()
                self.env[key] = original
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(key, result.stderr)
                self.assertFalse(self.output.exists())

    def test_stream_bootstrap_failure_prevents_serving(self):
        self.env['TEST_INIT_FAIL'] = '1'
        self.assertNotEqual(self.run_start().returncode, 0)
        self.assertEqual(len(self.calls()), 1)

    def test_insecure_origins_and_signup_bypass_fail_closed(self):
        for key, value in [('S3_ENDPOINT', 'http://storage.example.com'),
                           ('KORDI_CLOUD_PUBLIC_BASE_URL', 'http://api.example.com'),
                           ('KORDI_AUTH_LEGACY_SIGNUP_UNTIL', '2099-01-01'),
                           ('KORDI_NATS_TOKEN', 'value@other-host')]:
            with self.subTest(key=key):
                original = self.env.get(key)
                self.env[key] = value
                self.assertNotEqual(self.run_start().returncode, 0)
                self.assertFalse(self.output.exists())
                if original is None:
                    self.env.pop(key)
                else:
                    self.env[key] = original


if __name__ == '__main__':
    unittest.main()
