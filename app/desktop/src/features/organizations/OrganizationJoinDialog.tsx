import { Search, X } from 'lucide-react';
import { useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react';

import { AppDialog } from '@/components/ui/dialog';
import { ErrorLine } from '@/components/ui/ErrorLine';
import type { JoinableOrganization, JoinableOrganizations } from './organizationJoinClient';

export type OrganizationJoinActions = {
  /** Sends an email code for a direct join; returns the verification id. */
  sendCode: (organization: JoinableOrganization) => Promise<string>;
  verifyCode: (organization: JoinableOrganization, verificationId: string, code: string) => Promise<void>;
  request: (organization: JoinableOrganization, fields: Record<string, string>) => Promise<void>;
};

export type OrganizationJoinDialogProps = {
  /** `null` while the list loads. */
  data: JoinableOrganizations | null;
  failed?: boolean;
  actions: OrganizationJoinActions;
  onJoined?: (organization: JoinableOrganization) => void;
  onClose: () => void;
};

type RowState =
  | { kind: 'idle' }
  | { kind: 'busy'; form: 'code' | 'fields' | null; verificationId?: string }
  | { kind: 'code'; verificationId: string }
  | { kind: 'fields' }
  | { kind: 'requested' }
  | { kind: 'joined' };

function memberLabel(count: number): string {
  return `${count.toLocaleString()} ${count === 1 ? 'member' : 'members'}`;
}

function initial(name: string): string {
  return (Array.from(name.trim())[0] ?? '?').toLocaleUpperCase();
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Something went wrong. Try again.';
}

function OrganizationJoinRow({
  organization,
  hidden,
  email,
  actions,
  onJoined,
}: {
  organization: JoinableOrganization;
  hidden: boolean;
  email: string | null;
  actions: OrganizationJoinActions;
  onJoined?: (organization: JoinableOrganization) => void;
}) {
  const [state, setState] = useState<RowState>(organization.requested ? { kind: 'requested' } : { kind: 'idle' });
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const required = organization.joinRequestFields.filter((field) => field.required);
  const busy = state.kind === 'busy';
  const form = state.kind === 'code' || state.kind === 'fields' ? state.kind : state.kind === 'busy' ? state.form : null;
  const verificationId = state.kind === 'code' || state.kind === 'busy' ? state.verificationId : undefined;

  const run = async (busyState: RowState & { kind: 'busy' }, task: () => Promise<RowState>, fallback: RowState) => {
    setError(null);
    setState(busyState);
    try {
      setState(await task());
    } catch (cause) {
      setError(errorText(cause));
      setState(fallback);
    }
  };

  const join = () => void run({ kind: 'busy', form: null }, async () => {
    const id = await actions.sendCode(organization);
    return { kind: 'code', verificationId: id };
  }, { kind: 'idle' });

  const request = (fields: Record<string, string>, fallback: RowState) => void run(
    { kind: 'busy', form: fallback.kind === 'fields' ? 'fields' : null },
    async () => {
      await actions.request(organization, fields);
      return { kind: 'requested' };
    },
    fallback,
  );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (form === 'code' && verificationId) {
      const typed = code.trim();
      if (!typed) return;
      void run({ kind: 'busy', form: 'code', verificationId }, async () => {
        await actions.verifyCode(organization, verificationId, typed);
        onJoined?.(organization);
        return { kind: 'joined' };
      }, { kind: 'code', verificationId });
      return;
    }
    const fields = Object.fromEntries(required.map((field) => [field.key, values[field.key]?.trim() ?? '']));
    if (Object.values(fields).some((value) => !value)) return;
    request(fields, { kind: 'fields' });
  };

  let action = null;
  if (state.kind === 'requested' || state.kind === 'joined') {
    action = (
      <button type="button" className="org-join-action org-join-action-done" disabled>
        {state.kind === 'joined' ? 'Joined' : 'Requested'}
      </button>
    );
  } else if (!form && organization.canJoin) {
    action = <button type="button" className="org-join-action org-join-action-join" disabled={busy} onClick={join}>Join</button>;
  } else if (!form && organization.canRequest) {
    action = (
      <button
        type="button"
        className="org-join-action org-join-action-request"
        disabled={busy}
        onClick={() => (required.length ? setState({ kind: 'fields' }) : request({}, { kind: 'idle' }))}
      >
        Request to join
      </button>
    );
  }

  return (
    <li className="org-join-item" data-organization-id={organization.id} hidden={hidden}>
      <div className="org-join-row">
        <span className="org-join-avatar" aria-hidden="true">{initial(organization.name)}</span>
        <span className="org-join-text">
          <strong>{organization.name}</strong>
          <small>{memberLabel(organization.memberCount)}</small>
        </span>
        {action}
      </div>
      {form ? (
        <form className="org-join-form" onSubmit={submit} aria-label={`Join ${organization.name}`}>
          {form === 'code' ? (
            <input
              autoFocus
              className="org-join-input"
              aria-label="Email code"
              placeholder={email ? `Code sent to ${email}` : 'Email code'}
              autoComplete="one-time-code"
              inputMode="numeric"
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
          ) : required.map((field, index) => (
            <input
              key={field.key}
              autoFocus={index === 0}
              className="org-join-input"
              aria-label={field.label}
              placeholder={field.label}
              maxLength={field.maxLength}
              value={values[field.key] ?? ''}
              onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.value }))}
            />
          ))}
          <button type="submit" className="org-join-action org-join-action-join" disabled={busy}>
            {form === 'code' ? 'Verify' : 'Send request'}
          </button>
        </form>
      ) : null}
      {error ? <ErrorLine className="ml-[42px]">{error}</ErrorLine> : null}
    </li>
  );
}

