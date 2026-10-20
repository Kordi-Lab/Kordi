// ChatGPT models in the order the picker lists them, newest first. The pinned
// OMP catalog lists them alphabetically, may not know the newest one yet, and
// includes internal "daybreak" ids that the picker never offers.

export const CHATGPT_MODEL_ORDER = [
  'gpt-6.1-sol',
  'gpt-6-astra',
  'gpt-6-sol',
  'gpt-6-luna',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
] as const;

export const CHATGPT_DEFAULT_MODEL = CHATGPT_MODEL_ORDER[0];

const chatGptProviderIds = new Set(['openai', 'openai-codex']);

export function isChatGptCatalogProvider(providerId: string) {
  return chatGptProviderIds.has(providerId);
}

export function isHiddenChatGptModel(modelId: string) {
  return modelId.toLowerCase().includes('daybreak');
}

/** Ranked models first in picker order; unranked ones keep their order after them. Daybreak ids are dropped. */
export function orderChatGptModels(models: readonly string[]): string[] {
  const rank = (model: string) => {
    const index = (CHATGPT_MODEL_ORDER as readonly string[]).indexOf(model.toLowerCase());
    return index < 0 ? CHATGPT_MODEL_ORDER.length : index;
  };
  return [...new Set(models)]
    .filter((model) => !isHiddenChatGptModel(model))
    .map((model, position) => ({ model, position }))
    .sort((left, right) => rank(left.model) - rank(right.model) || left.position - right.position)
    .map(({ model }) => model);
}

/** A catalog entry with the ChatGPT order, the newest model and default, and no daybreak ids. */
export function withChatGptModelCatalog<T extends { id: string; models: string[]; defaultModel?: string | null }>(entry: T): T {
  if (!isChatGptCatalogProvider(entry.id) || entry.models.length === 0) return entry;
  const models = orderChatGptModels([CHATGPT_DEFAULT_MODEL, ...entry.models]);
  const defaultModel = entry.id === 'openai-codex' || !entry.defaultModel || isHiddenChatGptModel(entry.defaultModel)
    ? CHATGPT_DEFAULT_MODEL
    : entry.defaultModel;
  return { ...entry, models, defaultModel };
}
