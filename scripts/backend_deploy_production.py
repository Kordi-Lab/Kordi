#!/usr/bin/env python3
"""Promote verified images on the production machine under its shared host lock."""
import argparse
import json
from pathlib import Path
import re

from backend_artifact import SERVICES, verify_bundle
from backend_backup import verify_backup
from backend_backup_create import create_backup
from backend_deploy_common import health, lock, run, write_failure, write_record, write_state

KUBECTL = ["sudo", "k3s", "kubectl", "--namespace", "kordi-cloud"]
CONTAINERS = {"cloud-server": "server", "cloud-agent-runner": "runner"}
CTR = ["sudo", "k3s", "ctr", "--namespace", "k8s.io"]


def reference(service, digest):
    return f"docker.io/library/kordi-{service}@{digest}"


def image_store():
    return {columns[0]: columns[2] for line in run(CTR + ["images", "list"]).splitlines()
            if len(columns := line.split()) >= 3 and re.fullmatch(r"sha256:[0-9a-f]{64}", columns[2])}


def capture_previous():
    stored = image_store()
    previous = {}
    for service in SERVICES:
        deployment = json.loads(run(KUBECTL + ["get", "deployment", "kordi-" + service, "-o", "json"]))
        containers = deployment["spec"]["template"]["spec"]["containers"]
        container = next(item for item in containers if item["name"] == CONTAINERS[service])
        old = container["image"]
        canonical = "docker.io/library/" + old if "/" not in old else old
        digest = stored.get(canonical)
        if not digest:
            raise ValueError("The previous image must be resolvable before production changes")
        previous[service] = reference(service, digest)
        # Retain a digest-addressable reference for rollback before importing any new tag.
        if previous[service] not in stored:
            run(CTR + ["images", "tag", canonical, previous[service]])
    return previous


def apply_images(images):
    for service in SERVICES:
        run(KUBECTL + ["set", "image", "deployment/kordi-" + service, CONTAINERS[service] + "=" + images[service]])


def verify_running(images):
    for service in SERVICES:
        run(KUBECTL + ["rollout", "status", "deployment/kordi-" + service, "--timeout=180s"])
        deployment = json.loads(run(KUBECTL + ["get", "deployment", "kordi-" + service, "-o", "json"]))
        containers = deployment["spec"]["template"]["spec"]["containers"]
        if next(item["image"] for item in containers if item["name"] == CONTAINERS[service]) != images[service]:
            raise ValueError("Production image changed during verification")
    health("https://kordi.ai/health", attempts=12)


def deploy(args):
    if args.schema_compatibility not in ("backward-compatible", "forward-only"):
        raise ValueError("Declare backward-compatible or forward-only schema changes")
    if not args.state.is_absolute():
        raise ValueError("An absolute host state directory is required")
    with lock("host-wide", args.lock_dir):
        record = {"environment": "production", "sha": args.sha, "buildRunId": args.run_id,
                  "outcome": "failure", "rollback": "not attempted", "stage": "artifact verification",
                  "schemaCompatibility": args.schema_compatibility}
        applied = False
        previous = None
        try:
            bundle = verify_bundle(args.bundle, args.sha, args.run_id)
            record["images"] = bundle["images"]
            record["stage"] = "backup verification"
            backup_id = create_backup(args.backup_root, args.run_id) if args.backup_id == "auto" else args.backup_id
            record.update(verify_backup(args.backup_root, backup_id))
            record["stage"] = "capture previous images"
            previous = capture_previous()
            record["previousImages"] = previous
            record["stage"] = "import approved images"
            images = {}
            for service in SERVICES:
                run(CTR + ["images", "import", str(args.bundle / f"{service}.oci.tar")])
                image = bundle["images"][service]
                if image_store().get(image["tag"]) != image["digest"]:
                    raise ValueError("Imported production image differs from its approved digest")
                images[service] = reference(service, image["digest"])
                if images[service] not in image_store():
                    run(CTR + ["images", "tag", image["tag"], images[service]])
            record["stage"] = "rollout and public health"
            applied = True
            apply_images(images)
            verify_running(images)
            record["outcome"] = "success"
            record["stage"] = "complete"
            write_state(args.state / "current.json", bundle)
        except Exception as error:
            write_failure(args.state, error)
            if applied and previous and args.schema_compatibility == "backward-compatible":
                try:
                    apply_images(previous)
                    verify_running(previous)
                    record["rollback"] = "previous images restored and verified"
                except Exception:
                    record["rollback"] = "failed; operator recovery required"
            elif applied:
                record["rollback"] = "forward fix required; database restore is a separate approved operation"
            raise
        finally:
            write_record(args.state / "records", record)
            write_state(args.bundle / "deployment-result.json", record)
    print("Production backend promoted and verified")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--sha", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--backup-root", type=Path, required=True)
    parser.add_argument("--backup-id", required=True)
    parser.add_argument("--schema-compatibility", required=True, choices=("backward-compatible", "forward-only"))
    parser.add_argument("--lock-dir", type=Path, default=Path("/tmp/kordi-deploy-locks"))
    args = parser.parse_args()
    args.state.mkdir(parents=True, exist_ok=True)
    deploy(args)


if __name__ == "__main__":
    main()
