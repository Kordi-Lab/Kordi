import { FolderOpen, LoaderCircle, MessageSquare, Share, Upload } from 'lucide-react';
import { useEffect, useState } from 'react';

import { AppDialog, AppDialogActions, AppDialogDescription, AppDialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

import type { DocumentShare } from './documentShareTypes';
import { DocumentSwitch } from './DocumentSwitch';

export type DocumentSharePopoverProps = {
  /** True until the Mac-hosted file has a cloud copy. */
  local: boolean;
  share: DocumentShare | null;
  agentName: string | null;
  title: string;
  uploading: boolean;
  busy: boolean;
  error: string | null;
  onUpload: () => void;
  onLinkOn: () => void;
  onLinkOff: () => void;
  onReadersCanAskAgent: (value: boolean) => void;
  /** Missing until the document is in the cloud. */
  onSendInKordi?: () => void;
  /** Missing for cloud-only documents. */
  onShowInFinder?: () => void;
};

function displayUrl(url: string) {
  return url.replace(/^https?:\/\//, '');
}

async function shareOrCopy(url: string, title: string) {
  const nav = globalThis.navigator as Navigator | undefined;
  if (nav?.share) {
    try {
      await nav.share({ url, title });
      return 'shared' as const;
    } catch {
      // Cancelling the share menu leaves the link where it was.
      return 'cancelled' as const;
    }
  }
  await nav?.clipboard?.writeText(url).catch(() => undefined);
  return 'copied' as const;
}

export function DocumentSharePopover({
  local,
  share,
  agentName,
  title,
  uploading,
  busy,
  error,
  onUpload,
  onLinkOn,
  onLinkOff,
  onReadersCanAskAgent,
  onSendInKordi,
  onShowInFinder,
}: DocumentSharePopoverProps) {
  const [confirmOff, setConfirmOff] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);

  const copyLink = () => {
    if (!share) return;
    void globalThis.navigator?.clipboard?.writeText(share.shareUrl).catch(() => undefined);
    setCopied(true);
  };

  return (
    <div className="app-document-share" role="dialog" aria-label="Share">
      {local ? (
        <button type="button" className="app-document-share-primary" disabled={uploading} onClick={onUpload}>
          {uploading ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : <Upload aria-hidden="true" />}
          {uploading ? 'Uploading' : 'Upload to Kordi'}
        </button>
      ) : (
        <>
          <div className="app-document-share-row">
            <span className="app-document-share-label">Anyone with the link</span>
            <DocumentSwitch
              checked={Boolean(share)}
              label="Anyone with the link"
              disabled={busy}
              onChange={(next) => (next ? onLinkOn() : setConfirmOff(true))}
            />
          </div>
          {share ? (
            <>
              <div className="app-document-share-row">
                <span className="app-document-share-url" title={share.shareUrl}>{displayUrl(share.shareUrl)}</span>
                <button type="button" className="app-document-share-copy" onClick={copyLink}>{copied ? 'Copied' : 'Copy'}</button>
              </div>
              <div className="app-document-share-row">
                <span className="app-document-share-label">Readers can ask {agentName ?? 'the agent'}</span>
                <DocumentSwitch
                  checked={share.readersCanAskAgent}
                  label={`Readers can ask ${agentName ?? 'the agent'}`}
                  disabled={busy}
                  onChange={onReadersCanAskAgent}
                />
              </div>
            </>
          ) : null}
        </>
      )}
      <hr />
      <button type="button" className="app-document-share-row is-action" disabled={!onSendInKordi} onClick={onSendInKordi}>
        <span className="app-document-share-icon is-kordi" aria-hidden="true"><MessageSquare /></span>
        <span className="app-document-share-label">Send in Kordi</span>
      </button>
      {!local ? (
        <button
          type="button"
          className="app-document-share-row is-action"
          disabled={!share}
          onClick={() => { if (share) void shareOrCopy(share.shareUrl, title).then((result) => { if (result === 'copied') setCopied(true); }); }}
        >
          <span className="app-document-share-icon is-link" aria-hidden="true"><Share /></span>
          <span className="app-document-share-label">Share link</span>
        </button>
      ) : null}
      {onShowInFinder ? (
        <button type="button" className="app-document-share-row is-action" onClick={onShowInFinder}>
          <span className="app-document-share-icon is-finder" aria-hidden="true"><FolderOpen /></span>
          <span className="app-document-share-label">Show in Finder</span>
        </button>
      ) : null}
      {error ? <div className="app-document-share-error" role="alert">{error}</div> : null}

      {confirmOff ? (
        <AppDialog titleId="document-link-off-title" descriptionId="document-link-off-description" onDismiss={() => setConfirmOff(false)} busy={busy}>
          <AppDialogTitle id="document-link-off-title">Turn off the link?</AppDialogTitle>
          <AppDialogDescription id="document-link-off-description">People in the session keep access.</AppDialogDescription>
          <AppDialogActions>
            <Button type="button" variant="quiet" onClick={() => setConfirmOff(false)}>Cancel</Button>
            <Button type="button" onClick={() => { setConfirmOff(false); onLinkOff(); }}>Turn off</Button>
          </AppDialogActions>
        </AppDialog>
      ) : null}
    </div>
  );
}
