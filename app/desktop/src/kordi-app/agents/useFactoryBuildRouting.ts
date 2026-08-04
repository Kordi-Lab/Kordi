import { useState, type Dispatch, type SetStateAction } from 'react';

import { fetchDesktopSkillLibraryDetail, type DesktopAgentBuilderSeed } from '@/lib/desktop';
import {
  fetchDesktopAgentBuilderList,
  resolveDesktopAgentBuilder,
  type DesktopAgentBuilderSummary,
} from '@/lib/desktopAgentBuilderCatalog';
import type { Agent } from '../types';
import { agentBuilderSeedForAgent, newArtifactSeed, seedForLibraryArtifact } from './factoryAgentUtils';
import {
  agentBuilderTargetKey,
  createFactoryBuildTargetKey,
  factoryArtifactTargetKey,
  factoryBuildIdentityFromTarget,
  type AgentSaveFeedback,
  type FactoryArtifactKind,
  type FactoryBuildRoute,
  type FactoryLibraryArtifact,
  type FactoryLibrarySection,
  type FactoryReturnContext,
  type FactorySection,
} from './model';

type FactoryBuildRoutingOptions = {
  agents: Agent[];
  builds: DesktopAgentBuilderSummary[];
  buildRoute: FactoryBuildRoute | null;
  canCreateAgent: boolean;
  cloudAccountId?: string | null;
  factorySection: FactorySection;
  inspectedAgent?: Agent;
  libraryArtifacts: Record<'tool' | 'plugin', FactoryLibraryArtifact[]>;
  librarySection: FactoryLibrarySection;
  selectedLibraryId: string | null;
  skills: Array<{ id: string; name: string; description: string }>;
  setBuilds: Dispatch<SetStateAction<DesktopAgentBuilderSummary[]>>;
  setBuildRoute: Dispatch<SetStateAction<FactoryBuildRoute | null>>;
  setBuildSeed: Dispatch<SetStateAction<DesktopAgentBuilderSeed>>;
  setBuilderGeneration: Dispatch<SetStateAction<number>>;
  setFactorySection: Dispatch<SetStateAction<FactorySection>>;
  setPublishFeedback: Dispatch<SetStateAction<AgentSaveFeedback | null>>;
};

export function useFactoryBuildRouting({
  agents,
  builds,
  buildRoute,
  canCreateAgent,
  cloudAccountId,
  factorySection,
  inspectedAgent,
  libraryArtifacts,
  librarySection,
  selectedLibraryId,
  skills,
  setBuilds,
  setBuildRoute,
  setBuildSeed,
  setBuilderGeneration,
  setFactorySection,
  setPublishFeedback,
}: FactoryBuildRoutingOptions) {
  const [routingToBuild, setRoutingToBuild] = useState(false);

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

  const startFactoryBuild = (kind: FactoryArtifactKind) => {
    if (kind === 'agent' && !canCreateAgent) return;
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
    try {
      const identity = factoryBuildIdentityFromTarget(summary.targetKey);
      const kind = identity?.kind ?? (['agent', 'skill', 'tool', 'plugin'].includes(summary.artifactKind)
        ? summary.artifactKind as FactoryArtifactKind
        : 'agent');
      const artifactId = identity?.artifactId ?? null;
      const agent = kind === 'agent' && artifactId
        ? agents.find((candidate) => candidate.id === artifactId)
        : undefined;
      const libraryArtifact = kind !== 'agent' && artifactId
        ? (kind === 'skill'
          ? skills.find((skill) => skill.id === artifactId)
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
    } finally {
      setRoutingToBuild(false);
    }
  };

  return { editAgentInBuild, editLibraryArtifactInBuild, openBuildSummary, routingToBuild, startFactoryBuild };
}
