"""Bounded, credential-free workspace operations inside a Fly guest."""
import base64
import json
import os
from pathlib import Path
import resource
import selectors
import signal
import subprocess
import sys
import time

LIMIT = 1024 * 1024
ROOT = Path('/workspace')


def workspace_path(value):
    path = Path(value)
    if path.is_absolute() or '..' in path.parts:
        raise ValueError('Path must be relative to the workspace')
    resolved = (ROOT / path).resolve()
    if resolved != ROOT and ROOT not in resolved.parents:
        raise ValueError('Path escapes workspace')
    return resolved


def shell(command):
    child = subprocess.Popen(['/bin/bash', '-lc', command], cwd=ROOT,
                             env={'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': str(ROOT)},
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             start_new_session=True)
    streams = selectors.DefaultSelector()
    streams.register(child.stdout, selectors.EVENT_READ, 'stdout')
    streams.register(child.stderr, selectors.EVENT_READ, 'stderr')
    output = {'stdout': bytearray(), 'stderr': bytearray()}
    end = time.monotonic() + 30
    try:
        while streams.get_map():
            if time.monotonic() >= end:
                raise TimeoutError('Command exceeded 30 seconds')
            for key, _ in streams.select(timeout=0.1):
                chunk = os.read(key.fileobj.fileno(), 8192)
                if not chunk:
                    streams.unregister(key.fileobj)
                    continue
                output[key.data].extend(chunk)
                if sum(map(len, output.values())) > LIMIT:
                    raise ValueError('Command output exceeds limit')
        code = child.wait(timeout=max(0.1, end - time.monotonic()))
        return {'exit_code': code, **{k: bytes(v).decode('utf-8', 'replace') for k, v in output.items()}}
    finally:
        # Kill descendants even if the shell exited after backgrounding a child.
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        child.wait()
        streams.close()
        child.stdout.close()
        child.stderr.close()


def execute(op):
    kind = op['kind']
    if kind == 'bash':
        return shell(op['command'])
    path = workspace_path(op['path'])
    text = ''
    if kind in ('read_text', 'read_bytes'):
        limit = min(max(0, int(op.get('max_bytes', LIMIT))), LIMIT)
        if not path.is_file():
            raise ValueError('Read requires a regular file')
        with path.open('rb') as stream:
            data = stream.read(limit + 1)
        if len(data) > limit:
            raise ValueError('File exceeds read limit')
        text = base64.b64encode(data).decode() if kind == 'read_bytes' else data.decode()
    elif kind == 'write_text':
        content = op['content'].encode()
        if len(content) > LIMIT:
            raise ValueError('File exceeds write limit')
        path.parent.mkdir(parents=True, exist_ok=True)
        # Recheck after creating parents; reject links out of the workspace.
        path = workspace_path(op['path'])
        path.write_bytes(content)
    elif kind == 'list':
        names = []
        size = 0
        for entry in path.iterdir():
            size += len(entry.name.encode()) + 1
            if size > LIMIT:
                raise ValueError('Directory listing exceeds limit')
            names.append(entry.name)
        text = '\n'.join(sorted(names))
    else:
        raise ValueError('Unsupported workspace operation')
    return {'exit_code': 0, 'stdout': text, 'stderr': ''}


def main():
    op = json.loads(base64.b64decode(sys.argv[1], validate=True))
    # The control plane supplies only operation data. No provider or platform
    # credentials are present in the guest, including in spawned processes.
    os.environ.clear()
    if os.getuid() == 0:
        os.setgroups([])
        os.setgid(1000)
        os.setuid(1000)
    resource.setrlimit(resource.RLIMIT_FSIZE, (16 * LIMIT, 16 * LIMIT))
    resource.setrlimit(resource.RLIMIT_NOFILE, (128, 128))
    try:
        result = execute(op)
    except Exception:
        result = {'exit_code': 1, 'stdout': '', 'stderr': 'Workspace operation failed or exceeded its limit.'}
    print(json.dumps(result))


if __name__ == '__main__':
    main()
