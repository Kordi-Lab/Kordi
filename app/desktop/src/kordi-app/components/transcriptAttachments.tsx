import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { convertFileSrc } from '@tauri-apps/api/core';
import { Check, CheckCheck, Download, ExternalLink, FileText, Image, LoaderCircle, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { displayAttachmentName } from '@/features/chat/composerAttachments';
import { defaultCloudAuthClient } from '@/features/cloud/authClient';
import {
  loadVisibleCloudAttachmentPreview,
  recoverCloudAttachmentPreview,
  type CloudAttachmentPreviewLease,
} from '@/features/cloud/cloudAttachments';
import { loadSession } from '@/features/cloud/session';
import { downloadDesktopAttachment, openDesktopExternalUrl, storeDesktopChatAttachment } from '@/lib/desktop';
import { cn } from '@/lib/utils';
import type { Message, MessageAttachment } from '../types';

const INLINE_ATTACHMENT_PREVIEW_MAX_BYTES = 10 * 1024 * 1024;
const ARCHIVE_ATTACHMENT_EXTENSIONS = new Set(['zip', '7z', 'rar', 'tar', 'gz', 'tgz', 'bz2', 'xz']);
const ATTACHMENT_PREVIEW_RECOVERY_RETRY_DELAY_MS = 30_000;
const recoveredAttachmentPreviewUrls = new Map<string, string>();
const recoveringAttachmentPreviewPromises = new Map<string, Promise<string | null>>();
const attachmentPreviewRecoveryRetryAfter = new Map<string, number>();

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
    attachment.previewAttachmentId ?? '',
    attachment.localPath ?? '',
    attachment.previewUrl ?? '',
    attachment.name ?? '',
    attachment.sizeBytes ?? '',
  ].join(':');
}

function safeAttachmentPreviewUrl(value?: string | null) {
  const trimmed = value?.trim() ?? '';
  if (!trimmed || isInternalObjectStoreUrl(trimmed)) return undefined;
  return trimmed;
}

function recoverableAttachmentId(attachment: MessageAttachment) {
  return attachment.attachmentId?.trim() || null;
}

type AttachmentPreviewRecoveryDependencies = {
  loadCloudSession?: () => Promise<{ token: string } | null>;
  recoverPreview?: typeof recoverCloudAttachmentPreview;
  now?: () => number;
  retryDelayMs?: number;
};

export function clearAttachmentPreviewRecoveryStateForTests() {
  recoveredAttachmentPreviewUrls.clear();
  recoveringAttachmentPreviewPromises.clear();
  attachmentPreviewRecoveryRetryAfter.clear();
}

export async function recoverAttachmentPreviewOnce(
  attachment: MessageAttachment,
  dependencies: AttachmentPreviewRecoveryDependencies = {},
) {
  const attachmentId = recoverableAttachmentId(attachment);
  if (!attachmentId) return null;
  const cached = recoveredAttachmentPreviewUrls.get(attachmentId);
  if (cached) return cached;
  const now = dependencies.now ?? Date.now;
  const retryAfter = attachmentPreviewRecoveryRetryAfter.get(attachmentId) ?? 0;
  if (retryAfter > now()) return null;
  attachmentPreviewRecoveryRetryAfter.delete(attachmentId);
  const existing = recoveringAttachmentPreviewPromises.get(attachmentId);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const session = await (dependencies.loadCloudSession ?? loadSession)();
      if (!session?.token) return null;
      const previewUrl = await (dependencies.recoverPreview ?? recoverCloudAttachmentPreview)({
        token: session.token,
        client: defaultCloudAuthClient(),
        attachment: {
          attachmentId,
          name: attachment.name,
          kind: attachment.kind,
          mimeType: attachment.mimeType ?? null,
          sizeBytes: attachment.sizeBytes ?? null,
          previewUrl: attachment.previewUrl ?? null,
        },
      });
      if (previewUrl) {
        recoveredAttachmentPreviewUrls.set(attachmentId, previewUrl);
        attachmentPreviewRecoveryRetryAfter.delete(attachmentId);
      } else {
        attachmentPreviewRecoveryRetryAfter.set(
          attachmentId,
          now() + Math.max(0, dependencies.retryDelayMs ?? ATTACHMENT_PREVIEW_RECOVERY_RETRY_DELAY_MS),
        );
      }
      return previewUrl;
    } catch {
      attachmentPreviewRecoveryRetryAfter.set(
        attachmentId,
        now() + Math.max(0, dependencies.retryDelayMs ?? ATTACHMENT_PREVIEW_RECOVERY_RETRY_DELAY_MS),
      );
      return null;
    } finally {
      recoveringAttachmentPreviewPromises.delete(attachmentId);
    }
  })();
  recoveringAttachmentPreviewPromises.set(attachmentId, promise);
  return promise;
}

