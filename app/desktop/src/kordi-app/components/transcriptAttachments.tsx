import { useEffect, useMemo, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { Download, ExternalLink, FileText, Image, ImageOff } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { displayAttachmentName } from '@/features/chat/composerAttachments';
import { defaultCloudAuthClient } from '@/features/cloud/authClient';
import { loadSession } from '@/features/cloud/session';
import { downloadDesktopAttachment, openDesktopExternalUrl, storeDesktopChatAttachment } from '@/lib/desktop';
import { cn } from '@/lib/utils';
import type { Message, MessageAttachment } from '../types';

const INLINE_ATTACHMENT_PREVIEW_MAX_BYTES = 20 * 1024 * 1024;
const CLOUD_ATTACHMENT_AUTO_DOWNLOAD_MAX_BYTES = 20 * 1024 * 1024;
const ARCHIVE_ATTACHMENT_EXTENSIONS = new Set(['zip', '7z', 'rar', 'tar', 'gz', 'tgz', 'bz2', 'xz']);

function isNativeShell() {
  return typeof window !== 'undefined' && Boolean(window.__TAURI_INTERNALS__);
}

function isInternalObjectStoreUrl(value?: string | null) {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.hostname === 'minio.kordi-cloud.svc.cluster.local';
  } catch {
    return value.includes('minio.kordi-cloud.svc.cluster.local');
  }
}

function safeRemoteAttachmentUrl(value?: string | null) {
  const trimmed = value?.trim() || null;
  if (!trimmed || isInternalObjectStoreUrl(trimmed)) return null;
  return trimmed;
}

function attachmentPreviewUrl(attachment: MessageAttachment) {
  if (!shouldPreviewAttachmentInline(attachment)) return undefined;
  if (attachment.localPath && isNativeShell()) {
    try {
      return convertFileSrc(attachment.localPath);
    } catch {
      // fall through to a safe remote URL if one exists
    }
  }
  return safeRemoteAttachmentUrl(attachment.previewUrl) ?? undefined;
}

function attachmentExtension(attachment: MessageAttachment) {
  const candidate = attachment.name || attachment.localPath || '';
  const match = candidate.match(/\.([A-Za-z0-9]+)$/);
  return match?.[1]?.toLowerCase() ?? '';
}

function isArchiveAttachment(attachment: MessageAttachment) {
  return ARCHIVE_ATTACHMENT_EXTENSIONS.has(attachmentExtension(attachment));
}

function isLargeAttachment(attachment: MessageAttachment) {
  return typeof attachment.sizeBytes === 'number' && attachment.sizeBytes > INLINE_ATTACHMENT_PREVIEW_MAX_BYTES;
}

function shouldPreviewAttachmentInline(attachment: MessageAttachment) {
  return attachment.kind === 'image' && !isArchiveAttachment(attachment) && !isLargeAttachment(attachment);
}

function shouldAutoDownloadCloudAttachment(attachment: MessageAttachment) {
  if (!attachment.attachmentId || attachment.localPath || !isNativeShell()) return false;
  if (typeof attachment.sizeBytes === 'number' && attachment.sizeBytes > CLOUD_ATTACHMENT_AUTO_DOWNLOAD_MAX_BYTES) return false;
  return true;
}

function useAutoDownloadedCloudAttachment(attachment: MessageAttachment) {
  const [localPath, setLocalPath] = useState<string | null>(attachment.localPath ?? null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLocalPath(attachment.localPath ?? null);
  }, [attachment.attachmentId, attachment.localPath]);

  useEffect(() => {
    if (!shouldAutoDownloadCloudAttachment(attachment)) return;
    let cancelled = false;
    const attachmentId = attachment.attachmentId!;

    async function download() {
      setError(null);
      try {
        const session = await loadSession();
        if (!session?.token || cancelled) return;
        const blob = await defaultCloudAuthClient().downloadAttachmentContent(session.token, attachmentId);
        if (blob.size > CLOUD_ATTACHMENT_AUTO_DOWNLOAD_MAX_BYTES) return;
        const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
        if (cancelled) return;
        const storedPath = await storeDesktopChatAttachment(attachment.name || 'attachment.bin', bytes);
        if (!cancelled) setLocalPath(storedPath);
      } catch (downloadError) {
        if (!cancelled) {
          setError(downloadError instanceof Error ? downloadError.message : 'Unable to download attachment');
        }
      }
    }

    void download();
    return () => {
      cancelled = true;
    };
  }, [attachment.attachmentId, attachment.localPath, attachment.name, attachment.sizeBytes]);

  return useMemo(() => ({ localPath, error }), [localPath, error]);
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

function AttachmentActions({ attachment }: { attachment: MessageAttachment }) {
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadedPath, setDownloadedPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canOpen = Boolean(attachment.localPath && isNativeShell());

  if (!canOpen) {
    return null;
  }

  async function handleDownload() {
    if (!attachment.localPath) return;
    setIsDownloading(true);
    setError(null);
    try {
      const targetPath = await downloadDesktopAttachment(attachment.localPath, attachment.name);
      setDownloadedPath(targetPath);
    } catch (downloadError) {
      setError(downloadError instanceof Error ? downloadError.message : 'Unable to download attachment');
    } finally {
      setIsDownloading(false);
    }
  }

  async function handleOpen() {
    if (!attachment.localPath) return;
    setError(null);
    try {
      await openDesktopExternalUrl(downloadedPath ?? attachment.localPath);
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : 'Unable to open attachment');
    }
  }

  const actionButtonClass = 'h-7 w-7 rounded-full border-white/10 bg-white/5 p-0 text-slate-200 hover:bg-white/10';

  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      <div className="flex items-center gap-1">
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={() => void handleDownload()}
          disabled={isDownloading}
          className={actionButtonClass}
          aria-label={`Download ${attachment.name}`}
          title={downloadedPath ? 'Downloaded to Downloads' : 'Download'}
        >
          <Download className="h-3.5 w-3.5" />
        </Button>
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={() => void handleOpen()}
          className={actionButtonClass}
          aria-label={`Open ${attachment.name} with local app`}
          title="Open with local app"
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </Button>
      </div>
      {isDownloading ? <span className="text-[10px] text-slate-400">Downloading…</span> : null}
      {downloadedPath && !isDownloading ? <span className="text-[10px] text-slate-400">Downloaded</span> : null}
      {error ? <span className="max-w-[160px] text-right text-[10px] text-rose-300">{error}</span> : null}
    </div>
  );
}