export function OrganizationJoinDialog({ data, failed = false, actions, onJoined, onClose }: OrganizationJoinDialogProps) {
  const [query, setQuery] = useState('');
  const titleRef = useRef<HTMLHeadingElement>(null);
  const organizations = useMemo(() => data?.organizations ?? [], [data]);
  const hasList = organizations.length > 0;
  // With nothing to search, rest focus on the title instead of ringing the close button.
  useLayoutEffect(() => {
    if (!hasList) titleRef.current?.focus();
  }, [hasList]);
  // Filtered rows are hidden, not unmounted, so a sent request or join keeps its state.
  const visibleIds = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return new Set(organizations
      .filter((organization) => !needle || organization.name.toLocaleLowerCase().includes(needle))
      .map((organization) => organization.id));
  }, [organizations, query]);

  let line: string;
  if (failed) line = 'Could not load organizations. Try again later.';
  else if (!data) line = 'Loading…';
  else if (!data.emailDomain) line = 'Verify your email to find your organization.';
  else if (!hasList) line = `No organizations use ${data.emailDomain} yet.`;
  else line = `Matching your ${data.emailDomain} email.`;

  return (
    <AppDialog
      titleId="org-join-title"
      descriptionId="org-join-line"
      onDismiss={onClose}
      className="org-join-dialog"
      backdropClassName="!z-[100000]"
    >
      <header className="org-join-heading">
        <h2 ref={titleRef} id="org-join-title" tabIndex={-1}>Find your organization</h2>
        <button type="button" aria-label="Close" onClick={onClose}><X size={16} /></button>
      </header>
      <p id="org-join-line" className="org-join-line" aria-live="polite">{line}</p>
      {hasList ? (
        <>
          <label className="org-join-search">
            <Search size={14} aria-hidden="true" />
            <input
              autoFocus
              aria-label="Search organizations"
              placeholder="Search organizations"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <ul className="org-join-list app-transient-scroll" hidden={visibleIds.size === 0}>
            {organizations.map((organization) => (
              <OrganizationJoinRow
                key={organization.id}
                organization={organization}
                hidden={!visibleIds.has(organization.id)}
                email={data?.email ?? null}
                actions={actions}
                onJoined={onJoined}
              />
            ))}
          </ul>
          {visibleIds.size === 0 ? <p className="org-join-empty">No matches.</p> : null}
        </>
      ) : null}
    </AppDialog>
  );
}
