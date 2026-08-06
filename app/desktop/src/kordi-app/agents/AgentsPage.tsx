import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowLeft } from 'lucide-react';
import {
  installDesktopAgentBuilderSkill,
  type DesktopAgentBuilderDraft,
  type DesktopAgentBuilderSeed,
  type DesktopAgentBuilderStatus,
} from '@/lib/desktop';
import {
  fetchDesktopAgentBuilderList,
  type DesktopAgentBuilderSummary,
} from '@/lib/desktopAgentBuilderCatalog';
import type {
  CloudAgentAccessScope,
  CloudAgentMentionPermissions,
  CloudAgentProactiveConfig,
} from '@/features/cloud/cloudAgentsClient';
import { defaultCloudAgentsClient } from '@/features/cloud/cloudAgentsClient';
import { loadSession } from '@/features/cloud/session';
import type { Agent } from '../types';
import { AgentInspectionView } from './AgentInspectionView';
import { AgentStudioConversation } from './AgentStudioConversation';
import { AgentStudioRail } from './AgentStudioRail';
import { AgentStudioWorkspace } from './AgentStudioWorkspace';
import { CapabilityLibraryView, type FactorySkillLibraryMode } from './CapabilityLibraryView';
import {
  agentBuilderSkillSlug,
  modelRoutingForAgent,
  resourcesForCreate,
  sameModelRouting,
  shapeDraftFromBuilder,
  type AgentModelRoutingDraft,
} from './factoryAgentUtils';
import {
  agentBuilderTargetKey,
  agentStudioConfigChanges,
  cloudAgentAccessLabel,
  factoryArtifactTargetKey,
  factoryBuildIdentityFromTarget,
  getAgentConfigPath,
  isRepoFilePath,
  type AgentSaveFeedback,
  type AgentStudioCapabilityKind,
  type FactoryBuildRoute,
  type FactoryLibraryArtifact,
  type FactoryLibrarySection,
  type FactorySection,
} from './model';
import type { AgentsPageProps } from './model';
import type { ShapeAgentDraft } from './shapeAgentDraft';
import { useAgentBuilderSession } from './useAgentBuilderSession';
import { useAgentsPageModel } from './useAgentsPageModel';
import { useFactoryBuildRouting } from './useFactoryBuildRouting';
import { useSkillLibrary } from './useSkillLibrary';

function isNativeDesktopShell() {
  return typeof window !== 'undefined' && typeof window.__TAURI_INTERNALS__ !== 'undefined';
}

