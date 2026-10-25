import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowUpRight, BookOpen, Check, Search, ShieldCheck, X } from 'lucide-react';
import { AppDialog, AppDialogDescription, AppDialogTitle } from '@/components/ui/dialog';
import { cloudApiBaseUrl, defaultCloudAuthClient } from '@/features/cloud/authClient';
import { useCloudAuthCapabilitiesState } from '@/features/cloud/cloudAuthCapabilities';
import { isNativeDesktopShell } from '@/lib/desktop';
import type { NavId } from '@/kordi-app/types';
import { HelpPermissions } from './HelpPermissions';
import { nativeMacPermissions } from './permissionAccess';
import { contextualHelpTopic, helpTopics, introduction, searchHelpTopics, type HelpAction, type HelpTopic } from './helpContent';
import { readHelpProgress, saveHelpProgress } from './helpProgress';
import { HelpReleaseNotes } from './HelpReleaseNotes';
import '@/styles/help.css';

type HelpView = 'home' | 'intro' | 'permissions' | 'updates' | `topic:${string}`;
export type HelpHubProps = {
  activeNav: NavId;
  progressKey: string;
  settingsAvailable: boolean;
  supportAvailable: boolean;
  onAction: (action: HelpAction) => Promise<void> | void;
  onOpenSession: (id: string) => void;
  onDismiss: () => void;
};