function attachmentPreviewUrl(attachment: MessageAttachment) {
  if (!shouldPreviewAttachmentInline(attachment)) return undefined;
  const previewUrl = safeAttachmentPreviewUrl(attachment.previewUrl);
  if (previewUrl) return previewUrl;
  if (attachment.localPath && isNativeShell() && !isLargeAttachment(attachment)) {
    try {
      return convertFileSrc(attachment.localPath);
    } catch {
      return undefined;
    }
  }
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
  return attachment.kind === 'image'
    && !isArchiveAttachment(attachment)
    && (
      !isLargeAttachment(attachment)
      || Boolean(attachment.previewAttachmentId)
      || Boolean(safeAttachmentPreviewUrl(attachment.previewUrl))
    );
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

function AttachmentActions({ attachment, variant = 'icon' }: { attachment: MessageAttachment; variant?: 'icon' | 'menu' | 'original' }) {
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
    const menuButtonClass = 'app-transient-row flex w-full items-center gap-2 rounded-[10px] px-3 py-2 text-left text-[12px] transition disabled:cursor-not-allowed disabled:opacity-55';
    return (
      <div className="flex min-w-[170px] flex-col gap-1">
        <button
          type="button"
          onClick={() => void handleDownload()}
          disabled={isDownloading}
          className={menuButtonClass}
          aria-label={`Download ${attachment.name}`}
        >
          <Download className="h-3.5 w-3.5" />
          <span>{downloadedPath ? 'Download again' : 'Download'}</span>
        </button>
        {canOpen ? (
          <button
            type="button"
            onClick={() => void handleOpen()}
            className={menuButtonClass}
            aria-label={`Open ${attachment.name} with local app`}
          >
            <ExternalLink className="h-3.5 w-3.5" />
            <span>Open with local app</span>
          </button>
        ) : null}
        {isDownloading ? <span className="app-transient-muted px-3 pb-1 text-[10px]">Downloading…</span> : null}
        {downloadedPath && !isDownloading ? <span className="app-transient-muted px-3 pb-1 text-[10px]">Downloaded</span> : null}
        {error ? <span className="app-error-text max-w-[190px] px-3 pb-1 text-[10px] text-rose-300">{error}</span> : null}
      </div>
    );
  }

  const actionButtonClass = 'h-7 w-7 rounded-full p-0';

  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      <div className="flex items-center gap-1">
        <Button
          type="button"
          variant="quiet"
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
            variant="quiet"
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
      {error ? <span className="app-error-text max-w-[160px] text-right text-[10px] text-rose-300">{error}</span> : null}
    </div>
  );
}

function PortalLayer({ children }: { children: ReactNode }) {
  if (typeof document === 'undefined' || !document.body) return <>{children}</>;
  return createPortal(children, document.body);
}

type AttachmentContextMenuState = {
  attachment: MessageAttachment;
  x: number;
  y: number;
};

type AttachmentContextMenuHost = {
  contains: (target: Node | null) => boolean;
} | null;

export function shouldCloseAttachmentContextMenuForTarget(menuElement: AttachmentContextMenuHost, target: EventTarget | null) {
  if (!menuElement || !target) return true;
  if (typeof Node !== 'undefined' && !(target instanceof Node)) return true;
  return !menuElement.contains(target as Node);
}

function AttachmentContextMenu({ state, onClose }: { state: AttachmentContextMenuState; onClose: () => void }) {
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      if (shouldCloseAttachmentContextMenuForTarget(menuRef.current, event.target)) onClose();
    }

    window.addEventListener('pointerdown', handlePointerDown, true);
    return () => window.removeEventListener('pointerdown', handlePointerDown, true);
  }, [onClose]);

  return (
    <PortalLayer>
      <div
        ref={menuRef}
        data-attachment-image-context-menu="true"
        className="app-transient-surface fixed z-[230] rounded-[14px] border p-1.5"
        style={{ left: state.x, top: state.y }}
        onContextMenu={(event) => event.preventDefault()}
      >
        <AttachmentActions attachment={state.attachment} variant="menu" />
      </div>
    </PortalLayer>
  );
}

