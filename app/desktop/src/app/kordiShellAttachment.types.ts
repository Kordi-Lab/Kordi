import type { MutableRefObject } from 'react';

import type { AttachmentItem } from '@/features/chat/composerController.types';

export type KordiShellAttachmentArgs = {
  chatAttachmentInputRef: MutableRefObject<HTMLInputElement | null>;
  chatComposerAttachments: AttachmentItem[];
  saveDesktopAttachments: (files: File[]) => Promise<AttachmentItem[]>;
  saveDesktopAttachmentPaths: (paths?: string[]) => Promise<AttachmentItem[]>;
  removeChatComposerAttachment: (id: string) => void;
  updateChatComposerAttachment: (id: string, update: AttachmentItem) => void;
};
