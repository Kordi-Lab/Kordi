import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowLeft } from 'lucide-react';
import {
  installDesktopAgentBuilderSkill,
  fetchDesktopAgentBuilderList,
  fetchDesktopSkillLibraryDetail,
  resolveDesktopAgentBuilder,
  type DesktopAgentBuilderDraft,
  type DesktopAgentBuilderSeed,
  type DesktopAgentBuilderStatus,
  type DesktopAgentBuilderSummary,
} from '@/lib/desktop';
import type { CloudAgentAccessScope } from '@/features/cloud/cloudAgentsClient';
import type { Agent } from '../types';
import { AgentInspectionView } from './AgentInspectionView';
import { AgentStudioConversation } from './AgentStudioConversation';
import { AgentStudioRail } from './AgentStudioRail';
import { AgentStudioWorkspace } from './AgentStudioWorkspace';
import { CapabilityLibraryView } from './CapabilityLibraryView';
import {
  agentBuilderTargetKey,
  agentStudioConfigChanges,
  cloudAgentAccessLabel,
  createFactoryBuildTargetKey,
  factoryArtifactTargetKey,
  factoryBuildIdentityFromTarget,
  getAgentConfigPath,
  isRepoFilePath,
  type AgentSaveFeedback,
  type AgentStudioCapabilityKind,
  type FactoryArtifactKind,
  type FactoryBuildRoute,
  type FactoryLibraryArtifact,
  type FactoryLibrarySection,
  type FactoryReturnContext,
  type FactorySection,
} from './model';
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

function newArtifactSeed(kind: FactoryArtifactKind): DesktopAgentBuilderSeed {
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
    tools: [],
    plugins: [],
    skills: [],
  };
}

