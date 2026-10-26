import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Bell, CalendarDays, Camera, Check, ChevronDown, ListTodo, MapPin, Mic, Speech } from 'lucide-react';
import { invokeDesktop, isNativeDesktopShell } from '@/lib/desktop';
import { parsePendingToolApprovals, TOOL_APPROVAL_PENDING_COMMAND, TOOL_APPROVAL_REQUEST_EVENT, TOOL_APPROVAL_RESOLVED_EVENT, toolApprovalHeadline, type ToolApprovalPrompt } from '@/features/connectors/toolApprovalModel';
import { nativeMacPermissions, openPermissionSettings, permissionAction, permissionDefinitions, readHelpPermission, requestHelpPermission, type PermissionDefinition, type PermissionStatus } from './permissionAccess';
import type { HelpAction } from './helpContent';

const permissionIcons = { notifications: Bell, location: MapPin, microphone: Mic, camera: Camera, speech: Speech, calendar: CalendarDays, reminders: ListTodo };

function PermissionRow({ definition }: { definition: PermissionDefinition }) {
  const [status, setStatus] = useState<PermissionStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef({ value: 0 });
  const refresh = useCallback(async () => {
    const current = ++generation.current.value;
    const next = await readHelpPermission(definition.id).catch(() => 'unknown' as const);
    if (current === generation.current.value) setStatus(next);
  }, [definition.id]);
  useEffect(() => {
    void refresh();
    const lifecycle = generation.current;
    const onFocus = () => { void refresh(); };
    window.addEventListener('focus', onFocus);
    return () => { lifecycle.value++; window.removeEventListener('focus', onFocus); };
  }, [refresh]);
  const Icon = permissionIcons[definition.id];
  const statusLabel = status === 'allowed' ? 'Allowed' : status === 'denied' ? 'Off' : status === 'restricted' ? 'Restricted' : status === 'unavailable' ? 'Unavailable' : 'Checking…';
  const actionLabel = status === 'not-requested' ? 'Allow' : status === 'unknown' ? 'Check again' : statusLabel;
  const action = status ? permissionAction(status, nativeMacPermissions()) : null;
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      if (action === 'Allow') await requestHelpPermission(definition.id);
      if (action === 'Open Settings') await openPermissionSettings(definition);
      await refresh();
    } catch {
      setError('Access could not be updated. Check device settings, then try again.');
      await refresh();
    } finally { setBusy(false); }
  };
  return (
    <li className="help-permission-row help-device-permission">
      <div className="help-permission-heading">
        <h3><Icon size={16} strokeWidth={1.75} aria-hidden="true" />{definition.name}</h3>
        <span className="help-permission-state" data-status={status} aria-live="polite">
          {action ? <button className={`help-permission-action ${action === 'Allow' ? 'help-permission-allow' : ''}`} disabled={busy} onClick={() => void run()} aria-label={`${action}: ${definition.name}`} title={action === 'Open Settings' ? `Manage ${definition.name.toLowerCase()} in system settings` : undefined}>
            {!busy && status === 'allowed' ? <Check size={12} aria-hidden="true" /> : null}
            {busy ? 'Updating…' : actionLabel}
            {!busy && action === 'Open Settings' ? <ArrowUpRight size={12} aria-hidden="true" /> : null}
          </button> : <span>{status === 'allowed' ? <Check size={12} aria-hidden="true" /> : null}{statusLabel}</span>}
        </span>
      </div>
      <p className="help-permission-description">{definition.description}</p>
      {!nativeMacPermissions() && (status === 'denied' || status === 'allowed') ? <p>Manage this permission in your browser or device settings.</p> : null}
      {status === 'restricted' ? <p>This device’s policy controls access. Contact the person who manages it.</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </li>
  );
}

function PendingApprovals({ onOpenSession }: { onOpenSession: (id: string) => void }) {
  const [prompts, setPrompts] = useState<ToolApprovalPrompt[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    const unlisteners: Array<() => void> = [];
    const refresh = () => {
      void invokeDesktop<unknown>(TOOL_APPROVAL_PENDING_COMMAND).then((value) => {
        if (active) { setPrompts(parsePendingToolApprovals(value)); setStatus('ready'); }
      }, () => { if (active) setStatus('error'); });
    };
    refresh();
    window.addEventListener('focus', refresh);
    void import('@tauri-apps/api/event').then(async ({ listen }) => {
      for (const event of [TOOL_APPROVAL_REQUEST_EVENT, TOOL_APPROVAL_RESOLVED_EVENT]) {
        const stop = await listen(event, refresh);
        if (active) unlisteners.push(stop); else stop();
      }
      if (active) refresh();
    }).catch(() => { /* Focus and manual refresh remain available. */ });
    return () => { active = false; window.removeEventListener('focus', refresh); unlisteners.forEach((stop) => stop()); };
  }, [attempt]);
  return (
    <section className="help-section">
      <h3>Requests waiting for you</h3>
      <p>Review each action in its conversation before choosing Allow or Not now. Requests may expire.</p>
      <p role="status">{status === 'loading' ? 'Checking pending requests…' : status === 'error' ? 'Could not check pending requests.' : !prompts.length ? 'No pending requests on this Mac.' : `${prompts.length} pending request${prompts.length === 1 ? '' : 's'}`}</p>
      {prompts.map((prompt) => <div className="help-permission-row" key={prompt.requestId}>
        <div><h4>{toolApprovalHeadline(prompt)}</h4><p>{prompt.conversationTitle || 'Agent conversation'}</p></div>
        <button className="help-secondary" onClick={() => onOpenSession(prompt.sessionId)}>Review request</button>
      </div>)}
      <button className="help-text-button" onClick={() => setAttempt((value) => value + 1)}>Check requests again</button>
    </section>
  );
}

export function HelpPermissions({ onAction, onOpenSession, connectorsAvailable, groundingAvailable, compact = false }: {
  compact?: boolean;
  onAction: (action: HelpAction) => void;
  onOpenSession: (id: string) => void;
  connectorsAvailable: boolean;
  groundingAvailable: boolean;
}) {
  return (
    <>
      {!compact ? <h2>Permissions & access</h2> : null}
      <p className="help-permissions-intro">Choose what Kordi can access on this device.</p>
      <ul className="help-permission-list">{permissionDefinitions.map((definition) => <PermissionRow key={definition.id} definition={definition} />)}</ul>
      <details className="help-section"><summary>Services and agent access<ChevronDown size={14} aria-hidden="true" /></summary>
        <p>Connect accounts, choose which agents can use them, and manage read or action access in Connectors. Mac Contacts uses Automation access. The optional Notification Center connector needs Full Disk Access; its setup opens the right settings and lets you check again.</p>
        <button className="help-secondary" disabled={!connectorsAvailable} onClick={() => onAction({ kind: 'settings', tab: 'connectors' })}>Manage connectors & access</button>
        {!connectorsAvailable ? <p>Connectors are unavailable or their availability could not be checked.</p> : null}
      </details>
      <details className="help-section"><summary>Card sources and sharing<ChevronDown size={14} aria-hidden="true" /></summary>
        <p>Device permission does not choose what goes into your card. In Grounding, select sources for each build, review topics, and choose which profile to share.</p>
        <button className="help-secondary" disabled={!groundingAvailable} onClick={() => onAction({ kind: 'grounding' })}>Review cards & sharing</button>
      </details>
      {isNativeDesktopShell() ? <PendingApprovals onOpenSession={onOpenSession} /> : <p>Pending Mac agent approvals are available in the desktop app. Review other action requests in their conversation.</p>}
    </>
  );
}
