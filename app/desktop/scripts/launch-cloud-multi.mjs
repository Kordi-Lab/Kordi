#!/usr/bin/env node
//
// One-shot launcher for cloud-edition side-by-side testing.
//
//   pnpm --dir app/desktop tauri:dev:multi:cloud
//   pnpm --dir app/desktop tauri:dev:multi:cloud -- --users user1,user2
//
// Does three things you'd otherwise do by hand:
//   1. Opens an SSH tunnel from laptop:17081 -> takotako:17082 ->
//      kubectl port-forward svc/kordi-cloud-server in the cluster, so
//      `authClient.ts`'s default 127.0.0.1:17081 hits the real cluster.
//   2. Exports VITE_KORDI_EDITION=cloud / KORDI_EDITION=cloud so the
//      launched Tauri instances boot in cloud mode (otherwise they
//      default to the local edition and the login gate doesn't show).
//   3. Spawns the existing multi-instance launcher with the rest of
//      the user-supplied args forwarded as-is.
//
// The SSH tunnel is reused if one is already listening on 17081 —
// safe to re-run without leaking processes. Override targets via env:
//   KORDI_CLOUD_SSH_TARGET=user@host
//   KORDI_CLOUD_SSH_ZONE=zone
//   KORDI_CLOUD_VM_PORT=17082
//   KORDI_CLOUD_LOCAL_PORT=17081

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
    const args = [
        'compute', 'ssh', SSH_TARGET,
        '--zone', SSH_ZONE,
        '--ssh-flag', `-L ${LOCAL_PORT}:127.0.0.1:${VM_PORT}`,
        '--command',
        `kubectl -n kordi-cloud port-forward svc/kordi-cloud-server ${VM_PORT}:17081`,
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

ensureTunnel();

const forwardedArgs = process.argv.slice(2);
const env = {
    ...process.env,
    VITE_KORDI_EDITION: 'cloud',
    KORDI_EDITION: 'cloud',
};

console.log('[kordi] Launching tauri:dev:multi with VITE_KORDI_EDITION=cloud');
const child = spawn('pnpm', ['tauri:dev:multi', '--', ...forwardedArgs], {
    cwd: appDir,
    env,
    stdio: 'inherit',
});
child.on('exit', (code) => process.exit(code ?? 0));
