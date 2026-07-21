import { useEffect, useMemo, useState } from 'react';
import { MoreHorizontal, PanelRight, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  installDesktopAgentBuilderSkill,
  openDesktopAgentBuilder,
  updateDesktopAgentBuilderDraft,
  type DesktopAgentBuilderDraft,
  type DesktopAgentBuilderSeed,
  type DesktopAgentBuilderStatus,
  type DesktopSkillLibraryEntry,
} from '@/lib/desktop';
import type { CloudAgentAccessScope } from '@/features/cloud/cloudAgentsClient';
import type { Agent } from '../types';
import { AgentDeleteConfirmDialog, archiveAgentFromMenu } from './AgentDetailPane';
import { AgentStudioConversation } from './AgentStudioConversation';
import { AgentStudioRail } from './AgentStudioRail';
import { AgentStudioWorkspace } from './AgentStudioWorkspace';
import { SkillLibraryView } from './SkillLibraryView';
import { cloudAgentAccessLabel, getAgentConfigPath, isRepoFilePath, type AgentSaveFeedback, type AgentStudioCapabilityKind, type FactoryArtifactKind, type FactorySection } from './model';
import type { AgentsPageProps } from './model';
import { type ShapeAgentDraft } from './shapeAgentDraft';
import { useAgentBuilderSession } from './useAgentBuilderSession';
import { useAgentsPageModel } from './useAgentsPageModel';
import { useSkillLibrary } from './useSkillLibrary';

function resourcesForCreate(creatorAgent?: Agent | null) {
  const creatorResource = creatorAgent ? [{
    kind: 'creator-agent',
    value: creatorAgent.id,
    title: creatorAgent.name,
    summary: `${creatorAgent.loadedTools.length} tools and ${creatorAgent.loadedSkills.length} skills available during shaping`,
  }] : [];
  return creatorResource;
}