const cloudAgentActivityClient = defaultCloudAgentsClient();

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
  onListCloudAgentProactiveRuns,
  onSetAgentSkillEnabled,
}: AgentsPageProps) {
  const [factorySection, setFactorySection] = useState<FactorySection>('agents');
  const [librarySection, setLibrarySection] = useState<FactoryLibrarySection>('skill');
  const [librarySkillMode, setLibrarySkillMode] = useState<FactorySkillLibraryMode>('installed');
  const [selectedLibraryIds, setSelectedLibraryIds] = useState<Partial<Record<FactoryLibrarySection, string>>>({});
  const [buildRoute, setBuildRoute] = useState<FactoryBuildRoute | null>(null);
  const [buildSeed, setBuildSeed] = useState<DesktopAgentBuilderSeed>({});
  const [builds, setBuilds] = useState<DesktopAgentBuilderSummary[]>([]);
  const [buildListLoading, setBuildListLoading] = useState(true);
  const [builderGeneration, setBuilderGeneration] = useState(0);
  const [accessDraftByAgentId, setAccessDraftByAgentId] = useState<Record<string, CloudAgentAccessScope>>({});
  const [publishedAccessByAgentId, setPublishedAccessByAgentId] = useState<Record<string, CloudAgentAccessScope>>({});
  const [routingDraftByAgentId, setRoutingDraftByAgentId] = useState<Record<string, AgentModelRoutingDraft>>({});
  const [publishing, setPublishing] = useState(false);
  const [publishFeedback, setPublishFeedback] = useState<AgentSaveFeedback | null>(null);
  const listProactiveRuns = useCallback(async (agentId: string, limit = 30) => {
    if (onListCloudAgentProactiveRuns) return onListCloudAgentProactiveRuns(agentId, limit);
    const session = await loadSession();
    if (!session?.token) throw new Error('Sign in to Cloud to view proactive collaboration activity.');
    return cloudAgentActivityClient.listProactiveRuns(session.token, agentId, limit);
  }, [onListCloudAgentProactiveRuns]);
  const routeKind = buildRoute?.artifactKind ?? 'agent';
  const buildingStandaloneArtifact = Boolean(buildRoute && routeKind !== 'agent');
  const creating = Boolean(buildRoute && (buildRoute.artifactId === null || buildingStandaloneArtifact));
  const creatingSkill = routeKind === 'skill' && creating;
  const inspectedAgentSource = activeAgent ?? agents.find((agent) => agent.id === activeAgentId) ?? agents[0];
  const inspectedAgent = inspectedAgentSource && publishedAccessByAgentId[inspectedAgentSource.id]
    ? { ...inspectedAgentSource, cloudAgentAccessScope: publishedAccessByAgentId[inspectedAgentSource.id] }
    : inspectedAgentSource;
  const selectedAgentSource = buildRoute?.artifactKind === 'agent' && buildRoute.artifactId
    ? agents.find((agent) => agent.id === buildRoute.artifactId)
    : undefined;
  const selectedAgent = selectedAgentSource && publishedAccessByAgentId[selectedAgentSource.id]
    ? { ...selectedAgentSource, cloudAgentAccessScope: publishedAccessByAgentId[selectedAgentSource.id] }
    : selectedAgentSource;
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
  const {
    editAgentInBuild,
    editLibraryArtifactInBuild,
    openBuildSummary,
    routingToBuild,
    startFactoryBuild,
  } = useFactoryBuildRouting({
    agents,
    builds,
    buildRoute,
    canCreateAgent: Boolean(onCreateCloudAgent),
    cloudAccountId,
    factorySection,
    inspectedAgent,
    libraryArtifacts,
    librarySection,
    selectedLibraryId,
    skills: skillLibrary.skills,
    setBuilds,
    setBuildRoute,
    setBuildSeed,
    setBuilderGeneration,
    setFactorySection,
    setPublishFeedback,
  });

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
  const builderAccessScope: CloudAgentAccessScope = builder.status?.draft?.access === 'participant-conversations'
    ? 'participant_conversations'
    : 'private';
  const publishedAccessScope: CloudAgentAccessScope = selectedAgent
    ? publishedAccessByAgentId[selectedAgent.id]
      ?? selectedAgent.cloudAgentAccessScope
      ?? (builder.status?.lifecycle === 'published' ? builderAccessScope : 'private')
    : 'private';
  const selectedAccessScope = selectedAgent
    ? accessDraftByAgentId[selectedAgent.id] ?? builderAccessScope
    : 'private';
  const accessChanged = Boolean(
    selectedAgent && selectedAccessScope !== publishedAccessScope,
  );
  const builderDraft = builder.status?.draft;
  const cloudDefinitionChanges = selectedAgent?.cloudAgentId && builderDraft ? [
    builderDraft.name !== selectedAgent.name ? { key: 'definition' as const, label: 'Agent name updated', detail: builderDraft.name } : null,
    builderDraft.role !== selectedAgent.role ? { key: 'definition' as const, label: 'Agent role updated', detail: builderDraft.role } : null,
    builderDraft.description !== (selectedAgent.cloudAgentDescription ?? '') ? { key: 'definition' as const, label: 'Agent description updated', detail: builderDraft.description || 'Cleared' } : null,
    builderDraft.sourceSummary !== (selectedAgent.cloudAgentSourceSummary ?? '') ? { key: 'definition' as const, label: 'Source summary updated', detail: builderDraft.sourceSummary || 'Cleared' } : null,
    JSON.stringify(builderDraft.boundaries) !== JSON.stringify(selectedAgent.cloudAgentBoundaries ?? []) ? { key: 'definition' as const, label: 'Agent boundaries updated', detail: `${builderDraft.boundaries.length} configured` } : null,
    builderDraft.proactive.enabled !== (selectedAgent.cloudAgentProactive?.enabled ?? false) ? { key: 'proactive' as const, label: 'Proactive collaboration updated', detail: builderDraft.proactive.enabled ? 'On' : 'Off' } : null,
    JSON.stringify(builderDraft.mentionPermissions) !== JSON.stringify(selectedAgent.cloudAgentMentionPermissions ?? { people: true, agents: true }) ? { key: 'mentions' as const, label: '@mention permissions updated', detail: [builderDraft.mentionPermissions.people ? 'People' : null, builderDraft.mentionPermissions.agents ? 'Agents' : null].filter(Boolean).join(' and ') || 'None' } : null,
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
          proactive: builder.status?.draft?.proactive ?? { enabled: false, skillPack: 'proact-v1' },
          mentionPermissions: builder.status?.draft?.mentionPermissions ?? { people: false, agents: false },
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
          proactive: builder.status?.draft?.proactive ?? selectedAgent.cloudAgentProactive ?? { enabled: false, skillPack: 'proact-v1' },
          mentionPermissions: builder.status?.draft?.mentionPermissions ?? selectedAgent.cloudAgentMentionPermissions ?? { people: true, agents: true },
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
        if (accessChanged) {
          setPublishedAccessByAgentId((current) => ({ ...current, [selectedAgent.id]: selectedAccessScope }));
          setAccessDraftByAgentId((current) => {
            const next = { ...current };
            delete next[selectedAgent.id];
            return next;
          });
        }
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

  const updateAgentAccess = (scope: CloudAgentAccessScope) => {
    if (!selectedAgent) return;
    if (scope === 'private' && builder.status?.draft?.proactive.enabled) {
      setPublishFeedback({ tone: 'error', text: 'Turn off proactive collaboration before limiting access to only you.' });
      return;
    }
    setAccessDraftByAgentId((current) => ({ ...current, [selectedAgent.id]: scope }));
    void persistBuilderDraft((draft) => ({ ...draft, access: scope === 'participant_conversations' ? 'participant-conversations' : 'only-me' }));
    setPublishFeedback({ tone: 'info', text: 'Access change added to the reviewable draft.' });
  };

  const updateProactive = (proactive: CloudAgentProactiveConfig) => {
    if (proactive.enabled && builderAccessScope !== 'participant_conversations') {
      setPublishFeedback({ tone: 'error', text: 'Share this agent with people in its chats before enabling proactive collaboration.' });
      return;
    }
    void persistBuilderDraft((draft) => ({ ...draft, proactive }));
    setPublishFeedback({ tone: 'info', text: 'Proactive collaboration change added to the reviewable draft.' });
  };

  const updateMentionPermissions = (mentionPermissions: CloudAgentMentionPermissions) => {
    void persistBuilderDraft((draft) => ({ ...draft, mentionPermissions }));
    setPublishFeedback({ tone: 'info', text: '@mention permissions added to the reviewable draft.' });
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

  const openFactorySection = (section: FactorySection) => {
    setFactorySection(section);
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
          libraryCommunity={librarySection === 'skill' && librarySkillMode === 'community'}
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
            skillMode={librarySkillMode}
            installedSkills={skillLibrary.skills}
            onSkillModeChange={setLibrarySkillMode}
            onCommunityInstalled={async () => { await skillLibrary.refresh(); }}
            onEditInBuild={(artifact) => void editLibraryArtifactInBuild(artifact)}
          />
        ) : null}
        {factorySection === 'build' ? <main className="app-agent-studio-main app-factory-build-main">
          {buildRoute ? (
            <>
              <header className="app-factory-build-context">
                <button type="button" className="app-button-quiet app-agent-studio-icon-button" onClick={returnFromBuild} aria-label="Return to inspection"><ArrowLeft className="h-4 w-4" /></button>
                <div className="min-w-0"><strong>{displayName}</strong><span>{routeKind.charAt(0).toUpperCase() + routeKind.slice(1)} · {buildState}</span></div>
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
                if (scope === 'private' && builder.status?.draft?.proactive.enabled) {
                  setPublishFeedback({ tone: 'error', text: 'Turn off proactive collaboration before limiting access to only you.' });
                  return;
                }
                void persistBuilderDraft((draft) => ({ ...draft, access: scope === 'participant_conversations' ? 'participant-conversations' : 'only-me' }));
              }}
              proactive={builder.status?.draft?.proactive ?? { enabled: false, skillPack: 'proact-v1' }}
              mentionPermissions={builder.status?.draft?.mentionPermissions ?? { people: false, agents: false }}
              onProactiveChange={updateProactive}
              onMentionPermissionsChange={updateMentionPermissions}
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
              onUpdateAgentAccess={updateAgentAccess}
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
              onListProactiveRuns={listProactiveRuns}
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
