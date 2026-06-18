import type { ShapeAgentResourceInput } from './shapeAgentDraft';

export function buildShapeAgentDraftPrompt(input: {
  resources: ShapeAgentResourceInput[];
  identity: string;
}): string {
  const resources = input.resources.length > 0
    ? input.resources.map((resource) => `- ${resource.kind}: ${resource.value}`).join('\n')
    : '- description-only';

  return `You are creating a Kordi Cloud Agent draft.

Access model:
- This Agent is private to the creator's Cloud account by default.
- It syncs to the creator's signed-in devices only.
- Do not claim it is public, shared with contacts, or shared with a workspace.

Use this Shape-style process:
1. Infer the best Agent role from the resources and identity.
2. Generate a clear name, role, description, system prompt, source summary, boundaries, and suggested skills.
3. Prefer these role patterns when applicable: customer support, technical support, sales or shopping assistant, content or brand voice, personal assistant, tutor, internal knowledge base.
4. Every Agent should have honest limitations and boundaries.
5. Suggest navigate-knowledge when source-backed lookup would be useful, but do not invent unsafe executable tools.

Resources:
${resources}

Identity intent:
${input.identity.trim() || 'The user has not provided a detailed identity yet. Infer a focused, useful private agent from the resources.'}

Return only JSON matching this schema:
{
  "name": "string",
  "role": "string",
  "description": "string",
  "systemPrompt": "string",
  "sourceSummary": "string",
  "boundaries": ["string"],
  "skills": [{ "name": "string", "description": "string" }]
}

JSON requirements:
- No markdown fences.
- Keep the systemPrompt concise but complete.
- boundaries must be specific and truthful.
- skills must be metadata suggestions only, not installed tools.`;
}
