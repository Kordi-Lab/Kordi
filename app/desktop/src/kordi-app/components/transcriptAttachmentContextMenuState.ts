import type { MessageAttachment } from '../types';

export type AttachmentContextMenuState = {
  attachment: MessageAttachment;
  x: number;
  y: number;
};

type AttachmentContextMenuHost = { contains: (target: Node | null) => boolean } | null;

export function shouldCloseAttachmentContextMenuForTarget(menuElement: AttachmentContextMenuHost, target: EventTarget | null) {
  if (!menuElement || !target) return true;
  if (typeof Node !== 'undefined' && !(target instanceof Node)) return true;
  return !menuElement.contains(target as Node);
}
