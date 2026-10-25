// Claude opens on Sonnet 5.5 when the owner has not chosen a model. The
// pinned OMP catalog names Opus 5.5 as Anthropic's default and lists its
// models alphabetically, so Kordi sets its own default and lists it first.

export const CLAUDE_DEFAULT_MODEL = 'claude-sonnet-5-5';

/** A Claude catalog entry with Sonnet 5.5 first and as its default; other entries, or a catalog without it, stay as they are. */
export function withClaudeModelCatalog<T extends { id: string; models: string[]; defaultModel?: string | null }>(entry: T): T {
  if (entry.id !== 'anthropic' || !entry.models.includes(CLAUDE_DEFAULT_MODEL)) return entry;
  const models = [CLAUDE_DEFAULT_MODEL, ...entry.models.filter((model) => model !== CLAUDE_DEFAULT_MODEL)];
  return { ...entry, models, defaultModel: CLAUDE_DEFAULT_MODEL };
}