export default function HelpHub({ activeNav, progressKey, settingsAvailable, supportAvailable, onAction, onOpenSession, onDismiss }: HelpHubProps) {
  const titleId = useId();
  const descriptionId = useId();
  const [view, setView] = useState<HelpView>('home');
  const [query, setQuery] = useState('');
  const [progress, setProgress] = useState(() => readHelpProgress(progressKey));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progressSaved, setProgressSaved] = useState(true);
  const contentRef = useRef<HTMLDivElement>(null);
  const client = useMemo(() => defaultCloudAuthClient(), []);
  const capabilities = useCloudAuthCapabilitiesState(client, cloudApiBaseUrl());
  const available = {
    grounding: (capabilities.capabilities?.commonGroundVersion ?? 0) > 0,
    connectors: settingsAvailable && (nativeMacPermissions() || (capabilities.capabilities?.connectorsVersion ?? 0) > 0),
    memory: settingsAvailable && (capabilities.capabilities?.memoryVersion ?? 0) > 0,
  };
  const topic = view.startsWith('topic:') ? helpTopics.find((item) => item.id === view.slice(6)) : null;
  const suggested = helpTopics.find((item) => item.id === contextualHelpTopic(activeNav))!;
  const results = searchHelpTopics(query);
  useEffect(() => {
    contentRef.current?.scrollTo?.(0, 0);
    if (view === 'home') contentRef.current?.querySelector('input')?.focus();
    else contentRef.current?.focus();
  }, [view]);
  const updateProgress = (next: typeof progress) => {
    setProgress(next);
    setProgressSaved(saveHelpProgress(progressKey, next));
  };
  const advanceIntroduction = () => {
    const finished = progress.step === introduction.length - 1;
    updateProgress({ step: finished ? progress.step : progress.step + 1, completed: finished, welcome: false });
    if (finished) setView('home');
    else contentRef.current?.focus();
  };
  const action = async (target: HelpAction) => {
    setError(null);
    if (target.kind === 'permissions' || target.kind === 'updates') { setView(target.kind); return; }
    setBusy(true);
    try { await onAction(target); onDismiss(); }
    catch { setError('This destination could not open. Check your connection and try again.'); }
    finally { setBusy(false); }
  };
  const unavailableReason = (item: HelpTopic) => {
    if (item.action.kind === 'settings' && !settingsAvailable) return 'Sign in to configure account settings.';
    if (item.action.kind === 'support' && !supportAvailable) return 'Kordi Support is not available yet. Try again after Contacts finishes syncing.';
    if (!item.requirement || available[item.requirement]) return null;
    return capabilities.status === 'loading' ? 'Checking availability…'
      : capabilities.status === 'failed' ? 'Could not check availability. You can still read this guide offline.'
        : 'This feature is not available for this account or app version.';
  };
  const back = () => { setError(null); setView('home'); };
  return (
    <AppDialog titleId={titleId} descriptionId={descriptionId} onDismiss={onDismiss} className="help-dialog" backdropClassName="help-backdrop">
      <header className="help-header">
        <div><AppDialogTitle id={titleId}>Help & setup</AppDialogTitle><AppDialogDescription id={descriptionId}>Find your way around Kordi.</AppDialogDescription></div>
        <button className="help-icon-button" onClick={onDismiss} aria-label="Close Help & setup"><X size={18} /></button>
      </header>
      <nav className="help-tabs" aria-label="Help sections">
        <button aria-current={view !== 'permissions' && view !== 'updates' ? 'page' : undefined} onClick={back}><BookOpen size={15} />Explore Kordi</button>
        <button aria-current={view === 'permissions' ? 'page' : undefined} onClick={() => setView('permissions')}><ShieldCheck size={15} />Permissions & access</button>
      </nav>
      <div className="help-content" ref={contentRef} tabIndex={-1} aria-label="Help content" onKeyDown={(event) => {
        if (view !== 'intro' || event.altKey || event.ctrlKey || event.metaKey) return;
        if (event.key === 'ArrowRight') { event.preventDefault(); advanceIntroduction(); }
        if (event.key === 'ArrowLeft' && progress.step > 0) { event.preventDefault(); updateProgress({ ...progress, step: progress.step - 1 }); }
      }}>
        {view !== 'home' ? <button className="help-back" onClick={back}><ArrowLeft size={14} />All guides</button> : null}
        {view === 'home' ? <>
          <section className="help-welcome">
            <p className="help-eyebrow">GET TO KNOW KORDI</p><h2>Your people, cards, and work.</h2>
            <p>A quick introduction, then explore at your own pace. You can always return with the ? button.</p>
            <button className="help-primary" onClick={() => {
              if (progress.completed) updateProgress({ step: 0, completed: false, welcome: false });
              setView('intro');
            }}>{progress.completed ? 'Replay introduction' : progress.step > 0 ? 'Resume introduction' : 'Show me around'}</button>
          </section>
          <button className="help-context" onClick={() => setView(`topic:${suggested.id}`)}><span><small>HELP WITH THIS SCREEN</small><strong>{suggested.title}</strong></span><ArrowUpRight size={18} /></button>
          <label className="help-search"><Search size={16} aria-hidden="true" /><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search guides, setup, permissions…" aria-label="Search help" /></label>
          <p className="help-result-count" role="status">{query.trim() ? `${results.length} guides found` : 'Explore every part of Kordi'}</p>
          {!results.length ? <p>No guides match. Try “cards”, “authentication”, or “camera”.</p> : null}
          <div className="help-topics">{results.map((item) => <button className="help-topic" key={item.id} onClick={() => setView(`topic:${item.id}`)}><span><strong>{item.title}</strong><span>{item.summary}</span></span><ArrowUpRight size={15} aria-hidden="true" /></button>)}</div>
          <footer className="help-home-footer"><button className="help-text-button" onClick={() => setView('updates')}>What’s New</button><button className="help-text-button" onClick={() => setView('topic:support')}>Contact support</button></footer>
        </> : null}
        {topic ? <article className="help-article">
          <p className="help-eyebrow">{topic.location}</p><h2>{topic.title}</h2><p>{topic.summary}</p>
          <ol>{topic.steps.map((step) => <li key={step}>{step}</li>)}</ol>
          <button className="help-primary" disabled={busy || Boolean(unavailableReason(topic))} onClick={() => void action(topic.action)}>{topic.actionLabel}<ArrowUpRight size={15} /></button>
          {unavailableReason(topic) ? <p role="status">{unavailableReason(topic)}</p> : null}
          {topic.requirement && capabilities.status === 'failed' ? <button className="help-text-button" onClick={capabilities.refetch}>Check availability again</button> : null}
          <p className="help-footnote">Return to ? whenever you need this guide.</p>
        </article> : null}
        {view === 'intro' ? <section className="help-intro">
          <p className="help-eyebrow" aria-live="polite">Step {progress.step + 1} of {introduction.length}</p>
          <div className="help-progress" aria-hidden="true">{introduction.map((item, index) => <span key={item.topic} data-done={index <= progress.step} />)}</div>
          <h2>{introduction[progress.step].title}</h2><p>{introduction[progress.step].body}</p>
          <button className="help-context" onClick={() => setView(`topic:${introduction[progress.step].topic}`)}><span><small>EXPLORE THIS AREA</small><strong>{helpTopics.find((item) => item.id === introduction[progress.step].topic)?.title}</strong></span><ArrowUpRight size={18} /></button>
          <div className="help-intro-actions">
            <button className="help-secondary" disabled={progress.step === 0} onClick={() => updateProgress({ ...progress, step: progress.step - 1 })}>Previous</button>
            <button className="help-primary" onClick={advanceIntroduction}>{progress.step === introduction.length - 1 ? <><Check size={15} />Finish introduction</> : 'Next'}</button>
          </div>
          <button className="help-text-button" onClick={back}>Skip for now</button>
          <p className="help-footnote">Introduction progress is saved for this account on this device. It does not mark any setup task complete.</p>
          {!progressSaved ? <p role="status">Progress could not be saved on this device. You can still use every guide.</p> : null}
        </section> : null}
        {view === 'permissions' ? <HelpPermissions onAction={(target) => void action(target)} onOpenSession={(id) => { onOpenSession(id); onDismiss(); }} connectorsAvailable={available.connectors} groundingAvailable={available.grounding} /> : null}
        {view === 'updates' ? <HelpReleaseNotes native={isNativeDesktopShell()} /> : null}
        {error ? <p role="alert">{error}</p> : null}
      </div>
    </AppDialog>
  );
}
