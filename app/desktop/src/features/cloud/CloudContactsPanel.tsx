import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  CloudAuthClient,
  CloudAuthError,
  defaultCloudAuthClient,
  type CloudAccount,
  type CloudContactSummary,
  type CloudPublicProfile,
} from './authClient';
import { loadSession } from './session';
import { IdentityAvatar } from '@/kordi-app/components/IdentityAvatar';
import { cloudAvatarImageUrl, cloudAvatarSeedForAccount } from './avatar';

function avatarSeedFor(profile: { accountId: string; avatarUrl: string | null }): string {
  return cloudAvatarSeedForAccount(profile.accountId, profile.avatarUrl);
}

type Props = {
  account: CloudAccount;
  client?: CloudAuthClient;
  onClose: () => void;
};

type LookupState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'found'; profile: CloudPublicProfile }
  | { kind: 'error'; message: string };

export function CloudContactsPanel({ account, client, onClose }: Props) {
  const authClient = useMemo(() => client ?? defaultCloudAuthClient(), [client]);
  const [contacts, setContacts] = useState<CloudContactSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [lookupQuery, setLookupQuery] = useState('');
  const [lookup, setLookup] = useState<LookupState>({ kind: 'idle' });
  const [adding, setAdding] = useState(false);
  const [copied, setCopied] = useState(false);

  const fetchContacts = useCallback(async () => {
    const session = await loadSession();
    if (!session) {
      setLoadError('Your session has expired. Please sign in again.');
      return;
    }
    try {
      const list = await authClient.listContacts(session.token);
      setContacts(list);
      setLoadError(null);
    } catch (caught) {
      setLoadError(caught instanceof Error ? caught.message : 'Could not load contacts.');
    }
  }, [authClient]);

  useEffect(() => {
    void fetchContacts();
  }, [fetchContacts]);

  const handleLookup = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const trimmed = lookupQuery.trim();
      if (!trimmed) return;
      if (trimmed === account.accountId) {
        setLookup({ kind: 'error', message: 'That is your own Kordi ID.' });
        return;
      }
      setLookup({ kind: 'loading' });
      const session = await loadSession();
      if (!session) {
        setLookup({ kind: 'error', message: 'Your session has expired. Please sign in again.' });
        return;
      }
      try {
        const profile = await authClient.getProfile(session.token, trimmed);
        setLookup({ kind: 'found', profile });
      } catch (caught) {
        if (caught instanceof CloudAuthError && caught.code === 'account_missing') {
          setLookup({ kind: 'error', message: 'No Kordi account with that ID.' });
        } else {
          setLookup({
            kind: 'error',
            message: caught instanceof Error ? caught.message : 'Lookup failed.',
          });
        }
      }
    },
    [authClient, lookupQuery, account.accountId],
  );

  const handleAdd = useCallback(
    async (peerAccountId: string) => {
      const session = await loadSession();
      if (!session) {
        setLookup({ kind: 'error', message: 'Your session has expired. Please sign in again.' });
        return;
      }
      setAdding(true);
      try {
        await authClient.addContact(session.token, peerAccountId);
        setLookup({ kind: 'idle' });
        setLookupQuery('');
        await fetchContacts();
      } catch (caught) {
        setLookup({
          kind: 'error',
          message: caught instanceof Error ? caught.message : 'Could not add contact.',
        });
      } finally {
        setAdding(false);
      }
    },
    [authClient, fetchContacts],
  );

  const handleCopy = useCallback(() => {
    const value = account.accountId;
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      void navigator.clipboard.writeText(value);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }, [account.accountId]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Cloud contacts"
      className="app-transient-overlay fixed inset-0 z-[200] grid place-items-center p-6 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="app-transient-surface w-full max-w-[460px] rounded-[20px] border p-5"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-[18px] font-semibold tracking-tight">Cloud contacts</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="app-button-quiet app-transient-flat-action rounded-[10px] px-2.5 py-1 text-[11px] font-semibold"
          >
            Close
          </button>
        </header>

        <section className="app-transient-row mt-4 rounded-[14px] border p-3.5">
          <div className="flex items-center gap-3">
            <IdentityAvatar
              kind="human"
              seed={avatarSeedFor({ accountId: account.accountId, avatarUrl: account.avatarUrl })}
              name={account.displayName ?? account.primaryEmail ?? 'You'}
              imageUrl={cloudAvatarImageUrl(account.avatarUrl)}
              avatarKey={`cloud-self:${account.accountId}`}
              className="h-10 w-10 shrink-0 rounded-full border border-[color:var(--app-transient-border)]"
            />
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-semibold leading-tight">
                {account.displayName ?? account.primaryEmail ?? 'You'}
              </div>
              <div className="app-transient-muted mt-0.5 truncate font-mono text-[11px]">
                {account.accountId}
              </div>
            </div>
            <button
              type="button"
              onClick={handleCopy}
              className="app-button-quiet app-transient-flat-action rounded-[10px] px-3 py-1 text-[11px] font-semibold"
              aria-label="Copy your Kordi ID"
            >
              {copied ? 'Copied' : 'Copy ID'}
            </button>
          </div>
        </section>

        <form className="mt-4 grid gap-2" onSubmit={handleLookup}>
          <label className="grid gap-1">
            <span className="app-transient-muted text-[11px] font-semibold tracking-[0.02em]">
              Kordi ID to add
            </span>
            <input
              type="text"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              placeholder="acct_…"
              value={lookupQuery}
              onChange={(event) => setLookupQuery(event.currentTarget.value)}
              className="h-10 rounded-[12px] border border-[color:var(--app-transient-border)] bg-[color:var(--app-transient-raised-bg)] px-4 font-mono text-[13px] text-[color:var(--app-transient-text)] outline-none placeholder:text-[color:var(--app-transient-subtle-text)]"
            />
          </label>
          <button
            type="submit"
            disabled={lookup.kind === 'loading' || lookupQuery.trim().length === 0}
            className="h-10 rounded-[12px] bg-[color:var(--app-transient-text)] text-[13px] font-semibold text-[color:var(--app-transient-surface-fallback)] transition disabled:cursor-not-allowed disabled:opacity-60"
          >
            {lookup.kind === 'loading' ? 'Looking up…' : 'Find user'}
          </button>
        </form>

        {lookup.kind === 'error' ? (
          <div role="alert" className="app-error-text mt-3 rounded-xl border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-[12px] text-rose-200">
            {lookup.message}
          </div>
        ) : null}

        {lookup.kind === 'found' ? (
          <div className="mt-3 rounded-2xl border border-emerald-400/30 bg-emerald-500/10 p-3">
            <div className="flex items-center gap-3">
              <IdentityAvatar
                kind="human"
                seed={avatarSeedFor(lookup.profile)}
                name={lookup.profile.displayName ?? lookup.profile.accountId}
                imageUrl={cloudAvatarImageUrl(lookup.profile.avatarUrl)}
                avatarKey={`cloud-peer:${lookup.profile.accountId}`}
                className="h-10 w-10 shrink-0 rounded-full border border-[color:var(--app-transient-border)]"
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-semibold">
                  {lookup.profile.displayName ?? 'Unnamed account'}
                </div>
                <div className="app-transient-muted mt-0.5 truncate font-mono text-[11px]">
                  {lookup.profile.accountId}
                </div>
              </div>
              {lookup.profile.isContact ? (
                <span className="rounded-full bg-emerald-400/20 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-200">
                  Already a contact
                </span>
              ) : (
                <button
                  type="button"
                  disabled={adding}
                  onClick={() => handleAdd(lookup.profile.accountId)}
                  className="rounded-full bg-emerald-400 px-3 py-1 text-[12px] font-semibold text-emerald-950 transition disabled:opacity-60"
                >
                  {adding ? 'Adding…' : 'Add contact'}
                </button>
              )}
            </div>
          </div>
        ) : null}

        <section className="mt-5">
          <div className="flex items-baseline justify-between">
            <h3 className="app-transient-muted text-[12px] font-semibold tracking-[0.02em]">
              Your contacts
            </h3>
            <span className="app-transient-subtle text-[11px]">
              {contacts ? `${contacts.length} total` : '…'}
            </span>
          </div>
          <div className="mt-2 grid gap-2">
            {loadError ? (
              <div role="alert" className="app-error-text rounded-xl border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-[12px] text-rose-200">
                {loadError}
              </div>
            ) : null}
            {contacts && contacts.length === 0 ? (
              <div className="app-transient-row app-transient-muted rounded-xl border px-3 py-3 text-[12px]">
                No contacts yet. Paste a Kordi ID above to add one.
              </div>
            ) : null}
            {contacts?.map((contact) => (
              <div
                key={contact.accountId}
                className="app-transient-row flex items-center gap-3 rounded-xl border px-3 py-2"
              >
                <IdentityAvatar
                  kind="human"
                  seed={avatarSeedFor(contact)}
                  name={contact.displayName ?? contact.accountId}
                  imageUrl={cloudAvatarImageUrl(contact.avatarUrl)}
                  avatarKey={`cloud-contact:${contact.accountId}`}
                  className="h-9 w-9 shrink-0 rounded-full border border-[color:var(--app-transient-border)]"
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-semibold">
                    {contact.displayName ?? 'Unnamed account'}
                  </div>
                  <div className="app-transient-muted mt-0.5 truncate font-mono text-[11px]">
                    {contact.accountId}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
