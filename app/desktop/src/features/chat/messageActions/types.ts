import type { DesktopCollaborationState } from '@/kordi-app/types';

export type ResolvedMentionedCollaborationTarget = {
  host: DesktopCollaborationState['hosts'][number];
  peer: DesktopCollaborationState['hosts'][number]['visiblePeers'][number];
  label: string;
  displayLabel: string;
  targetKind: 'person' | 'agent';
  requestText: string;
};

export type PendingCollaborationOutreach = {
  conversationId: string;
  requestId?: string | null;
  parentSessionId: string;
};
