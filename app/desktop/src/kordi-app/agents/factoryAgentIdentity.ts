import { usesDefaultLocalAgentSession } from '@/features/chat/agentSessionRouting';
import {
  AGENT_CANONICAL_AVATAR_STYLE,
  generatedAvatarPreviewUrl,
  type CanonicalAvatarMutation,
} from '@/features/cloud/canonicalAvatar';
import type { DesktopAgentBuilderDraft } from '@/lib/desktop';
import type { Agent } from '../types';
import { getAvatarOverride, setAvatarOverride } from '../components/avatarOverrides';
import { getIdentityAvatarKey } from '../components/IdentityAvatar';
import { getAgentConfigPath, isRepoFilePath, type AgentsPageProps } from './model';

type IdentityChange = { key: 'definition'; label: string; detail: string };

export function factoryLocalAgentCapabilities(agent: Agent | undefined, canSetSkill: boolean) {
  const configPath = agent ? getAgentConfigPath(agent) : null;
  return {
    hasLocalConfig: Boolean(agent && typeof window !== 'undefined' && window.__TAURI_INTERNALS__ && configPath && isRepoFilePath(configPath)),
    canToggleRuntimeSkills: Boolean(agent?.isOwned && (agent.id === 'desktop:local-agent' || agent.isCollaborationActive) && canSetSkill),
  };
}

export function factoryAgentAvatarPresentation(agent?: Agent) {
  const seed = agent?.avatarSeed?.trim() || agent?.id || '';
  const avatarKey = agent ? getIdentityAvatarKey('agent', seed) : null;
  return {
    avatarKey,
    avatarUrl: avatarKey
      ? getAvatarOverride(avatarKey)
        || agent?.profileImageUrl
        || generatedAvatarPreviewUrl(AGENT_CANONICAL_AVATAR_STYLE, seed)
      : null,
  };
}

export function factoryAgentIdentityChanges(
  agent: Agent | undefined,
  draft: DesktopAgentBuilderDraft | null | undefined,
  mutation: CanonicalAvatarMutation | undefined,
): IdentityChange[] {
  if (!agent) return [];
  return [
    usesDefaultLocalAgentSession(agent) && draft && draft.name !== agent.name
      ? { key: 'definition', label: 'Agent name updated', detail: draft.name }
      : null,
    mutation
      ? { key: 'definition', label: 'Agent avatar updated', detail: mutation.action === 'upload' ? 'Uploaded image' : 'Generated avatar' }
      : null,
  ].filter((change): change is IdentityChange => Boolean(change));
}

export function cloudAgentDefinitionChanges(
  agent: Agent | undefined,
  draft: DesktopAgentBuilderDraft | null | undefined,
): IdentityChange[] {
  if (!agent?.cloudAgentId || !draft) return [];
  return [
    draft.name !== agent.name ? { key: 'definition' as const, label: 'Agent name updated', detail: draft.name } : null,
    draft.role !== agent.role ? { key: 'definition' as const, label: 'Agent role updated', detail: draft.role } : null,
    draft.description !== (agent.cloudAgentDescription ?? '') ? { key: 'definition' as const, label: 'Agent description updated', detail: draft.description || 'Cleared' } : null,
    draft.sourceSummary !== (agent.cloudAgentSourceSummary ?? '') ? { key: 'definition' as const, label: 'Source summary updated', detail: draft.sourceSummary || 'Cleared' } : null,
    JSON.stringify(draft.boundaries) !== JSON.stringify(agent.cloudAgentBoundaries ?? []) ? { key: 'definition' as const, label: 'Agent boundaries updated', detail: `${draft.boundaries.length} configured` } : null,
  ].filter((change): change is IdentityChange => Boolean(change));
}

export async function publishDefaultAgentIdentity({
  agent,
  draft,
  mutation,
  avatarKey,
  onRenameLocalAgent,
  onUpdateLocalAgentAvatar,
}: {
  agent: Agent;
  draft?: DesktopAgentBuilderDraft | null;
  mutation?: CanonicalAvatarMutation;
  avatarKey: string | null;
  onRenameLocalAgent: AgentsPageProps['onRenameLocalAgent'];
  onUpdateLocalAgentAvatar: AgentsPageProps['onUpdateLocalAgentAvatar'];
}) {
  if (!usesDefaultLocalAgentSession(agent)) return;
  if (draft?.name.trim()) {
    if (!onRenameLocalAgent) throw new Error('Local agent identity updates are unavailable in this session.');
    await onRenameLocalAgent(draft.name);
  }
  if (!avatarKey || !mutation) return;
  await onUpdateLocalAgentAvatar?.(mutation);
  const avatarUrl = mutation.action === 'upload'
    ? mutation.uploadedAsset
    : mutation.seed
      ? generatedAvatarPreviewUrl(AGENT_CANONICAL_AVATAR_STYLE, mutation.seed)
      : null;
  if (avatarUrl) setAvatarOverride(avatarKey, avatarUrl);
}
