import { useEffect, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { Download, ExternalLink, FileText, Image, ImageOff, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { displayAttachmentName } from '@/features/chat/composerAttachments';
import { defaultCloudAuthClient } from '@/features/cloud/authClient';
import { loadSession } from '@/features/cloud/session';
import { downloadDesktopAttachment, openDesktopExternalUrl, storeDesktopChatAttachment } from '@/lib/desktop';
import { cn } from '@/lib/utils';
import type { Message, MessageAttachment } from '../types';

const INLINE_ATTACHMENT_PREVIEW_MAX_BYTES = 10 * 1024 * 1024;
const ARCHIVE_ATTACHMENT_EXTENSIONS = new Set(['zip', '7z', 'rar', 'tar', 'gz', 'tgz', 'bz2', 'xz']);

function isNativeShell() {
  return typeof window !== 'undefined' && Boolean(window.__TAURI_INTERNALS__);
}

function isInternalObjectStoreUrl(value?: string | null) {
  if (!value) return false;
  try {
    return new URL(value).hostname === 'minio.kordi-cloud.svc.cluster.local';
  } catch {
    return value.includes('minio.kordi-cloud.svc.cluster.local');
  }
}

export function attachmentPreviewIdentity(attachment: MessageAttachment) {
  return [
    attachment.attachmentId ?? '',
    attachment.localPath ?? '',
    attachment.previewUrl ?? '',
    attachment.name ?? '',
    attachment.sizeBytes ?? '',
  ].join(':');
}

function attachmentPreviewUrl(attachment: MessageAttachment) {
  if (!shouldPreviewAttachmentInline(attachment)) return undefined;
  if (attachment.localPath && isNativeShell()) {
    try {
      return convertFileSrc(attachment.localPath);
    } catch {
      return undefined;
    }
  }
  if (attachment.previewUrl && !isInternalObjectStoreUrl(attachment.previewUrl)) return attachment.previewUrl;
  return undefined;
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
  const canDownload = Boolean((attachment.localPath && isNativeShell()) || attachment.attachmentId);
  const canOpen = Boolean(((downloadedPath ?? attachment.localPath) && isNativeShell()));

  if (!canDownload && !canOpen) {
    return null;
  }

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
        {canOpen ? (
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
        ) : null}
      </div>
      {isDownloading ? <span className="text-[10px] text-slate-400">Downloading…</span> : null}
      {downloadedPath && !isDownloading ? <span className="text-[10px] text-slate-400">Downloaded</span> : null}
      {error ? <span className="max-w-[160px] text-right text-[10px] text-rose-300">{error}</span> : null}
    </div>
  );
}

function AttachmentFileCard({ attachment, index }: { attachment: MessageAttachment; index: number }) {
  const sizeLabel = formatAttachmentSize(attachment.sizeBytes);
  const label = [attachment.formatLabel || (isArchiveAttachment(attachment) ? 'ARCHIVE' : 'FILE'), sizeLabel]
    .filter(Boolean)
    .join(' • ');
  const Icon = attachment.kind === 'image' ? Image : FileText;

  return (
    <div key={`${attachment.name}-${index}`} className="flex items-center gap-3 rounded-[14px] border border-white/10 bg-black/10 px-3 py-2.5">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white/6 text-slate-200">
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12px] font-medium text-white/92">{attachment.name}</div>
        <div className="mt-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-slate-400">
          {label || 'FILE'}
        </div>
      </div>
      <AttachmentActions attachment={attachment} />
    </div>
  );
}

function BrokenImagePreview({ attachment }: { attachment: MessageAttachment }) {
  return (
    <div className="app-attachment-image-fallback flex h-28 flex-col items-center justify-center gap-2 rounded-[15px] border border-dashed border-current/18 bg-current/[0.035] px-4 text-center">
      <div className="app-attachment-image-fallback-icon flex h-9 w-9 items-center justify-center rounded-2xl border border-current/12 bg-current/[0.04]">
        <ImageOff className="h-4 w-4" />
      </div>
      <div>
        <div className="app-attachment-image-fallback-title text-[11px] font-medium">Preview unavailable</div>
        <div className="app-attachment-image-fallback-name mt-0.5 max-w-[13rem] truncate text-[10px]">{displayAttachmentName(attachment.name, attachment.kind)}</div>
      </div>
    </div>
  );
}

