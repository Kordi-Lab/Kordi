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

/** Composer label: the display name without a leading "GPT-" ("GPT-6.1 Sol" → "6.1 Sol"). */
export function modelShortName(value: string, label?: string | null): string {
  const name = modelDisplayName(value, label);
  return name.replace(/^GPT-(?=\S)/, '');
}

export function modelEffortLabel(value: string): string {
  if (!value || value === 'auto' || value === 'default' || value === 'thinking') return 'Default';
  if (['xhigh', 'extrahigh', 'extra_high'].includes(value.toLowerCase())) return 'Extra high';
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** Composer chip text while no provider account is connected, so no model is named. */
export const COMPOSER_NO_MODEL_LABEL = '--';

/**
 * The composer chip's model and effort text. Without a connected provider there is no
 * usable model, so both halves show a neutral placeholder instead of a default model.
 */
export function composerModelChipLabels({ model, modelLabel, thinking, hasProvider }: {
  model: string;
  modelLabel?: string | null;
  thinking: string;
  hasProvider: boolean;
}): { model: string; effort: string } {
  if (!hasProvider) return { model: COMPOSER_NO_MODEL_LABEL, effort: COMPOSER_NO_MODEL_LABEL };
  return { model: modelShortName(model, modelLabel), effort: modelEffortLabel(thinking) };
}
