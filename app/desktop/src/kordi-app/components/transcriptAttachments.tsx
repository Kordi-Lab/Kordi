import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { convertFileSrc } from '@tauri-apps/api/core';
import { Download, ExternalLink, FileText, Image, LoaderCircle, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { displayAttachmentName } from '@/features/chat/composerAttachments';
import { defaultCloudAuthClient } from '@/features/cloud/authClient';
import {
  loadVisibleCloudAttachmentPreview,
  type CloudAttachmentPreviewLease,
} from '@/features/cloud/cloudAttachments';
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
    attachment.previewAttachmentId ?? '',
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
  return attachment.kind === 'image'
    && !isArchiveAttachment(attachment)
    && (!isLargeAttachment(attachment) || Boolean(attachment.previewAttachmentId));
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

function AttachmentActions({ attachment, variant = 'icon' }: { attachment: MessageAttachment; variant?: 'icon' | 'menu' }) {
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

  if (variant === 'menu') {
    const menuButtonClass = 'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[12px] text-slate-100 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-55';
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
        {isDownloading ? <span className="px-3 pb-1 text-[10px] text-slate-400">Downloading…</span> : null}
        {downloadedPath && !isDownloading ? <span className="px-3 pb-1 text-[10px] text-slate-400">Downloaded</span> : null}
        {error ? <span className="app-error-text max-w-[190px] px-3 pb-1 text-[10px] text-rose-300">{error}</span> : null}
      </div>
    );
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
        className="fixed z-[230] rounded-[14px] border border-white/12 bg-slate-950/94 p-1.5 shadow-[0_18px_55px_rgba(0,0,0,0.38)] backdrop-blur-xl"
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
    <div key={`${attachment.name}-${index}`} className="relative flex items-center gap-3 rounded-[14px] border border-white/10 bg-black/10 px-3 py-2.5">
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
      className={cn('relative flex h-full min-h-28 overflow-hidden rounded-[15px] bg-black/[0.035]', className)}
    >
      <div className="absolute inset-0 bg-[linear-gradient(110deg,transparent_0%,rgba(255,255,255,0.10)_42%,transparent_74%)] opacity-70 motion-safe:animate-[app-attachment-shimmer_1.45s_ease-in-out_infinite]" aria-hidden="true" />
      <span className="sr-only">Loading attached image</span>
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
      className="fixed inset-0 z-[220] flex items-center justify-center bg-black/72 px-5 py-6 backdrop-blur-md"
      role="dialog"
      aria-modal="true"
      aria-label="Preview image"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div data-attachment-image-lightbox-panel="true" className="relative flex max-h-full w-full max-w-5xl items-center justify-center overflow-hidden rounded-[24px] bg-transparent">
        <button
          type="button"
          onClick={onClose}
          className="absolute right-3 top-3 z-10 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-black/45 text-white/90 shadow-lg shadow-black/25 backdrop-blur-md transition hover:bg-black/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/70"
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

function AttachmentImageCard({ attachment, index, totalCount, onOpenPreview, onOpenContextMenu }: {
  attachment: MessageAttachment;
  index: number;
  totalCount: number;
  onOpenPreview: (
    attachment: MessageAttachment,
    previewUrl: string,
    previewLease: CloudAttachmentPreviewLease | null,
  ) => void;
  onOpenContextMenu: (attachment: MessageAttachment, event: MouseEvent) => void;
}) {
  const [previewFailed, setPreviewFailed] = useState(false);
  const [imageLoaded, setImageLoaded] = useState(false);
  const [remotePreviewUrl, setRemotePreviewUrl] = useState<string | null>(null);
  const previewLeaseRef = useRef<CloudAttachmentPreviewLease | null>(null);
  const previewUrl = remotePreviewUrl ?? attachmentPreviewUrl(attachment);
  const displayName = displayAttachmentName(attachment.name, attachment.kind);
  const showImage = Boolean(previewUrl && !previewFailed);
  const singleImage = totalCount <= 1;

  useEffect(() => {
    if (attachmentPreviewUrl(attachment) || attachment.kind !== 'image' || !attachment.attachmentId) return;
    const controller = new AbortController();
    void loadSession()
      .then((session) => {
        if (!session?.token || controller.signal.aborted) return null;
        return loadVisibleCloudAttachmentPreview({
          token: session.token,
          client: defaultCloudAuthClient(),
          attachment: {
            attachmentId: attachment.attachmentId ?? '',
            previewAttachmentId: attachment.previewAttachmentId ?? null,
            kind: 'image',
          },
          signal: controller.signal,
        });
      })
      .then((nextPreviewLease) => {
        if (!nextPreviewLease) return;
        if (controller.signal.aborted) {
          nextPreviewLease.release();
          return;
        }
        previewLeaseRef.current?.release();
        previewLeaseRef.current = nextPreviewLease;
        setRemotePreviewUrl(nextPreviewLease.previewUrl);
      })
      .catch((error) => {
        if (!controller.signal.aborted && (!(error instanceof Error) || error.name !== 'AbortError')) {
          setPreviewFailed(true);
        }
      });
    return () => {
      controller.abort();
      previewLeaseRef.current?.release();
      previewLeaseRef.current = null;
    };
  }, [attachment.attachmentId, attachment.kind, attachment.previewAttachmentId]);

  return (
    <div
      key={`${attachment.name}-${index}`}
      data-attachment-image-card="true"
      data-attachment-image-context-target="true"
      className={cn('app-attachment-image-card app-attachment-image-tile overflow-hidden bg-transparent', imageTileClass(index, totalCount))}
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
            onLoad={() => setImageLoaded(true)}
            onError={() => {
              previewLeaseRef.current?.release();
              previewLeaseRef.current = null;
              setRemotePreviewUrl(null);
              setPreviewFailed(true);
            }}
          />
        </button>
      ) : (
        <AttachmentImageLoadingSurface />
      )}
    </div>
  );
}

export function AttachmentPreview({ msg }: { msg: Message }) {
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
  const isSending = isAttachmentSending(msg);

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
            className="relative grid max-w-[min(100%,29rem)] grid-cols-6 auto-rows-[6.5rem] gap-0.5 overflow-hidden rounded-[20px] p-0"
          >
            {previewImageAttachments.map((attachment, index) => (
              <AttachmentImageCard
                key={`${attachment.name}-${index}-${attachmentPreviewIdentity(attachment)}`}
                attachment={attachment}
                index={index}
                totalCount={previewImageAttachments.length}
                onOpenPreview={openLightbox}
                onOpenContextMenu={openContextMenu}
              />
            ))}
            {isSending ? <AttachmentSendingIndicator /> : null}
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
