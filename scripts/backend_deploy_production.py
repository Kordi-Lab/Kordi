#!/usr/bin/env python3
"""Promote verified images on the production machine under its shared host lock."""
import argparse
import ipaddress
import json
from pathlib import Path
import re

from backend_artifact import PRODUCTION_SERVICES, verify_bundle
from backend_backup import verify_backup
from backend_backup_create import create_backup
from backend_deploy_common import health, lock, run, write_failure, write_record, write_state

KUBECTL = ["sudo", "k3s", "kubectl", "--namespace", "kordi-cloud"]
CONTAINERS = {"cloud-server": "server", "cloud-agent-runner": "runner"}
CTR = ["sudo", "k3s", "ctr", "--namespace", "k8s.io"]
# Agent sandbox pods run model-directed commands. The runner labels them with
# this selector; the policy in
# bridges/cloud-server/deploy/k3s/manifests/agent-sandbox-network-policy.yaml
# admits no inbound traffic and keeps their outbound traffic off internal
# networks. A runner is never promoted without it.
SANDBOX_POLICY = "kordi-cloud-agent-sandbox"
SANDBOX_SELECTOR = {"app.kubernetes.io/component": "agent-sandbox"}
SANDBOX_EXCLUDED_RANGES = tuple(ipaddress.ip_network(cidr) for cidr in (
    "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "169.254.0.0/16", "127.0.0.0/8"))
# IPv6 destinations an IPv6 egress rule must also exclude: loopback, unique
# local, link-local, and IPv4-mapped or NAT64 forms of internal IPv4 ranges.
SANDBOX_EXCLUDED_IPV6_RANGES = tuple(ipaddress.ip_network(cidr) for cidr in (
    "::1/128", "fc00::/7", "fe80::/10", "::ffff:0:0/96", "64:ff9b::/96"))
DNS_PORTS = [("TCP", 53), ("UDP", 53)]
DNS_PEER = {"namespaceSelector": {"matchLabels": {"kubernetes.io/metadata.name": "kube-system"}},
            "podSelector": {"matchLabels": {"k8s-app": "kube-dns"}}}
# Labels the runner sets on sandbox pods (job_spec.rs); the sandbox id varies.
SANDBOX_POD_LABELS = {"app.kubernetes.io/component": "agent-sandbox",
                      "app.kubernetes.io/name": "kordi-cloud-sandbox-executor"}
SANDBOX_ID_LABEL = "kordi.ai/sandbox-id"


def reference(service, digest):
    return f"docker.io/library/kordi-{service}@{digest}"


def image_store():
    return {columns[0]: columns[2] for line in run(CTR + ["images", "list"]).splitlines()
            if len(columns := line.split()) >= 3 and re.fullmatch(r"sha256:[0-9a-f]{64}", columns[2])}


def capture_previous():
    stored = image_store()
    previous = {}
    for service in PRODUCTION_SERVICES:
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


def sandbox_policy_problem(policy):
    """Describe why a sandbox NetworkPolicy does not isolate sandbox pods, or return None."""
    spec = policy.get("spec") or {}
    if (spec.get("podSelector") or {}).get("matchLabels") != SANDBOX_SELECTOR \
            or (spec.get("podSelector") or {}).get("matchExpressions"):
        return "it does not select exactly the agent sandbox pods"
    if sorted(spec.get("policyTypes") or []) != ["Egress", "Ingress"]:
        return "it does not restrict both ingress and egress"
    if spec.get("ingress"):
        return "it admits inbound traffic"
    for rule in spec.get("egress") or []:
        peers = rule.get("to") or []
        if not peers:
            return "an egress rule allows every destination"
        for peer in peers:
            block = peer.get("ipBlock")
            if block is None:
                ports = sorted((port.get("protocol", "TCP"), port.get("port")) for port in rule.get("ports") or [])
                if ports != DNS_PORTS:
                    return "an egress rule reaches cluster workloads on ports other than DNS"
                if peer != DNS_PEER:
                    return "an egress rule reaches cluster workloads other than the cluster DNS pods"
                continue
            network = ipaddress.ip_network(block.get("cidr", ""), strict=False)
            excluded = [ipaddress.ip_network(cidr, strict=False) for cidr in block.get("except") or []]
            for internal in SANDBOX_EXCLUDED_RANGES + SANDBOX_EXCLUDED_IPV6_RANGES:
                if network.version == internal.version and network.overlaps(internal) \
                        and not any(internal.subnet_of(item) for item in excluded if item.version == internal.version):
                    return f"an egress rule reaches {internal}"
    return None


def may_select_sandbox_pods(selector):
    """Whether a pod selector can match sandbox pods; unknown expressions count as a match."""
    for key, value in ((selector or {}).get("matchLabels") or {}).items():
        if key != SANDBOX_ID_LABEL and SANDBOX_POD_LABELS.get(key) != value:
            return False
    return True


def additional_sandbox_policy_problem(policies):
    """NetworkPolicies add up, so no other policy may allow traffic for sandbox pods."""
    for policy in policies:
        name = (policy.get("metadata") or {}).get("name")
        spec = policy.get("spec") or {}
        if name != SANDBOX_POLICY and may_select_sandbox_pods(spec.get("podSelector")) \
                and (spec.get("ingress") or spec.get("egress")):
            return f"NetworkPolicy {name} also allows traffic for sandbox pods"
    return None


def verify_sandbox_network_policy():
    try:
        policy = json.loads(run(KUBECTL + ["get", "networkpolicy", SANDBOX_POLICY, "-o", "json"]))
    except Exception as error:
        raise ValueError("The agent sandbox NetworkPolicy must exist before the runner is promoted") from error
    problem = sandbox_policy_problem(policy)
    if not problem:
        policies = json.loads(run(KUBECTL + ["get", "networkpolicy", "-o", "json"])).get("items") or []
        problem = additional_sandbox_policy_problem(policies)
    if problem:
        raise ValueError(f"The agent sandbox NetworkPolicy does not isolate sandbox pods: {problem}")


def apply_images(images):
    for service in PRODUCTION_SERVICES:
        run(KUBECTL + ["set", "image", "deployment/kordi-" + service, CONTAINERS[service] + "=" + images[service]])


def verify_running(images):
    for service in PRODUCTION_SERVICES:
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
            record["images"] = {service: bundle["images"][service] for service in PRODUCTION_SERVICES}
            record["stage"] = "backup verification"
            backup_id = create_backup(args.backup_root, args.run_id) if args.backup_id == "auto" else args.backup_id
            record.update(verify_backup(args.backup_root, backup_id))
            record["stage"] = "sandbox network policy verification"
            verify_sandbox_network_policy()
            record["stage"] = "capture previous images"
            previous = capture_previous()
            record["previousImages"] = previous
            record["stage"] = "import approved images"
            images = {}
            for service in PRODUCTION_SERVICES:
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
