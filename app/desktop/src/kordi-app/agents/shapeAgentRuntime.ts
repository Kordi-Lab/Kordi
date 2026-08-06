import { runDesktopShapeAgentDraft } from '@/lib/desktop';
import type { Agent } from '../types';
import {
  buildFallbackShapeAgentDraft,
  parseShapeAgentDraftJson,
  type ShapeAgentDraft,
  type ShapeAgentResourceInput,
} from './shapeAgentDraft';
import { buildShapeAgentDraftPrompt, type ShapeAgentCreatorContext } from './shapeAgentPrompts';

export type ShapeAgentRoute = {
  defaultModel?: string | null;
  defaultAuthProvider?: string | null;
  defaultAuthChoice?: string | null;
  fallbackModel?: string | null;
  fallbackAuthProvider?: string | null;
  fallbackAuthChoice?: string | null;
  thinking?: string | null;
};

type ShapeAgentRunner = (prompt: string, route: ShapeAgentRoute) => Promise<{ assistantText?: string | null; message?: string | null; succeeded?: boolean } | null>;

function cleanText(value?: string | null) {
  return value?.trim() || null;
}

export function shapeAgentRouteFromCreatorAgent(agent?: Agent | null): ShapeAgentRoute | null {
  const defaultModel = cleanText(agent?.defaultModel);
  const defaultAuthProvider = cleanText(agent?.defaultAuthProvider) || cleanText(agent?.defaultProvider);
  if (!defaultModel || !defaultAuthProvider) return null;
  return {
    defaultModel,
    defaultAuthProvider,
    defaultAuthChoice: cleanText(agent?.defaultAuthChoice),
    fallbackModel: cleanText(agent?.fallbackModel),
    fallbackAuthProvider: cleanText(agent?.fallbackAuthProvider),
    fallbackAuthChoice: cleanText(agent?.fallbackAuthChoice),
    thinking: cleanText(agent?.defaultThinking),
  };
}

export async function draftShapeAgentWithRunner(input: {
  resources: ShapeAgentResourceInput[];
  identity: string;
  creatorAgent?: ShapeAgentCreatorContext | null;
  route?: ShapeAgentRoute | null;
  runPrompt: ShapeAgentRunner;
}): Promise<{ draft: ShapeAgentDraft; source: 'llm' | 'fallback'; error?: string | null }> {
  if (!input.creatorAgent || !input.route?.defaultModel || !input.route?.defaultAuthProvider) {
    throw new Error("Configure Kordi's LLM provider and model route before shaping an agent.");
  }
  const prompt = buildShapeAgentDraftPrompt({ resources: input.resources, identity: input.identity, creatorAgent: input.creatorAgent });
  try {
    const turn = await input.runPrompt(prompt, input.route);
    const text = turn?.assistantText?.trim() || turn?.message?.trim() || '';
    const draft = text ? parseShapeAgentDraftJson(text) : null;
    if (draft) return { draft, source: 'llm' };
    return {
      draft: buildFallbackShapeAgentDraft({ resources: input.resources, identity: input.identity }),
      source: 'fallback',
      error: text ? 'The model did not return valid agent JSON.' : 'No model response was available.',
    };
  } catch (error) {
    return {
      draft: buildFallbackShapeAgentDraft({ resources: input.resources, identity: input.identity }),
      source: 'fallback',
      error: error instanceof Error ? error.message : 'Unable to run Shape draft model.',
    };
  }
}

export async function draftShapeAgentWithDesktopRuntime(input: {
  resources: ShapeAgentResourceInput[];
  identity: string;
  creatorAgent?: ShapeAgentCreatorContext | null;
  route?: ShapeAgentRoute | null;
}) {
  return draftShapeAgentWithRunner({
    ...input,
    runPrompt: runDesktopShapeAgentDraft,
  });
}
