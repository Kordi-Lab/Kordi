import type { DesktopAgentBuilderDraft, DesktopAgentBuilderSeed, DesktopAgentBuilderStatus, DesktopChatMessageRoute } from '@/lib/desktop';
import type { CloudAgentAccessScope, CreateCloudAgentInput } from '@/features/cloud/cloudAgentsClient';
import type { CanonicalAvatarMutation } from '@/features/cloud/canonicalAvatar';
import type { Agent } from '../types';
import type { FactoryArtifactKind, FactoryLibraryArtifact } from './model';
import type { ShapeAgentDraft } from './shapeAgentDraft';

export const CLOUD_AGENT_TOOL_DESCRIPTIONS: Readonly<Record<string, string>> = {
  bash: 'Run shell commands in the private agent workspace.',
  edit: 'Make precise changes to workspace files.',
  find: 'Find files and folders by name.',
  grep: 'Search text across workspace files.',
  ls: 'List files and folders in the workspace.',
  read: 'Read files from the workspace.',
  web_fetch: 'Read content from a web page.',
  web_search: 'Search the web for current information.',
  write: 'Create or replace workspace files.',
};

export function resourcesForCreate(creatorAgent?: Agent | null) {
  return creatorAgent ? [{
    kind: 'creator-agent',
    value: creatorAgent.id,
    title: creatorAgent.name,
    summary: `${creatorAgent.loadedTools.length} tools and ${creatorAgent.loadedSkills.length} skills available during shaping`,
  }] : [];
}

export function factoryAgentCreateInput({
  draft,
  runtime,
  accessScope,
  creatorAgent,
  avatarMutation,
}: {
  draft: ShapeAgentDraft;
  runtime?: DesktopAgentBuilderDraft | null;
  accessScope: CloudAgentAccessScope;
  creatorAgent?: Agent | null;
  avatarMutation?: CanonicalAvatarMutation;
}): CreateCloudAgentInput {
  return {
    accessScope,
    name: draft.name,
    role: draft.role,
    description: draft.description,
    ...(avatarMutation ? { avatarMutation } : {}),
    systemPrompt: draft.systemPrompt,
    sourceSummary: draft.sourceSummary,
    boundaries: draft.boundaries,
    resources: resourcesForCreate(creatorAgent),
    skills: draft.skills,
    modelRouting: {
      defaultModel: runtime?.model ?? null,
      defaultAuthProvider: runtime?.provider ?? null,
      thinking: runtime?.thinking ?? null,
      tools: runtime?.tools ?? [],
      plugins: runtime?.plugins ?? [],
    },
  };
}

export function readyFactoryBuildForPublish(status: DesktopAgentBuilderStatus | null) {
  if (!status) throw new Error('The Factory draft is unavailable.');
  if (!status.validation.valid || !status.publishReady) {
    throw new Error(status.validation.errors[0] || 'Validate the Factory draft before publishing.');
  }
  return status;
}

export function shapeDraftFromBuilder(draft: DesktopAgentBuilderDraft): ShapeAgentDraft {
  return {
    name: draft.name,
    role: draft.role,
    description: draft.description,
    systemPrompt: draft.systemPrompt,
    sourceSummary: draft.sourceSummary,
    boundaries: draft.boundaries,
    skills: draft.skills.map((skill) => ({ ...skill })),
  };
}

