import { runDesktopShapeAgentDraft } from '@/lib/desktop';
import {
  buildFallbackShapeAgentDraft,
  parseShapeAgentDraftJson,
  type ShapeAgentDraft,
  type ShapeAgentResourceInput,
} from './shapeAgentDraft';
import { buildShapeAgentDraftPrompt } from './shapeAgentPrompts';

type ShapeAgentRunner = (prompt: string) => Promise<{ assistantText?: string | null; message?: string | null; succeeded?: boolean } | null>;

export async function draftShapeAgentWithRunner(input: {
  resources: ShapeAgentResourceInput[];
  identity: string;
  runPrompt: ShapeAgentRunner;
}): Promise<{ draft: ShapeAgentDraft; source: 'llm' | 'fallback'; error?: string | null }> {
  const prompt = buildShapeAgentDraftPrompt({ resources: input.resources, identity: input.identity });
  try {
    const turn = await input.runPrompt(prompt);
    const text = turn?.assistantText?.trim() || turn?.message?.trim() || '';
    const draft = text ? parseShapeAgentDraftJson(text) : null;
    if (draft) return { draft, source: 'llm' };
    return {
      draft: buildFallbackShapeAgentDraft({ resources: input.resources, identity: input.identity }),
      source: 'fallback',
      error: text ? 'The model did not return valid Cloud Agent JSON.' : 'No model response was available.',
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
}) {
  return draftShapeAgentWithRunner({
    ...input,
    runPrompt: runDesktopShapeAgentDraft,
  });
}
