import type { DesktopBridgeState } from '@/kordi-app/types';

export type ResolvedMentionedBridgeTarget = {
  host: DesktopBridgeState['hosts'][number];
  peer: DesktopBridgeState['hosts'][number]['visiblePeers'][number];
  label: string;
  targetKind: 'bridge-person' | 'bridge-agent';
  requestText: string;
};

export type PendingBridgeOutreach = {
  conversationId: string;
  requestId?: string | null;
  parentSessionId: string;
};