function isAttachmentSending(msg: Message) {
  return (msg.statusChips ?? []).some((chip) => {
    const normalized = chip.trim().toLowerCase();
    return normalized === 'sending' || normalized === 'pending';
  });
}

export type AttachmentImageDeliveryVisual = {
  kind: 'uploading' | 'delivering' | 'sent' | 'delivered' | 'partial' | 'failed';
  label: string;
};

export type AttachmentImageForegroundTone = 'light' | 'dark';

function linearSrgbChannel(channel: number) {
  const value = Math.min(255, Math.max(0, channel)) / 255;
  return value <= 0.04045
    ? value / 12.92
    : ((value + 0.055) / 1.055) ** 2.4;
}

export function attachmentImageForegroundToneFromRgba(
  pixels: ArrayLike<number>,
): AttachmentImageForegroundTone | null {
  let weightedLuminance = 0;
  let alphaWeight = 0;

  for (let index = 0; index + 3 < pixels.length; index += 4) {
    const alpha = Math.min(255, Math.max(0, pixels[index + 3] ?? 0)) / 255;
    if (alpha <= 0.02) continue;
    const luminance = (
      (0.2126 * linearSrgbChannel(pixels[index] ?? 0))
      + (0.7152 * linearSrgbChannel(pixels[index + 1] ?? 0))
      + (0.0722 * linearSrgbChannel(pixels[index + 2] ?? 0))
    );
    weightedLuminance += luminance * alpha;
    alphaWeight += alpha;
  }

  if (alphaWeight === 0) return null;
  return (weightedLuminance / alphaWeight) >= 0.179 ? 'dark' : 'light';
}

function sampleAttachmentImageForegroundTone(
  image: HTMLImageElement,
): AttachmentImageForegroundTone | null {
  const naturalWidth = image.naturalWidth;
  const naturalHeight = image.naturalHeight;
  if (!naturalWidth || !naturalHeight || typeof document === 'undefined') return null;

  const renderedWidth = image.clientWidth || naturalWidth;
  const renderedHeight = image.clientHeight || naturalHeight;
  if (!renderedWidth || !renderedHeight) return null;

  try {
    const objectFit = window.getComputedStyle(image).objectFit;
    const scale = objectFit === 'cover'
      ? Math.max(renderedWidth / naturalWidth, renderedHeight / naturalHeight)
      : Math.min(renderedWidth / naturalWidth, renderedHeight / naturalHeight);
    const objectWidth = naturalWidth * scale;
    const objectHeight = naturalHeight * scale;
    const objectLeft = (renderedWidth - objectWidth) / 2;
    const objectTop = (renderedHeight - objectHeight) / 2;
    const targetWidth = Math.min(renderedWidth, Math.max(64, renderedWidth * 0.4));
    const targetHeight = Math.min(renderedHeight, Math.max(28, renderedHeight * 0.18));
    const targetLeft = renderedWidth - targetWidth;
    const targetTop = renderedHeight - targetHeight;
    const sampleLeft = Math.max(targetLeft, objectLeft);
    const sampleTop = Math.max(targetTop, objectTop);
    const sampleRight = Math.min(renderedWidth, objectLeft + objectWidth);
    const sampleBottom = Math.min(renderedHeight, objectTop + objectHeight);
    const sampleDisplayWidth = sampleRight - sampleLeft;
    const sampleDisplayHeight = sampleBottom - sampleTop;
    if (
      sampleDisplayWidth <= 0
      || sampleDisplayHeight <= 0
      || (sampleDisplayWidth * sampleDisplayHeight) < (targetWidth * targetHeight * 0.5)
    ) {
      return null;
    }

    const sourceX = (sampleLeft - objectLeft) / scale;
    const sourceY = (sampleTop - objectTop) / scale;
    const sourceWidth = sampleDisplayWidth / scale;
    const sourceHeight = sampleDisplayHeight / scale;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.min(48, Math.round(sampleDisplayWidth)));
    canvas.height = Math.max(1, Math.min(24, Math.round(sampleDisplayHeight)));
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(
      image,
      sourceX,
      sourceY,
      sourceWidth,
      sourceHeight,
      0,
      0,
      canvas.width,
      canvas.height,
    );
    return attachmentImageForegroundToneFromRgba(
      context.getImageData(0, 0, canvas.width, canvas.height).data,
    );
  } catch {
    return null;
  }
}

