"""Create and actually restore a pre-deployment backup, entirely on the product host."""
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shutil
import subprocess
import uuid
from urllib.parse import unquote, urlsplit

from backend_artifact import digest_file
from backend_deploy_common import run, write_state

KUBE = ["sudo", "k3s", "kubectl"]
DATABASE = KUBE + ["--namespace", "kordi-cloud", "exec", "statefulset/postgres", "--"]


def create_backup(directory, run_id):
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    if directory.is_symlink() or directory.stat().st_mode & 0o022:
        raise ValueError("Backup directory must be private and host-owned")
    source_url = urlsplit(run(KUBE + ["--namespace", "kordi-cloud", "exec", "deployment/kordi-cloud-server", "-c", "server", "--", "printenv", "DATABASE_URL"]))
    database_name = run(DATABASE + ["sh", "-ec", 'printf %s "$POSTGRES_DB"'])
    if source_url.hostname not in ("postgres", "postgres.kordi-cloud", "postgres.kordi-cloud.svc", "postgres.kordi-cloud.svc.cluster.local") or unquote(source_url.path.lstrip("/")) != database_name:
        raise ValueError("The running backend database does not match the configured backup target")
    size = int(run(DATABASE + ["sh", "-ec", 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT pg_database_size(current_database())"']))
    if shutil.disk_usage(directory).free < size * 3 + 2 * 1024**3:
        raise ValueError("Insufficient free space for backup and isolated restore verification")
    backup_id = f"deploy-{run_id}-{uuid.uuid4().hex[:12]}"
    target = directory / (backup_id + ".dump")
    started = datetime.now(timezone.utc).isoformat()
    with target.open("xb") as stream:
        os.chmod(target, 0o600)
        process = subprocess.run(DATABASE + ["env", "PGAPPNAME=kordi-cd-" + backup_id, "sh", "-ec", 'exec timeout 1800 pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --compress=1 --lock-wait-timeout=30s --no-owner --no-acl'],
                                 stdout=stream, stderr=subprocess.PIPE)
    if process.returncode:
        target.unlink()
        raise RuntimeError("Production backup creation failed; no deployment was attempted")
    namespace = "kordi-cd-restore-" + uuid.uuid4().hex[:12]
    created = False
    try:
        source = json.loads(run(KUBE + ["--namespace", "kordi-cloud", "get", "pod", "postgres-0", "-o", "json"]))
        image = next(c["image"] for c in source["spec"]["containers"] if c["name"] == "postgres")
        run(KUBE + ["create", "namespace", namespace])
        created = True
        policy = {"apiVersion": "networking.k8s.io/v1", "kind": "NetworkPolicy",
                  "metadata": {"name": "deny-network", "namespace": namespace},
                  "spec": {"podSelector": {}, "policyTypes": ["Ingress", "Egress"]}}
        run(KUBE + ["apply", "-f", "-"], input=json.dumps(policy))
        pod = {"apiVersion": "v1", "kind": "Pod", "metadata": {"name": "restore", "namespace": namespace},
               "spec": {"nodeName": source["spec"]["nodeName"], "restartPolicy": "Never",
                        "automountServiceAccountToken": False, "activeDeadlineSeconds": 1800,
                        "containers": [{"name": "postgres", "image": image, "imagePullPolicy": "Never",
                                        "args": ["postgres", "-c", "listen_addresses="],
                                        "env": [{"name": "POSTGRES_USER", "value": "restore"},
                                                {"name": "POSTGRES_DB", "value": "restored"},
                                                {"name": "POSTGRES_HOST_AUTH_METHOD", "value": "trust"}],
                                        "resources": {"requests": {"cpu": "100m", "memory": "256Mi"},
                                                      "limits": {"cpu": "1", "memory": "1Gi"}},
                                        "readinessProbe": {"exec": {"command": ["sh", "-ec", 'test "$(cat /proc/1/comm)" = postgres && pg_isready -U restore -d restored']},
                                                           "periodSeconds": 2},
                                        "volumeMounts": [{"name": "data", "mountPath": "/var/lib/postgresql/data"}]}],
                        "volumes": [{"name": "data", "emptyDir": {}}]}}
        run(KUBE + ["apply", "-f", "-"], input=json.dumps(pod))
        run(KUBE + ["--namespace", namespace, "wait", "--for=condition=Ready", "pod/restore", "--timeout=180s"])
        with target.open("rb") as stream:
            result = subprocess.run(KUBE + ["--namespace", namespace, "exec", "-i", "restore", "--",
                                            "timeout", "1740", "pg_restore", "-U", "restore", "-d", "restored", "--no-owner", "--no-acl", "--exit-on-error"],
                                    stdin=stream, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        if result.returncode:
            raise RuntimeError("The backup did not restore successfully; production images were not changed")
        run(KUBE + ["--namespace", namespace, "exec", "restore", "--", "psql", "-U", "restore", "-d", "restored", "-Atc", "SELECT 1"])
        checksum = digest_file(target)
        receipt = {"version": 1, "environment": "production", "file": target.name,
                   "size": target.stat().st_size, "sha256": checksum, "createdAt": started,
                   "restoreVerification": {"success": True, "backupSha256": checksum,
                                           "completedAt": datetime.now(timezone.utc).isoformat()}}
        write_state(directory / (backup_id + ".json"), receipt)
        return backup_id
    finally:
        if created:
            run(KUBE + ["delete", "namespace", namespace, "--wait=true", "--timeout=180s"])
