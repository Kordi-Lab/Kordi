import type { ContactRequest } from '@/kordi-app/types';

import type { CloudContactRequest } from './authClient';
import { cloudAvatarImageUrl, cloudAvatarSeedForAccount } from './avatar';
import { CLOUD_HOST_SENTINEL, cloudContactInitials } from './cloudContactMapping';
import { formatKordiHandle } from './kordiId';

export function isPendingIncomingCloudContactRequest(request: Pick<ContactRequest, 'direction' | 'status'>): boolean {
  return request.direction === 'incoming' && request.status === 'pending';
}

export function cloudRequestToContactRequest(row: CloudContactRequest): ContactRequest {
  const counterpartKordiHandle = formatKordiHandle(row.counterpart?.kordiId);
  const counterpartName = row.counterpart?.displayName?.trim() || counterpartKordiHandle || 'Kordi user';
  const counterpartId = row.direction === 'incoming' ? row.fromAccountId : row.toAccountId;
  const title = row.direction === 'incoming'
    ? `${counterpartName} wants to connect`
    : `Request sent to ${counterpartName}`;
  return {
    id: `cloud:${row.requestId}`,
    initials: cloudContactInitials(counterpartName),
    title,
    detail: row.message?.trim() || counterpartKordiHandle || 'Kordi ID unavailable',
    time: row.createdAt,
    profileImageUrl: cloudAvatarImageUrl(row.counterpart?.avatarUrl),
    avatarSeed: cloudAvatarSeedForAccount(counterpartId, row.counterpart?.avatarUrl),
    avatarName: counterpartName,
    source: 'collaboration',
    sourceHostId: CLOUD_HOST_SENTINEL,
    sourceRequestId: row.requestId,
    requesterNodeId: row.fromAccountId,
    targetNodeId: row.toAccountId,
    status: row.status,
    direction: row.direction,
  };
}