function shapeDraftFromBuilder(draft: DesktopAgentBuilderDraft): ShapeAgentDraft {
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

function isNativeDesktopShell() {
  return typeof window !== 'undefined' && typeof window.__TAURI_INTERNALS__ !== 'undefined';
}

function agentBuilderSkillSlug(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function agentBuilderSeedForAgent(agent?: Agent): DesktopAgentBuilderSeed {
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

function draftWithLibrarySkill(draft: DesktopAgentBuilderDraft, skill: DesktopSkillLibraryEntry, skillMd: string) {
  const normalizedName = agentBuilderSkillSlug(skill.name);
  const content = skillMd.trim() || [
    '---',
    `name: ${normalizedName}`,
    `description: "${skill.description.replace(/"/g, '\\"')}"`,
    '---',
    '',
    `# ${skill.name}`,
  ].join('\n');
  return {
    ...draft,
    skills: [
      ...draft.skills.filter((entry) => entry.name !== normalizedName),
      {
        name: normalizedName,
        description: skill.description,
        path: `skills/${normalizedName}/SKILL.md`,
        content,
      },
    ].sort((left, right) => left.name.localeCompare(right.name)),
  };
}

type AgentModelRoutingDraft = {
  defaultModel?: string | null;
  defaultAuthProvider?: string | null;
  defaultAuthChoice?: string | null;
  fallbackModel?: string | null;
  fallbackAuthProvider?: string | null;
  fallbackAuthChoice?: string | null;
  thinking?: string | null;
};

function modelRoutingForAgent(agent?: Agent): AgentModelRoutingDraft {
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

function sameModelRouting(left: AgentModelRoutingDraft, right: AgentModelRoutingDraft) {
  return (Object.keys(modelRoutingForAgent()) as Array<keyof AgentModelRoutingDraft>)
    .every((key) => (left[key] ?? null) === (right[key] ?? null));
}

export function AgentsPage({
  agents,
  activeAgentId,
  activeAgent,
  localProfileAvatarSeed,
  localProfileDisplayName,
  localProfileImageUrl,
  onOpenAgent,
  chatModelOptions,
  composerProviderOptions,
  onUpdateAgentModelRouting,
  onOpenAgentReachoutSession,
  onOpenAuthSettings,
  onCreateCloudAgent,
  onUpdateCloudAgent,
  onArchiveCloudAgent,
  onSetAgentSkillEnabled,
}: AgentsPageProps) {
  const [creatingKind, setCreatingKind] = useState<FactoryArtifactKind | null>(null);
  const [factorySection, setFactorySection] = useState<FactorySection>('builds');
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [creationDraft, setCreationDraft] = useState<ShapeAgentDraft | null>(null);
  const [builderGeneration, setBuilderGeneration] = useState(0);
  const [creationAccessScope, setCreationAccessScope] = useState<CloudAgentAccessScope>('private');
  const [accessDraftByAgentId, setAccessDraftByAgentId] = useState<Record<string, CloudAgentAccessScope>>({});
  const [routingDraftByAgentId, setRoutingDraftByAgentId] = useState<Record<string, AgentModelRoutingDraft>>({});
  const [compactPane, setCompactPane] = useState<'conversation' | 'workspace'>('conversation');
  const [publishing, setPublishing] = useState(false);
  const [publishFeedback, setPublishFeedback] = useState<AgentSaveFeedback | null>(null);
  const [archiveConfirmAgent, setArchiveConfirmAgent] = useState<Agent | null>(null);
  const [archiveDeleting, setArchiveDeleting] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const creating = creatingKind !== null;
  const creatingSkill = creatingKind === 'skill';
  const selectedAgent = creating
    ? undefined
    : activeAgent ?? agents.find((agent) => agent.id === activeAgentId) ?? agents[0];
  const creatorAgent = agents.find((agent) => agent.id === 'desktop:local-agent')
    ?? agents.find((agent) => agent.name.trim().toLocaleLowerCase() === 'kordi' && !agent.cloudAgentId)
    ?? agents.find((agent) => agent.isOwned && !agent.cloudAgentId)
    ?? null;
  const skillLibrary = useSkillLibrary();
  const {
    agentConfigs,
    activeAgentConfig,
    activePersistedConfig,
    activeDetail,
    activeSaveFeedback,
    activeFilePreview,
    activeFileDraft,
    activeFileCanEdit,
    activeFileIsEditing,
    activeFileSaveFeedback,
    availableSkills,
    availableTools,
    availablePlugins,
    activeDraftChanges,
    resetAgentDraft,
    saveAgentConfig,
    markAgentDraftPublished,
    saveActiveFile,
    selectIdentityFile,
    openPromptDetail,
    startFileEditing,
    cancelFileEditing,
    replaceAgentDraft,
    updateActiveFileDraft,
  } = useAgentsPageModel(agents, selectedAgent);
  const capabilitySkillCatalog = useMemo(() => {
    const names = new Map<string, string>();
    const descriptions: Record<string, string> = {};
    availableSkills.forEach((name) => names.set(name.toLocaleLowerCase(), name));
    skillLibrary.skills.forEach((skill) => {
      const name = agentBuilderSkillSlug(skill.name) || skill.name;
      names.set(name.toLocaleLowerCase(), name);
      if (skill.description.trim()) descriptions[name.toLocaleLowerCase()] = skill.description.trim();
    });
    return {
      names: Array.from(names.values()).sort((left, right) => left.localeCompare(right)),
      descriptions,
    };
  }, [availableSkills, skillLibrary.skills]);

  useEffect(() => {
    setPublishFeedback(null);
    setCompactPane('conversation');
  }, [creating, selectedAgent?.id]);

  const builderTargetKey = creating ? `create-${creatingKind}` : selectedAgent ? `agent:${selectedAgent.id}` : 'agent:none';
  const builderSeed = useMemo<DesktopAgentBuilderSeed>(() => creatingSkill ? {
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
  } : creating ? {
    name: 'New agent',
    role: 'Kordi agent',
    description: '',
    systemPrompt: '',
    access: 'only-me',
    tools: [],
    plugins: [],
    skills: [],
  } : agentBuilderSeedForAgent(selectedAgent), [creating, creatingSkill, selectedAgent]);
  const builderSeedKey = `${builderGeneration}:${JSON.stringify(builderSeed)}`;
  const builder = useAgentBuilderSession({
    targetKey: builderTargetKey,
    seed: builderSeed,
    seedKey: builderSeedKey,
    enabled: creating || Boolean(selectedAgent),
  });

  useEffect(() => {
    const draft = builder.status?.draft;
    if (!draft) return;
    if (creating) {
      setCreationDraft(shapeDraftFromBuilder(draft));
      setCreationAccessScope(draft.access === 'participant-conversations' ? 'participant_conversations' : 'private');
      return;
    }
    if (!selectedAgent) return;
    replaceAgentDraft(selectedAgent.id, {
      systemPrompt: draft.systemPrompt,
      loadedSkills: draft.skills.map((skill) => skill.name),
      loadedTools: draft.tools,
      loadedPlugins: draft.plugins,
    });
    if (selectedAgent.cloudAgentId) {
      setAccessDraftByAgentId((current) => ({
        ...current,
        [selectedAgent.id]: draft.access === 'participant-conversations' ? 'participant_conversations' : 'private',
      }));
    }
  }, [builder.status?.validation.fingerprint, creating, replaceAgentDraft, selectedAgent?.cloudAgentId, selectedAgent?.id]);

  const selectedConfigPath = selectedAgent ? getAgentConfigPath(selectedAgent) : null;
  const hasLocalConfig = Boolean(
    selectedAgent
      && isNativeDesktopShell()
      && selectedConfigPath
      && isRepoFilePath(selectedConfigPath),
  );
  const canToggleRuntimeSkills = Boolean(
    selectedAgent?.isOwned
      && (selectedAgent.id === 'desktop:local-agent' || selectedAgent.isBridgeActive)
      && onSetAgentSkillEnabled,
  );
  const skillAgentTargets = useMemo(() => agents
    .filter((agent) => agent.isOwned)
    .map((agent) => ({
      id: agent.id,
      name: agent.name,
      role: agent.role,
      avatarSeed: agent.avatarSeed,
      profileImageUrl: agent.profileImageUrl,
      loadedSkills: agentConfigs[agent.id]?.loadedSkills ?? agent.loadedSkills,
    })), [agentConfigs, agents]);
  const canEditPrompt = Boolean(builder.status?.draft);
  const editableCapabilityKinds = useMemo(() => {
    const kinds = new Set<AgentStudioCapabilityKind>();
    if (creatingSkill) {
      kinds.add('skill');
    } else if (creating || selectedAgent?.cloudAgentId) {
      kinds.add('skill');
      kinds.add('tool');
    } else if (hasLocalConfig) {
      kinds.add('skill');
      kinds.add('tool');
      kinds.add('plugin');
    } else if (canToggleRuntimeSkills) kinds.add('skill');
    return kinds;
  }, [canToggleRuntimeSkills, creating, creatingSkill, hasLocalConfig, selectedAgent?.cloudAgentId]);
  const selectedAccessScope = selectedAgent?.cloudAgentId
    ? accessDraftByAgentId[selectedAgent.id] ?? selectedAgent.cloudAgentAccessScope ?? 'private'
    : 'private';
  const accessChanged = Boolean(
    selectedAgent?.cloudAgentId
      && selectedAccessScope !== (selectedAgent.cloudAgentAccessScope ?? 'private'),
  );
  const builderDraft = builder.status?.draft;
  const cloudDefinitionChanges = selectedAgent?.cloudAgentId && builderDraft ? [
    builderDraft.name !== selectedAgent.name ? { key: 'definition' as const, label: 'Agent name updated', detail: builderDraft.name } : null,
    builderDraft.role !== selectedAgent.role ? { key: 'definition' as const, label: 'Agent role updated', detail: builderDraft.role } : null,
    builderDraft.description !== (selectedAgent.cloudAgentDescription ?? '') ? { key: 'definition' as const, label: 'Agent description updated', detail: builderDraft.description || 'Cleared' } : null,
    builderDraft.sourceSummary !== (selectedAgent.cloudAgentSourceSummary ?? '') ? { key: 'definition' as const, label: 'Source summary updated', detail: builderDraft.sourceSummary || 'Cleared' } : null,
    JSON.stringify(builderDraft.boundaries) !== JSON.stringify(selectedAgent.cloudAgentBoundaries ?? []) ? { key: 'definition' as const, label: 'Agent boundaries updated', detail: `${builderDraft.boundaries.length} configured` } : null,
  ].filter((change): change is NonNullable<typeof change> => Boolean(change)) : [];
  const publishedRouting = modelRoutingForAgent(selectedAgent);
  const selectedRouting = selectedAgent ? routingDraftByAgentId[selectedAgent.id] ?? publishedRouting : publishedRouting;
  const routingChanged = Boolean(selectedAgent && !sameModelRouting(selectedRouting, publishedRouting));
  const studioChangesWithDefinition = [...activeDraftChanges, ...cloudDefinitionChanges];
  const studioChangesWithAccess = accessChanged
    ? [...studioChangesWithDefinition, { key: 'access' as const, label: 'Access policy updated', detail: cloudAgentAccessLabel(selectedAccessScope) }]
    : studioChangesWithDefinition;
  const studioChanges = routingChanged
    ? [...studioChangesWithAccess, { key: 'routing' as const, label: 'Model routing updated', detail: selectedRouting.defaultModel || 'Runtime default' }]
    : studioChangesWithAccess;
  const publishDisabled = Boolean(publishing
    || builder.opening
    || builder.testing
    || builder.updating
    || (builder.activeTurn && !builder.activeTurn.completed)
    || !builder.status?.publishReady
    || (creating
      ? !creationDraft || (creatingSkill ? !builder.status?.draft?.skills[0] : !onCreateCloudAgent)
      : !selectedAgent || !activeAgentConfig || studioChanges.length === 0)
    || (!creating && selectedAgent && !selectedAgent.cloudAgentId && activeDraftChanges.some((change) => (
      change.key === 'skills' ? !canToggleRuntimeSkills && !hasLocalConfig : !hasLocalConfig
    ))));

  const persistBuilderDraft = async (update: DesktopAgentBuilderDraft | ((current: DesktopAgentBuilderDraft) => DesktopAgentBuilderDraft)) => {
    const result = await builder.updateDraft(update);
    if (result) setPublishFeedback({ tone: 'info', text: 'Saved to the private agent draft.' });
    return result;
  };

  const updateBuilderPrompt = (value: string) => {
    void persistBuilderDraft((draft) => ({ ...draft, systemPrompt: value }));
  };

  const updateBuilderShapeDraft = (shape: ShapeAgentDraft) => {
    void persistBuilderDraft((draft) => ({
      ...draft,
      name: shape.name,
      role: shape.role,
      description: shape.description,
      systemPrompt: shape.systemPrompt,
      sourceSummary: shape.sourceSummary,
      boundaries: shape.boundaries,
      skills: shape.skills.map((skill) => ({
        name: agentBuilderSkillSlug(skill.name),
        description: skill.description,
        path: `skills/${agentBuilderSkillSlug(skill.name)}/SKILL.md`,
        content: skill.content ?? '',
      })),
    }));
  };

  const updateBuilderCapability = (kind: AgentStudioCapabilityKind, name: string, selected: boolean) => {
    void persistBuilderDraft((draft) => {
      if (kind === 'skill') {
        const slug = agentBuilderSkillSlug(name);
        const skills = selected
          ? draft.skills.filter((skill) => skill.name !== slug)
          : [...draft.skills.filter((skill) => skill.name !== slug), {
            name: slug,
            description: capabilitySkillCatalog.descriptions[slug.toLocaleLowerCase()]
              ?? `Reusable guidance for ${name.replace(/[-_]+/g, ' ')}.`,
            path: `skills/${slug}/SKILL.md`,
            content: '',
          }].sort((left, right) => left.name.localeCompare(right.name));
        return { ...draft, skills };
      }
      const field = kind === 'tool' ? 'tools' : 'plugins';
      const values = selected
        ? draft[field].filter((entry) => entry !== name)
        : [...draft[field].filter((entry) => entry !== name), name].sort((left, right) => left.localeCompare(right));
      return { ...draft, [field]: values };
    });
  };

  const renameBuilderCapability = (kind: AgentStudioCapabilityKind, previousName: string, nextName: string) => {
    void persistBuilderDraft((draft) => {
      if (kind === 'skill') {
        const normalizedNextName = agentBuilderSkillSlug(nextName);
        const skills = draft.skills.map((skill) => {
          if (skill.name !== previousName) return skill;
          const content = skill.content.replace(
            /(^---[\s\S]*?^name:\s*)([^\r\n]+)([\s\S]*?^---)/m,
            `$1${normalizedNextName}$3`,
          );
          return { ...skill, name: normalizedNextName, path: `skills/${normalizedNextName}/SKILL.md`, content };
        });
        return { ...draft, skills };
      }
      const field = kind === 'tool' ? 'tools' : 'plugins';
      return {
        ...draft,
        [field]: draft[field].map((entry) => entry === previousName ? nextName : entry),
      };
    });
  };

  const publish = async () => {
    if (publishDisabled || publishing) return;
    setPublishing(true);
    setPublishFeedback({
      tone: 'info',
      text: creatingSkill
        ? 'Installing the reviewed skill…'
        : creating
          ? 'Creating the Cloud Agent…'
          : `Publishing ${selectedAgent?.name ?? 'agent'}…`,
    });
    try {
      if (creating) {
        if (creatingSkill) {
          const status = builder.status;
          const skill = status?.draft?.skills[0];
          if (!status || !skill) throw new Error('The Factory draft does not contain an installable skill.');
          const installed = await installDesktopAgentBuilderSkill(status.draftId, skill.name, 'global');
          await builder.markPublished();
          await skillLibrary.refresh();
          setCreationDraft(null);
          setCreatingKind(null);
          setSelectedSkillId(installed.id);
          setFactorySection('skills');
          setPublishFeedback({ tone: 'success', text: `${installed.name} was installed disabled. Review it in Skill Library before enabling it.` });
          return;
        }
        if (!creationDraft || !onCreateCloudAgent) return;
        const created = await onCreateCloudAgent({
          accessScope: creationAccessScope,
          name: creationDraft.name,
          role: creationDraft.role,
          description: creationDraft.description,
          systemPrompt: creationDraft.systemPrompt,
          sourceSummary: creationDraft.sourceSummary,
          boundaries: creationDraft.boundaries,
          resources: resourcesForCreate(creatorAgent),
          skills: creationDraft.skills,
          modelRouting: {
            defaultModel: builder.status?.draft?.model ?? null,
            defaultAuthProvider: builder.status?.draft?.provider ?? null,
            thinking: builder.status?.draft?.thinking ?? null,
            tools: builder.status?.draft?.tools ?? [],
            plugins: builder.status?.draft?.plugins ?? [],
          },
        });
        await builder.markPublished();
        setCreationDraft(null);
        setCreatingKind(null);
        onOpenAgent(created.id);
        setPublishFeedback({ tone: 'success', text: `${created.name} was created and is ready.` });
        return;
      }
      if (!selectedAgent || !activeAgentConfig || !activePersistedConfig) return;
      if (selectedAgent.cloudAgentId) {
        if (!onUpdateCloudAgent) throw new Error('Cloud Agent updates are unavailable in this session.');
        const builderSkills = new Map((builder.status?.draft?.skills ?? []).map((skill) => [skill.name, skill]));
        const descriptions = new Map((selectedAgent.cloudAgentSkills ?? []).map((skill) => [skill.name, skill.description]));
        await onUpdateCloudAgent(selectedAgent, {
          name: builder.status?.draft?.name ?? selectedAgent.name,
          role: builder.status?.draft?.role ?? selectedAgent.role,
          description: builder.status?.draft?.description ?? selectedAgent.cloudAgentDescription ?? null,
          systemPrompt: activeAgentConfig.systemPrompt,
          sourceSummary: builder.status?.draft?.sourceSummary ?? selectedAgent.cloudAgentSourceSummary ?? null,
          boundaries: builder.status?.draft?.boundaries ?? selectedAgent.cloudAgentBoundaries ?? [],
          skills: activeAgentConfig.loadedSkills.map((name) => ({
            name,
            description: builderSkills.get(name)?.description ?? descriptions.get(name) ?? 'Configured in Kordi Factory.',
            content: builderSkills.get(name)?.content ?? null,
          })),
          modelRouting: {
            ...selectedRouting,
            tools: builder.status?.draft?.tools ?? activeAgentConfig.loadedTools,
            plugins: builder.status?.draft?.plugins ?? activeAgentConfig.loadedPlugins,
          },
          ...(accessChanged ? { accessScope: selectedAccessScope } : {}),
        });
        markAgentDraftPublished(selectedAgent, activeAgentConfig);
        setAccessDraftByAgentId((current) => {
          const next = { ...current };
          delete next[selectedAgent.id];
          return next;
        });
        setRoutingDraftByAgentId((current) => {
          const next = { ...current };
          delete next[selectedAgent.id];
          return next;
        });
      } else {
        const addedSkills = activeAgentConfig.loadedSkills.filter((skill) => !activePersistedConfig.loadedSkills.includes(skill));
        const removedSkills = activePersistedConfig.loadedSkills.filter((skill) => !activeAgentConfig.loadedSkills.includes(skill));
        if (canToggleRuntimeSkills) {
          for (const skill of removedSkills) await onSetAgentSkillEnabled?.(selectedAgent, skill, false);
          for (const skill of addedSkills) await onSetAgentSkillEnabled?.(selectedAgent, skill, true);
        }
        if (routingChanged) {
          if (!onUpdateAgentModelRouting) throw new Error('Model routing updates are unavailable for this runtime.');
          await onUpdateAgentModelRouting(selectedAgent, selectedRouting);
        }
        const hasFileBackedChange = activeDraftChanges.some((change) => (
          change.key !== 'skills' || !canToggleRuntimeSkills
        ));
        if (hasFileBackedChange) await saveAgentConfig(selectedAgent, 'all');
        markAgentDraftPublished(selectedAgent, activeAgentConfig, 'Published Factory runtime changes');
      }
      await builder.markPublished();
      setPublishFeedback({ tone: 'success', text: `${selectedAgent.name} is published and ready.` });
    } catch (error) {
      setPublishFeedback({ tone: 'error', text: error instanceof Error ? error.message : `Kordi could not ${creatingSkill ? 'install this skill' : 'publish this agent draft'}.` });
    } finally {
      setPublishing(false);
    }
  };

  const discard = async () => {
    await builder.discard();
    if (creating) {
      setCreationDraft(null);
      setBuilderGeneration((current) => current + 1);
      setPublishFeedback({ tone: 'info', text: 'New Factory build discarded.' });
      return;
    }
    if (selectedAgent) resetAgentDraft(selectedAgent);
    if (selectedAgent) {
      setAccessDraftByAgentId((current) => {
        const next = { ...current };
        delete next[selectedAgent.id];
        return next;
      });
      setRoutingDraftByAgentId((current) => {
        const next = { ...current };
        delete next[selectedAgent.id];
        return next;
      });
    }
    setBuilderGeneration((current) => current + 1);
    setPublishFeedback({ tone: 'info', text: 'Unpublished changes discarded.' });
  };

  const updateCloudAccess = (scope: CloudAgentAccessScope) => {
    if (!selectedAgent?.cloudAgentId || !onUpdateCloudAgent) return;
    setAccessDraftByAgentId((current) => ({ ...current, [selectedAgent.id]: scope }));
    void persistBuilderDraft((draft) => ({ ...draft, access: scope === 'participant_conversations' ? 'participant-conversations' : 'only-me' }));
    setPublishFeedback({ tone: 'info', text: 'Access change added to the reviewable draft.' });
  };

  const stageModelRouting = (_agent: Agent, values: AgentModelRoutingDraft) => {
    if (!selectedAgent) return;
    setRoutingDraftByAgentId((current) => ({ ...current, [selectedAgent.id]: values }));
    void persistBuilderDraft((draft) => ({
      ...draft,
      provider: values.defaultAuthProvider ?? null,
      model: values.defaultModel ?? null,
      thinking: values.thinking ?? null,
    }));
    setPublishFeedback({ tone: 'info', text: 'Model routing change added to the reviewable draft.' });
  };

  const startFactoryBuild = (kind: FactoryArtifactKind) => {
    if (kind === 'agent' && !onCreateCloudAgent) return;
    if (creatingKind !== kind) {
      setCreationDraft(null);
      setBuilderGeneration((current) => current + 1);
    }
    setCreatingKind(kind);
    setFactorySection('builds');
    setPublishFeedback(null);
  };

  const openFactorySection = (section: FactorySection) => {
    setFactorySection(section);
    if (section === 'skills' && !selectedSkillId && skillLibrary.skills[0]) {
      setSelectedSkillId(skillLibrary.skills[0].id);
    }
  };

  const addLibrarySkillToAgent = async (targetAgentId: string, skill: DesktopSkillLibraryEntry, skillMd: string) => {
    const targetAgent = agents.find((agent) => agent.id === targetAgentId && agent.isOwned);
    if (!targetAgent) throw new Error('Choose an agent you own.');

    const isOpenTarget = !creating && selectedAgent?.id === targetAgent.id;
    let result: DesktopAgentBuilderStatus | null = null;
    if (isOpenTarget && builder.status?.draft && builder.status.lifecycle === 'draft' && !builder.opening) {
      result = await builder.updateDraft((draft) => draftWithLibrarySkill(draft, skill, skillMd));
      if (!result) throw new Error(`Kordi could not update ${targetAgent.name}'s draft.`);
    } else {
      const opened = await openDesktopAgentBuilder(`agent:${targetAgent.id}`, agentBuilderSeedForAgent(targetAgent));
      if (!opened?.status.draft || opened.status.lifecycle !== 'draft') {
        throw new Error(`Kordi could not open ${targetAgent.name}'s private draft.`);
      }
      result = await updateDesktopAgentBuilderDraft(
        opened.status.draftId,
        draftWithLibrarySkill(opened.status.draft, skill, skillMd),
      );
      if (isOpenTarget) setBuilderGeneration((current) => current + 1);
    }

    if (!result?.draft) throw new Error(`Kordi could not save ${targetAgent.name}'s private draft.`);
    replaceAgentDraft(targetAgent.id, {
      systemPrompt: result.draft.systemPrompt,
      loadedSkills: result.draft.skills.map((entry) => entry.name),
      loadedTools: result.draft.tools,
      loadedPlugins: result.draft.plugins,
    });
    setPublishFeedback({ tone: 'info', text: `${skill.name} was added to ${targetAgent.name}'s private draft. Publish that agent to apply it.` });
  };

  const handleCommunityInstalled = async (installed: DesktopSkillLibraryEntry) => {
    const next = await skillLibrary.refresh();
    const reloaded = next.find((skill) => skill.id === installed.id) ?? installed;
    setSelectedSkillId(reloaded.id);
  };

  const removeLibrarySkill = async (skill: DesktopSkillLibraryEntry) => {
    const removed = await skillLibrary.remove(skill);
    if (!removed) return false;
    if (selectedSkillId === skill.id) {
      setSelectedSkillId(skillLibrary.skills.find((candidate) => candidate.id !== skill.id)?.id ?? null);
    }
    return true;
  };

  const confirmArchive = async () => {
    if (!archiveConfirmAgent || archiveDeleting) return;
    setArchiveDeleting(true);
    setArchiveError(null);
    const archived = await archiveAgentFromMenu({ agent: archiveConfirmAgent, onArchiveCloudAgent });
    if (archived) setArchiveConfirmAgent(null);
    else setArchiveError('Kordi could not delete this agent. Please try again.');
    setArchiveDeleting(false);
  };

  const displayName = creatingSkill
    ? builder.status?.draft?.skills[0]?.name ?? 'New skill'
    : creating
      ? creationDraft?.name ?? 'New agent'
      : selectedAgent?.name ?? 'Kordi Factory';
  const routedAgent = selectedAgent ? {
    ...selectedAgent,
    defaultModel: selectedRouting.defaultModel ?? selectedAgent.defaultModel,
    defaultAuthProvider: selectedRouting.defaultAuthProvider,
    defaultAuthChoice: selectedRouting.defaultAuthChoice,
    fallbackModel: selectedRouting.fallbackModel,
    fallbackAuthProvider: selectedRouting.fallbackAuthProvider,
    fallbackAuthChoice: selectedRouting.fallbackAuthChoice,
    defaultThinking: selectedRouting.thinking,
  } : undefined;
  const canStageRouting = Boolean(
    selectedAgent
      && chatModelOptions?.length
      && (selectedAgent.cloudAgentId ? onUpdateCloudAgent : selectedAgent.isOwned && onUpdateAgentModelRouting),
  );

  return (
    <div className="app-agents-page app-agent-studio-page flex h-full min-h-0 min-w-0 flex-1">
      <div className="app-agent-studio-shell">
        <AgentStudioRail
          agents={agents}
          activeAgentId={activeAgentId}
          creatingKind={creatingKind}
          agentConfigs={agentConfigs}
          skills={skillLibrary.skills}
          selectedSkillId={selectedSkillId}
          section={factorySection}
          canCreateAgent={Boolean(onCreateCloudAgent)}
          onSectionChange={openFactorySection}
          onOpenAgent={(agentId) => { setCreatingKind(null); setFactorySection('builds'); onOpenAgent(agentId); }}
          onOpenSkill={(skillId) => { setSelectedSkillId(skillId); setFactorySection('skills'); }}
          onCreateArtifact={startFactoryBuild}
        />
        {factorySection === 'skills' ? (
          <SkillLibraryView
            skills={skillLibrary.skills}
            selectedSkillId={selectedSkillId}
            loading={skillLibrary.loading}
            error={skillLibrary.error}
            mutatingSkillId={skillLibrary.mutatingSkillId}
            agentTargets={skillAgentTargets}
            onSelectSkill={setSelectedSkillId}
            onRefresh={skillLibrary.refresh}
            onSetEnabled={skillLibrary.setEnabled}
            onRemove={removeLibrarySkill}
            onInstalled={handleCommunityInstalled}
            onAddToAgent={addLibrarySkillToAgent}
          />
        ) : <main className="app-agent-studio-main">
          {!creating && selectedAgent?.cloudAgentId && onArchiveCloudAgent ? (
            <div className="app-agent-studio-header-actions is-floating">
              <details className="relative">
                <summary className="app-agent-studio-icon-button" aria-label="More agent actions"><MoreHorizontal className="h-4 w-4" /></summary>
                <div className="app-agent-studio-actions-menu"><button type="button" onClick={() => setArchiveConfirmAgent(selectedAgent)}>Delete agent</button></div>
              </details>
            </div>
          ) : null}
          <div className="app-agent-studio-compact-switcher" role="group" aria-label="Factory pane">
            <button type="button" className={cn(compactPane === 'conversation' && 'is-active')} onClick={() => setCompactPane('conversation')}><Sparkles className="h-3.5 w-3.5" />Conversation</button>
            <button type="button" className={cn(compactPane === 'workspace' && 'is-active')} onClick={() => setCompactPane('workspace')}><PanelRight className="h-3.5 w-3.5" />Workspace</button>
          </div>
          <div className="app-agent-studio-body" data-compact-pane={compactPane}>
            <AgentStudioConversation
              targetName={displayName}
              creating={creating}
              localProfileAvatarSeed={localProfileAvatarSeed}
              localProfileDisplayName={localProfileDisplayName}
              localProfileImageUrl={localProfileImageUrl}
              sessionId={builder.status?.sessionId}
              detail={builder.detail}
              activeTurn={builder.activeTurn}
              optimisticPrompt={builder.optimisticPrompt}
              optimisticAttachments={builder.optimisticAttachments}
              opening={builder.opening}
              error={builder.error}
              modelOptions={chatModelOptions}
              providerOptions={composerProviderOptions}
              onSend={builder.send}
              onStop={builder.stop}
              onOpenAuthSettings={onOpenAuthSettings}
            />
            <AgentStudioWorkspace
              key={creating ? `create-${creatingKind}` : selectedAgent?.id ?? 'no-agent'}
              agent={routedAgent}
              creating={creating}
              artifactKind={creatingKind ?? 'agent'}
              creationDraft={creationDraft}
              creationAccessScope={creationAccessScope}
              agentAccessScope={selectedAccessScope}
              onCreationAccessScopeChange={(scope) => {
                setCreationAccessScope(scope);
                void persistBuilderDraft((draft) => ({ ...draft, access: scope === 'participant_conversations' ? 'participant-conversations' : 'only-me' }));
              }}
              config={activeAgentConfig}
              persisted={activePersistedConfig}
              changes={studioChanges}
              availableSkills={capabilitySkillCatalog.names}
              skillDescriptions={capabilitySkillCatalog.descriptions}
              availableTools={availableTools}
              availablePlugins={availablePlugins}
              editableCapabilityKinds={editableCapabilityKinds}
              allowCapabilityCreation={creating || Boolean(selectedAgent?.cloudAgentId) || hasLocalConfig}
              canEditPrompt={canEditPrompt}
              onPromptChange={updateBuilderPrompt}
              onCreationDraftChange={updateBuilderShapeDraft}
              onToggleCapability={(kind, name, selected) => {
                updateBuilderCapability(kind, name, selected);
              }}
              onAddCapability={(kind, name) => {
                updateBuilderCapability(kind, name, false);
              }}
              onRenameCapability={(kind, previousName, nextName) => {
                renameBuilderCapability(kind, previousName, nextName);
              }}
              onPublish={() => void publish()}
              onDiscard={() => void discard()}
              publishing={publishing}
              publishFeedback={publishFeedback ?? activeSaveFeedback}
              publishDisabled={publishDisabled}
              chatModelOptions={chatModelOptions}
              composerProviderOptions={composerProviderOptions}
              onUpdateModelRouting={canStageRouting ? stageModelRouting : undefined}
              onUpdateCloudAccess={updateCloudAccess}
              activeDetail={activeDetail}
              activeFilePreview={activeFilePreview}
              activeFileDraft={activeFileDraft}
              activeFileCanEdit={activeFileCanEdit}
              activeFileIsEditing={activeFileIsEditing}
              activeFileSaveFeedback={activeFileSaveFeedback}
              onSelectPrompt={() => selectedAgent && openPromptDetail(selectedAgent.id)}
              onSelectFile={(path) => selectedAgent && selectIdentityFile(selectedAgent.id, path)}
              onStartFileEditing={startFileEditing}
              onCancelFileEditing={cancelFileEditing}
              onSaveFile={() => void saveActiveFile()}
              onFileDraftChange={updateActiveFileDraft}
              onOpenReachout={onOpenAgentReachoutSession}
              builderStatus={builder.status}
              builderTesting={builder.testing}
              onTestBuilderDraft={() => void builder.testDraft()}
              onReadBuilderFile={builder.readFile}
              onWriteBuilderFile={builder.writeFile}
            />
          </div>
        </main>}
      </div>
      {archiveConfirmAgent ? (
        <AgentDeleteConfirmDialog
          agent={archiveConfirmAgent}
          isDeleting={archiveDeleting}
          error={archiveError}
          onCancel={() => { if (!archiveDeleting) setArchiveConfirmAgent(null); }}
          onConfirm={() => void confirmArchive()}
        />
      ) : null}
    </div>
  );
}
