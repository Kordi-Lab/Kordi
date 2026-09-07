import {
  upsertCanonicalIdentityFast,
} from '@/lib/desktop';
import type {
  ApplyCloudGroupAgentControlInput,
  CloudGroupAgentPresentation,
} from './cloudGroupAgentControl.types';
import {
  cloudAgentCanonicalIdentityId,
  cloudAgentDisplayName,
  cloudAgentId,
} from './cloudAgentIdentity';

function cloudGroupAgentPresentation(
  input: ApplyCloudGroupAgentControlInput,
): CloudGroupAgentPresentation {
  const { account, envelope } = input.context;
  const message = envelope.message!;
  const hostedAgentName = input.stateOps.cleanText(
    message.targetCloudAgentName,
  );
  const hostedAgentOwnerName = input.stateOps.cleanText(
    message.targetCloudAgentOwnerName,
  )
    || input.stateOps.cleanText(account.displayName)
    || input.stateOps.cleanText(account.primaryEmail)
    || 'Cloud user';
  const agentId = cloudAgentId(
    message.targetCloudAgentId,
    account.accountId,
  );
  return {
    agentId,
    identityId: cloudAgentCanonicalIdentityId(agentId, account.accountId),
    displayName: cloudAgentDisplayName(hostedAgentName),
    ownerDisplayName: hostedAgentOwnerName,
  };
}

export async function ensureCloudGroupAgentIdentity(
  input: ApplyCloudGroupAgentControlInput,
  signal?: AbortSignal,
): Promise<CloudGroupAgentPresentation> {
  const { account, localHumanIdentityId } = input.context;
  const presentation = cloudGroupAgentPresentation(input);
  const agentIdentity = await upsertCanonicalIdentityFast({
    id: presentation.identityId,
    kind: 'agent',
    displayName: presentation.displayName,
    ownerIdentityId: localHumanIdentityId,
    source: 'local',
    sourceHostId: 'cloud',
    sourceIdentityId: presentation.agentId,
    humanId: account.accountId,
    agentId: presentation.agentId,
    avatarKey: presentation.agentId,
    profileImageUrl: null,
    metadata: { accountId: account.accountId, cloudGroupAgent: true },
  });
  if (!signal?.aborted) {
    input.setCanonicalState((current) =>
      input.stateOps.upsertIdentity(current, agentIdentity)
    );
  }
  return presentation;
}
