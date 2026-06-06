#!/usr/bin/env node
//
// One-shot launcher for side-by-side account testing.
//
//   pnpm --dir app/desktop tauri:dev:multi:cloud
//   pnpm --dir app/desktop tauri:dev:multi:cloud -- --users user1,user2
//
// Spawns the existing multi-instance launcher and points each desktop window
// at the configured hosted API.
//
// For a public test or self-hosted API, set:
//   VITE_KORDI_CLOUD_API_BASE=<PUBLIC_TEST_CLOUD_API_BASE>
//
// For internal/operator local tunnel testing, opt in explicitly and provide
// the SSH target details via environment variables:
//   KORDI_CLOUD_USE_LOCAL_TUNNEL=1
//   KORDI_CLOUD_SSH_TARGET=<operator-host>
//   KORDI_CLOUD_SSH_ZONE=<operator-zone>
//   KORDI_CLOUD_VM_PORT=17088
//   KORDI_CLOUD_LOCAL_PORT=17081

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const appDir = dirname(__dirname);

const SSH_TARGET = process.env.KORDI_CLOUD_SSH_TARGET;
const SSH_ZONE = process.env.KORDI_CLOUD_SSH_ZONE;
const VM_PORT = process.env.KORDI_CLOUD_VM_PORT ?? '17088';
const LOCAL_PORT = process.env.KORDI_CLOUD_LOCAL_PORT ?? '17081';
const localTunnelEnabled = process.env.KORDI_CLOUD_USE_LOCAL_TUNNEL === '1';

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
    if (!SSH_TARGET || !SSH_ZONE) {
        console.error('[kordi] KORDI_CLOUD_SSH_TARGET and KORDI_CLOUD_SSH_ZONE are required when KORDI_CLOUD_USE_LOCAL_TUNNEL=1.');
        process.exit(1);
    }

    if (tunnelHealthy()) {
        console.log(`[kordi] Cloud tunnel already up on 127.0.0.1:${LOCAL_PORT}`);
        return null;
    }
    const logsDir = join(appDir, '.multi-instance-logs');
    if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });
    const logFile = join(logsDir, 'cloud-tunnel.log');
    const out = openSync(logFile, 'a');
    const cmd = 'gcloud';
    const args = [
        'compute', 'ssh', SSH_TARGET,
        '--zone', SSH_ZONE,
        '--ssh-flag=-T',
        '--ssh-flag=-o ExitOnForwardFailure=yes',
        '--ssh-flag=-o ServerAliveInterval=15',
        '--ssh-flag=-o ServerAliveCountMax=3',
        `--ssh-flag=-L ${LOCAL_PORT}:127.0.0.1:${VM_PORT}`,
        '--command',
        `kubectl -n kordi-cloud port-forward --address 127.0.0.1 svc/kordi-cloud-server ${VM_PORT}:17081`,
    ];
    console.log(`[kordi] Opening cloud tunnel: gcloud compute ssh ${SSH_TARGET} (log -> ${logFile})`);
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

if (localTunnelEnabled) {
    ensureTunnel();
}

const configuredCloudApiBase = process.env.VITE_KORDI_CLOUD_API_BASE;
if (!configuredCloudApiBase && !localTunnelEnabled) {
    console.error('[kordi] VITE_KORDI_CLOUD_API_BASE is required for hosted multi-user runs. Set it to <PUBLIC_TEST_CLOUD_API_BASE> or enable KORDI_CLOUD_USE_LOCAL_TUNNEL=1.');
    process.exit(1);
}
const cloudApiBase = localTunnelEnabled ? `http://127.0.0.1:${LOCAL_PORT}` : configuredCloudApiBase;
const forwardedArgs = process.argv.slice(2);
const env = {
    ...process.env,
    VITE_KORDI_CLOUD_API_BASE: cloudApiBase,
};

console.log(`[kordi] Launching tauri:dev:multi with hosted API ${cloudApiBase}`);
const child = spawn('pnpm', ['tauri:dev:multi', '--', ...forwardedArgs], {
    cwd: appDir,
    env,
    stdio: 'inherit',
});
child.on('exit', (code) => process.exit(code ?? 0));
