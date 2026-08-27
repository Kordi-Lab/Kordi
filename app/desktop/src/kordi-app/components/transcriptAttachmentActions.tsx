import { useState } from 'react';
import { Download, ExternalLink, LoaderCircle } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { defaultCloudAuthClient } from '@/features/cloud/authClient';
import {
  downloadCloudAttachmentToLocalPath,
  persistCloudAttachmentBytes,
} from '@/features/cloud/cloudAttachmentLocalPathCache';
import { loadSession } from '@/features/cloud/session';
import {
  downloadDesktopAttachment,
  openDesktopExternalUrl,
  storeDesktopChatAttachment,
} from '@/lib/desktop';
import type { MessageAttachment } from '../types';

function isNativeShell() {
  return typeof window !== 'undefined' && Boolean(window.__TAURI_INTERNALS__);
}

function formatAttachmentSize(sizeBytes?: number | null) {
  if (typeof sizeBytes !== 'number' || !Number.isFinite(sizeBytes) || sizeBytes < 0) return null;
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = sizeBytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

export function AttachmentActions({ attachment, variant = 'icon' }: {
  attachment: MessageAttachment;
  variant?: 'icon' | 'menu' | 'original';
}) {
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadedPath, setDownloadedPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canDownload = Boolean((attachment.localPath && isNativeShell()) || attachment.attachmentId);
  const canOpen = Boolean(((downloadedPath ?? attachment.localPath) && isNativeShell()));

  if (!canDownload && !canOpen) return null;

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
    setIsDownloading(true);
    setError(null);
    try {
      const localPath = await ensureLocalPath();
      if (!localPath) return;
      setDownloadedPath(await downloadDesktopAttachment(localPath, attachment.name));
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

  async function handleOpenOriginal() {
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
        <button type="button" role="menuitem" onClick={() => void handleDownload()} disabled={isDownloading} className={menuButtonClass} aria-label={`Download ${attachment.name}`}>
          <Download className="app-transient-action-icon" />
          <span className="app-transient-action-label">{downloadedPath ? 'Download again' : 'Download'}</span>
        </button>
        {canOpen ? (
          <button type="button" role="menuitem" onClick={() => void handleOpen()} className={menuButtonClass} aria-label={`Open ${attachment.name} with local app`}>
            <ExternalLink className="app-transient-action-icon" />
            <span className="app-transient-action-label">Open with local app</span>
          </button>
        ) : null}
        {isDownloading ? <span className="app-transient-muted app-transient-status px-2.5 pb-1">Downloading…</span> : null}
        {downloadedPath && !isDownloading ? <span className="app-transient-muted app-transient-status px-2.5 pb-1">Downloaded</span> : null}
        {error ? <span className="app-error-text app-transient-status max-w-[190px] px-2.5 pb-1 text-rose-300">{error}</span> : null}
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
      {error ? <span className="app-error-text max-w-[160px] text-right text-[10px] text-rose-300">{error}</span> : null}
    </div>
  );
}
