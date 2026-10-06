const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createInterface } = require('node:readline');

test('provider hooks receive and preserve earlier plugin payload changes', { timeout: 15_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'kordi-provider-hook-'));
  const plugin = join(directory, 'probe.cjs');
  writeFileSync(plugin, `module.exports = kordi => {
    kordi.on('before_provider_request', event => ({payload:{...event.payload,temperature:0.125}}));
    kordi.on('before_provider_request', event => {
      if (event.payload.temperature !== 0.125) throw Error('Earlier hook was lost');
      return {payload:{...event.payload,top_p:0.9}};
    });
  };`);
  const child = spawn(process.execPath, [join(__dirname, 'host.js'), plugin], { stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  const lines = createInterface({ input: child.stdout });
  let sequence = 0;
  lines.on('line', line => {
    const message = JSON.parse(line);
    const response = pending.get(message.id);
    if (response) { pending.delete(message.id); message.error ? response.reject(Error(message.error.message)) : response.resolve(message.result); }
  });
  child.on('error', error => { for (const response of pending.values()) response.reject(error); });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  try {
    const result = await request('event', { event: { type: 'before_provider_request', payload: { model: 'fixture', messages: [] } } });
    assert.deepEqual(result.payload, { model: 'fixture', messages: [], temperature: 0.125, top_p: 0.9 });
  } finally { lines.close(); child.kill(); rmSync(directory, { recursive: true, force: true }); }
});
