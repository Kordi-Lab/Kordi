export const ATTACHMENT_MEDIA_ZOOM_MIN = 0.25;
export const ATTACHMENT_MEDIA_ZOOM_MAX = 4;
export const ATTACHMENT_MEDIA_ZOOM_STEP = 0.25;

export type AttachmentMediaZoomAction = 'in' | 'out' | 'reset';

export function attachmentMediaZoomActionForKey(event: {
  key: string;
  code?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
}): AttachmentMediaZoomAction | null {
  if (!event.metaKey && !event.ctrlKey) return null;
  if (event.key === '+' || event.key === '=' || event.code === 'Equal') return 'in';
  if (event.key === '-' || event.key === '_' || event.code === 'Minus') return 'out';
  if (event.key === '0' || event.code === 'Digit0') return 'reset';
  return null;
}

export function nextAttachmentMediaZoom(current: number, action: AttachmentMediaZoomAction) {
  if (action === 'reset') return 1;
  const delta = action === 'in' ? ATTACHMENT_MEDIA_ZOOM_STEP : -ATTACHMENT_MEDIA_ZOOM_STEP;
  return Math.min(ATTACHMENT_MEDIA_ZOOM_MAX, Math.max(ATTACHMENT_MEDIA_ZOOM_MIN, current + delta));
}
