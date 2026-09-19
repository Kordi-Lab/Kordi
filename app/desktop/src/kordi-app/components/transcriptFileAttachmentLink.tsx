import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { Check, Copy, Download, FolderOpen, LoaderCircle, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  AppDialog,
  AppDialogActions,
  AppDialogDescription,
  AppDialogTitle,
} from '@/components/ui/dialog';
import { defaultCloudAuthClient } from '@/features/cloud/authClient';
import { downloadCloudAttachmentToLocalPath } from '@/features/cloud/cloudAttachmentLocalPathCache';
import {
  cancelCloudAttachmentUpload,
  cloudAttachmentUploadSnapshot,
  subscribeCloudAttachmentUpload,
} from '@/features/cloud/cloudAttachmentUpload';
import { loadSession } from '@/features/cloud/session';
import { isMp4VideoAttachment } from '@/features/chat/attachmentMediaGallery';
import { attachmentFileFamily, attachmentFileTileLabel, splitAttachmentName } from '@/features/chat/attachmentFileFamily';
import { attachmentFormatLabel } from '@/features/chat/composerAttachments';
import {
  downloadDesktopAttachment,
  openDesktopExternalUrl,
  revealDesktopAttachment,
  saveDesktopAttachmentAs,
  storeDesktopChatAttachment,
} from '@/lib/desktop';
import type { MessageAttachment } from '../types';
import { formatAttachmentSize } from './transcriptAttachmentTypes';

function isNativeShell() {
  return typeof window !== 'undefined' && Boolean(window.__TAURI_INTERNALS__);
}

function useAttachmentUpload(localPath: string) {
  const subscribe = useCallback(
    (listener: () => void) => subscribeCloudAttachmentUpload(localPath, listener),
    [localPath],
  );
  const snapshot = useCallback(
    () => cloudAttachmentUploadSnapshot(localPath),
    [localPath],
  );
  return useSyncExternalStore(subscribe, snapshot, () => null);
}

function TranscriptFileAttachmentUploadAction({ attachment }: { attachment: MessageAttachment }) {
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const titleId = useId();
  const localPath = attachment.localPath?.trim() ?? '';
  const upload = useAttachmentUpload(localPath);
  const canCancel = upload && ['preparing', 'uploading', 'finishing'].includes(upload.phase);
  if (!canCancel) return null;

  return (
    <>
      <Button
        type="button"
        variant="quiet"
        size="icon"
        data-message-upload-cancel-button="true"
        data-message-transfer-action-side="opposite-avatar"
        className="app-message-transfer-action mb-0.5 h-7 w-7 shrink-0 self-end rounded-full p-0 text-rose-500"
        onClick={() => setConfirmingCancel(true)}
        aria-label={`Cancel upload of ${attachment.name}`}
        title="Cancel upload"
      >
        <X className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
      </Button>
      {confirmingCancel ? (
        <AppDialog titleId={titleId} onDismiss={() => setConfirmingCancel(false)} className="max-w-sm rounded-[20px]">
          <AppDialogTitle id={titleId}>Cancel upload?</AppDialogTitle>
          <AppDialogDescription>
            Uploaded parts will be discarded. You can retry this message later.
          </AppDialogDescription>
          <AppDialogActions>
            <Button variant="quiet" className="rounded-full px-4" autoFocus onClick={() => setConfirmingCancel(false)}>
              Keep uploading
            </Button>
            <Button
              className="rounded-full bg-rose-600 px-4 text-white hover:bg-rose-500"
              onClick={() => {
                setConfirmingCancel(false);
                void cancelCloudAttachmentUpload(localPath);
              }}
            >
              Cancel upload
            </Button>
          </AppDialogActions>
        </AppDialog>
      ) : null}
    </>
  );
}

export function TranscriptFileAttachmentUploadActions({
  attachments,
}: {
  attachments: readonly MessageAttachment[];
}) {
  return attachments
    .filter((attachment) => attachment.kind === 'file' && !isMp4VideoAttachment(attachment))
    .map((attachment, index) => (
      <TranscriptFileAttachmentUploadAction
        key={attachment.localPath ?? attachment.attachmentId ?? `${attachment.name}:${index}`}
        attachment={attachment}
      />
    ));
}

async function copyTextToClipboard(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  document.body.removeChild(textarea);
}

