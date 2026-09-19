#!/usr/bin/env python3
"""Transfer a verified GitHub artifact without sending repository credentials to a host."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import zipfile

FILES = {"backend-manifest.json"} | {f"{service}.{kind}.tar" for service in ("cloud-server", "cloud-agent-runner") for kind in ("docker", "oci")}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        return None


def resolve_artifact(repo, artifact_id, run_id, token):
    if not re.fullmatch(r"[\w.-]+/[\w.-]+", repo) or not artifact_id.isdigit() or not run_id.isdigit() or not token:
        raise ValueError("Repository, immutable artifact ID, build run ID, and read token are required")
    endpoint = f"https://api.github.com/repos/{repo}/actions/artifacts/{artifact_id}"
    headers = {"Authorization": "Bearer " + token, "Accept": "application/vnd.github+json"}
    with urllib.request.urlopen(urllib.request.Request(endpoint, headers=headers), timeout=30) as response:
        artifact = json.load(response)
    if artifact["name"] != "backend-bundle" or artifact["expired"] or str(artifact["workflow_run"]["id"]) != run_id:
        raise ValueError("Artifact does not belong to the approved backend build")
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", artifact.get("digest", "")):
        raise ValueError("Artifact is missing its GitHub checksum")
    try:
        urllib.request.build_opener(NoRedirect).open(urllib.request.Request(endpoint + "/zip", headers=headers), timeout=30)
    except urllib.error.HTTPError as error:
        if error.code != 302:
            raise RuntimeError("Unable to obtain the artifact download location") from None
        return {"url": error.headers["Location"], "digest": artifact["digest"]}
    raise ValueError("GitHub did not return an artifact download location")


def extract_verified(archive_path, directory, expected):
    digest = hashlib.sha256()
    with archive_path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    if "sha256:" + digest.hexdigest() != expected:
        raise ValueError("Downloaded artifact checksum mismatch")
    with zipfile.ZipFile(archive_path) as archive:
        entries = archive.infolist()
        if len(entries) != len(FILES) or {entry.filename for entry in entries} != FILES:
            raise ValueError("Unexpected backend artifact members")
        if any(stat.S_ISLNK(entry.external_attr >> 16) for entry in entries) or sum(e.file_size for e in entries) > 8 * 1024**3:
            raise ValueError("Invalid backend artifact entries")
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        for entry in entries:
            target = directory / entry.filename
            with archive.open(entry) as source, target.open("xb") as output:
                os.chmod(target, 0o600)
                shutil.copyfileobj(source, output)


def fetch_artifact(descriptor, directory):
    url = urllib.parse.urlsplit(descriptor["url"])
    if url.scheme != "https" or not url.hostname or not url.hostname.endswith((".blob.core.windows.net", ".actions.githubusercontent.com")):
        raise ValueError("Expected a GitHub artifact storage HTTPS URL")
    with tempfile.TemporaryDirectory(prefix="kordi-artifact-") as temporary:
        archive = Path(temporary) / "bundle.zip"
        with urllib.request.urlopen(descriptor["url"], timeout=60) as response, archive.open("wb") as output:
            size = 0
            for block in iter(lambda: response.read(1024 * 1024), b""):
                size += len(block)
                if size > 8 * 1024**3:
                    raise ValueError("Backend artifact exceeds the transfer limit")
                output.write(block)
        extract_verified(archive, directory, descriptor["digest"])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("resolve", "fetch"))
    parser.add_argument("--artifact-id")
    parser.add_argument("--run-id")
    parser.add_argument("--directory", type=Path)
    args = parser.parse_args()
    if args.command == "resolve":
        print(json.dumps(resolve_artifact(os.environ["GITHUB_REPOSITORY"], args.artifact_id, args.run_id,
                                         os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN"))))
    else:
        fetch_artifact(json.load(sys.stdin), args.directory)
        print("Backend artifact downloaded and verified")


if __name__ == "__main__":
    main()
