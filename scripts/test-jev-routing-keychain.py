#!/usr/bin/env python3
"""Run built-in synthetic Jev fixtures using a Vercel key stored in macOS Keychain."""
import argparse
import ctypes
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import sys


def save_report(directory, records, exit_code, *, name=None, provenance="live synthetic evaluation"):
    """Persist only structured fixture records, never subprocess logs or credentials."""
    directory.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    name = name or f'jev-{stamp}'
    fixtures = [row for row in records if 'fixture' in row]
    summary = next((row for row in reversed(records) if 'successfulEvaluations' in row), {})
    report = {'schemaVersion': 1, 'recordedAt': datetime.now(timezone.utc).isoformat(),
              'provenance': provenance, 'syntheticOnly': True, 'exitCode': exit_code,
              'fixtures': fixtures, 'summary': summary}
    json_path = directory / f'{name}.json'
    json_temp = directory / f'{name}.json.tmp'
    json_temp.write_text(json.dumps(report, indent=2) + '\n')
    json_temp.replace(json_path)
    lines = ['# Jev routing evaluation', '', f'Provenance: {provenance}.', '',
             'A successful API evaluation means a validated response; it does not establish routing accuracy or cost savings.', '',
             '| Consumer | Fixture | API result | Decision ms | Input tokens | Output tokens | Jev choice | Selected probability | Applied route |',
             '| --- | --- | --- | ---: | ---: | ---: | --- | ---: | --- |']
    for row in fixtures:
        evaluation = row.get('evaluation', {})
        answer = evaluation.get('answers', {}).get('route', {})
        selected = answer.get('choice')
        probability = answer.get('probabilities', {}).get(selected)
        values = [row.get('consumer'), row.get('fixture'), evaluation.get('status'), row.get('decisionMs'),
                  evaluation.get('inputTokens'), evaluation.get('outputTokens'), selected, probability, row.get('route')]
        lines.append('| ' + ' | '.join('-' if v is None else str(v).replace('|', '\\|') for v in values) + ' |')
    lines.extend(['', '## Summary', '', '```json', json.dumps(summary, indent=2), '```', ''])
    markdown_path = directory / f'{name}.md'
    markdown_temp = directory / f'{name}.md.tmp'
    markdown_temp.write_text('\n'.join(lines))
    markdown_temp.replace(markdown_path)
    return name


def read_test_key():
    # Use the same native API and interpreter identity that saved this test key.
    # Keychain still enforces its normal access controls; errors expose only a status code.
    security = ctypes.CDLL('/System/Library/Frameworks/Security.framework/Security')
    find = security.SecKeychainFindGenericPassword
    find.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_char_p,
                     ctypes.c_uint32, ctypes.c_char_p, ctypes.POINTER(ctypes.c_uint32),
                     ctypes.POINTER(ctypes.c_void_p), ctypes.c_void_p]
    find.restype = ctypes.c_int32
    length = ctypes.c_uint32()
    data = ctypes.c_void_p()
    service = b'ai.kordi.dev.jev.vercel-ai-gateway'
    account = b'local-test'
    status = find(None, len(service), service, len(account), account,
                  ctypes.byref(length), ctypes.byref(data), None)
    if status:
        raise RuntimeError(f'Keychain access failed with status {status}.')
    try:
        return ctypes.string_at(data, length.value).decode().strip()
    finally:
        free = security.SecKeychainItemFreeContent
        free.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
        free.restype = ctypes.c_int32
        free(None, data)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--live', action='store_true', help='Send synthetic fixtures to Vercel AI Gateway')
    parser.add_argument('--report-dir', type=Path, help='Directory for JSON and Markdown metric reports')
    args = parser.parse_args()
    if not args.live:
        parser.error('--live is required; this command makes evaluation API calls')
    if sys.platform != 'darwin':
        parser.error('This launcher uses macOS Keychain; other systems can supply AI_GATEWAY_API_KEY directly')
    root = Path(__file__).resolve().parent.parent
    # Build before loading the secret so compiler subprocesses never inherit it.
    result = subprocess.run(['cargo', 'build', '-p', 'kordi-cloud-agent-runner', '--example', 'evaluate_jev_routes'], cwd=root)
    if result.returncode:
        return result.returncode
    metadata = subprocess.run(['cargo', 'metadata', '--no-deps', '--format-version', '1'], cwd=root, capture_output=True, text=True)
    if metadata.returncode:
        print('Could not locate the test executable.', file=sys.stderr)
        return 1
    target = Path(json.loads(metadata.stdout)['target_directory'])
    try:
        key = read_test_key()
    except RuntimeError as error:
        print(str(error), file=sys.stderr)
        return 1
    if not key:
        print('Vercel test key is empty.', file=sys.stderr)
        return 1
    env = os.environ.copy()
    env['AI_GATEWAY_API_KEY'] = key
    env['KORDI_JEV_PROVIDER'] = 'vercel'
    env['KORDI_JEV_MODEL'] = 'typesafe-ai/jev'
    del key
    # No shell interpolation, credential arguments, key files, or credential output.
    records = []
    directory = args.report_dir or root / '.build' / 'jev-evaluations'
    name = save_report(directory, records, None)
    process = subprocess.Popen([str(target / 'debug' / 'examples' / 'evaluate_jev_routes'), '--live'], cwd=root, env=env, stdout=subprocess.PIPE, text=True)
    del env
    try:
        for line in process.stdout:
            print(line, end='', flush=True)
            try:
                value = json.loads(line)
                if isinstance(value, dict) and ('fixture' in value or 'successfulEvaluations' in value):
                    records.append(value)
                    save_report(directory, records, None, name=name)
            except json.JSONDecodeError:
                pass
        code = process.wait()
    except KeyboardInterrupt:
        process.terminate()
        code = process.wait()
    save_report(directory, records, code, name=name)
    print(f'Metric reports saved: {name}.json and {name}.md', flush=True)
    return code


if __name__ == '__main__':
    raise SystemExit(main())