export function agentBuilderSkillSlug(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

export function agentBuilderSeedForAgent(agent?: Agent): DesktopAgentBuilderSeed {
  return {
    name: agent?.name ?? 'Agent',
    role: agent?.role ?? '',
    description: agent?.cloudAgentDescription ?? agent?.cloudAgentSourceSummary ?? agent?.role ?? '',
    sourceSummary: agent?.cloudAgentSourceSummary ?? '',
    boundaries: agent?.cloudAgentBoundaries ?? [],
    systemPrompt: agent?.systemPrompt ?? '',
    access: agent?.cloudAgentAccessScope === 'participant_conversations' ? 'participant-conversations' : 'only-me',
    provider: agent?.defaultAuthProvider ?? null,
    model: agent?.defaultModel ?? null,
    thinking: agent?.defaultThinking ?? null,
    tools: agent?.loadedTools ?? [],
    plugins: agent?.loadedPlugins ?? [],
    skills: (agent?.cloudAgentSkills ?? agent?.loadedSkills.map((name) => ({ name, description: '' })) ?? []).map((skill) => ({
      name: skill.name,
      description: skill.description ?? '',
      content: 'content' in skill && typeof skill.content === 'string' ? skill.content : null,
    })),
  };
}

export function newArtifactSeed(
  kind: FactoryArtifactKind,
  defaultRoute?: DesktopChatMessageRoute | null,
): DesktopAgentBuilderSeed {
  if (kind === 'skill') {
    return {
      name: 'New skill build',
      role: 'Reusable Kordi skill',
      description: 'A private Factory workspace for one reusable skill.',
      systemPrompt: 'Build and maintain one focused, reusable Kordi skill. Keep its scope narrow, instructions actionable, and permissions minimal.',
      access: 'only-me',
      tools: [],
      plugins: [],
      skills: [{
        name: 'new-skill',
        description: 'Describe when this skill should be used.',
        content: [
          '---',
          'name: new-skill',
          'description: "Describe when this skill should be used."',
          '---',
          '',
          '# New skill',
          '',
          'Describe the focused workflow this skill should guide.',
        ].join('\n'),
      }],
    };
  }
  if (kind === 'tool' || kind === 'plugin') {
    const label = kind === 'tool' ? 'tool' : 'plugin';
    return {
      name: `New ${label}`,
      role: `Kordi ${label}`,
      description: `A private Factory workspace for one ${label}.`,
      systemPrompt: `Define one focused Kordi ${label}, including its purpose, boundaries, inputs, outputs, and required setup.`,
      access: 'only-me',
      tools: kind === 'tool' ? ['new-tool'] : [],
      plugins: kind === 'plugin' ? ['new-plugin'] : [],
      skills: [],
    };
  }
  return {
    name: 'New agent',
    role: 'Kordi agent',
    description: '',
    systemPrompt: '',
    access: 'only-me',
    provider: defaultRoute?.authProvider ?? null,
    model: defaultRoute?.model ?? null,
    thinking: defaultRoute?.thinking ?? null,
    tools: [],
    plugins: [],
    skills: [],
  };
}

export function seedForLibraryArtifact(
  artifact: FactoryLibraryArtifact,
  skillMd = '',
): DesktopAgentBuilderSeed {
  if (artifact.kind === 'skill') {
    const slug = agentBuilderSkillSlug(artifact.name) || 'skill';
    return {
      name: `${artifact.name} skill`,
      role: 'Reusable Kordi skill',
      description: artifact.description,
      systemPrompt: `Maintain the ${artifact.name} skill without changing the published copy until this draft is tested and published.`,
      access: 'only-me',
      tools: [],
      plugins: [],
      skills: [{ name: slug, description: artifact.description, content: skillMd || null }],
    };
  }
  return {
    name: artifact.name,
    role: `Kordi ${artifact.kind}`,
    description: artifact.description,
    systemPrompt: `Maintain the ${artifact.name} ${artifact.kind}. Keep its purpose, inputs, outputs, boundaries, and setup requirements explicit.`,
    access: 'only-me',
    tools: artifact.kind === 'tool' ? [artifact.name] : [],
    plugins: artifact.kind === 'plugin' ? [artifact.name] : [],
    skills: [],
  };
}

export type AgentModelRoutingDraft = {
  defaultModel?: string | null;
  defaultAuthProvider?: string | null;
  defaultAuthChoice?: string | null;
  fallbackModel?: string | null;
  fallbackAuthProvider?: string | null;
  fallbackAuthChoice?: string | null;
  thinking?: string | null;
};

export function modelRoutingForAgent(agent?: Agent): AgentModelRoutingDraft {
  return {
    defaultModel: agent?.defaultModel || null,
    defaultAuthProvider: agent?.defaultAuthProvider ?? null,
    defaultAuthChoice: agent?.defaultAuthChoice ?? null,
    fallbackModel: agent?.fallbackModel ?? null,
    fallbackAuthProvider: agent?.fallbackAuthProvider ?? null,
    fallbackAuthChoice: agent?.fallbackAuthChoice ?? null,
    thinking: agent?.defaultThinking ?? null,
  };
}

export function sameModelRouting(left: AgentModelRoutingDraft, right: AgentModelRoutingDraft) {
  return (Object.keys(modelRoutingForAgent()) as Array<keyof AgentModelRoutingDraft>)
    .every((key) => (left[key] ?? null) === (right[key] ?? null));
}
