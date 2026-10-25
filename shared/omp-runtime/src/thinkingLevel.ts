// The thinking level Kordi hands to OMP. OMP's pinned catalog lists `xhigh`
// for Claude Opus 4.5, but the Claude API accepts only low, medium and high
// effort there, so a higher level is capped at `high` before OMP sends it.

const HIGH_EFFORT_CAP = /^claude-opus-4-5(?:-|$)/u;

export function ompThinkingLevel(provider: string, modelId: string, requested: string | undefined): string | undefined {
  if (requested === undefined || requested === 'default') return undefined;
  const id = modelId.replace(/^.*\//u, '');
  if (provider === 'anthropic' && HIGH_EFFORT_CAP.test(id) && (requested === 'xhigh' || requested === 'max')) return 'high';
  return requested;
}
