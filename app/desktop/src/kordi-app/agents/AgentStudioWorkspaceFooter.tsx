import type { DesktopAgentBuilderStatus } from '@/lib/desktop';
import type { FactoryArtifactKind } from './model';

/**
 * Discard / Publish bar under the Build workspace. New builds show it once there is a draft;
 * an existing agent always shows it, with Publish disabled while nothing is unpublished.
 */
export function AgentStudioWorkspaceFooter({
  artifactKind,
  standaloneBuild,
  creating,
  hasCreationDraft,
  hasAgent,
  changeCount,
  builderStatus,
  builderTesting,
  publishing,
  publishDisabled,
  draftMutationDisabled,
  onDiscard,
  onPublish,
}: {
  artifactKind: FactoryArtifactKind;
  standaloneBuild: boolean;
  creating: boolean;
  hasCreationDraft: boolean;
  hasAgent: boolean;
  changeCount: number;
  builderStatus?: DesktopAgentBuilderStatus | null;
  builderTesting?: boolean;
  publishing: boolean;
  publishDisabled: boolean;
  draftMutationDisabled: boolean;
  onDiscard: () => void;
  onPublish: () => void;
}) {
  const existingAgent = !creating && hasAgent;
  if (builderStatus?.lifecycle === 'published' || !(changeCount > 0 || (creating && hasCreationDraft) || existingAgent)) return null;
  const summary = standaloneBuild
    ? `${artifactKind[0]?.toUpperCase()}${artifactKind.slice(1)} draft`
    : creating
      ? 'New agent build'
      : changeCount === 0
        ? 'No unpublished changes'
        : `${changeCount} unpublished change${changeCount === 1 ? '' : 's'}`;
  const publishLabel = builderTesting
    ? 'Testing…'
    : publishing
      ? 'Publishing…'
      : artifactKind === 'skill' ? 'Publish skill' : artifactKind === 'tool' ? 'Publish tool' : artifactKind === 'plugin' ? 'Publish plugin' : creating ? 'Publish agent' : 'Publish';
  const showDiscard = creating || changeCount > 0;
  return (
    <div className="app-agent-studio-workspace-footer">
      <span>{summary}</span>
      <div className="flex gap-2">
        {showDiscard ? <button type="button" className="app-button-quiet app-agent-studio-button is-ghost is-small" onClick={onDiscard} disabled={publishing || draftMutationDisabled}>Discard</button> : null}
        <button type="button" className="app-button-quiet app-agent-studio-button is-primary is-small" onClick={onPublish} disabled={publishDisabled || publishing || (existingAgent && changeCount === 0)}>{publishLabel}</button>
      </div>
    </div>
  );
}
