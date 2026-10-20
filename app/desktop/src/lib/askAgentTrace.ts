/** Temporary Ask Agent transcript trace. Logs a channel only when its value changes. */
const lastByChannel = new Map<string, string>();

export function askAgentTrace(channel: string, value: unknown) {
  let signature: string;
  try {
    signature = JSON.stringify(value);
  } catch {
    signature = String(value);
  }
  if (lastByChannel.get(channel) === signature) return;
  lastByChannel.set(channel, signature);
  const monotonicMs = typeof performance !== 'undefined' ? Math.round(performance.now()) : 0;
  console.warn('[ask-agent-trace]', JSON.stringify({ t: monotonicMs, at: new Date().toISOString(), channel, value }));
}

/** Logs one event without deduplication. */
export function askAgentTraceEvent(channel: string, value: unknown) {
  const monotonicMs = typeof performance !== 'undefined' ? Math.round(performance.now()) : 0;
  console.warn('[ask-agent-trace]', JSON.stringify({ t: monotonicMs, at: new Date().toISOString(), channel, event: value }));
}

export function askAgentRowSource(id: string | undefined, turnId?: string) {
  const value = id ?? turnId ?? '';
  if (value.includes('msg:cloud:self:pending:')) return 'pending';
  if (value.includes('msg:cloud:self:progress:')) return 'hosted';
  if (value.includes('msg:cloud:self:response:')) return 'server-row';
  if (value.startsWith('desktop-live-turn') || value.startsWith('turn')) return 'live';
  return value ? 'other' : 'none';
}
