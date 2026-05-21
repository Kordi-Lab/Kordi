#!/usr/bin/env node
//
// One-shot launcher for cloud-edition side-by-side testing.
//
//   pnpm --dir app/desktop tauri:dev:multi:cloud
//   pnpm --dir app/desktop tauri:dev:multi:cloud -- --users user1,user2
//
// Does two things you'd otherwise do by hand:
//   1. Exports VITE_KORDI_EDITION=cloud / KORDI_EDITION=cloud so the
//      launched Tauri instances boot in cloud mode (otherwise they
//      default to the local edition and the login gate doesn't show).
//   2. Spawns the existing multi-instance launcher with the rest of
//      the user-supplied args forwarded as-is.
//
// Cloud Edition defaults to the public cloud API, not a localhost Bridge.
// Override the API origin via:
//   VITE_KORDI_CLOUD_API_BASE=https://your-cloud-api.example.com
//
// For tunnel-based development only, opt in explicitly:
//   KORDI_CLOUD_USE_LOCAL_TUNNEL=1
//   KORDI_CLOUD_SSH_TARGET=user@host
//   KORDI_CLOUD_SSH_ZONE=zone
//   KORDI_CLOUD_VM_PORT=17082
//   KORDI_CLOUD_LOCAL_PORT=17081
//
// The remote hop binds VM_PORT on 127.0.0.1 and forwards to the k3s
// ClusterIP for svc/kordi-cloud-server. This avoids using the VM's port
// 17081 directly and avoids kubectl port-forward CLOSE_WAIT buildup under
// three WebView preview instances. The remote hop is started detached;
// the local SSH process only owns -L forwarding, which keeps the tunnel
// responsive under many browser connections.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const appDir = dirname(__dirname);

const SSH_TARGET = process.env.KORDI_CLOUD_SSH_TARGET ?? 'shu_yang@takotako';
const SSH_ZONE = process.env.KORDI_CLOUD_SSH_ZONE ?? 'us-central1-c';
const VM_PORT = process.env.KORDI_CLOUD_VM_PORT ?? '17082';
const LOCAL_PORT = process.env.KORDI_CLOUD_LOCAL_PORT ?? '17081';

function tunnelHealthy() {
    const result = spawnSync('curl', [
        '-sS',
        '-o', '/dev/null',
        '-w', '%{http_code}',
        '--max-time', '3',
        `http://127.0.0.1:${LOCAL_PORT}/health`,
    ], { encoding: 'utf8' });
    return result.stdout.trim() === '200';
}

function ensureTunnel() {
    if (tunnelHealthy()) {
        console.log(`[kordi] Cloud tunnel already up on 127.0.0.1:${LOCAL_PORT}`);
        return null;
    }
    const logsDir = join(appDir, '.multi-instance-logs');
    if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });
    const logFile = join(logsDir, 'cloud-tunnel.log');
    const out = openSync(logFile, 'a');
    const cmd = 'gcloud';
    const remoteCommand = [
        'set -e',
        `if ss -ltn | grep -q "127.0.0.1:${VM_PORT}"; then exit 0; fi`,
        'SVC_IP=$(kubectl -n kordi-cloud get svc kordi-cloud-server -o jsonpath=\'{.spec.clusterIP}\')',
        `nohup socat TCP-LISTEN:${VM_PORT},fork,bind=127.0.0.1,reuseaddr,backlog=128 TCP:\${SVC_IP}:17081 >/tmp/kordi-cloud-socat-${VM_PORT}.log 2>&1 < /dev/null &`,
    ].join('; ');
    console.log(`[kordi] Ensuring remote cloud tunnel hop on ${SSH_TARGET}:127.0.0.1:${VM_PORT} (log -> ${logFile})`);
    const remote = spawnSync(cmd, [
        'compute', 'ssh', SSH_TARGET,
        '--zone', SSH_ZONE,
        '--command',
        remoteCommand,
    ], { stdio: ['ignore', out, out] });
    if (remote.status !== 0) {
        console.error(`[kordi] Could not start remote cloud tunnel hop. Tail ${logFile} for diagnostics.`);
        process.exit(remote.status ?? 1);
    }

    const args = [
        'compute', 'ssh', SSH_TARGET,
        '--zone', SSH_ZONE,
        '--',
        '-N',
        '-L', `${LOCAL_PORT}:127.0.0.1:${VM_PORT}`,
    ];
    console.log(`[kordi] Opening local cloud tunnel: gcloud compute ssh ${SSH_TARGET} (log -> ${logFile})`);
    const child = spawn(cmd, args, {
        detached: true,
        stdio: ['ignore', out, out],
    });
    child.unref();

    // Block until /health responds (or give up after ~45s).
    const start = Date.now();
    const deadline = start + 45_000;
    while (Date.now() < deadline) {
        spawnSync('sleep', ['1']);
        if (tunnelHealthy()) {
            const elapsed = ((Date.now() - start) / 1000).toFixed(1);
            console.log(`[kordi] Tunnel up after ${elapsed}s (pid ${child.pid})`);
            return child.pid;
        }
    }
    console.error(`[kordi] Tunnel did not come up within 45s. Tail ${logFile} for diagnostics.`);
    process.exit(1);
}

if (process.env.KORDI_CLOUD_USE_LOCAL_TUNNEL === '1') {
    ensureTunnel();
}

const DEFAULT_CLOUD_API_BASE = 'https://coordinar.io';
const cloudApiBase = process.env.VITE_KORDI_CLOUD_API_BASE ?? DEFAULT_CLOUD_API_BASE;
const forwardedArgs = process.argv.slice(2);
const env = {
    ...process.env,
    VITE_KORDI_EDITION: 'cloud',
    KORDI_EDITION: 'cloud',
    VITE_KORDI_CLOUD_API_BASE: cloudApiBase,
};

console.log(`[kordi] Launching tauri:dev:multi with Cloud Edition API ${cloudApiBase}`);
const child = spawn('pnpm', ['tauri:dev:multi', '--', ...forwardedArgs], {
    cwd: appDir,
    env,
    stdio: 'inherit',
});
child.on('exit', (code) => process.exit(code ?? 0));
