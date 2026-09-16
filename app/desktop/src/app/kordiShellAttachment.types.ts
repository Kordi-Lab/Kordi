import type { MutableRefObject } from 'react';

import type {
  AttachmentItem,
  AttachmentItemUpdate,
  SaveDesktopAttachmentOptions,
} from '@/features/chat/composerController.types';

export type KordiShellAttachmentArgs = {
  chatAttachmentInputRef: MutableRefObject<HTMLInputElement | null>;
  chatComposerAttachments: AttachmentItem[];
  saveDesktopAttachments: (
    files: File[],
    options?: SaveDesktopAttachmentOptions,
  ) => Promise<AttachmentItem[]>;
  saveDesktopAttachmentPaths: (paths?: string[]) => Promise<AttachmentItem[]>;
  removeChatComposerAttachment: (id: string) => void;
  updateChatComposerAttachment: (
    id: string,
    update: AttachmentItemUpdate,
  ) => void;
};
