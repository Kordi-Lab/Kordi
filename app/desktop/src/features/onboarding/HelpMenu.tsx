import { useId, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ArrowRight, CircleHelp, Play, ShieldCheck, X } from 'lucide-react';
import { AppDialog, AppDialogTitle, type AppDialogAnchor } from '@/components/ui/dialog';
import { cloudApiBaseUrl, defaultCloudAuthClient } from '@/features/cloud/authClient';
import { useCloudAuthCapabilitiesState } from '@/features/cloud/cloudAuthCapabilities';
import { isNativeDesktopShell } from '@/lib/desktop';
import { HelpPermissions } from './HelpPermissions';
import { HelpReleaseNotes } from './HelpReleaseNotes';
import { nativeMacPermissions } from './permissionAccess';
import { readHelpProgress } from './helpProgress';
import type { HelpAction } from './helpContent';
import '@/styles/help.css';

export type HelpMenuProps = {
  progressKey: string;
  settingsAvailable: boolean;
  supportAvailable: boolean;
  onAction: (action: HelpAction) => Promise<void> | void;
  onOpenSession: (id: string) => void;
  onDismiss: () => void;
  onStartTour: () => void;
  anchor: AppDialogAnchor | null;
  initialView?: 'home' | 'permissions';
};

export default function HelpMenu({ progressKey, settingsAvailable, supportAvailable, onAction, onOpenSession, onDismiss, onStartTour, anchor, initialView = 'home' }: HelpMenuProps) {
  const titleId = useId();
  const [view, setView] = useState<'home' | 'permissions' | 'updates'>(initialView);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const progress = readHelpProgress(progressKey);
  const client = useMemo(() => defaultCloudAuthClient(), []);
  const capabilities = useCloudAuthCapabilitiesState(client, cloudApiBaseUrl());
  const action = async (target: HelpAction) => {
    setBusy(true); setError(null);
    try { await onAction(target); onDismiss(); }
    catch { setError('Could not open this destination. Try again.'); }
    finally { setBusy(false); }
  };
  return createPortal(<AppDialog titleId={titleId} onDismiss={onDismiss} presentation="popover" anchorRect={anchor} className={`help-menu ${view !== 'home' ? 'help-menu-detail' : ''}`} backdropClassName="help-menu-backdrop">
    <div onKeyDown={(event) => {
      if (event.key !== 'Tab') return;
      const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), summary, a[href]')).filter((element) => element.getClientRects().length > 0);
      if (!controls.length) return;
      event.preventDefault(); event.stopPropagation();
      const index = controls.indexOf(document.activeElement as HTMLElement);
      const destination = index < 0 ? (event.shiftKey ? controls.length - 1 : 0) : (index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length;
      controls[destination]?.focus();
    }}>
    <header className="help-menu-header">
      {view !== 'home' ? <button className="help-icon-button" aria-label="Back to help menu" onClick={() => setView('home')}><ArrowLeft size={16} /></button> : <CircleHelp size={16} aria-hidden="true" />}
      <AppDialogTitle id={titleId}>{view === 'permissions' ? 'Permissions & access' : view === 'updates' ? 'What’s new' : 'Help'}</AppDialogTitle>
      <button className="help-icon-button" onClick={onDismiss} aria-label="Close help"><X size={16} /></button>
    </header>
    {view === 'home' ? <div className="help-menu-items">
      <button onClick={onStartTour}><Play size={16} /><span>{progress.completed ? 'Replay tour' : progress.step > 0 ? 'Resume tour' : 'Show me around'}</span><ArrowRight size={14} /></button>
      <button onClick={() => setView('permissions')}><ShieldCheck size={16} /><span>Permissions & access</span><ArrowRight size={14} /></button>
      <div className="help-menu-divider" />
      <button onClick={() => setView('updates')}><span>What’s new</span></button>
      {supportAvailable ? <button disabled={busy} onClick={() => void action({ kind: 'support' })}><span>Contact support</span></button> : null}
    </div> : <div className="help-menu-content">
      {view === 'permissions' ? <HelpPermissions compact onAction={(target) => void action(target)} onOpenSession={(id) => { onOpenSession(id); onDismiss(); }} connectorsAvailable={settingsAvailable && (nativeMacPermissions() || (capabilities.capabilities?.connectorsVersion ?? 0) > 0)} groundingAvailable={(capabilities.capabilities?.commonGroundVersion ?? 0) > 0} /> : <HelpReleaseNotes native={isNativeDesktopShell()} />}
    </div>}
    {error ? <p className="help-menu-error" role="alert">{error}</p> : null}
    </div>
  </AppDialog>, document.querySelector('.kordi-app') ?? document.body);
}
