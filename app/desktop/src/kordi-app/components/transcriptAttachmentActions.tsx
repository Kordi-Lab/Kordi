import { useState } from 'react';
import { Copy, Download, ExternalLink, LoaderCircle } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { ErrorLine } from '@/components/ui/ErrorLine';
import { copyAttachmentImage } from '@/features/chat/attachmentImageClipboard';
import { defaultCloudAuthClient } from '@/features/cloud/authClient';
import {
  downloadCloudAttachmentToLocalPath,
  persistCloudAttachmentBytes,
} from '@/features/cloud/cloudAttachmentLocalPathCache';
import { loadSession } from '@/features/cloud/session';
import { openAttachmentInCompanion } from '@/features/documents/companionDocument';
import {
  downloadDesktopAttachment,
  openDesktopExternalUrl,
  storeDesktopChatAttachment,
} from '@/lib/desktop';
import type { MessageAttachment } from '../types';
import { formatAttachmentSize } from './transcriptAttachmentTypes';

function isNativeShell() {
  return typeof window !== 'undefined' && Boolean(window.__TAURI_INTERNALS__);
}

export function AttachmentActions({ attachment, variant = 'icon' }: {
  attachment: MessageAttachment;
  variant?: 'icon' | 'menu' | 'original';
}) {
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadedPath, setDownloadedPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copying' | 'copied'>('idle');
  const canDownload = Boolean((attachment.localPath && isNativeShell()) || attachment.attachmentId);
  const canOpen = Boolean(((downloadedPath ?? attachment.localPath) && isNativeShell()));
  const canCopy = attachment.kind === 'image'
    && Boolean(attachment.localPath || attachment.attachmentId || attachment.downloadUrl);

  if (!canDownload && !canOpen && !(variant === 'menu' && canCopy)) return null;

  async function handleCopy() {
    setCopyStatus('copying');
    setError(null);
    try {
      await copyAttachmentImage(attachment);
      setCopyStatus('copied');
    } catch (copyError) {
      setCopyStatus('idle');
      setError(copyError instanceof Error ? copyError.message : 'Unable to copy image.');
    }
  }

  async function ensureLocalPath() {
    if (attachment.localPath) return attachment.localPath;
    if (!attachment.attachmentId) return null;
    const session = await loadSession();
    if (!session?.token) throw new Error('Not signed in.');
    if (isNativeShell()) {
      return downloadCloudAttachmentToLocalPath(
        session.token,
        attachment.attachmentId,
        attachment.name || 'attachment.bin',
      );
    }
    const blob = await defaultCloudAuthClient().downloadAttachmentContent(session.token, attachment.attachmentId);
    const cached = await persistCloudAttachmentBytes(
      attachment.attachmentId,
      attachment.name || 'attachment.bin',
      blob,
    );
    if (cached) return cached;
    const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
    return storeDesktopChatAttachment(attachment.name || 'attachment.bin', bytes);
  }

  async function handleDownload() {
    // Markdown and HTML cloud attachments open in the chat's document pane instead.
    if (openAttachmentInCompanion(attachment)) return;
    setIsDownloading(true);
    setError(null);
    try {
      const localPath = await ensureLocalPath();
      if (!localPath) return;
      if (attachment.livePhoto) {
        const session = await loadSession();
        if (!session?.token) throw new Error('Sign in to download the Live Photo originals.');
        const video = attachment.livePhoto.video;
        const videoPath = await downloadCloudAttachmentToLocalPath(session.token, video.attachmentId, video.name);
        await downloadDesktopAttachment(videoPath, attachment.name.replace(/\.[^.]+$/, '') + '.mov');
      }
      setDownloadedPath(await downloadDesktopAttachment(localPath, attachment.name));
    } catch (downloadError) {
      setError(downloadError instanceof Error ? downloadError.message : 'Unable to download attachment');
    } finally {
      setIsDownloading(false);
    }
  }

  async function handleOpen() {
    if (openAttachmentInCompanion(attachment)) return;
    const target = downloadedPath ?? attachment.localPath;
    if (!target) return;
    setError(null);
    try {
      await openDesktopExternalUrl(target);
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : 'Unable to open attachment');
    }
  }

  async function handleOpenOriginal() {
    if (openAttachmentInCompanion(attachment)) return;
    setIsDownloading(true);
    setError(null);
    try {
      const localPath = await ensureLocalPath();
      if (!localPath) return;
      setDownloadedPath(localPath);
      if (isNativeShell()) await openDesktopExternalUrl(localPath);
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : 'Unable to open original attachment');
    } finally {
      setIsDownloading(false);
    }
  }

  if (variant === 'original') {
    const sizeLabel = formatAttachmentSize(attachment.sizeBytes);
    return (
      <button
        type="button"
        data-attachment-original-action="true"
        onClick={(event) => {
          event.stopPropagation();
          void handleOpenOriginal();
        }}
        disabled={isDownloading}
        className="inline-flex items-center gap-1.5 rounded-full bg-black/55 px-2.5 py-1 text-[10px] font-semibold text-white/92 shadow-lg shadow-black/20 backdrop-blur-md transition hover:bg-black/65 disabled:cursor-wait disabled:opacity-70"
        aria-label={`Open original ${attachment.name}`}
      >
        {isDownloading ? <LoaderCircle className="h-3 w-3 animate-spin" /> : <ExternalLink className="h-3 w-3" />}
        <span>Open original</span>
        {sizeLabel ? <span className="font-medium opacity-75">{sizeLabel}</span> : null}
      </button>
    );
  }

  if (variant === 'menu') {
    const menuButtonClass = 'app-transient-flat-action app-transient-action-row flex w-full items-center gap-2.5 rounded-[10px] px-3 py-1.5 text-left transition disabled:cursor-not-allowed disabled:opacity-55';
    return (
      <div className="flex min-w-[170px] flex-col">
        {canCopy ? (
          <button type="button" role="menuitem" onClick={() => void handleCopy()} disabled={copyStatus === 'copying'} className={menuButtonClass} aria-label={`Copy image ${attachment.name}`}>
            <Copy className="app-transient-action-icon" />
            <span role="status" className="app-transient-action-label">{copyStatus === 'copying' ? 'Copying…' : copyStatus === 'copied' ? 'Copied' : 'Copy image'}</span>
          </button>
        ) : null}
        {canDownload ? <button type="button" role="menuitem" onClick={() => void handleDownload()} disabled={isDownloading} className={menuButtonClass} aria-label={`Download ${attachment.name}`}>
          <Download className="app-transient-action-icon" />
          <span className="app-transient-action-label">{attachment.livePhoto ? 'Download Live Photo originals' : downloadedPath ? 'Download again' : 'Download'}</span>
        </button> : null}
        {canOpen ? (
          <button type="button" role="menuitem" onClick={() => void handleOpen()} className={menuButtonClass} aria-label={`Open ${attachment.name} with local app`}>
            <ExternalLink className="app-transient-action-icon" />
            <span className="app-transient-action-label">Open with local app</span>
          </button>
        ) : null}
        {isDownloading ? <span className="app-transient-muted app-transient-status px-2.5 pb-1">Downloading…</span> : null}
        {downloadedPath && !isDownloading ? <span className="app-transient-muted app-transient-status px-2.5 pb-1">Downloaded</span> : null}
        {error ? <ErrorLine className="mt-0 max-w-[190px] px-2.5 pb-1">{error}</ErrorLine> : null}
      </div>
    );
  }

  const actionButtonClass = 'h-7 w-7 rounded-full p-0';
  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      <div className="flex items-center gap-1">
        <Button type="button" variant="quiet" size="icon" onClick={() => void handleDownload()} disabled={isDownloading} className={actionButtonClass} aria-label={`Download ${attachment.name}`} title={downloadedPath ? 'Downloaded to Downloads' : 'Download'}>
          <Download className="h-3.5 w-3.5" />
        </Button>
        {canOpen ? (
          <Button type="button" variant="quiet" size="icon" onClick={() => void handleOpen()} className={actionButtonClass} aria-label={`Open ${attachment.name} with local app`} title="Open with local app">
            <ExternalLink className="h-3.5 w-3.5" />
          </Button>
        ) : null}
      </div>
      {isDownloading ? <span className="text-[10px] text-slate-400">Downloading…</span> : null}
      {downloadedPath && !isDownloading ? <span className="text-[10px] text-slate-400">Downloaded</span> : null}
      {error ? <ErrorLine align="end" className="mt-0 max-w-[160px]">{error}</ErrorLine> : null}
    </div>
  );
}
