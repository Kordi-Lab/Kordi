import type { Contact, DesktopCollaborationPeer } from '@/kordi-app/types';

import type { CloudAccount } from './authClient';
import { cloudAvatarImageUrl } from './avatar';
import { CLOUD_HOST_SENTINEL } from './cloudContactMapping';

export const CLOUD_SERVER_LABEL = 'kordi.cloud';
export const CLOUD_PERSON_RUNTIME = 'person';
export const CLOUD_AGENT_RUNTIME = 'kordi-desktop';

export function cloudPeerDisplayName(contact: Contact): string {
  return contact.name?.trim() || contact.sourceParticipantId?.trim() || contact.id.replace(/^cloud:/, '');
}

export function isSystemCloudAgentContact(contact: Contact): boolean {
  return Boolean(contact.systemContact && contact.sourceAgentId?.trim());
}

export function cloudAgentDisplayName(contact: Contact): string {
  if (isSystemCloudAgentContact(contact)) {
    return contact.targetCloudAgentName?.trim() || contact.name.trim();
  }
  return `${cloudPeerDisplayName(contact)}'s Kordi`;
}

export function cloudContactToPersonPeer(contact: Contact): DesktopCollaborationPeer {
  const accountId = contact.sourceParticipantId || contact.id.replace(/^cloud:/, '');
  const displayName = cloudPeerDisplayName(contact);
  return {
    nodeId: accountId,
    displayName,
    runtime: CLOUD_PERSON_RUNTIME,
    endpoint: CLOUD_SERVER_LABEL,
    ownerName: contact.owner || displayName,
    createdAt: null,
    sharedProjects: [],
    humanId: accountId,
    agentId: null,
    isDefaultAgent: false,
    discoveryMode: 'contacts',
    humanVisibilityPolicy: 'server-approval',
    contactApprovalPolicy: 'approval-required',
    agentReachabilityPolicy: 'contacts',
    isContact: true,
    contactRequestStatus: 'accepted',
    contactRequestDirection: 'outgoing',
    profileImageUrl: contact.profileImageUrl,
    avatarSeed: contact.avatarSeed ?? accountId,
  };
}

export function cloudContactToAgentPeer(contact: Contact): DesktopCollaborationPeer {
  const accountId = contact.sourceParticipantId || contact.id.replace(/^cloud:/, '');
  const ownerName = cloudPeerDisplayName(contact);
  return {
    nodeId: accountId,
    displayName: cloudAgentDisplayName(contact),
    runtime: CLOUD_AGENT_RUNTIME,
    endpoint: CLOUD_SERVER_LABEL,
    ownerName,
    createdAt: null,
    sharedProjects: [],
    humanId: accountId,
    agentId: contact.sourceAgentId?.trim() || `cloud-agent:${accountId}`,
    isDefaultAgent: true,
    discoveryMode: 'contacts',
    humanVisibilityPolicy: 'server-approval',
    contactApprovalPolicy: 'approval-required',
    agentReachabilityPolicy: 'contacts',
    isContact: true,
    contactRequestStatus: 'accepted',
    contactRequestDirection: 'outgoing',
    profileImageUrl: contact.profileImageUrl,
    avatarSeed: contact.avatarSeed ?? accountId,
  };
}

export function cloudSelfContact(account: CloudAccount): Contact {
  const displayName = account.displayName?.trim() || account.primaryEmail?.trim() || 'Me';
  return {
    id: `cloud:${account.accountId}`,
    name: displayName,
    initials: displayName.slice(0, 2).toUpperCase(),
    classType: 'my-agents',
    entityType: 'My agent',
    subtitle: 'Private Cloud agent chat',
    collaborationSources: [CLOUD_HOST_SENTINEL],
    status: 'Owned',
    discoverableOn: [CLOUD_HOST_SENTINEL],
    detail: 'Chat privately with My Kordi',
    owner: 'Me',
    sourceHostId: CLOUD_HOST_SENTINEL,
    sourceParticipantId: account.accountId,
    sourceRuntime: CLOUD_AGENT_RUNTIME,
    sourceHumanId: account.accountId,
    sourceAgentId: 'cloud-local-agent',
    contactStatus: 'self',
    contactRequestDirection: null,
    avatarSeed: account.accountId,
    profileImageUrl: cloudAvatarImageUrl(account.avatarUrl),
  };
}
