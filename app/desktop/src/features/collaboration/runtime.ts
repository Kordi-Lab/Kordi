const COLLABORATION_AGENT_RUNTIME_TOKENS = [
  'agent',
  'claude',
  'codex',
  'openclaw',
  'pi',
  'kordi',
  'generic',
  'bot',
] as const;

export function isCollaborationPersonRuntime(runtime: string) {
  return runtime.trim().toLowerCase() === 'person';
}

export function isCollaborationAgentRuntime(runtime: string) {
  const value = runtime.trim().toLowerCase();
  return COLLABORATION_AGENT_RUNTIME_TOKENS.some((token) => value.includes(token));
}
