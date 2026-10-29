#!/usr/bin/env python3
"""Initialize or deploy Kordi on the VPS itself, without a cloud control plane."""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import platform
import subprocess
import sys

from backend_deploy_common import lock
from vps_config import ROOT, caddyfile, credential_checksum, initialize, load, manifests, outside_repository, private_write

KUBE = ["k3s", "kubectl", "--kubeconfig", "/etc/rancher/k3s/k3s.yaml"]


def run(arguments, **kwargs):
    result = subprocess.run(arguments, capture_output=True, text=True, **kwargs)
    if result.returncode:
        # A failed kubectl invocation can echo Secret input. Never print it.
        raise RuntimeError("Host command failed; inspect the affected service locally")
    return result.stdout.strip()


def assert_owned_namespace(existing, config):
    if not existing:
        return
    metadata = existing["metadata"]
    if (metadata.get("labels", {}).get("app.kubernetes.io/managed-by") != "kordi-vps"
            or metadata.get("annotations", {}).get("kordi.cloud/storage-id") != config["storage_id"]):
        raise ValueError("This namespace belongs to another installation; no changes made")
    if metadata.get("annotations", {}).get("kordi.cloud/credential-checksum") != credential_checksum(config):
        raise ValueError("Generated credentials differ from this installation; restore its original private configuration")


def deployment_stages(documents):
    prerequisites = {"Namespace", "Secret", "ServiceAccount", "Role", "RoleBinding", "NetworkPolicy", "LimitRange"}
    return (
        [d for d in documents if d["kind"] in prerequisites],
        [d for d in documents if d["kind"] not in prerequisites | {"Deployment"}],
        [d for d in documents if d["kind"] == "Deployment"],
    )


def backup_database(directory):
    target = directory / (datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ") + ".dump")
    descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "wb") as stream:
        result = subprocess.run(KUBE + ["-n", "kordi-cloud", "exec", "statefulset/postgres", "--",
            "pg_dump", "-U", "kordi", "-d", "kordi_cloud", "--format=custom", "--no-owner", "--no-acl"],
            stdout=stream, stderr=subprocess.PIPE)
    if result.returncode or target.stat().st_size == 0:
        target.unlink()
        raise RuntimeError("Database backup failed; deployment was not changed")
    return target


def apply(config, state):
    outside_repository(state)
    if platform.system() != "Linux" or platform.machine() not in ("x86_64", "amd64") or os.geteuid() != 0:
        raise ValueError("Run apply as root on the selected Linux amd64 VPS")
    installed = Path("/etc/rancher/k3s/config.yaml.d/90-kordi-cloud-nodeport.yaml")
    expected = ROOT / "bridges/cloud-server/deploy/k3s/config/90-kordi-cloud-nodeport.yaml"
    if not installed.is_file() or installed.read_bytes() != expected.read_bytes():
        raise ValueError("Install k3s with the repository's loopback NodePort configuration first")
    if not state.is_absolute() or state.is_symlink():
        raise ValueError("Use an absolute private state directory on the VPS")
    state.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = state.stat()
    if info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError("Deployment state must be root-owned with mode 0700")
    with lock("host-wide", state):
        raw = run(KUBE + ["get", "namespace", "kordi-cloud", "--ignore-not-found", "-o", "json"])
        existing = json.loads(raw) if raw else None
        assert_owned_namespace(existing, config)
        deployed = run(KUBE + ["-n", "kordi-cloud", "get", "deployment", "kordi-cloud-server",
                              "--ignore-not-found", "-o", "name"]) if existing else ""
        if deployed:
            backup_database(state)
            print("Created a private pre-deployment database backup (attachments require separate backup).")
        documents = manifests(config)
        # Separate stages keep the API from starting before its database and
        # buckets exist. No delete, reset, or prune is performed.
        prerequisites, infrastructure, applications = deployment_stages(documents)
        for doc in prerequisites + infrastructure:
            run(KUBE + ["apply", "-f", "-"], input=json.dumps(doc))
        for name in ("postgres", "redis", "minio", "nats"):
            run(KUBE + ["-n", "kordi-cloud", "rollout", "status", "statefulset/" + name, "--timeout=240s"])
        for name in ("minio-bucket-init", "nats-init"):
            run(KUBE + ["-n", "kordi-cloud", "wait", "--for=condition=complete", "job/" + name, "--timeout=240s"])
        for doc in applications:
            run(KUBE + ["apply", "-f", "-"], input=json.dumps(doc))
        for name in ("kordi-omp-route-worker", "kordi-cloud-server", "kordi-cloud-agent-runner"):
            run(KUBE + ["-n", "kordi-cloud", "rollout", "status", "deployment/" + name, "--timeout=240s"])
        private_write(state / "Caddyfile", caddyfile(config))
        private_write(state / "last-deployment.json", json.dumps({"images": config["images"], "storage_id": config["storage_id"]}))
    print("Services are running. Install the generated Caddyfile, then verify public HTTPS, signup, chat, and attachments.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("init", "check", "apply"))
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--state", type=Path, default=Path("/var/lib/kordi-vps"))
    args = parser.parse_args()
    if args.command == "init":
        initialize(args.config)
        print("Created private configuration. Set domains, images, authentication, and optional service models.")
        return
    config = load(args.config)
    if args.command == "check":
        manifests(config)
        print("Configuration and manifests are valid; no server or model API was contacted.")
    else:
        apply(config, args.state)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, TypeError, OSError, RuntimeError) as error:
        # Parsing errors can contain credential-bearing input. Keep output fixed.
        message = str(error) if type(error) in (ValueError, RuntimeError) else "Configuration or host operation failed"
        if isinstance(error, json.JSONDecodeError):
            message = "Configuration must be valid JSON"
        print(message, file=sys.stderr)
        sys.exit(1)
