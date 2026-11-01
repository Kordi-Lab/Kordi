# Experimental single-node K3s guest image for an isolated Fly Machine.
# The base image digest and K3s release are pinned. K3s's published checksum
# file is verified before the binary is installed.
FROM --platform=linux/amd64 ubuntu:jammy-20260901.2@sha256:829f6df217bcbae2b371026e81711d1a787c61b2967ad09d015063663ebafbf7

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        arptables \
        ca-certificates \
        conntrack \
        curl \
        dbus \
        ebtables \
        iproute2 \
        iptables \
        iputils-ping \
        procps \
        socat \
        systemd \
        systemd-sysv \
        util-linux \
    && rm -rf /var/lib/apt/lists/* \
    && update-alternatives --set iptables /usr/sbin/iptables-legacy \
    && update-alternatives --set ip6tables /usr/sbin/ip6tables-legacy \
    && update-alternatives --set arptables /usr/sbin/arptables-legacy \
    && update-alternatives --set ebtables /usr/sbin/ebtables-legacy

RUN set -eu; \
    release_url='https://github.com/k3s-io/k3s/releases/download/v1.37.1%2Bk3s1'; \
    mkdir -p /tmp/k3s-release /usr/local/bin; \
    curl --fail --silent --show-error --location "$release_url/sha256sum-amd64.txt" \
        --output /tmp/k3s-release/sha256sum-amd64.txt; \
    curl --fail --silent --show-error --location "$release_url/k3s" \
        --output /tmp/k3s-release/k3s; \
    awk '$2 == "k3s" || $2 == "*k3s" { print }' \
        /tmp/k3s-release/sha256sum-amd64.txt > /tmp/k3s-release/k3s.sha256; \
    test "$(wc -l < /tmp/k3s-release/k3s.sha256)" -eq 1; \
    (cd /tmp/k3s-release && sha256sum --check --strict k3s.sha256); \
    install -m 0755 /tmp/k3s-release/k3s /usr/local/bin/k3s; \
    rm -rf /tmp/k3s-release; \
    mkdir -p /usr/local/share; \
    printf '%s\n' 'v1.37.1+k3s1' > /usr/local/share/k3s-version

COPY deploy/simulator/k3s-test/entrypoint.sh /usr/local/sbin/k3s-test-entrypoint
COPY deploy/simulator/k3s-test/k3s.service /etc/systemd/system/k3s.service

RUN chmod 0755 /usr/local/sbin/k3s-test-entrypoint \
    && mkdir -p /etc/systemd/system/multi-user.target.wants \
    && ln -s ../k3s.service /etc/systemd/system/multi-user.target.wants/k3s.service \
    && ln -sfn /lib/systemd/system/multi-user.target /etc/systemd/system/default.target

ENTRYPOINT ["/usr/local/sbin/k3s-test-entrypoint"]