function seedForLibraryArtifact(artifact: FactoryLibraryArtifact, skillMd = ''): DesktopAgentBuilderSeed {
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
  cloudAccountId,
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
  onSetAgentSkillEnabled,
}: AgentsPageProps) {
  const [factorySection, setFactorySection] = useState<FactorySection>('agents');
  const [librarySection, setLibrarySection] = useState<FactoryLibrarySection>('skill');
  const [selectedLibraryIds, setSelectedLibraryIds] = useState<Partial<Record<FactoryLibrarySection, string>>>({});
  const [buildRoute, setBuildRoute] = useState<FactoryBuildRoute | null>(null);
  const [buildSeed, setBuildSeed] = useState<DesktopAgentBuilderSeed>({});
  const [builds, setBuilds] = useState<DesktopAgentBuilderSummary[]>([]);
  const [buildListLoading, setBuildListLoading] = useState(true);
  const [routingToBuild, setRoutingToBuild] = useState(false);
  const [builderGeneration, setBuilderGeneration] = useState(0);
  const [accessDraftByAgentId, setAccessDraftByAgentId] = useState<Record<string, CloudAgentAccessScope>>({});
  const [routingDraftByAgentId, setRoutingDraftByAgentId] = useState<Record<string, AgentModelRoutingDraft>>({});
  const [publishing, setPublishing] = useState(false);
  const [publishFeedback, setPublishFeedback] = useState<AgentSaveFeedback | null>(null);
  const routeKind = buildRoute?.artifactKind ?? 'agent';
  const buildingStandaloneArtifact = Boolean(buildRoute && routeKind !== 'agent');
  const creating = Boolean(buildRoute && (buildRoute.artifactId === null || buildingStandaloneArtifact));
  const creatingSkill = routeKind === 'skill' && creating;
  const inspectedAgent = activeAgent ?? agents.find((agent) => agent.id === activeAgentId) ?? agents[0];
  const selectedAgent = buildRoute?.artifactKind === 'agent' && buildRoute.artifactId
    ? agents.find((agent) => agent.id === buildRoute.artifactId)
    : undefined;
  const creatorAgent = agents.find((agent) => agent.id === 'desktop:local-agent')
    ?? agents.find((agent) => agent.name.trim().toLocaleLowerCase() === 'kordi' && !agent.cloudAgentId)
    ?? agents.find((agent) => agent.isOwned && !agent.cloudAgentId)
    ?? null;
  const skillLibrary = useSkillLibrary();
  const {
    activeAgentConfig: modelActiveAgentConfig,
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
    activeDraftChanges: modelActiveDraftChanges,
    resetAgentDraft,
    saveAgentConfig,
    markAgentDraftPublished,
    saveActiveFile,
    selectIdentityFile,
    openPromptDetail,
    startFileEditing,
    cancelFileEditing,
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

  const libraryArtifacts = useMemo<Record<'tool' | 'plugin', FactoryLibraryArtifact[]>>(() => {
    const buildArtifacts = (kind: 'tool' | 'plugin') => builds
      .filter((build) => build.available && build.lifecycle === 'published' && build.artifactKind === kind)
      .map((build) => ({
        id: factoryBuildIdentityFromTarget(build.targetKey)?.artifactId ?? `${kind}:${build.name}`,
        name: build.name,
      }));
    const entriesFor = (kind: 'tool' | 'plugin', runtimeNames: string[]) => {
      const namesById = new Map(runtimeNames.map((name) => [`${kind}:${name}`, name]));
      buildArtifacts(kind).forEach((artifact) => namesById.set(artifact.id, artifact.name));
      return Array.from(namesById, ([id, name]) => {
        const usedBy = agents
          .filter((agent) => (kind === 'tool' ? agent.loadedTools : agent.loadedPlugins).includes(name))
          .map((agent) => agent.name);
        const factoryPublished = builds.some((build) => (
          build.lifecycle === 'published'
            && build.artifactKind === kind
            && factoryBuildIdentityFromTarget(build.targetKey)?.artifactId === id
        ));
        return {
          id,
          kind,
          name,
          description: factoryPublished
            ? `Published Kordi Factory ${kind} definition.`
            : `${kind === 'tool' ? 'Runtime tool' : 'Plugin'} used by ${usedBy.length} agent${usedBy.length === 1 ? '' : 's'}.`,
          status: factoryPublished ? 'Published' : 'Available',
          usedBy,
        };
      }).sort((left, right) => left.name.localeCompare(right.name));
    };
    return {
      tool: entriesFor('tool', availableTools),
      plugin: entriesFor('plugin', availablePlugins),
    };
  }, [agents, availablePlugins, availableTools, builds]);
  const selectedLibraryId = selectedLibraryIds[librarySection] ?? (
    librarySection === 'skill'
      ? skillLibrary.skills[0]?.id
      : libraryArtifacts[librarySection][0]?.id
  ) ?? null;
  const selectedSkill = librarySection === 'skill'
    ? skillLibrary.skills.find((skill) => skill.id === selectedLibraryId) ?? null
    : null;
  const selectedLibraryArtifact = useMemo<FactoryLibraryArtifact | null>(() => {
    if (librarySection === 'skill') {
      if (!selectedSkill) return null;
      return {
        id: selectedSkill.id,
        kind: 'skill',
        name: selectedSkill.name,
        description: selectedSkill.description,
        status: selectedSkill.enabled ? 'Enabled' : 'Disabled',
        usedBy: agents.filter((agent) => agent.loadedSkills.includes(selectedSkill.name)).map((agent) => agent.name),
      };
    }
    return libraryArtifacts[librarySection].find((artifact) => artifact.id === selectedLibraryId) ?? null;
  }, [agents, libraryArtifacts, librarySection, selectedLibraryId, selectedSkill]);

  const refreshBuilds = useCallback(async () => {
    setBuildListLoading(true);
    try {
      const next = await fetchDesktopAgentBuilderList();
      setBuilds(next);
      return next;
    } catch {
      return [];
    } finally {
      setBuildListLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetchDesktopAgentBuilderList()
      .then((next) => { if (!cancelled) setBuilds(next); })
      .finally(() => { if (!cancelled) setBuildListLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const builderTargetKey = buildRoute?.targetKey ?? agentBuilderTargetKey(cloudAccountId, 'inactive');
  const builderSeed = buildSeed;
  const builderSeedKey = `${builderGeneration}:${JSON.stringify(builderSeed)}`;
  const handleBuilderSessionResolved = useCallback((nextStatus: DesktopAgentBuilderStatus) => {
    setBuildRoute((current) => {
      if (!current) return current;
      const belongsToCurrentRoute = current.targetKey === nextStatus.targetKey
        || current.sessionId === nextStatus.sessionId
        || current.sessionId === null;
      if (!belongsToCurrentRoute) return current;
      if (current.targetKey === nextStatus.targetKey && current.sessionId === nextStatus.sessionId) return current;
      return {
        ...current,
        targetKey: nextStatus.targetKey,
        sessionId: nextStatus.sessionId,
      };
    });
  }, []);
  const builder = useAgentBuilderSession({
    targetKey: builderTargetKey,
    sessionId: buildRoute?.sessionId,
    seed: builderSeed,
    seedKey: builderSeedKey,
    onSessionResolved: handleBuilderSessionResolved,
    enabled: factorySection === 'build' && Boolean(buildRoute),
  });
  const creationDraft = creating && builder.status?.draft
    ? shapeDraftFromBuilder(builder.status.draft)
    : null;
  const creationAccessScope: CloudAgentAccessScope = builder.status?.draft?.access === 'participant-conversations'
    ? 'participant_conversations'
    : 'private';
  const activeAgentConfig = selectedAgent && builder.status?.draft ? {
    systemPrompt: builder.status.draft.systemPrompt,
    loadedSkills: builder.status.draft.skills.map((skill) => skill.name),
    loadedTools: builder.status.draft.tools,
    loadedPlugins: builder.status.draft.plugins,
  } : modelActiveAgentConfig;
  const activeDraftChanges = activeAgentConfig && activePersistedConfig
    ? agentStudioConfigChanges(activeAgentConfig, activePersistedConfig)
    : modelActiveDraftChanges;

  useEffect(() => {
    if (!builder.status) return;
    void fetchDesktopAgentBuilderList().then(setBuilds).catch(() => undefined);
  }, [builder.status?.lifecycle, builder.status?.sessionId, builder.status?.validation.fingerprint]);

  const selectedConfigPath = selectedAgent ? getAgentConfigPath(selectedAgent) : null;
  const hasLocalConfig = Boolean(
    selectedAgent
      && isNativeDesktopShell()
      && selectedConfigPath
      && isRepoFilePath(selectedConfigPath),
  );
  const canToggleRuntimeSkills = Boolean(
    selectedAgent?.isOwned
      && (selectedAgent.id === 'desktop:local-agent' || selectedAgent.isCollaborationActive)
      && onSetAgentSkillEnabled,
  );
  const canEditPrompt = Boolean(builder.status?.draft);
  const editableCapabilityKinds = useMemo(() => {
    const kinds = new Set<AgentStudioCapabilityKind>();
    if (buildingStandaloneArtifact) {
      kinds.add(routeKind as AgentStudioCapabilityKind);
    } else if (creating || selectedAgent?.cloudAgentId) {
      kinds.add('skill');
      kinds.add('tool');
      kinds.add('plugin');
    } else if (hasLocalConfig) {
      kinds.add('skill');
      kinds.add('tool');
      kinds.add('plugin');
    } else if (canToggleRuntimeSkills) kinds.add('skill');
    return kinds;
  }, [buildingStandaloneArtifact, canToggleRuntimeSkills, creating, hasLocalConfig, routeKind, selectedAgent?.cloudAgentId]);
  const selectedAccessScope = selectedAgent?.cloudAgentId
    ? accessDraftByAgentId[selectedAgent.id]
      ?? (builder.status?.draft?.access === 'participant-conversations' ? 'participant_conversations' : null)
      ?? selectedAgent.cloudAgentAccessScope
      ?? 'private'
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
  const builderRouting = builder.status?.draft ? {
    ...publishedRouting,
    defaultModel: builder.status.draft.model,
    defaultAuthProvider: builder.status.draft.provider,
    thinking: builder.status.draft.thinking,
  } : publishedRouting;
  const selectedRouting = selectedAgent ? routingDraftByAgentId[selectedAgent.id] ?? builderRouting : publishedRouting;
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
      ? !creationDraft || (creatingSkill
        ? !builder.status?.draft?.skills[0]
        : routeKind === 'agent' && !onCreateCloudAgent)
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
        : routeKind === 'tool' || routeKind === 'plugin'
          ? `Publishing the ${routeKind} definition…`
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
          const installed = await installDesktopAgentBuilderSkill(
            status.draftId,
            skill.name,
            'global',
            status.validation.fingerprint,
          );
          const targetKey = factoryArtifactTargetKey(cloudAccountId, 'skill', installed.id);
          await builder.retarget(targetKey);
          await builder.markPublished();
          await skillLibrary.refresh();
          setBuildRoute((current) => current ? { ...current, targetKey, artifactKind: 'skill', artifactId: installed.id } : current);
          setSelectedLibraryIds((current) => ({ ...current, skill: installed.id }));
          setPublishFeedback({ tone: 'success', text: `${installed.name} was published to Lib and remains disabled until it is managed in Build.` });
          return;
        }
        if (routeKind === 'tool' || routeKind === 'plugin') {
          const status = builder.status;
          const name = routeKind === 'tool' ? status?.draft?.tools[0] : status?.draft?.plugins[0];
          if (!status || !name) throw new Error(`The Factory draft does not contain a ${routeKind} definition.`);
          const artifactId = `${routeKind}:${name}`;
          const targetKey = factoryArtifactTargetKey(cloudAccountId, routeKind, artifactId);
          await builder.retarget(targetKey);
          await builder.markPublished();
          setBuildRoute((current) => current ? { ...current, targetKey, artifactKind: routeKind, artifactId } : current);
          setSelectedLibraryIds((current) => ({ ...current, [routeKind]: artifactId }));
          await refreshBuilds();
          setPublishFeedback({ tone: 'success', text: `${name} was published to Lib.` });
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
        const targetKey = factoryArtifactTargetKey(cloudAccountId, 'agent', created.id);
        await builder.retarget(targetKey);
        await builder.markPublished();
        setBuildRoute((current) => current ? { ...current, targetKey, artifactKind: 'agent', artifactId: created.id } : current);
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
        if (hasFileBackedChange) await saveAgentConfig(selectedAgent, 'all', activeAgentConfig);
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
    const discarded = await builder.discard();
    if (!discarded) return;
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
    const returnContext = buildRoute?.returnContext;
    setBuildRoute(null);
    setFactorySection(returnContext?.section ?? 'agents');
    if (returnContext?.section === 'library' && returnContext.librarySection) {
      setLibrarySection(returnContext.librarySection);
      if (returnContext.selectedId) setSelectedLibraryIds((current) => ({ ...current, [returnContext.librarySection!]: returnContext.selectedId! }));
    }
    await refreshBuilds();
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

  const currentReturnContext = (): FactoryReturnContext | null => {
    if (factorySection === 'agents') return { section: 'agents', selectedId: inspectedAgent?.id ?? null };
    if (factorySection === 'library') return { section: 'library', librarySection, selectedId: selectedLibraryId };
    return buildRoute?.returnContext ?? null;
  };

  const showBuild = (route: FactoryBuildRoute, seed: DesktopAgentBuilderSeed) => {
    setBuildSeed(seed);
    setBuildRoute(route);
    setBuilderGeneration((current) => current + 1);
    setFactorySection('build');
    setPublishFeedback(null);
  };

  const startFactoryBuild = (kind: FactoryArtifactKind) => {
    if (kind === 'agent' && !onCreateCloudAgent) return;
    const buildId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    showBuild({
      targetKey: createFactoryBuildTargetKey(cloudAccountId, kind, buildId),
      sessionId: null,
      artifactKind: kind,
      artifactId: null,
      returnContext: currentReturnContext(),
    }, newArtifactSeed(kind));
  };

  const openFactorySection = (section: FactorySection) => {
    setFactorySection(section);
  };

  const resolveKnownBuild = async (targetKeys: string[]) => {
    let known = builds.find((build) => targetKeys.includes(build.targetKey)) ?? null;
    if (!known) {
      try {
        const catalog = await fetchDesktopAgentBuilderList();
        setBuilds(catalog);
        known = catalog.find((build) => targetKeys.includes(build.targetKey)) ?? null;
      } catch {
        // Opening the route below will surface the actionable storage error in Build.
      }
    }
    if (known) return known;
    for (const targetKey of targetKeys) {
      try {
        const resolved = await resolveDesktopAgentBuilder(targetKey);
        if (resolved) return resolved;
      } catch {
        // Let the Build route render the native recovery or storage error.
      }
    }
    return null;
  };

  const editAgentInBuild = async (agent: Agent) => {
    setRoutingToBuild(true);
    try {
      const targetKey = factoryArtifactTargetKey(cloudAccountId, 'agent', agent.id);
      const legacyTargetKey = agentBuilderTargetKey(cloudAccountId, `agent:${agent.id}`);
      const known = await resolveKnownBuild([targetKey, legacyTargetKey]);
      showBuild({
        targetKey: known?.targetKey ?? targetKey,
        sessionId: known?.sessionId ?? null,
        artifactKind: 'agent',
        artifactId: agent.id,
        returnContext: { section: 'agents', selectedId: agent.id },
      }, agentBuilderSeedForAgent(agent));
    } finally {
      setRoutingToBuild(false);
    }
  };

  const editLibraryArtifactInBuild = async (artifact: FactoryLibraryArtifact) => {
    setRoutingToBuild(true);
    try {
      let skillMd = '';
      if (artifact.kind === 'skill') {
        try {
          skillMd = (await fetchDesktopSkillLibraryDetail(artifact.id)).skillMd;
        } catch {
          // The recovery surface will explain an inaccessible build; keep the published metadata seed usable.
        }
      }
      const targetKey = factoryArtifactTargetKey(cloudAccountId, artifact.kind, artifact.id);
      const known = await resolveKnownBuild([targetKey]);
      showBuild({
        targetKey,
        sessionId: known?.sessionId ?? null,
        artifactKind: artifact.kind,
        artifactId: artifact.id,
        returnContext: { section: 'library', librarySection: artifact.kind, selectedId: artifact.id },
      }, seedForLibraryArtifact(artifact, skillMd));
    } finally {
      setRoutingToBuild(false);
    }
  };

  const openBuildSummary = async (summary: DesktopAgentBuilderSummary) => {
    setRoutingToBuild(true);
    const identity = factoryBuildIdentityFromTarget(summary.targetKey);
    const kind = identity?.kind ?? (['agent', 'skill', 'tool', 'plugin'].includes(summary.artifactKind)
      ? summary.artifactKind as FactoryArtifactKind
      : 'agent');
    const artifactId = identity?.artifactId ?? null;
    const agent = kind === 'agent' && artifactId ? agents.find((candidate) => candidate.id === artifactId) : undefined;
    const libraryArtifact = kind !== 'agent' && artifactId
      ? (kind === 'skill'
        ? skillLibrary.skills.find((skill) => skill.id === artifactId)
        : libraryArtifacts[kind].find((candidate) => candidate.id === artifactId))
      : null;
    let skillMd = '';
    if (kind === 'skill' && artifactId) {
      try {
        skillMd = (await fetchDesktopSkillLibraryDetail(artifactId)).skillMd;
      } catch {
        // Existing build files remain authoritative; recovery will use the available published metadata.
      }
    }
    const seed = agent
      ? agentBuilderSeedForAgent(agent)
      : libraryArtifact
        ? seedForLibraryArtifact({
          id: libraryArtifact.id,
          kind: kind as FactoryLibrarySection,
          name: libraryArtifact.name,
          description: libraryArtifact.description,
          status: 'status' in libraryArtifact ? String(libraryArtifact.status) : 'Published',
          usedBy: [],
        }, skillMd)
        : newArtifactSeed(kind);
    showBuild({
      targetKey: summary.targetKey,
      sessionId: summary.sessionId,
      artifactKind: kind,
      artifactId,
      returnContext: currentReturnContext(),
    }, seed);
    setRoutingToBuild(false);
  };

  const displayName = routeKind === 'skill'
    ? builder.status?.draft?.skills[0]?.name ?? 'New skill'
    : routeKind === 'tool'
      ? builder.status?.draft?.tools[0] ?? creationDraft?.name ?? 'New tool'
      : routeKind === 'plugin'
        ? builder.status?.draft?.plugins[0] ?? creationDraft?.name ?? 'New plugin'
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
  const buildState = builder.opening
    ? 'Loading'
    : builder.status?.lifecycle === 'published'
      ? 'Published'
      : !builder.status?.draft || !builder.status.validation.valid
        ? 'Needs setup'
        : !builder.status.testReport || builder.status.testReport.fingerprint !== builder.status.validation.fingerprint || !builder.status.testReport.passed
          ? 'Needs testing'
          : builder.status.publishReady
            ? 'Ready to publish'
            : 'Private draft';
  const returnFromBuild = () => {
    const context = buildRoute?.returnContext;
    setFactorySection(context?.section ?? 'agents');
    if (context?.section === 'agents' && context.selectedId) onOpenAgent(context.selectedId);
    if (context?.section === 'library' && context.librarySection) {
      setLibrarySection(context.librarySection);
      if (context.selectedId) setSelectedLibraryIds((current) => ({ ...current, [context.librarySection!]: context.selectedId! }));
    }
  };

  return (
    <div className="app-agents-page app-agent-studio-page flex h-full min-h-0 min-w-0 flex-1 overflow-hidden">
      <div className="app-agent-studio-shell">
        <AgentStudioRail
          agents={agents}
          activeAgentId={activeAgentId}
          builds={builds}
          activeBuildSessionId={builder.status?.sessionId ?? buildRoute?.sessionId ?? null}
          skills={skillLibrary.skills}
          libraryArtifacts={libraryArtifacts}
          selectedLibraryId={selectedLibraryId}
          section={factorySection}
          librarySection={librarySection}
          canCreateAgent={Boolean(onCreateCloudAgent)}
          onSectionChange={openFactorySection}
          onLibrarySectionChange={setLibrarySection}
          onOpenBuild={(summary) => { void openBuildSummary(summary); }}
          onOpenAgent={(agentId) => { setFactorySection('agents'); onOpenAgent(agentId); }}
          onOpenLibraryArtifact={(kind, artifactId) => {
            setLibrarySection(kind);
            setSelectedLibraryIds((current) => ({ ...current, [kind]: artifactId }));
            setFactorySection('library');
          }}
          onCreateArtifact={startFactoryBuild}
        />
        {factorySection === 'agents' ? <AgentInspectionView agent={inspectedAgent} onEditInBuild={(agent) => void editAgentInBuild(agent)} /> : null}
        {factorySection === 'library' ? (
          <CapabilityLibraryView
            key={`${librarySection}:${selectedLibraryId ?? 'none'}`}
            kind={librarySection}
            artifact={selectedLibraryArtifact}
            skill={selectedSkill}
            onEditInBuild={(artifact) => void editLibraryArtifactInBuild(artifact)}
          />
        ) : null}
        {factorySection === 'build' ? <main className="app-agent-studio-main app-factory-build-main">
          {buildRoute ? (
            <>
              <header className="app-factory-build-context">
                <button type="button" className="app-button-quiet app-agent-studio-icon-button" onClick={returnFromBuild} aria-label="Return to inspection"><ArrowLeft className="h-4 w-4" /></button>
                <div className="min-w-0"><strong>{displayName}</strong><span>{routeKind.charAt(0).toUpperCase() + routeKind.slice(1)} · {buildState}</span></div>
                <code aria-label="Factory build route">Factory / Build / {builder.status?.sessionId ?? buildRoute.sessionId ?? 'new'}</code>
              </header>
              {builder.sessionUnavailable ? (
                <div className="app-factory-recovery" role="alert">
                  <AlertTriangle className="h-5 w-5" />
                  <h2>Build session unavailable</h2>
                  <p>{builder.error ?? 'The saved conversation cannot be opened.'} The published {routeKind} remains unchanged.</p>
                  <div><button type="button" className="app-button-quiet app-agent-studio-button" onClick={returnFromBuild}>Cancel</button><button type="button" className="app-button-quiet app-agent-studio-button is-primary" onClick={() => void builder.recover()}>Recover from published {routeKind}</button></div>
                </div>
              ) : <div className="app-agent-studio-body">
            <AgentStudioConversation
              targetName={displayName}
              creating={creating}
              artifactKind={routeKind}
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
              key={buildRoute.targetKey}
              agent={routedAgent}
              creating={creating}
              artifactKind={routeKind}
              creationDraft={creationDraft}
              creationAccessScope={creationAccessScope}
              agentAccessScope={selectedAccessScope}
              onCreationAccessScopeChange={(scope) => {
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
              draftMutationDisabled={Boolean(
                builder.opening
                  || builder.testing
                  || builder.updating
                  || publishing
                  || (builder.activeTurn && !builder.activeTurn.completed)
              )}
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
              </div>}
            </>
          ) : (
            <div className="app-skill-library-state"><strong>{buildListLoading ? 'Loading builds…' : 'No build selected'}</strong><span>Choose a recent conversation or use + to start one.</span></div>
          )}
        </main> : null}
      </div>
      {routingToBuild ? <div className="sr-only" role="status" aria-live="polite">Opening the exact Factory build conversation…</div> : null}
    </div>
  );
}
