import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

import { cn } from '@/lib/utils';

const FADE_MS = 180;

/** "Invite link copied" with Share…, or "Copy invite link" when the copy was refused.
 * It fades after `durationMs`, and stays while the pointer or focus is on it. */
export function GroupInviteNotice({ url, copied: copiedAtStart, durationMs, onDismiss }: {
  url: string;
  copied: boolean;
  durationMs: number;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(copiedAtStart);
  const [held, setHeld] = useState(false);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (held) return undefined;
    const fade = setTimeout(() => setLeaving(true), durationMs);
    return () => clearTimeout(fade);
  }, [held, copied, durationMs]);
  useEffect(() => {
    if (!leaving) return undefined;
    const gone = setTimeout(onDismiss, FADE_MS);
    return () => clearTimeout(gone);
  }, [leaving, onDismiss]);

  if (typeof document === 'undefined') return null;
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
  const hold = () => { setHeld(true); setLeaving(false); };
  const copy = () => {
    void navigator.clipboard?.writeText(url).then(() => setCopied(true), () => undefined);
  };

  return createPortal(
    <div
      className={cn('app-copy-toast app-invite-toast', !copied && 'app-invite-toast-action-first')}
      role="status"
      aria-live="polite"
      data-leaving={leaving || undefined}
      onPointerEnter={hold}
      onPointerLeave={() => setHeld(false)}
      onFocus={hold}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setHeld(false); }}
    >
      {copied
        ? <span>Invite link copied</span>
        : <button type="button" className="app-toast-action" onClick={copy}>Copy invite link</button>}
      {canShare ? (
        <>
          <span aria-hidden="true" className="app-invite-toast-divider" />
          <button type="button" className="app-toast-action" onClick={() => { void navigator.share({ url }).catch(() => undefined); }}>Share…</button>
        </>
      ) : null}
    </div>,
    document.querySelector('.kordi-app') ?? document.body,
  );
}
