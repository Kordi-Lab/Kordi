#!/bin/bash
set -eu

if [ "$(id -u)" -ne 0 ]; then
    echo "k3s-test requires root inside its dedicated Fly Machine" >&2
    exit 1
fi

if ! mountpoint -q /data; then
    echo "refusing to start without the persistent Fly volume mounted at /data" >&2
    exit 1
fi

if [ ! -d /sys/fs/cgroup ] || [ ! -r /proc/cgroups ]; then
    echo "the Fly guest does not expose the cgroup interfaces required by systemd and K3s" >&2
    exit 1
fi

machine_id=${FLY_MACHINE_ID:-}
app_name=${FLY_APP_NAME:-}
case "$machine_id" in
    ''|*[!A-Za-z0-9-]*)
        echo "FLY_MACHINE_ID is missing or invalid" >&2
        exit 1
        ;;
esac
case "$app_name" in
    ''|*[!a-z0-9-]*|-*|*-)
        echo "FLY_APP_NAME is missing or invalid" >&2
        exit 1
        ;;
esac

private_ipv6=$(awk '/fly-local-6pn/ { print $1; exit }' /etc/hosts)
private_ipv4=$(ip -4 -o addr show dev eth0 scope global \
    | awk 'NR == 1 { sub(/\/.*/, "", $4); print $4 }')
if [ -z "$private_ipv6" ] || [ -z "$private_ipv4" ]; then
    echo "cannot find the Fly private IPv4 and IPv6 addresses" >&2
    exit 1
fi

mkdir -p /data/k3s
chmod 0700 /data/k3s
mkdir -p /data/k3s/node /data/logs /data/podtemp
chmod 0700 /data/k3s/node

printf '%s' "$machine_id" | sha256sum | cut -c1-32 > /etc/machine-id
chmod 0444 /etc/machine-id

# Persist the node password which K3s stores below /etc/rancher/node.
mkdir -p /etc/rancher /etc/rancher/k3s
if [ -e /etc/rancher/node ] && [ ! -L /etc/rancher/node ]; then
    rmdir /etc/rancher/node 2>/dev/null || {
        echo "/etc/rancher/node exists and is not an empty directory" >&2
        exit 1
    }
fi
ln -sfn /data/k3s/node /etc/rancher/node

config_tmp=/data/k3s/config.yaml.tmp
cat > "$config_tmp" <<EOF
node-name: "human-sim-${machine_id}"
bind-address: "::"
disable:
  - traefik
  - servicelb
node-ip: "${private_ipv6},${private_ipv4}"
node-external-ip: "${private_ipv6}"
kubelet-arg:
  - "node-ip=::"
data-dir: "/data/k3s"
write-kubeconfig: "/data/k3s/kubeconfig.yaml"
write-kubeconfig-mode: "0600"
cluster-cidr: "fd42:6b6f:7264::/56,10.42.0.0/16"
service-cidr: "fd43:6b6f:7264::/112,10.43.0.0/16"
cluster-dns: "fd43:6b6f:7264::a"
flannel-backend: "wireguard-native"
flannel-external-ip: true
flannel-ipv6-masq: true
tls-san:
  - "127.0.0.1"
  - "${app_name}.internal"
EOF
chmod 0600 "$config_tmp"
if [ -f /data/k3s/config.yaml ] && ! cmp -s "$config_tmp" /data/k3s/config.yaml; then
    mv /data/k3s/config.yaml "/data/k3s/config.yaml.backup.$(date +%s)"
fi
mv -f "$config_tmp" /data/k3s/config.yaml
ln -sfn /data/k3s/config.yaml /etc/rancher/k3s/config.yaml

# K3s networking relies on forwarding and bridge netfilter. Fail closed if
# the Fly guest kernel does not expose these controls.
sysctl -w net.bridge.bridge-nf-call-iptables=1
sysctl -w net.bridge.bridge-nf-call-ip6tables=1
sysctl -w net.ipv4.ip_forward=1
sysctl -w net.ipv4.conf.all.src_valid_mark=1
sysctl -w net.ipv6.conf.all.forwarding=1
sysctl -w net.ipv6.conf.all.disable_ipv6=0

# Kubernetes volume mounts must propagate through the guest root mount.
mount --make-rshared /
mkdir -p /var/log/pods /var/lib/kubelet/pods
mount --bind /data/logs /var/log/pods
mount --bind /data/podtemp /var/lib/kubelet/pods

ulimit -n 1048576
ulimit -u unlimited

# Fly currently exposes a hybrid cgroup v1 hierarchy. Kubernetes 1.37 still
# supports v1 resource enforcement, but requires this explicit compatibility
# setting. Never disable CPU, memory, PID, or pod isolation controllers.
kubelet_dropins=/data/k3s/agent/etc/kubelet.conf.d
mkdir -p "$kubelet_dropins"
if [ "$(stat -fc %T /sys/fs/cgroup)" != cgroup2fs ]; then
    cat > "$kubelet_dropins/90-cgroup-v1-compat.conf" <<'EOF'
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
failCgroupV1: false
EOF
else
    rm -f "$kubelet_dropins/90-cgroup-v1-compat.conf"
fi

/usr/local/bin/k3s check-config

# Match upstream fly-k3s: keep mounts shared and run systemd as PID 1 in a
# separate PID namespace beneath Fly's outer init.
exec unshare --pid --fork --mount-proc /lib/systemd/systemd
