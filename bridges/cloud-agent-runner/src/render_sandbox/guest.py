"""Credential-free Render workspace executor; never runs on the runner host."""
import base64
import json
import os
from pathlib import Path
import resource
import stat
import sys

ROOT = Path('/workspace')
CHECKPOINT = Path('/tmp/kordi-checkpoint.json')
LIMIT = 16 * 1024 * 1024
MAX_ENTRIES = 2048


def restore(source):
    entries = json.loads(source)
    if not isinstance(entries, list) or len(entries) > MAX_ENTRIES:
        raise ValueError('Invalid checkpoint')
    total = 0
    for entry in entries:
        relative = Path(entry['path'])
        if relative.is_absolute() or '..' in relative.parts or not relative.parts:
            raise ValueError('Invalid checkpoint path')
        path = ROOT / relative
        if path.exists() or path.is_symlink():
            raise ValueError('Duplicate checkpoint entry')
        if entry['kind'] == 'directory':
            path.mkdir()
        elif entry['kind'] == 'file':
            data = base64.b64decode(entry['data'], validate=True)
            total += len(data)
            if total > LIMIT:
                raise ValueError('Workspace exceeds limit')
            path.write_bytes(data)
            path.chmod(0o700 if entry['executable'] else 0o600)
        else:
            raise ValueError('Unsupported checkpoint entry')


def checkpoint():
    entries = []
    total = 0
    for parent, directories, files in os.walk(ROOT, followlinks=False):
        directories.sort()
        files.sort()
        for name in directories + files:
            path = Path(parent) / name
            info = path.lstat()
            entry = {'path': str(path.relative_to(ROOT))}
            if stat.S_ISLNK(info.st_mode):
                raise ValueError('Workspace checkpoints do not support links')
            if stat.S_ISDIR(info.st_mode):
                entry['kind'] = 'directory'
            elif stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
                total += info.st_size
                if total > LIMIT:
                    raise ValueError('Workspace exceeds limit')
                with path.open('rb') as source:
                    data = source.read(LIMIT + 1)
                if len(data) != info.st_size:
                    raise ValueError('Workspace changed during checkpoint')
                entry.update(kind='file', data=base64.b64encode(data).decode(),
                             executable=bool(info.st_mode & 0o111))
            else:
                raise ValueError('Unsupported workspace file')
            entries.append(entry)
            if len(entries) > MAX_ENTRIES:
                raise ValueError('Workspace has too many entries')
    CHECKPOINT.write_text(json.dumps(entries))


def main():
    request = json.loads(base64.b64decode(sys.argv[1], validate=True))
    os.environ.clear()
    if request['kind'] == 'initialize':
        ROOT.mkdir(mode=0o700)
        os.chown(ROOT, 1000, 1000)
        if CHECKPOINT.exists():
            os.chown(CHECKPOINT, 1000, 1000)
    os.setgroups([])
    os.setgid(1000)
    os.setuid(1000)
    resource.setrlimit(resource.RLIMIT_FSIZE, (24 * 1024 * 1024, 24 * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_NOFILE, (128, 128))
    resource.setrlimit(resource.RLIMIT_NPROC, (64, 64))
    if request['kind'] == 'initialize':
        if CHECKPOINT.exists():
            restore(CHECKPOINT.read_bytes())
        print(json.dumps({'exit_code': 0, 'stdout': '', 'stderr': ''}))
        return
    # Reuse the existing bounded executor without invoking its environment setup.
    namespace = {'__name__': 'workspace_operations'}
    exec(base64.b64decode(request['executor'], validate=True), namespace)
    try:
        result = namespace['execute'](request['operation'])
    except Exception:
        result = {'exit_code': 1, 'stdout': '', 'stderr': 'Workspace operation failed or exceeded its limit.'}
    checkpoint()
    print(json.dumps(result))


if __name__ == '__main__':
    main()
