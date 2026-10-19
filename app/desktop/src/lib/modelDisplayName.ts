/** Friendly names are presentation only; custom names and protocol IDs stay intact. */
export function modelDisplayName(value: string, label?: string | null): string {
  const raw = value.trim();
  const id = raw.split('/').slice(-1)[0] ?? raw;
  if (label?.trim() && label !== raw && label !== id) return label;
  if (!id || id === 'default') return 'Default';
  if (!/^(gpt-|claude-|gemini-|grok-|o[134](?:-|$))/.test(id)) return label || id;
  return id
    .replace(/(\d)-(\d)/g, '$1.$2')
    .split('-')
    .map((word) => word === 'gpt' ? 'GPT' : /^o[134]$/.test(word) ? word : word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ').replace(/^GPT /, 'GPT-');
}

export function modelEffortLabel(value: string): string {
  if (!value || value === 'auto' || value === 'default' || value === 'thinking') return 'Default';
  if (['xhigh', 'extrahigh', 'extra_high'].includes(value.toLowerCase())) return 'Extra high';
  return value.charAt(0).toUpperCase() + value.slice(1);
}
