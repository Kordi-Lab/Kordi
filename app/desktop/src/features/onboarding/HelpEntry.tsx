import { lazy, Suspense, useRef, useState } from 'react';
import type { AppDialogAnchor } from '@/components/ui/dialog';
import { CircleHelp } from 'lucide-react';
import { cloudApiBaseUrl } from '@/features/cloud/authClient';
import type { NavId } from '@/kordi-app/types';
import type { WorkspaceSidebarAccount } from '@/pages/workspaceSidebar.types';
import { helpProgressKey, readHelpProgress, saveHelpProgress } from './helpProgress';
import { requestHelpGrounding } from './helpNavigation';
import type { HelpTourId } from './helpTourSteps';
import type { HelpAction } from './helpContent';
import { HelpWelcome } from './HelpWelcome';

const HelpMenu = lazy(() => import('./HelpMenu'));
const HelpTour = lazy(() => import('./HelpTour'));

type HelpEntryProps = {
  activeNav: NavId;
  setActiveNav: (nav: NavId) => void;
  account: WorkspaceSidebarAccount;
  onOpenSupport?: () => Promise<void> | void;
  onOpenSession: (id: string) => void;
};

export function HelpEntry(props: HelpEntryProps) {
  return <AccountHelpEntry key={props.account.cloudAccount?.accountId ?? 'local'} {...props} />;
}

function AccountHelpEntry({ setActiveNav, account, onOpenSupport, onOpenSession }: HelpEntryProps) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<AppDialogAnchor | null>(null);
  const [tour, setTour] = useState<HelpTourId | null>(null);
  const [initialView, setInitialView] = useState<'home' | 'permissions'>('home');
  const tourOpenedSettings = useRef(false);
  const settingsAvailable = Boolean(account.cloudAccount && account.cloudSettings && account.setCloudAccountDialogTab);
  const trigger = useRef<HTMLButtonElement>(null);
  const progressKey = helpProgressKey(account.cloudAccount?.accountId ?? 'local', cloudApiBaseUrl());
  const [welcome, setWelcome] = useState(() => readHelpProgress(progressKey).welcome);
  const openHelp = () => {
    setAnchor(trigger.current?.getBoundingClientRect() ?? null);
    if (tourOpenedSettings.current) { account.setCloudAccountDialogTab?.(null); tourOpenedSettings.current = false; }
    trigger.current?.focus();
    setWelcome(false);
    saveHelpProgress(progressKey, { ...readHelpProgress(progressKey), welcome: false });
    setTour(null);
    setInitialView('home');
    setOpen(true);
  };
  const startTour = (id: HelpTourId = 'workspace') => {
    setWelcome(false);
    saveHelpProgress(progressKey, { ...readHelpProgress(progressKey), welcome: false });
    setOpen(false);
    setTour(id);
  };
  const exitTour = (permissions = false) => {
    setTour(null);
    if (tourOpenedSettings.current) { account.setCloudAccountDialogTab?.(null); tourOpenedSettings.current = false; }
    trigger.current?.focus();
    if (permissions) { setAnchor(trigger.current?.getBoundingClientRect() ?? null); setInitialView('permissions'); setOpen(true); }
  };
  const action = async (target: HelpAction) => {
    if (target.kind === 'navigate') setActiveNav(target.page);
    if (target.kind === 'settings') account.setCloudAccountDialogTab?.(target.tab);
    if (target.kind === 'grounding' && account.cloudAccount) {
      requestHelpGrounding(account.cloudAccount.accountId);
      setActiveNav('contacts');
    }
    if (target.kind === 'support') await onOpenSupport?.();
  };
  return <div className="relative">
    <button data-help-target="help" ref={trigger} type="button" className="app-workspace-nav-button relative mx-auto grid h-8 w-8 place-items-center rounded-[10px] p-0" data-active={open || Boolean(tour)} aria-label={welcome ? 'Help & setup: get started with Kordi' : 'Help & setup'} title={welcome ? 'New to Kordi? Start here' : 'Help & setup'} aria-haspopup="dialog" aria-expanded={open || Boolean(tour)} onClick={openHelp}>
      <CircleHelp className="h-[18px] w-[18px]" aria-hidden="true" />
      {welcome ? <span className="absolute right-0 top-0 h-2 w-2 rounded-full bg-emerald-400" aria-hidden="true" /> : null}
    </button>
    {welcome && !open && !tour ? <HelpWelcome trigger={trigger} onStart={() => startTour()} onDismiss={() => {
          setWelcome(false);
          saveHelpProgress(progressKey, { ...readHelpProgress(progressKey), welcome: false });
        }} /> : null}
    {open ? <Suspense fallback={<span role="status" className="sr-only">Loading help…</span>}><HelpMenu anchor={anchor} progressKey={progressKey} initialView={initialView} onStartTour={startTour} settingsAvailable={settingsAvailable} supportAvailable={Boolean(onOpenSupport)} onAction={action} onOpenSession={onOpenSession} onDismiss={() => setOpen(false)} /></Suspense> : null}
    {tour ? <Suspense fallback={<span role="status" className="sr-only">Loading tour…</span>}><HelpTour tourId={tour} progressKey={tour === 'workspace' ? progressKey : `${progressKey}:${tour}`} settingsAvailable={settingsAvailable} onExit={exitTour} onPrepare={(step) => {
      if (step.settings && settingsAvailable) {
        tourOpenedSettings.current = true;
        account.setCloudAccountDialogTab?.(step.settings);
      } else if (tourOpenedSettings.current) {
        account.setCloudAccountDialogTab?.(null);
        tourOpenedSettings.current = false;
      }
      if (step.page) setActiveNav(step.page);
      if (step.groundingScreen && account.cloudAccount) {
        requestHelpGrounding(account.cloudAccount.accountId, step.groundingScreen);
        setActiveNav('contacts');
      }
    }} /></Suspense> : null}
  </div>;
}