export function attachmentImageDeliveryVisual(status?: string | null): AttachmentImageDeliveryVisual | null {
  const normalized = status?.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!normalized) return null;

  if (normalized === 'sending' || normalized === 'pending' || normalized === 'pending_send') {
    return { kind: 'uploading', label: 'Sending image' };
  }
  if (normalized === 'processing' || normalized === 'awaiting_reply') {
    return { kind: 'delivering', label: 'Delivering image' };
  }
  if (normalized === 'sent') {
    return { kind: 'sent', label: 'Sent' };
  }
  if (normalized === 'delivered' || normalized === 'read' || normalized === 'responded') {
    return { kind: 'delivered', label: normalized === 'delivered' ? 'Delivered' : 'Read' };
  }
  if (normalized === 'partial') {
    return { kind: 'partial', label: 'Partially delivered' };
  }
  if (normalized === 'failed' || normalized === 'processing_failed' || normalized === 'cancelled') {
    return { kind: 'failed', label: 'Sending failed' };
  }
  return null;
}

function adaptiveDeliveryOverlayClassName(foregroundTone: AttachmentImageForegroundTone | null) {
  return cn(
    'app-attachment-image-delivery-overlay',
    foregroundTone
      ? `app-attachment-image-delivery-foreground-${foregroundTone}`
      : 'app-attachment-image-delivery-adaptive',
  );
}

