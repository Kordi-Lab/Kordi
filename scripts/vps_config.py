"""Private operator configuration and manifests for a single VPS."""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
from urllib.parse import urlsplit, urlunsplit
import uuid

import yaml

ROOT = Path(__file__).resolve().parent.parent
BASE = ROOT / "bridges/cloud-server/deploy/k3s/manifests"
SERVICES = ("cloud-server", "cloud-agent-runner", "omp-route-worker")
GENERATED = ("postgres", "redis", "minio", "runner", "worker", "cursor", "email", "provider")


def outside_repository(path):
    if path.resolve().is_relative_to(ROOT):
        raise ValueError("Keep private configuration and deployment state outside the repository")


def credential_checksum(config):
    return hashlib.sha256(json.dumps(config["generated"], sort_keys=True).encode()).hexdigest()


def private_write(path, text):
    if path.is_symlink():
        raise ValueError("Refusing to write through a symlink")
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "w") as stream:
        os.fchmod(stream.fileno(), 0o600)
        stream.write(text)


def initialize(path):
    outside_repository(path)
    config = json.loads((ROOT / "deploy/vps/config.example.json").read_text())
    config["storage_id"] = str(uuid.uuid4())
    config["generated"] = {name: secrets.token_hex(32) for name in GENERATED}
    config["generated"]["provider"] = base64.b64encode(secrets.token_bytes(32)).decode()
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as stream:
        stream.write(json.dumps(config, indent=2) + "\n")


def origin(value):
    url = urlsplit(value)
    if (url.scheme != "https" or not url.hostname or url.port is not None
            or url.username or url.password or url.query or url.fragment or url.path not in ("", "/")
            or not re.fullmatch(r"[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?", url.hostname)
            or any(not label or label.startswith("-") or label.endswith("-") for label in url.hostname.split("."))):
        raise ValueError("Public endpoints must be HTTPS DNS origins without ports or credentials")
    return "https://" + url.hostname


def validate(config):
    uuid.UUID(config["storage_id"])
    origins = [origin(config["public_origin"]), *map(origin, config["additional_origins"])]
    if len(set(origins)) != len(origins) or origin(config["object_origin"]) in origins:
        raise ValueError("API origins must be distinct from the object storage origin")
    for service in SERVICES:
        image = config["images"][service]
        if not re.fullmatch(r"[a-zA-Z0-9._/-]+(?::[a-f0-9]{40}|@sha256:[a-f0-9]{64})", image):
            raise ValueError("Each application image needs a full revision tag or SHA-256 digest")
    for name in GENERATED:
        if name == "provider":
            if len(base64.b64decode(config["generated"][name], validate=True)) != 32:
                raise ValueError("Provider encryption key must contain 32 bytes")
        elif not re.fullmatch(r"[a-f0-9]{64}", config["generated"][name]):
            raise ValueError("Generated credentials must be retained from init")
    server = config["server"]
    if any(not re.fullmatch(r"KORDI_[A-Z0-9_]+", key) or not isinstance(value, str)
           for key, value in server.items()):
        raise ValueError("Server settings must be string-valued KORDI environment variables")
    # Core storage/security settings are generated below, never overridden by
    # arbitrary environment data copied from a different installation.
    if set(server) & set(core_settings(config)):
        raise ValueError("Server settings may not override generated storage or authentication settings")
    for provider in ("GOOGLE", "GITHUB"):
        configured = [bool(server.get(f"KORDI_OAUTH_{provider}_{key}", "").strip())
                      for key in ("CLIENT_ID", "CLIENT_SECRET")]
        if any(configured) and not all(configured):
            raise ValueError("OAuth requires both client ID and client secret")
    smtp = all(server.get("KORDI_AUTH_SMTP_" + key, "").strip() for key in ("HOST", "FROM"))
    oauth = any(server.get(f"KORDI_OAUTH_{p}_CLIENT_ID", "").strip() for p in ("GOOGLE", "GITHUB"))
    if not smtp and not oauth:
        raise ValueError("Configure SMTP signup delivery or a complete OAuth provider before deployment")
    for feature in ("SYSTEM_AGENT", "SUPPORT"):
        if server.get(f"KORDI_{feature}_ENABLED", "false").lower() not in ("true", "1", "yes", "on"):
            continue
        provider = server.get(f"KORDI_{feature}_PROVIDER") or server.get("KORDI_SERVICE_MODEL_PROVIDER", "openai")
        if provider not in ("openai", "openai-compatible"):
            raise ValueError("The VPS bootstrap uses operator API keys; Vertex remains available in the existing GCP deployment")
        for suffix, shared in (("API_KEY", "API_KEY"), ("MODEL", "MODEL")):
            if not (server.get(f"KORDI_{feature}_OPENAI_{suffix}") or server.get(f"KORDI_SERVICE_MODEL_{shared}", "")).strip():
                raise ValueError("Enabled service models require an explicit API key and model")
        endpoint = server.get(f"KORDI_{feature}_OPENAI_BASE_URL") or server.get("KORDI_SERVICE_MODEL_BASE_URL", "https://api.openai.com/v1")
        parsed = urlsplit(endpoint)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError("VPS model endpoints must use HTTPS without embedded credentials")
        if feature == "SUPPORT" and not server.get("KORDI_SUPPORT_OWNER_EMAIL", "").strip():
            raise ValueError("Enabled Support requires its operator email")
    return config


def load(path):
    outside_repository(path)
    stat = path.lstat()
    if path.is_symlink() or not path.is_file() or stat.st_mode & 0o077 or stat.st_uid != os.getuid():
        raise ValueError("Use an operator-owned regular configuration file with mode 0600")
    return validate(json.loads(path.read_text()))


