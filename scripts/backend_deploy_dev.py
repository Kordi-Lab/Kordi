#!/usr/bin/env python3
"""Update the configured shared development stack using a verified image bundle."""
import argparse
import json
import os
from pathlib import Path
import re

from backend_artifact import SERVICES, verify_bundle
from backend_deploy_common import health, lock, run, write_failure, write_record, write_state


def deploy(args):
    bundle = verify_bundle(args.bundle, args.sha, args.run_id)
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]+", args.project):
        raise ValueError("Invalid development Compose project")
    if not args.state.is_absolute() or not args.env_file.is_file():
        raise ValueError("An existing isolated environment file and absolute state directory are required")
    if not 1024 <= args.api_port <= 65535:
        raise ValueError("Invalid dedicated development API port")
    os.environ["KORDI_DEBUG_API_PORT"] = str(args.api_port)
    args.state.mkdir(parents=True, exist_ok=True)
    override = args.state / "images.json"
    state_file = args.state / "current.json"
    # Read development credentials only from the existing isolated environment file.
    for name in ("POSTGRES_PASSWORD", "REDIS_PASSWORD", "MINIO_ROOT_USER", "MINIO_ROOT_PASSWORD",
                 "KORDI_CLOUD_PROVIDER_AUTH_ENCRYPTION_KEY", "KORDI_CLOUD_RUNNER_TOKEN",
                 "KORDI_CHAT_SYNC_CURSOR_SECRET", "KORDI_OAUTH_GITHUB_CLIENT_ID",
                 "KORDI_OAUTH_GITHUB_CLIENT_SECRET", "KORDI_OAUTH_GOOGLE_CLIENT_ID",
                 "KORDI_OAUTH_GOOGLE_CLIENT_SECRET"):
        os.environ.pop(name, None)
    compose = ["docker", "compose", "--project-name", args.project, "--env-file", str(args.env_file),
               "-f", str(args.compose), "-f", str(override)]
    with lock("host-wide", args.lock_dir):
        record = {"environment": "dev", "sha": args.sha, "buildRunId": args.run_id,
                  "images": bundle["images"], "outcome": "failure", "rollback": "not attempted", "stage": "load images"}
        try:
            expected = getattr(args, "expected_current_sha", None)
            current = json.loads(state_file.read_text())["sha"] if state_file.exists() else "none"
            if expected is not None and current != expected:
                raise ValueError("Deployed revision changed after ordering validation; retry against the current host state")
            for service in SERVICES:
                run(["docker", "load", "--input", str(args.bundle / f"{service}.docker.tar")])
                actual = run(["docker", "image", "inspect", "--format", "{{.Id}}", bundle["images"][service]["tag"]])
                if actual not in {bundle["images"][service]["imageId"], bundle["images"][service]["digest"]}:
                    raise ValueError("Loaded development image differs from the approved image")
            images = {"services": {service: {"image": bundle["images"][service]["tag"]} for service in SERVICES}}
            write_state(override, images)
            record["stage"] = "start development stack"
            run(compose + ["up", "--detach", "--no-build", "--wait", "--wait-timeout", "180"])
            for service in SERVICES:
                container = run(compose + ["ps", "-q", service])
                if run(["docker", "inspect", "--format", "{{.Image}}", container]) not in {bundle["images"][service]["imageId"], bundle["images"][service]["digest"]}:
                    raise ValueError("Running development container does not match its approved image")
            record["stage"] = "health verification"
            health(f"http://127.0.0.1:{args.api_port}/health")
            record["outcome"] = "success"
            record["stage"] = "complete"
            write_state(state_file, bundle)
        except Exception as error:
            write_failure(args.state, error)
            raise
        finally:
            write_record(args.state / "records", record)
            write_state(args.bundle / "deployment-result.json", record)
    print("Development backend updated and verified")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--sha", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--expected-current-sha")
    parser.add_argument("--project", required=True)
    parser.add_argument("--api-port", type=int, required=True)
    parser.add_argument("--env-file", type=Path, required=True)
    parser.add_argument("--compose", type=Path, required=True)
    parser.add_argument("--lock-dir", type=Path, default=Path("/tmp/kordi-deploy-locks"))
    deploy(parser.parse_args())


if __name__ == "__main__":
    main()