function AttachmentImageDeliveryOverlay({ status, time, foregroundTone, onRetry }: {
  status?: string | null;
  time?: string | null;
  foregroundTone: AttachmentImageForegroundTone | null;
  onRetry?: () => void;
}) {
  const visual = attachmentImageDeliveryVisual(status);
  if (!visual) return null;

  if (visual.kind === 'uploading') {
    return (
      <div
        data-attachment-image-delivery-status="uploading"
        className={adaptiveDeliveryOverlayClassName(foregroundTone)}
        role="status"
        aria-label={visual.label}
      >
        <div className="app-attachment-image-media-ring" aria-hidden="true">
          <div className="app-attachment-image-media-ring-spinner">
            <svg viewBox="0 0 32 32" focusable="false">
              <circle className="app-attachment-image-media-ring-track" cx="16" cy="16" r="12.5" />
              <circle className="app-attachment-image-media-ring-progress" cx="16" cy="16" r="12.5" />
            </svg>
          </div>
        </div>
      </div>
    );
  }

  if (visual.kind === 'delivering') {
    return (
      <div
        data-attachment-image-delivery-status="delivering"
        className={adaptiveDeliveryOverlayClassName(foregroundTone)}
        role="status"
        aria-label={visual.label}
      >
        <div className="app-attachment-image-delivery-meta">
          <span className="app-attachment-image-delivery-spinner" aria-hidden="true">
            <LoaderCircle className="h-3 w-3" />
          </span>
          <span>Delivering…</span>
        </div>
      </div>
    );
  }

  if (visual.kind === 'failed' || visual.kind === 'partial') {
    return (
      <div
        data-attachment-image-delivery-status={visual.kind}
        className="app-attachment-image-delivery-overlay"
        role="status"
        aria-label={visual.label}
        title={visual.label}
      >
        <div className="app-attachment-image-delivery-meta app-attachment-image-delivery-error">
          {onRetry ? (
            <button
              type="button"
              className="app-attachment-image-delivery-retry"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onRetry();
              }}
              aria-label="Retry sending image"
            >
              <span>{visual.kind === 'partial' ? 'Partial' : 'Failed'}</span>
              <span aria-hidden="true">·</span>
              <span className="app-attachment-image-delivery-retry-action">Retry</span>
            </button>
          ) : (
            <span>{visual.kind === 'partial' ? 'Partially delivered' : 'Failed'}</span>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      data-attachment-image-delivery-status={visual.kind}
      className={adaptiveDeliveryOverlayClassName(foregroundTone)}
      role="status"
      aria-label={visual.label}
    >
      <div className="app-attachment-image-delivery-meta">
        {time ? <span>{time}</span> : null}
        {visual.kind === 'delivered'
          ? <CheckCheck className="h-3.5 w-3.5" strokeWidth={2.25} aria-hidden="true" />
          : <Check className="h-3.5 w-3.5" strokeWidth={2.25} aria-hidden="true" />}
      </div>
    </div>
  );
}

function AttachmentSendingIndicator({ className }: { className?: string }) {
  return (
    <div
      data-attachment-sending-indicator="true"
      className={cn('pointer-events-none absolute right-2 top-2 z-10 inline-flex items-center gap-1.5 rounded-full bg-black/55 px-2.5 py-1 text-[10px] font-medium text-white/92 shadow-lg shadow-black/20 backdrop-blur-md', className)}
      aria-label="Sending attachment"
    >
      <LoaderCircle className="h-3 w-3 animate-spin" aria-hidden="true" />
      <span>Sending…</span>
    </div>
  );
}

function AttachmentFileCard({ attachment, index, isSending = false }: { attachment: MessageAttachment; index: number; isSending?: boolean }) {
  const sizeLabel = formatAttachmentSize(attachment.sizeBytes);
  const label = [attachment.formatLabel || (isArchiveAttachment(attachment) ? 'ARCHIVE' : 'FILE'), sizeLabel]
    .filter(Boolean)
    .join(' • ');
  const Icon = attachment.kind === 'image' ? Image : FileText;

  return (
    <div key={`${attachment.name}-${index}`} data-attachment-file-card="true" className="relative flex items-center gap-3 rounded-[14px] border border-white/10 bg-black/10 px-3 py-2.5">
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
      {isSending ? <AttachmentSendingIndicator /> : null}
    </div>
  );
}

function AttachmentImageLoadingSurface({ className }: { className?: string }) {
  return (
    <div
      data-attachment-image-loading="true"
      aria-label="Loading attached image"
      className={cn('relative flex h-full min-h-28 aspect-[4/3] overflow-hidden rounded-[15px] bg-black/[0.035]', className)}
    >
      <div className="absolute inset-0 bg-[linear-gradient(110deg,transparent_0%,rgba(255,255,255,0.10)_42%,transparent_74%)] opacity-70 motion-safe:animate-[app-attachment-shimmer_1.45s_ease-in-out_infinite]" aria-hidden="true" />
      <span className="sr-only">Loading attached image</span>
    </div>
  );
}

function AttachmentImageUnavailableSurface({ attachment }: { attachment: MessageAttachment }) {
  return (
    <div
      data-attachment-image-unavailable="true"
      className="app-attachment-image-fallback flex h-full min-h-28 aspect-[4/3] items-center gap-3 rounded-[15px] bg-black/[0.045] px-3 py-2.5"
      role="status"
    >
      <div className="app-attachment-image-fallback-icon flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-black/[0.06]">
        <Image className="h-4 w-4" aria-hidden="true" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="app-attachment-image-fallback-title truncate text-[12px] font-medium">{displayAttachmentName(attachment.name, attachment.kind)}</div>
        <div className="app-attachment-image-fallback-name mt-0.5 text-[10px] font-medium">Preview unavailable</div>
      </div>
      <AttachmentActions attachment={attachment} />
    </div>
  );
}

export function AttachmentImageLightbox({ attachment, previewUrl, onClose, onContextMenu }: {
  attachment: MessageAttachment;
  previewUrl: string;
  onClose: () => void;
  onContextMenu?: (event: MouseEvent) => void;
}) {
  return (
    <div
      data-attachment-image-lightbox="true"
      className="app-transient-overlay fixed inset-0 z-[220] flex items-center justify-center px-5 py-6 backdrop-blur-md"
      role="dialog"
      aria-modal="true"
      aria-label="Preview image"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div data-attachment-image-lightbox-panel="true" className="app-transient-surface relative flex max-h-full w-full max-w-5xl items-center justify-center overflow-hidden rounded-[24px] border p-2">
        <button
          type="button"
          onClick={onClose}
          className="app-button-quiet absolute right-3 top-3 z-10 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full p-0"
          aria-label="Close image preview"
        >
          <X className="h-4 w-4" />
        </button>
        <img
          src={previewUrl}
          alt={attachment.name || 'Attached image'}
          className="max-h-[min(84vh,940px)] max-w-full rounded-[18px] object-contain shadow-2xl shadow-black/35"
          title="Right-click for image actions"
          onContextMenu={onContextMenu}
        />
      </div>
    </div>
  );
}

function imageTileClass(index: number, totalCount: number) {
  if (totalCount <= 1) return 'col-span-6 row-span-3';
  if (totalCount === 2) return 'col-span-3 row-span-3';
  if (totalCount === 3) return index === 0 ? 'col-span-6 row-span-2' : 'col-span-3 row-span-2';
  if (totalCount === 4) return 'col-span-3 row-span-2';
  if (totalCount === 5) return index < 2 ? 'col-span-3 row-span-2' : 'col-span-2 row-span-2';
  if (totalCount === 6) return 'col-span-2 row-span-2';
  return index < 2 ? 'col-span-3 row-span-2' : 'col-span-2 row-span-2';
}

function AttachmentImageCard({
  attachment,
  index,
  totalCount,
  onOpenPreview,
  onOpenContextMenu,
  onImageForegroundTone,
}: {
  attachment: MessageAttachment;
  index: number;
  totalCount: number;
  onOpenPreview: (
    attachment: MessageAttachment,
    previewUrl: string,
    previewLease: CloudAttachmentPreviewLease | null,
  ) => void;
  onOpenContextMenu: (attachment: MessageAttachment, event: MouseEvent) => void;
  onImageForegroundTone?: (
    attachmentIdentity: string,
    tone: AttachmentImageForegroundTone | null,
  ) => void;
}) {
  const attachmentId = recoverableAttachmentId(attachment);
  const [recoveredPreviewUrl, setRecoveredPreviewUrl] = useState(() => attachmentId ? recoveredAttachmentPreviewUrls.get(attachmentId) ?? null : null);
  const [remotePreviewUrl, setRemotePreviewUrl] = useState<string | null>(null);
  const [failedPreviewUrls, setFailedPreviewUrls] = useState<string[]>([]);
  const [previewUnavailable, setPreviewUnavailable] = useState(false);
  const previewLeaseRef = useRef<CloudAttachmentPreviewLease | null>(null);
  const directPreviewUrl = attachmentPreviewUrl(attachment);
  const usableRecoveredPreviewUrl = recoveredPreviewUrl && !failedPreviewUrls.includes(recoveredPreviewUrl) ? recoveredPreviewUrl : null;
  const usableRemotePreviewUrl = remotePreviewUrl && !failedPreviewUrls.includes(remotePreviewUrl) ? remotePreviewUrl : null;
  const usableDirectPreviewUrl = directPreviewUrl && !failedPreviewUrls.includes(directPreviewUrl) ? directPreviewUrl : null;
  const previewUrl = usableRecoveredPreviewUrl ?? usableRemotePreviewUrl ?? usableDirectPreviewUrl;
  const [imageLoaded, setImageLoaded] = useState(() => Boolean(previewUrl?.startsWith('data:image/')));
  const displayName = displayAttachmentName(attachment.name, attachment.kind);
  const showImage = Boolean(previewUrl);
  const singleImage = totalCount <= 1;
  const showOriginalAction = showImage && isLargeAttachment(attachment);

  useEffect(() => {
    if (usableRecoveredPreviewUrl || usableRemotePreviewUrl || usableDirectPreviewUrl || previewUnavailable || attachment.kind !== 'image' || !attachmentId) return;
    const controller = new AbortController();
    void (async () => {
      const session = await loadSession();
      if (!session?.token || controller.signal.aborted) {
        if (!controller.signal.aborted) setPreviewUnavailable(true);
        return;
      }
      if (!attachment.previewAttachmentId) {
        const recoveredPreview = await recoverAttachmentPreviewOnce(attachment);
        if (controller.signal.aborted) return;
        if (recoveredPreview) {
          setRecoveredPreviewUrl(recoveredPreview);
          setPreviewUnavailable(false);
          return;
        }
      }
      const nextPreviewLease = await loadVisibleCloudAttachmentPreview({
        token: session.token,
        client: defaultCloudAuthClient(),
        attachment: {
          attachmentId: attachment.attachmentId ?? '',
          previewAttachmentId: attachment.previewAttachmentId ?? null,
          kind: 'image',
        },
        signal: controller.signal,
      });
      if (!nextPreviewLease) {
        setPreviewUnavailable(true);
        return;
      }
      if (controller.signal.aborted) {
        nextPreviewLease.release();
        return;
      }
      previewLeaseRef.current?.release();
      previewLeaseRef.current = nextPreviewLease;
      setRemotePreviewUrl(nextPreviewLease.previewUrl);
      setPreviewUnavailable(false);
    })()
      .catch((error) => {
        if (!controller.signal.aborted && (!(error instanceof Error) || error.name !== 'AbortError')) {
          setPreviewUnavailable(true);
        }
      });
    return () => controller.abort();
  }, [attachment, attachmentId, previewUnavailable, usableDirectPreviewUrl, usableRecoveredPreviewUrl, usableRemotePreviewUrl]);

  useEffect(() => {
    return () => {
      previewLeaseRef.current?.release();
      previewLeaseRef.current = null;
    };
  }, []);

  useEffect(() => {
    setImageLoaded(Boolean(previewUrl?.startsWith('data:image/')));
  }, [previewUrl]);

  return (
    <div
      key={`${attachment.name}-${index}`}
      data-attachment-image-card="true"
      data-attachment-image-context-target="true"
      className={cn('app-attachment-image-card app-attachment-image-tile relative overflow-hidden bg-transparent', imageTileClass(index, totalCount))}
      onContextMenu={(event) => onOpenContextMenu(attachment, event)}
    >
      {showImage && previewUrl ? (
        <button
          type="button"
          data-attachment-image-preview-trigger="true"
          title={`${displayName} · Right-click for image actions`}
          onClick={() => onOpenPreview(
            attachment,
            previewUrl,
            previewLeaseRef.current?.retain() ?? null,
          )}
          className="group relative block h-full w-full overflow-hidden text-left outline-none transition focus-visible:ring-2 focus-visible:ring-sky-400/70 focus-visible:ring-offset-1 focus-visible:ring-offset-black/20"
          aria-label={`Preview ${attachment.name || 'attached image'}`}
        >
          {!imageLoaded ? <AttachmentImageLoadingSurface className="absolute inset-0" /> : null}
          <img
            src={previewUrl}
            alt={attachment.name || 'Attached image'}
            className={cn(
              'relative block h-full w-full transition-opacity duration-200 ease-out motion-reduce:transition-none',
              imageLoaded ? 'opacity-100' : 'opacity-0',
              singleImage ? 'max-h-[320px] object-contain' : 'object-cover',
            )}
            onLoad={(event) => {
              setImageLoaded(true);
              onImageForegroundTone?.(
                attachmentPreviewIdentity(attachment),
                sampleAttachmentImageForegroundTone(event.currentTarget),
              );
            }}
            onError={() => {
              if (previewUrl) {
                setFailedPreviewUrls((current) => current.includes(previewUrl) ? current : [...current, previewUrl]);
              }
              setImageLoaded(false);
              previewLeaseRef.current?.release();
              previewLeaseRef.current = null;
              setRemotePreviewUrl(null);
              if (!attachmentId || (previewUrl !== directPreviewUrl && previewUrl !== recoveredPreviewUrl)) {
                setPreviewUnavailable(true);
              }
            }}
          />
        </button>
      ) : previewUnavailable ? (
        <AttachmentImageUnavailableSurface attachment={attachment} />
      ) : (
        <AttachmentImageLoadingSurface />
      )}
      {showOriginalAction ? (
        <div className="absolute bottom-2 right-2 z-10">
          <AttachmentActions attachment={attachment} variant="original" />
        </div>
      ) : null}
    </div>
  );
}

export function AttachmentPreview({
  msg,
  imageDeliveryStatus,
  onRetryImage,
}: {
  msg: Message;
  imageDeliveryStatus?: string | null;
  onRetryImage?: () => void;
}) {
  const attachments = msg.attachments ?? [];
  const previewImageAttachments = attachments.filter((attachment) => shouldPreviewAttachmentInline(attachment));
  const downloadableAttachments = attachments.filter((attachment) => !shouldPreviewAttachmentInline(attachment));
  const [lightboxAttachment, setLightboxAttachment] = useState<{
    attachment: MessageAttachment;
    previewUrl: string;
    previewLease: CloudAttachmentPreviewLease | null;
  } | null>(null);
  const lightboxPreviewLeaseRef = useRef<CloudAttachmentPreviewLease | null>(null);
  const [contextMenuState, setContextMenuState] = useState<AttachmentContextMenuState | null>(null);
  const [sampledForegroundTone, setSampledForegroundTone] = useState<{
    attachmentIdentity: string;
    tone: AttachmentImageForegroundTone | null;
  } | null>(null);
  const isSending = isAttachmentSending(msg);
  const resolvedImageDeliveryStatus = imageDeliveryStatus === undefined
    ? msg.statusChips?.[0] ?? null
    : imageDeliveryStatus;
  const loadingOnlyImageCollage = previewImageAttachments.length > 0
    && previewImageAttachments.every((attachment) => !attachmentPreviewUrl(attachment));
  const deliveryImageIdentity = previewImageAttachments.length > 0
    ? attachmentPreviewIdentity(previewImageAttachments[previewImageAttachments.length - 1]!)
    : null;
  const deliveryForegroundTone = sampledForegroundTone?.attachmentIdentity === deliveryImageIdentity
    ? sampledForegroundTone.tone
    : null;

  const updateImageForegroundTone = useCallback((
    attachmentIdentity: string,
    tone: AttachmentImageForegroundTone | null,
  ) => {
    setSampledForegroundTone((current) => (
      current?.attachmentIdentity === attachmentIdentity && current.tone === tone
        ? current
        : { attachmentIdentity, tone }
    ));
  }, []);

  const openLightbox = useCallback((
    attachment: MessageAttachment,
    previewUrl: string,
    previewLease: CloudAttachmentPreviewLease | null,
  ) => {
    const previousLease = lightboxPreviewLeaseRef.current;
    lightboxPreviewLeaseRef.current = previewLease;
    previousLease?.release();
    setLightboxAttachment({ attachment, previewUrl, previewLease });
  }, []);

  const closeLightbox = useCallback(() => {
    const previewLease = lightboxPreviewLeaseRef.current;
    lightboxPreviewLeaseRef.current = null;
    previewLease?.release();
    setLightboxAttachment(null);
  }, []);

  function openContextMenu(attachment: MessageAttachment, event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    setContextMenuState({ attachment, x: event.clientX, y: event.clientY });
  }

  useEffect(() => {
    if (!lightboxAttachment && !contextMenuState) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      closeLightbox();
      setContextMenuState(null);
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [closeLightbox, contextMenuState, lightboxAttachment]);

  useEffect(() => () => {
    lightboxPreviewLeaseRef.current?.release();
    lightboxPreviewLeaseRef.current = null;
  }, []);

  if (attachments.length === 0) {
    return null;
  }

  return (
    <>
      <div className="flex flex-col gap-2">
        {previewImageAttachments.length > 0 ? (
          <div
            data-attachment-image-collage="true"
            data-attachment-image-count={previewImageAttachments.length}
            className={cn(
              'app-attachment-image-collage relative grid max-w-[min(100%,29rem)] grid-cols-6 gap-0.5 overflow-hidden rounded-[20px] p-0',
              loadingOnlyImageCollage ? 'w-[min(100%,20rem)] auto-rows-[4rem]' : 'w-[min(100%,29rem)] auto-rows-[6.5rem]',
            )}
          >
            {previewImageAttachments.map((attachment, index) => (
              <AttachmentImageCard
                key={`${attachment.name}-${index}-${attachmentPreviewIdentity(attachment)}`}
                attachment={attachment}
                index={index}
                totalCount={previewImageAttachments.length}
                onOpenPreview={openLightbox}
                onOpenContextMenu={openContextMenu}
                onImageForegroundTone={index === previewImageAttachments.length - 1
                  ? updateImageForegroundTone
                  : undefined}
              />
            ))}
            <AttachmentImageDeliveryOverlay
              status={resolvedImageDeliveryStatus}
              time={msg.time}
              foregroundTone={deliveryForegroundTone}
              onRetry={onRetryImage}
            />
          </div>
        ) : null}
        {downloadableAttachments.length > 0 ? (
          <div className="flex flex-col gap-2">
            {downloadableAttachments.map((attachment, index) => (
              <AttachmentFileCard key={`${attachment.name}-${index}`} attachment={attachment} index={index} isSending={isSending} />
            ))}
          </div>
        ) : null}
      </div>
      {lightboxAttachment ? (
        <PortalLayer>
          <AttachmentImageLightbox
            attachment={lightboxAttachment.attachment}
            previewUrl={lightboxAttachment.previewUrl}
            onClose={closeLightbox}
            onContextMenu={(event) => openContextMenu(lightboxAttachment.attachment, event)}
          />
        </PortalLayer>
      ) : null}
      {contextMenuState ? (
        <AttachmentContextMenu state={contextMenuState} onClose={() => setContextMenuState(null)} />
      ) : null}
    </>
  );
}