export function AttachmentImageLightbox({ attachment, previewUrl, onClose }: {
  attachment: MessageAttachment;
  previewUrl: string;
  onClose: () => void;
}) {
  return (
    <div
      data-attachment-image-lightbox="true"
      className="fixed inset-0 z-[220] flex items-center justify-center bg-black/72 px-5 py-6 backdrop-blur-md"
      role="dialog"
      aria-modal="true"
      aria-label="Preview image"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-full w-full max-w-5xl flex-col overflow-hidden rounded-[24px] border border-white/14 bg-slate-950/92 shadow-[0_30px_90px_rgba(0,0,0,0.48)]">
        <div className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-3 text-slate-100">
          <div className="min-w-0">
            <div className="truncate text-[13px] font-medium">{displayAttachmentName(attachment.name, attachment.kind)}</div>
            <div className="mt-0.5 text-[10px] uppercase tracking-[0.14em] text-slate-400">Image preview</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/8 text-slate-200 transition hover:bg-white/14 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/70"
            aria-label="Close image preview"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex min-h-0 flex-1 items-center justify-center bg-black/24 p-3">
          <img
            src={previewUrl}
            alt={attachment.name || 'Attached image'}
            className="max-h-[min(78vh,900px)] max-w-full rounded-[16px] object-contain shadow-2xl shadow-black/30"
          />
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-white/10 px-4 py-3 text-slate-200">
          <AttachmentActions attachment={attachment} />
        </div>
      </div>
    </div>
  );
}

function AttachmentImageCard({ attachment, index, onOpenPreview }: {
  attachment: MessageAttachment;
  index: number;
  onOpenPreview: (attachment: MessageAttachment, previewUrl: string) => void;
}) {
  const [previewFailed, setPreviewFailed] = useState(false);
  const previewUrl = attachmentPreviewUrl(attachment);
  const sizeLabel = formatAttachmentSize(attachment.sizeBytes);
  const metadataLabel = [sizeLabel, attachment.formatLabel].filter(Boolean).join(' • ');
  const displayName = displayAttachmentName(attachment.name, attachment.kind);
  const showImage = Boolean(previewUrl && !previewFailed);

  return (
    <div
      key={`${attachment.name}-${index}`}
      data-attachment-image-card="true"
      className="app-attachment-image-card overflow-hidden rounded-[18px] border border-current/10 bg-current/[0.025] p-1.5 shadow-[0_10px_28px_rgba(2,8,23,0.10)]"
    >
      {showImage && previewUrl ? (
        <button
          type="button"
          data-attachment-image-preview-trigger="true"
          onClick={() => onOpenPreview(attachment, previewUrl)}
          className="group block w-full overflow-hidden rounded-[14px] bg-black/5 text-left outline-none transition focus-visible:ring-2 focus-visible:ring-sky-400/70"
          aria-label={`Preview ${attachment.name || 'attached image'}`}
        >
          <img
            src={previewUrl}
            alt={attachment.name || 'Attached image'}
            className="block max-h-[320px] w-full object-contain transition duration-150 group-hover:scale-[1.01]"
            onError={() => setPreviewFailed(true)}
          />
        </button>
      ) : (
        <BrokenImagePreview attachment={attachment} />
      )}
      <div className="mt-1.5 flex items-center justify-between gap-2 px-1 text-[10px] text-current/62">
        <span className="min-w-0 truncate">{displayName}</span>
        <div className="flex shrink-0 items-center gap-2">
          {metadataLabel ? <span className="whitespace-nowrap uppercase tracking-[0.12em]">{metadataLabel}</span> : null}
          <AttachmentActions attachment={attachment} />
        </div>
      </div>
    </div>
  );
}

export function AttachmentPreview({ msg }: { msg: Message }) {
  const attachments = msg.attachments ?? [];
  const previewImageAttachments = attachments.filter((attachment) => shouldPreviewAttachmentInline(attachment));
  const downloadableAttachments = attachments.filter((attachment) => !shouldPreviewAttachmentInline(attachment));
  const [lightboxAttachment, setLightboxAttachment] = useState<{ attachment: MessageAttachment; previewUrl: string } | null>(null);

  useEffect(() => {
    if (!lightboxAttachment) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setLightboxAttachment(null);
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [lightboxAttachment]);

  if (attachments.length === 0) {
    return null;
  }

  return (
    <>
      <div className="flex flex-col gap-2">
        {previewImageAttachments.length > 0 ? (
          <div className={cn('grid gap-2', previewImageAttachments.length > 1 ? 'sm:grid-cols-2' : 'grid-cols-1')}>
            {previewImageAttachments.map((attachment, index) => (
              <AttachmentImageCard
                key={`${attachment.name}-${index}-${attachmentPreviewIdentity(attachment)}`}
                attachment={attachment}
                index={index}
                onOpenPreview={(nextAttachment, previewUrl) => setLightboxAttachment({ attachment: nextAttachment, previewUrl })}
              />
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
      {lightboxAttachment ? (
        <AttachmentImageLightbox
          attachment={lightboxAttachment.attachment}
          previewUrl={lightboxAttachment.previewUrl}
          onClose={() => setLightboxAttachment(null)}
        />
      ) : null}
    </>
  );
}
