const BRIDGE_AGENT_RUNTIME_TOKENS = [
  'agent',
  'claude',
  'codex',
  'openclaw',
  'pi',
  'kordi',
  'generic',
  'bot',
] as const;

export function isBridgePersonRuntime(runtime: string) {
  return runtime.trim().toLowerCase() === 'person';
}

export function isBridgeAgentRuntime(runtime: string) {
  const value = runtime.trim().toLowerCase();
  return BRIDGE_AGENT_RUNTIME_TOKENS.some((token) => value.includes(token));
}