function AttachmentFileCard({ attachment, index }: { attachment: MessageAttachment; index: number }) {
  const autoDownload = useAutoDownloadedCloudAttachment(attachment);
  const effectiveAttachment = useMemo(
    () => ({ ...attachment, localPath: autoDownload.localPath ?? attachment.localPath ?? null }),
    [attachment, autoDownload.localPath],
  );
  const sizeLabel = formatAttachmentSize(effectiveAttachment.sizeBytes);
  const label = [effectiveAttachment.formatLabel || (isArchiveAttachment(effectiveAttachment) ? 'ARCHIVE' : 'FILE'), sizeLabel]
    .filter(Boolean)
    .join(' • ');
  const Icon = effectiveAttachment.kind === 'image' ? Image : FileText;

  return (
    <div key={`${effectiveAttachment.name}-${index}`} className="flex items-center gap-3 rounded-[14px] border border-white/10 bg-black/10 px-3 py-2.5">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white/6 text-slate-200">
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12px] font-medium text-white/92">{effectiveAttachment.name}</div>
        <div className="mt-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-slate-400">
          {label || 'FILE'}
        </div>
      </div>
      <AttachmentActions attachment={effectiveAttachment} />
    </div>
  );
}

function BrokenImagePreview({ attachment }: { attachment: MessageAttachment }) {
  return (
    <div className="app-attachment-image-fallback flex h-36 flex-col items-center justify-center gap-2 bg-[radial-gradient(circle_at_top,rgba(148,163,184,0.16),rgba(15,23,42,0.58))] px-4 text-center">
      <div className="app-attachment-image-fallback-icon flex h-11 w-11 items-center justify-center rounded-2xl border border-white/10 bg-white/6 shadow-inner shadow-black/20">
        <ImageOff className="h-5 w-5" />
      </div>
      <div>
        <div className="app-attachment-image-fallback-title text-[12px] font-medium">Preview unavailable</div>
        <div className="app-attachment-image-fallback-name mt-0.5 max-w-[14rem] truncate text-[10px]">{displayAttachmentName(attachment.name, attachment.kind)}</div>
      </div>
    </div>
  );
}

function AttachmentImageCard({ attachment, index }: { attachment: MessageAttachment; index: number }) {
  const [previewFailed, setPreviewFailed] = useState(false);
  const autoDownload = useAutoDownloadedCloudAttachment(attachment);
  const effectiveAttachment = useMemo(
    () => ({ ...attachment, localPath: autoDownload.localPath ?? attachment.localPath ?? null }),
    [attachment, autoDownload.localPath],
  );
  const previewUrl = attachmentPreviewUrl(effectiveAttachment);
  const sizeLabel = formatAttachmentSize(effectiveAttachment.sizeBytes);
  const metadataLabel = [sizeLabel, effectiveAttachment.formatLabel].filter(Boolean).join(' • ');
  const showImage = Boolean(previewUrl && !previewFailed);

  return (
    <div key={`${effectiveAttachment.name}-${index}`} className="app-attachment-image-card overflow-hidden rounded-[16px] border border-white/10 bg-black/10">
      {showImage ? (
        <img
          src={previewUrl}
          alt={effectiveAttachment.name || 'Attached image'}
          className="block max-h-[320px] w-full object-cover"
          onError={() => setPreviewFailed(true)}
        />
      ) : (
        <BrokenImagePreview attachment={effectiveAttachment} />
      )}
      <div className="app-attachment-image-footer flex items-center justify-between gap-2 px-3 py-2 text-[11px]">
        <span className="min-w-0 truncate text-[10px] font-medium uppercase tracking-[0.14em]">
          {metadataLabel || 'IMAGE'}
        </span>
        <AttachmentActions attachment={effectiveAttachment} />
      </div>
    </div>
  );
}

export function AttachmentPreview({ msg }: { msg: Message }) {
  const attachments = msg.attachments ?? [];
  const previewImageAttachments = attachments.filter((attachment) => shouldPreviewAttachmentInline(attachment));
  const downloadableAttachments = attachments.filter((attachment) => !shouldPreviewAttachmentInline(attachment));

  if (attachments.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-2">
      {previewImageAttachments.length > 0 ? (
        <div className={cn('grid gap-2', previewImageAttachments.length > 1 ? 'sm:grid-cols-2' : 'grid-cols-1')}>
          {previewImageAttachments.map((attachment, index) => (
            <AttachmentImageCard key={`${attachment.name}-${index}`} attachment={attachment} index={index} />
          ))}
        </div>
      ) : null}
      {downloadableAttachments.length > 0 ? (
        <div className="flex flex-col gap-2">
          {downloadableAttachments.map((attachment, index) => (
            <AttachmentFileCard key={`${attachment.name}-${index}`} attachment={attachment} index={index} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
