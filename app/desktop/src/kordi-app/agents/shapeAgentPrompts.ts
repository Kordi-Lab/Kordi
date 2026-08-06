import type { Agent } from '../types';
import type { ShapeAgentResourceInput } from './shapeAgentDraft';

export type ShapeAgentCreatorContext = Pick<Agent, 'name' | 'role' | 'systemPrompt' | 'loadedTools' | 'loadedSkills' | 'identityFiles'>;

function creatorAgentPromptBlock(creatorAgent?: ShapeAgentCreatorContext | null) {
  if (!creatorAgent) return 'Existing creator Agent:\n- None selected. Shape from the user inputs only.';
  const tools = creatorAgent.loadedTools.length > 0 ? creatorAgent.loadedTools.join(', ') : 'none exposed';
  const skills = creatorAgent.loadedSkills.length > 0 ? creatorAgent.loadedSkills.join(', ') : 'none exposed';
  const files = creatorAgent.identityFiles.length > 0 ? creatorAgent.identityFiles.join(', ') : 'none exposed';
  return `Existing creator Agent:
- Name: ${creatorAgent.name}
- Role: ${creatorAgent.role}
- Runtime prompt summary: ${creatorAgent.systemPrompt.trim().slice(0, 800) || 'not exposed'}
- Tools available to the creator during shaping: ${tools}
- Skills available to the creator during shaping: ${skills}
- Identity files visible to the creator: ${files}

Use the creator agent's available tools and skills to shape the draft. The synchronized definition may suggest skills, but do not claim its runtime has installed executable tools unless that runtime actually supports them.`;
}

export function buildShapeAgentDraftPrompt(input: {
  resources: ShapeAgentResourceInput[];
  identity: string;
  creatorAgent?: ShapeAgentCreatorContext | null;
}): string {
  const resources = input.resources.length > 0
    ? input.resources.map((resource) => `- ${resource.kind}: ${resource.value}`).join('\n')
    : '- description-only';

  return `You are creating a Kordi agent draft that can run locally or through Cloud fallback.

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

${creatorAgentPromptBlock(input.creatorAgent)}

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
