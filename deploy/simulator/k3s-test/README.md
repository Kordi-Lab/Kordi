# Experimental single-node K3s image for Fly Machines

This image is a bootstrap image for an isolated test control plane. It is not
high availability and is not a production Kubernetes recommendation. It does
not alter or reuse any existing Fly app or Machine.

The image follows the upstream [`superfly/fly-k3s`](https://github.com/superfly/fly-k3s)
approach of an Ubuntu 22.04 guest, systemd-managed K3s, and legacy iptables. It
omits the upstream multi-node creation script, telemetry agents, and Longhorn.
K3s runs as a single server using its default embedded SQLite datastore. The
full K3s runtime and containerd remain enabled, with Flannel's WireGuard-native
backend for the pod network.

## Image pins

- Base: Ubuntu Jammy `jammy-20260901.2`, pinned to the amd64 OCI index digest
  `sha256:829f6df217bcbae2b371026e81711d1a787c61b2967ad09d015063663ebafbf7`.
- K3s: `v1.37.1+k3s1`. The build downloads the binary and the matching official
  `sha256sum-amd64.txt` from that release and verifies the binary before install.
- Ubuntu apt package versions are resolved from the Jammy repositories at build
  time; they are not individually locked in this experimental image.

Build from the repository root so the Docker build context is the workspace:

```sh
docker build -f deploy/simulator/k3s-test/Dockerfile -t kordi-k3s-test:local .
```

For a remote Fly build, use Fly's build-only and push path with a dedicated
test app and a temporary Fly config; do not run a deploy command for this
image-only step. Keep the temporary config outside the repository. The image
is amd64, consistent with the pinned K3s binary and Ubuntu image.

## Machine requirements

The Machine must be dedicated to this test and configured with at least 2 CPU
cores and 2 GiB RAM, plus workload headroom. K3s needs cgroups and systemd. The
image starts systemd in a separate PID namespace under Fly's outer init and
keeps mount propagation shared, as Kubernetes requires.
It refuses to start unless a persistent Fly Volume is mounted at `/data`; K3s
stores its SQLite database, server state, node password, kubeconfig, and
configuration beneath `/data/k3s`. The entrypoint writes the stable Fly Machine
ID hash to `/etc/machine-id`, persists `/etc/rancher/node`, pod logs, and kubelet pod
temporary data on the volume, then runs the K3s config check before starting
systemd.

Do not configure public Fly services, public IPs, or a public listener for the
Kubernetes API. Leave the Machine reachable only through Fly private networking.
An authorized operator can use `fly proxy` over Fly WireGuard to forward a local
port to TCP 6443. The generated kubeconfig is `/data/k3s/kubeconfig.yaml`; copy
it to a private local file, keep it mode `0600`, and set its server endpoint to
the local forwarded address (for example `https://127.0.0.1:16443`). Its API
certificate includes `127.0.0.1` for that access path.

The Fly Machine guest kernel is provider supplied. This image cannot add kernel
modules. The entrypoint uses the upstream Fly K3s pattern: it makes `/` shared,
sets forwarding and bridge-netfilter sysctls, runs `k3s check-config`, and
starts systemd in a PID namespace. It configures WireGuard-native Flannel, not a
disabled CNI. Before using the image, verify on a disposable Machine that the
guest kernel and cgroups support the required networking features. If those
checks fail, stop: this image cannot fix that constraint.

Fly volumes are attached to one Machine and one host and do not replicate. This
single-node test therefore has a single failure domain. Back up K3s state and
practice restoring it before relying on the cluster. Do not place customer or
production data on it.

## Initial verification checklist

After a separately authorized Machine launch:

1. Confirm the Machine has no public services or public IPs and has its volume
   mounted at `/data`.
2. Check logs for successful systemd startup, `k3s.service`, and a Ready node.
   If startup fails, inspect cgroups and kernel capabilities before changing
   the image or K3s networking.
3. Run `fly proxy 16443:6443 -a <dedicated-test-app>` from an authorized
   operator environment. Keep that tunnel running only while needed.
4. Use the copied kubeconfig with its local forwarded endpoint and confirm
   `kubectl get nodes` and a small synthetic Job work.
5. Stop the Machine, start it again, and verify the same cluster state returns
   from `/data/k3s`.

A Ready node alone does not verify message delivery or recovery. Complete the
checks above and retain the experiment evidence before declaring the channel
validated.

## Cgroup compatibility

The observed Fly guest exposes cgroup v1. The entrypoint writes an explicit
`failCgroupV1: false` kubelet drop-in on v1 hosts, preserving CPU, memory, PID,
and pod isolation enforcement. This is a Kubernetes 1.37 compatibility option,
not a long-term upgrade path: migrate to a cgroup v2 host before upgrading beyond
the pinned release. The drop-in is removed on v2 hosts. Traefik and ServiceLB are
disabled because this private worker cluster does not need ingress services.
