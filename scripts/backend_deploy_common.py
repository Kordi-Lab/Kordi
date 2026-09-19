"""Host-only primitives shared by development and production deployments."""
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.request


def run(arguments, **kwargs):
    # Host diagnostics remain on the host. Callers publish only structured outcomes.
    return subprocess.check_output(arguments, text=True, stderr=subprocess.STDOUT, **kwargs).strip()


@contextmanager
def lock(name, directory, timeout=1800):
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / (name + ".lock")).open("a") as stream:
        deadline = time.monotonic() + timeout
        while True:
            try:
                fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise TimeoutError("Another deployment still holds the host lock")
                time.sleep(0.2)
        try:
            yield
        finally:
            fcntl.flock(stream, fcntl.LOCK_UN)


def health(url, attempts=60):
    for _ in range(attempts):
        try:
            with urllib.request.urlopen(url, timeout=5) as response:
                if response.status == 200 and json.load(response).get("ok") is True:
                    return
        except (OSError, ValueError):
            pass
        time.sleep(2)
    raise RuntimeError("Backend health verification failed")


def write_record(directory, record):
    directory.mkdir(parents=True, exist_ok=True)
    record["recordedAt"] = datetime.now(timezone.utc).isoformat()
    filename = f"{record['buildRunId']}-{time.time_ns()}.json"
    target = directory / filename
    with target.open("x") as stream:
        os.chmod(target, 0o600)
        json.dump(record, stream, indent=2)
        stream.write("\n")
    return target


def write_state(path, data):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(data, indent=2) + "\n")
    os.chmod(temporary, 0o600)
    temporary.replace(path)
