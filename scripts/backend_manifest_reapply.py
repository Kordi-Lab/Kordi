"""Read-only host guard for the legacy server manifest deployment path."""
import json
import subprocess
import sys


def requires_image_promotion(deployment):
    spec = deployment["spec"]["template"]["spec"]
    server = next(item for item in spec["containers"] if item["name"] == "server")
    if server.get("envFrom"):
        # Imported settings cannot be classified without reading credentials.
        return True
    providers = {"KORDI_SUPPORT_PROVIDER", "KORDI_SYSTEM_AGENT_PROVIDER", "KORDI_PIP_PROVIDER"}
    for item in server.get("env", []):
        name = item["name"]
        if name == "GOOGLE_APPLICATION_CREDENTIALS" or name.startswith("KORDI_SERVICE_VERTEX_"):
            return True
        if name in providers and ("valueFrom" in item or item.get("value", "").strip() == "vertex-ai"):
            return True
    return False


def main():
    result = subprocess.run([
        "sudo", "k3s", "kubectl", "--namespace", "kordi-cloud", "get", "deployment",
        "kordi-cloud-server", "--ignore-not-found", "-o", "json",
    ], capture_output=True, text=True)
    if result.returncode:
        raise ValueError("Could not inspect the existing server deployment; no changes made.")
    if result.stdout.strip() and requires_image_promotion(json.loads(result.stdout)):
        raise ValueError(
            "Managed service identity requires the protected Deploy production workflow. "
            "It preserves provider settings, service accounts and credential mounts; "
            "the legacy manifest must not be reapplied. No changes made."
        )


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, TypeError, StopIteration, OSError) as error:
        # Never print deployment contents or Kubernetes response bodies.
        message = str(error) if type(error) is ValueError else "Server configuration inspection failed; no changes made."
        print(message, file=sys.stderr)
        sys.exit(2)