function FileMenuAction({ icon: Icon, label, busy = false, onClick }: {
  icon: typeof FolderOpen;
  label: string;
  busy?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={busy}
      onClick={onClick}
      className="app-transient-flat-action app-transient-action-row flex w-full items-center gap-2.5 rounded-[10px] px-3 py-1.5 text-left transition disabled:cursor-wait disabled:opacity-55"
    >
      {busy
        ? <LoaderCircle className="app-transient-action-icon animate-spin" />
        : <Icon className="app-transient-action-icon" />}
      <span className="app-transient-action-label">{label}</span>
    </button>
  );
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
  const localPath = attachment.localPath?.trim() ?? '';
  const upload = useAttachmentUpload(localPath);
  const uploadPercent = upload && upload.totalBytes > 0
    ? Math.min(100, Math.floor((upload.uploadedBytes / upload.totalBytes) * 100))
    : null;
  const sendingLabel = upload?.phase === 'preparing'
    ? 'Preparing…'
    : upload?.phase === 'uploading' && uploadPercent !== null
      ? `Uploading ${uploadPercent}%`
      : upload?.phase === 'finishing'
        ? 'Finishing…'
      : 'Sending…';

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

  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [menuAction, setMenuAction] = useState<'reveal' | 'save' | null>(null);
  const [menuNotice, setMenuNotice] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const closeMenu = useCallback(() => {
    setMenu(null);
    setMenuAction(null);
    setMenuNotice(null);
  }, []);

  function openMenu(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    setMenuNotice(null);
    setMenu({ x: event.clientX, y: event.clientY });
  }

  useEffect(() => {
    if (!menu) return;
    function handlePointerDown(event: PointerEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) closeMenu();
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') closeMenu();
    }
    window.addEventListener('pointerdown', handlePointerDown, true);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown, true);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [closeMenu, menu]);

  async function handleRevealInFinder() {
    setMenuAction('reveal');
    setMenuNotice(null);
    try {
      const target = await ensureLocalPath();
      if (!target) throw new Error('Attachment is not available locally.');
      await revealDesktopAttachment(target);
      closeMenu();
    } catch (revealError) {
      setMenuNotice(revealError instanceof Error ? revealError.message : 'Unable to show in Finder');
    } finally {
      setMenuAction(null);
    }
  }

  async function handleSaveAs() {
    setMenuAction('save');
    setMenuNotice(null);
    try {
      const target = await ensureLocalPath();
      if (!target) throw new Error('Attachment is not available locally.');
      const savedPath = await saveDesktopAttachmentAs(target, attachment.name);
      if (savedPath) {
        setDownloadedPath(savedPath);
        closeMenu();
      }
    } catch (saveError) {
      setMenuNotice(saveError instanceof Error ? saveError.message : 'Unable to save attachment');
    } finally {
      setMenuAction(null);
    }
  }

  async function handleCopyFilename() {
    try {
      await copyTextToClipboard(attachment.name);
      setMenuNotice('Copied');
      window.setTimeout(closeMenu, 600);
    } catch {
      setMenuNotice('Unable to copy');
    }
  }

  const isActionable = canDownload || canOpen;
  const family = attachmentFileFamily(attachment);
  const typeLabel = attachmentFormatLabel(attachment.name, attachment.mimeType ?? undefined);
  const tileLabel = attachmentFileTileLabel(typeLabel);
  const sizeLabel = formatAttachmentSize(attachment.sizeBytes);
  const busy = isSending || isDownloading;
  const { base: nameBase, extension: nameExtension } = splitAttachmentName(attachment.name);
  const chipContent = (
    <>
      <span className="app-attachment-file-tile" aria-hidden="true">{tileLabel}</span>
      <span className="app-attachment-file-body">
        <span className="app-attachment-file-name">
          <span className="app-attachment-file-name-base">{nameBase}</span>
          {nameExtension ? <span className="app-attachment-file-name-ext">{nameExtension}</span> : null}
        </span>
        <span className="app-attachment-file-sub">
          <span className="app-attachment-file-type">{typeLabel}</span>
          {isSending ? (
            <>
              <span className="app-attachment-file-dot" aria-hidden="true" />
              <span
                data-attachment-sending-indicator="true"
                className="app-attachment-file-sending"
                aria-label={upload?.phase === 'preparing'
                  ? 'Preparing attachment'
                  : upload?.phase === 'finishing'
                    ? 'Finishing attachment upload'
                    : uploadPercent === null ? 'Sending attachment' : `Uploading attachment, ${uploadPercent}%`}
              >
                {sendingLabel}
              </span>
            </>
          ) : sizeLabel ? (
            <>
              <span className="app-attachment-file-dot" aria-hidden="true" />
              {sizeLabel}
            </>
          ) : null}
        </span>
      </span>
      <span className="app-attachment-file-action" aria-hidden="true">
        {busy
          ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
          : downloadedPath
            ? <Check className="h-3.5 w-3.5" strokeWidth={2.4} />
            : <Download className="h-3.5 w-3.5" strokeWidth={1.9} />}
      </span>
    </>
  );

  return (
    <div className="app-attachment-file-stack">
      {isActionable ? (
        <button
          type="button"
          data-attachment-file-chip="true"
          data-file-family={family}
          data-downloaded={downloadedPath ? 'true' : undefined}
          onClick={() => void (canOpen ? handleOpen() : handleDownload())}
          onContextMenu={openMenu}
          disabled={isDownloading}
          className="app-attachment-file-chip"
          aria-label={`${canOpen ? 'Open' : 'Download'} ${attachment.name}`}
          title={`${canOpen ? 'Open' : 'Download'} ${attachment.name} · Right-click for file actions`}
        >
          {chipContent}
        </button>
      ) : (
        <span
          data-attachment-file-chip="true"
          data-file-family={family}
          onContextMenu={openMenu}
          className="app-attachment-file-chip app-attachment-file-chip-static"
        >
          {chipContent}
        </span>
      )}
      {error ? <span className="app-error-text app-attachment-file-status">{error}</span> : null}
      {menu && typeof document !== 'undefined' && document.body
        ? createPortal(
          <div
            ref={menuRef}
            data-attachment-file-menu="true"
            className="app-transient-surface fixed z-[230] rounded-[14px] border p-1.5"
            style={{ left: menu.x, top: menu.y }}
            onContextMenu={(event) => event.preventDefault()}
          >
            <div className="flex min-w-[180px] flex-col">
              <FileMenuAction
                icon={FolderOpen}
                label="Show in Finder"
                busy={menuAction === 'reveal'}
                onClick={() => void handleRevealInFinder()}
              />
              <FileMenuAction
                icon={Download}
                label="Save As…"
                busy={menuAction === 'save'}
                onClick={() => void handleSaveAs()}
              />
              <FileMenuAction
                icon={Copy}
                label="Copy Filename"
                onClick={() => void handleCopyFilename()}
              />
              {menuNotice ? (
                <span className="app-transient-muted px-2.5 pb-1 text-[10px]">{menuNotice}</span>
              ) : null}
            </div>
          </div>,
          document.body,
        )
        : null}
    </div>
  );
}
