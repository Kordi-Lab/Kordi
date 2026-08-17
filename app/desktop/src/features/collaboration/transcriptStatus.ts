import type { DesktopCollaborationHost } from '@/kordi-app/types';

export function collaborationHostLabel(
  host?: DesktopCollaborationHost | null,
) {
  return host?.serverUrl?.replace(/^https?:\/\//, '') || 'Cloud';
}

export function collaborationOutboundStatusChip(
  deliveryState: string | null | undefined,
  agentHasBegunReply: boolean,
) {
  const normalized = deliveryState?.trim().toLowerCase();
  if (
    agentHasBegunReply
    && (!normalized
      || normalized === 'sent'
      || normalized === 'delivered'
      || normalized === 'processing')
  ) return 'read';
  if (
    normalized === 'processing'
    || normalized === 'handed_off_direct'
    || normalized === 'handed_off_mailbox'
  ) return 'read';
  return deliveryState || 'sent';
}
