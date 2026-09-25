#!/usr/bin/env python3
"""Create and verify a revision-bound backend bundle without extracting archives."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import tarfile

# Every image the bundle carries. Development runs all of them from the bundle.
SERVICES = ("cloud-server", "cloud-agent-runner", "omp-route-worker")
# Production (k3s) has no OMP route worker deployment yet, so promotion applies only these.
PRODUCTION_SERVICES = ("cloud-server", "cloud-agent-runner")
SHA = re.compile(r"^[0-9a-f]{40}$")


def digest_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return "sha256:" + digest.hexdigest()


def read_member(archive, name):
    member = archive.getmember(name)
    if not member.isfile() or member.size > 16 * 1024 * 1024:
        raise ValueError("Invalid image metadata member")
    return archive.extractfile(member).read()


def image_metadata(directory, service, sha):
    with tarfile.open(directory / f"{service}.oci.tar") as archive:
        index = json.loads(read_member(archive, "index.json"))
        if len(index["manifests"]) != 1:
            raise ValueError("Expected one Linux amd64 image, without attestations")
        digest = index["manifests"][0]["digest"]
        if not re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
            raise ValueError("Invalid OCI manifest digest")
        raw = read_member(archive, "blobs/sha256/" + digest[7:])
        if "sha256:" + hashlib.sha256(raw).hexdigest() != digest:
            raise ValueError("OCI manifest checksum mismatch")
        manifest = json.loads(raw)
        config_id = manifest["config"]["digest"]
        if not re.fullmatch(r"sha256:[0-9a-f]{64}", config_id):
            raise ValueError("Invalid OCI config digest")
        config_raw = read_member(archive, "blobs/sha256/" + config_id[7:])
        if "sha256:" + hashlib.sha256(config_raw).hexdigest() != config_id:
            raise ValueError("OCI config checksum mismatch")
        config = json.loads(config_raw)
        if config.get("os") != "linux" or config.get("architecture") != "amd64":
            raise ValueError("Backend images must target Linux amd64")
        if config.get("config", {}).get("Labels", {}).get("org.opencontainers.image.revision") != sha:
            raise ValueError("Image revision label does not match the tested revision")
    with tarfile.open(directory / f"{service}.docker.tar") as archive:
        manifests = json.loads(read_member(archive, "manifest.json"))
        if len(manifests) != 1:
            raise ValueError("Expected one Docker image")
        raw = read_member(archive, manifests[0]["Config"])
        if "sha256:" + hashlib.sha256(raw).hexdigest() != config_id:
            raise ValueError("Docker and OCI archives contain different images")
    return {"digest": digest, "imageId": config_id, "tag": f"docker.io/library/kordi-{service}:{sha}"}


def create_manifest(directory, sha, run_id):
    if not SHA.fullmatch(sha) or not re.fullmatch(r"[1-9][0-9]*", str(run_id)):
        raise ValueError("A full revision and build run ID are required")
    files = {f"{service}.{kind}.tar": digest_file(directory / f"{service}.{kind}.tar")
             for service in SERVICES for kind in ("docker", "oci")}
    return {"version": 1, "sha": sha, "buildRunId": str(run_id), "files": files,
            "images": {service: image_metadata(directory, service, sha) for service in SERVICES}}


def verify_bundle(directory, sha, run_id):
    recorded = json.loads((directory / "backend-manifest.json").read_text())
    expected = create_manifest(directory, sha, run_id)
    if recorded != expected:
        raise ValueError("Backend bundle does not match its trusted revision, build run, or checksums")
    return recorded


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("create", "verify"))
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--sha", required=True)
    parser.add_argument("--run-id", required=True)
    args = parser.parse_args()
    if args.command == "create":
        manifest = create_manifest(args.directory, args.sha, args.run_id)
        (args.directory / "backend-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    else:
        verify_bundle(args.directory, args.sha, args.run_id)
    print("Backend bundle verified for " + args.sha)


if __name__ == "__main__":
    main()
