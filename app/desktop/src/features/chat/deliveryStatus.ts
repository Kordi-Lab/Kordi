export type MessageDeliveryVisual = {
  glyph: 'single-check' | 'double-check' | 'clock' | 'spinner' | 'exclamation';
  tone: 'gray' | 'blue' | 'red';
  label: string;
  motion?: 'pulse';
};

export function messageDeliveryVisual(status?: string | null): MessageDeliveryVisual | null {
  const normalized = status?.trim().toLowerCase();
  if (!normalized) return null;

  if (normalized === 'read' || normalized === 'responded') {
    return { glyph: 'double-check', tone: 'gray', label: 'Read' };
  }
  if (normalized === 'delivered') {
    return { glyph: 'single-check', tone: 'gray', label: 'Delivered' };
  }
  if (normalized === 'sent') {
    return { glyph: 'single-check', tone: 'gray', label: 'Sent' };
  }
  if (normalized === 'sending' || normalized === 'pending_send') {
    return { glyph: 'clock', tone: 'gray', label: 'Sending', motion: 'pulse' };
  }
  if (normalized === 'processing' || normalized === 'awaiting reply' || normalized === 'handed_off_direct' || normalized === 'handed_off_mailbox') {
    return { glyph: 'spinner', tone: 'gray', label: 'Processing' };
  }
  if (normalized === 'failed' || normalized === 'processing_failed') {
    return { glyph: 'exclamation', tone: 'red', label: 'Sending failed' };
  }
  return null;
}
