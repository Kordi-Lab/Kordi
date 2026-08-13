type AttachmentImageLightboxMediaHost = {
  contains: (target: Node | null) => boolean;
} | null;

export function shouldDismissAttachmentImageLightboxForTarget(
  mediaElement: AttachmentImageLightboxMediaHost,
  target: EventTarget | null,
) {
  if (!target) return true;
  if (typeof Node === 'undefined' || !(target instanceof Node)) return true;
  if (mediaElement?.contains(target)) return false;
  return !(typeof Element !== 'undefined'
    && target instanceof Element
    && target.closest('[data-attachment-image-lightbox-control="true"]'));
}
