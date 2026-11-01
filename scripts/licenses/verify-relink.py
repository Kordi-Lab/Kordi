#!/usr/bin/env python3
"""Verify an actually rebuilt runtime; record hashes and synthetic results only."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]

def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

def worker_input_digest():
    paths = sorted((ROOT / 'shared/omp-runtime/src').rglob('*.ts'))
    paths += [ROOT / 'shared/omp-runtime/package.json', ROOT / 'shared/omp-runtime/bun.lock', ROOT / 'shared/omp-runtime/scripts/build-standalone.mjs', ROOT / 'shared/omp-runtime/scripts/native-addon.mjs']
    value = ''.join(str(p.relative_to(ROOT)) + '\0' + digest(p) + '\n' for p in sorted(paths))
    return hashlib.sha256(value.encode()).hexdigest()

def run(binary, args, input=None):
    env = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'NODE_ENV': 'production', 'TMPDIR': tempfile.gettempdir()}
    result = subprocess.run([str(Path(binary).resolve()), *args], input=input, capture_output=True, text=True, timeout=60, env=env)
    if result.returncode:
        raise RuntimeError('Synthetic relink probe failed; no potentially private process output is included')
    return result

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['baseline-worker', 'modified-worker', 'modified-bun', 'output']:
        parser.add_argument('--' + name, required=True)
    args = parser.parse_args()
    checks = {}
    for label, binary in [('baseline', args.baseline_worker), ('modified', args.modified_worker)]:
        ready = run(binary, [], '')
        smoke = run(binary, ['__kordi_smoke_eval'])
        expected = label == 'modified'
        checks[label] = {
            'ready': ready.stdout.strip() == '{"schemaVersion":1,"type":"ready"}',
            'workerProtocol': smoke.stdout.strip() == 'eval-result-2;computer-capabilities-ready;browser-worker-closed',
            'expectedJscMarker': ('KORDI_JSC_RELINK_PROBE' in ready.stderr) == expected,
        }
    with tempfile.TemporaryDirectory(prefix='kordi-relink-proof-') as directory:
        directory = Path(directory)
        source = directory / 'probe.c'
        source.write_text('int kordi_relink_probe(void) { return 42; }\n')
        script = directory / 'probe.ts'
        script.write_text('import { cc } from "bun:ffi";\nconst lib = cc({source: new URL("./probe.c", import.meta.url).pathname, symbols: {kordi_relink_probe: {args: [], returns: "int"}}});\nif (lib.symbols.kordi_relink_probe() !== 42) throw new Error("probe");\nconsole.log("RELINK_C_PROBE_OK"); lib.close();\n')
        probe = run(args.modified_bun, [str(script)])
        checks['tinycc'] = {'modifiedLibraryExecuted': 'KORDI_TINYCC_RELINK_PROBE' in probe.stderr, 'compiledCExecuted': probe.stdout.strip() == 'RELINK_C_PROBE_OK'}
    if not all(result for group in checks.values() for result in group.values()):
        raise RuntimeError('Relinking did not satisfy every required probe')
    pins = json.loads((ROOT / 'legal/runtime-sources.json').read_text())
    record = {'schemaVersion': 1, 'status': 'verified', 'targetTriple': 'aarch64-apple-darwin', 'bunVersion': pins['bunVersion'],
              'workerSourceSha256': worker_input_digest(), 'sourcePinsSha256': digest(ROOT / 'legal/runtime-sources.json'),
              'binarySha256': {'baselineWorker': digest(args.baseline_worker), 'modifiedWorker': digest(args.modified_worker), 'modifiedBun': digest(args.modified_bun)}, 'checks': checks,
              'scope': 'Local source-rebuild and replacement demonstration. Modified probe binaries are test artifacts, not release binaries.'}
    Path(args.output).write_text(json.dumps(record, indent=2) + '\n')
    print('Verified modified JavaScriptCore and TinyCC execution, worker startup and native worker protocol.')

if __name__ == '__main__':
    main()
