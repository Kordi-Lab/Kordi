import { useCallback, useId, useState, useSyncExternalStore } from 'react';
import { FileText, LoaderCircle, X } from 'lucide-react';

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
import { downloadDesktopAttachment, openDesktopExternalUrl, storeDesktopChatAttachment } from '@/lib/desktop';
import type { MessageAttachment } from '../types';

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
    .filter((attachment) => attachment.kind === 'file')
    .map((attachment, index) => (
      <TranscriptFileAttachmentUploadAction
        key={attachment.localPath ?? attachment.attachmentId ?? `${attachment.name}:${index}`}
        attachment={attachment}
      />
    ));
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
          className="inline-flex items-center gap-1 text-[10px] font-medium text-[color:var(--utility-muted-text)]"
          aria-label={upload?.phase === 'preparing'
            ? 'Preparing attachment'
            : upload?.phase === 'finishing'
              ? 'Finishing attachment upload'
              : uploadPercent === null ? 'Sending attachment' : `Uploading attachment, ${uploadPercent}%`}
        >
          <LoaderCircle className="h-3 w-3 animate-spin" aria-hidden="true" />
          <span>{sendingLabel}</span>
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
