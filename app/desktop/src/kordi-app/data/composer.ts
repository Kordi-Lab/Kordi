export const composerModelOptions = [
  'GPT-5.6-Luna',
  'GPT-5.6-Sol',
  'GPT-5.6-Terra',
  'GPT-5.5',
  'GPT-5.4-Mini',
  'GPT-5.4',
  'GPT-5.3-Codex-Spark',
] as const;

export const composerModeOptions = {
  chat: ['Send as Me', 'Send as Research Agent', 'Delegate to Research Agent', 'Internal note'],
  project: ['Post update', 'Ask project agent', 'Start new session', 'Share artifact'],
} as const;

export const composerThinkingOptions = [
  { value: 'off', label: 'Off' },
  { value: 'default', label: 'Default' },
  { value: 'minimal', label: 'Minimal' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra High' },
  { value: 'max', label: 'Max' },
] as const;
