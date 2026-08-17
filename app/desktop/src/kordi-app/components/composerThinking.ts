export function normalizeComposerThinkingLevels(levels: string[]) {
  const normalized = levels.map((level) => level.trim()).filter(Boolean);
  if (normalized.length === 1 && normalized[0] === 'off') return ['default'];
  return normalized;
}

export function composerThinkingLevelsIncludingCurrent(
  levels: string[],
  current: string,
) {
  const normalizedLevels = normalizeComposerThinkingLevels(levels);
  const normalizedCurrent = current.trim();
  const normalizedCurrentKey = normalizedCurrent
    .toLowerCase()
    .replace(/[\s_-]/g, '');
  if (
    !normalizedCurrent
    || normalizedCurrentKey === 'default'
    || normalizedCurrentKey === 'auto'
    || normalizedCurrentKey === 'thinking'
    || normalizedLevels.includes(normalizedCurrent)
  ) return normalizedLevels;
  return [...normalizedLevels, normalizedCurrent];
}

export function fallbackComposerThinkingValue(
  levels: string[],
  requested: string,
) {
  const normalizedLevels = normalizeComposerThinkingLevels(levels);
  if (normalizedLevels.includes(requested)) return requested;
  if (requested === 'max' && normalizedLevels.includes('xhigh')) return 'xhigh';
  if (requested === 'max' && normalizedLevels.includes('high')) return 'high';
  if (requested === 'xhigh' && normalizedLevels.includes('high')) return 'high';
  if (normalizedLevels.includes('medium')) return 'medium';
  if (normalizedLevels.includes('default')) return 'default';
  if (normalizedLevels.includes('off')) return 'off';
  return normalizedLevels[0] ?? requested;
}
