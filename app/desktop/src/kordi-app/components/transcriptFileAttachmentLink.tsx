import { useState } from 'react';
import { FileText, LoaderCircle } from 'lucide-react';

import { defaultCloudAuthClient } from '@/features/cloud/authClient';
import { loadSession } from '@/features/cloud/session';
import { downloadDesktopAttachment, openDesktopExternalUrl, storeDesktopChatAttachment } from '@/lib/desktop';
import type { MessageAttachment } from '../types';

function isNativeShell() {
  return typeof window !== 'undefined' && Boolean(window.__TAURI_INTERNALS__);
}

export function TranscriptFileAttachmentLink({
  attachment,
  isSending = false,
}: {
  attachment: MessageAttachment;
  isSending?: boolean;
}) {
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadedPath, setDownloadedPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canDownload = Boolean((attachment.localPath && isNativeShell()) || attachment.attachmentId);
  const canOpen = Boolean((downloadedPath ?? attachment.localPath) && isNativeShell());

  async function ensureLocalPath() {
    if (attachment.localPath) return attachment.localPath;
    if (!attachment.attachmentId) return null;
    const session = await loadSession();
    if (!session?.token) throw new Error('Not signed in.');
    const blob = await defaultCloudAuthClient().downloadAttachmentContent(session.token, attachment.attachmentId);
    const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
    return storeDesktopChatAttachment(attachment.name || 'attachment.bin', bytes);
  }

  async function handleDownload() {
    setIsDownloading(true);
    setError(null);
    try {
      const localPath = await ensureLocalPath();
      if (!localPath) return;
      const targetPath = await downloadDesktopAttachment(localPath, attachment.name);
      setDownloadedPath(targetPath);
    } catch (downloadError) {
      setError(downloadError instanceof Error ? downloadError.message : 'Unable to download attachment');
    } finally {
      setIsDownloading(false);
    }
  }

  async function handleOpen() {
    const target = downloadedPath ?? attachment.localPath;
    if (!target) return;
    setError(null);
    try {
      await openDesktopExternalUrl(target);
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : 'Unable to open attachment');
    }
  }

  const isActionable = canDownload || canOpen;
  const linkContent = (
    <>
      <FileText className="h-3 w-3 shrink-0" strokeWidth={1.8} aria-hidden="true" />
      <span className="truncate">{attachment.name}</span>
    </>
  );

  return (
    <div
      data-attachment-file-link="true"
      className="flex max-w-full flex-wrap items-center gap-x-2 gap-y-1 text-[11px]"
    >
      {isActionable ? (
        <button
          type="button"
          onClick={() => void (canOpen ? handleOpen() : handleDownload())}
          disabled={isDownloading}
          className="app-markdown-link inline-flex max-w-full items-center gap-1 bg-transparent p-0 text-left font-medium disabled:cursor-wait disabled:opacity-65"
          aria-label={`${canOpen ? 'Open' : 'Download'} ${attachment.name}`}
          title={`${canOpen ? 'Open' : 'Download'} ${attachment.name}`}
        >
          {linkContent}
        </button>
      ) : (
        <span className="inline-flex max-w-full items-center gap-1 text-[color:var(--utility-muted-text)]">
          {linkContent}
        </span>
      )}
      {isSending ? (
        <span
          data-attachment-sending-indicator="true"
          className="pointer-events-none inline-flex items-center gap-1 text-[10px] font-medium text-[color:var(--utility-muted-text)]"
          aria-label="Sending attachment"
        >
          <LoaderCircle className="h-3 w-3 animate-spin" aria-hidden="true" />
          <span>Sending…</span>
        </span>
      ) : null}
      {isDownloading ? (
        <span className="inline-flex items-center gap-1 text-[10px] text-[color:var(--utility-muted-text)]">
          <LoaderCircle className="h-3 w-3 animate-spin" aria-hidden="true" />
          Downloading…
        </span>
      ) : null}
      {downloadedPath && !isDownloading ? (
        <span className="text-[10px] text-[color:var(--utility-muted-text)]">Downloaded</span>
      ) : null}
      {error ? <span className="app-error-text text-[10px] text-rose-400">{error}</span> : null}
    </div>
  );
}