def core_settings(config):
    generated = config["generated"]
    origins = [origin(config["public_origin"]), *map(origin, config["additional_origins"])]
    return {
        "KORDI_CLOUD_PUBLIC_BASE_URL": origins[0],
        "KORDI_CLOUD_OAUTH_REDIRECT_ALLOWLIST": ",".join(origins + ["http://127.0.0.1:", "http://localhost:", "kordi://oauth/callback"]),
        "KORDI_CHAT_REALTIME_ALLOWED_ORIGINS": ",".join(origins + ["tauri://localhost", "http://tauri.localhost"]),
        "KORDI_CHAT_SYNC_CURSOR_SECRET": generated["cursor"],
        "KORDI_AUTH_EMAIL_CODE_SECRET": generated["email"],
        "KORDI_CLOUD_PROVIDER_AUTH_ENCRYPTION_KEY": generated["provider"],
        "KORDI_CLOUD_PROVIDER_AUTH_ENCRYPTION_KEY_ID": "selfhost:v1",
        "KORDI_CLOUD_RUNNER_TOKEN": generated["runner"],
        "KORDI_OMP_ROUTE_WORKER_TOKEN": generated["worker"],
        "KORDI_OMP_ROUTE_WORKER_URL": "http://kordi-omp-route-worker:17331",
        "KORDI_CLOUD_TRUSTED_PROXIES": "127.0.0.1/32,::1/128,10.42.0.1/32",
    }


def secret(name, values):
    return {"apiVersion": "v1", "kind": "Secret", "metadata": {"name": name, "namespace": "kordi-cloud"},
            "type": "Opaque", "stringData": values}


def manifests(config):
    generated = config["generated"]
    docs = [{"apiVersion": "v1", "kind": "Namespace", "metadata": {"name": "kordi-cloud",
             "labels": {"app.kubernetes.io/managed-by": "kordi-vps"},
             "annotations": {"kordi.cloud/storage-id": config["storage_id"],
                             "kordi.cloud/credential-checksum": credential_checksum(config)}}}]
    for name, values in {
        "postgres-credentials": {"password": generated["postgres"]},
        "redis-credentials": {"password": generated["redis"]},
        "minio-credentials": {"access-key": "kordi-storage", "secret-key": generated["minio"]},
        "kordi-cloud-runner": {"runner-token": generated["runner"]},
        "kordi-omp-route-worker": {"token": generated["worker"]},
        "kordi-vps-settings": {**config["server"], **core_settings(config)},
    }.items():
        docs.append(secret(name, values))
    for file in ("postgres.yaml", "redis.yaml", "minio.yaml", "omp-route-worker-deployment.yaml",
                 "cloud-server-deployment.yaml", "cloud-agent-runner-deployment.yaml"):
        docs.extend(yaml.safe_load_all((BASE / file).read_text()))
    docs.extend(yaml.safe_load_all((ROOT / "deploy/vps/nats.yaml").read_text()))
    docs.extend(yaml.safe_load_all((ROOT / "deploy/vps/sandbox-policy.yaml").read_text()))
    docs.append({"apiVersion": "v1", "kind": "Service", "metadata": {"name": "minio-edge", "namespace": "kordi-cloud"},
                 "spec": {"type": "NodePort", "selector": {"app.kubernetes.io/name": "minio"},
                          "ports": [{"port": 9000, "targetPort": "s3", "nodePort": 30090}]}})
    for doc in docs:
        if doc["kind"] != "Deployment":
            continue
        service = doc["metadata"]["name"].removeprefix("kordi-")
        container = doc["spec"]["template"]["spec"]["containers"][0]
        container["image"] = config["images"][service]
        if service == "cloud-server":
            doc["spec"]["replicas"] = 1
            # Replace the product template's environment, including optional
            # product secrets and release URLs. Do not inherit GCP identities.
            environment = {
                "DATABASE_URL": urlunsplit(("postgresql", f"kordi:{generated['postgres']}@postgres:5432", "/kordi_cloud", "", "")),
                "REDIS_URL": urlunsplit(("redis", f"default:{generated['redis']}@redis:6379", "/0", "", "")),
                "NATS_URL": "nats://nats:4222", "S3_ENDPOINT": origin(config["object_origin"]),
                "S3_BUCKET": "kordi-attachments", "S3_REGION": "us-east-1",
                "S3_ACCESS_KEY": "kordi-storage", "S3_SECRET_KEY": generated["minio"],
            }
            settings = next(d for d in docs if d["kind"] == "Secret" and d["metadata"]["name"] == "kordi-vps-settings")
            settings["stringData"].update(environment)
            container["env"] = []
            container["envFrom"] = [{"secretRef": {"name": "kordi-vps-settings"}}]
    # Secret-backed environment changes must restart applications even when the
    # image revision is unchanged. Never put plaintext configuration in metadata.
    settings_hash = hashlib.sha256(json.dumps(
        [d["stringData"] for d in docs if d["kind"] == "Secret"], sort_keys=True).encode()).hexdigest()
    for doc in docs:
        if doc["kind"] == "Deployment":
            doc["spec"]["template"]["metadata"].setdefault("annotations", {})["kordi.cloud/settings-checksum"] = settings_hash
    return docs


def caddyfile(config):
    origins = [origin(config["public_origin"]), *map(origin, config["additional_origins"])]
    return (", ".join(origins) + " {\n  reverse_proxy 127.0.0.1:30081 {\n"
            "    header_up X-Real-IP {remote_host}\n  }\n}\n\n" + origin(config["object_origin"])
            + " {\n  reverse_proxy 127.0.0.1:30090\n}\n")
