import { useState } from 'react';
import { ImagePlus, LoaderCircle } from 'lucide-react';

import { defaultCloudAuthClient } from '@/features/cloud/authClient';
import { loadSession } from '@/features/cloud/session';
import {
  addMediaToExpressiveMediaLibrary,
  expressiveMediaKindForFile,
  synchronizeExpressiveMediaLibrary,
  type ExpressiveMediaKind,
} from '@/features/emoji/expressiveMediaLibrary';
import { readDesktopChatAttachment } from '@/lib/desktop';
import type { MessageAttachment } from '../types';

export function AddAttachmentToMediaLibraryAction({
  attachment,
  onAdded,
}: {
  attachment: MessageAttachment;
  onAdded: () => void;
}) {
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mediaKind = expressiveMediaKindForFile({
    name: attachment.name,
    type: attachment.mimeType ?? '',
  });

  if (!mediaKind) return null;

  async function loadAttachmentData() {
    if (attachment.localPath) return readDesktopChatAttachment(attachment.localPath);
    if (attachment.attachmentId) {
      const session = await loadSession();
      if (!session?.token) throw new Error('Sign in to save this media.');
      const blob = await defaultCloudAuthClient().downloadAttachmentContent(session.token, attachment.attachmentId);
      return Array.from(new Uint8Array(await blob.arrayBuffer()));
    }
    const sourceUrl = attachment.downloadUrl ?? attachment.previewUrl;
    if (!sourceUrl) throw new Error('The original media is not available.');
    const response = await fetch(sourceUrl);
    if (!response.ok) throw new Error('Unable to download the original media.');
    return Array.from(new Uint8Array(await response.arrayBuffer()));
  }

  async function handleAddToLibrary(kind: ExpressiveMediaKind) {
    setIsSaving(true);
    setError(null);
    try {
      const session = await loadSession();
      if (!session?.token || !session.accountId) throw new Error('Sign in to save this media.');
      const data = await loadAttachmentData();
      await addMediaToExpressiveMediaLibrary({
        name: attachment.name,
        mimeType: attachment.mimeType ?? (kind === 'gif' ? 'image/gif' : ''),
        sizeBytes: attachment.sizeBytes ?? data.length,
        data,
        attachmentId: attachment.attachmentId,
      }, kind, { accountId: session.accountId });
      void synchronizeExpressiveMediaLibrary({
        accountId: session.accountId,
        token: session.token,
        client: defaultCloudAuthClient(),
      });
      onAdded();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Unable to save this media.');
    } finally {
      setIsSaving(false);
    }
  }

  const libraryName = mediaKind === 'gif' ? 'My GIFs' : 'My Stickers';
  return (
    <div className="flex min-w-[170px] flex-col">
      <button
        type="button"
        role="menuitem"
        onClick={() => void handleAddToLibrary(mediaKind)}
        disabled={isSaving}
        className="app-transient-flat-action app-transient-action-row flex w-full items-center gap-2.5 rounded-[10px] px-3 py-1.5 text-left transition disabled:cursor-wait disabled:opacity-55"
        aria-label={`Add ${attachment.name} to ${libraryName}`}
      >
        {isSaving ? <LoaderCircle className="app-transient-action-icon animate-spin" /> : <ImagePlus className="app-transient-action-icon" />}
        <span className="app-transient-action-label">Add to {libraryName}</span>
      </button>
      {error ? <span className="app-error-text app-transient-status max-w-[190px] px-2.5 pb-1 text-rose-300">{error}</span> : null}
    </div>
  );
}
