import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { AppDialog, AppDialogActions, AppDialogTitle } from '@/components/ui/dialog';

export function ChannelCreateDialog({ groupName, onCancel, onCreate }: {
  groupName: string;
  onCancel: () => void;
  onCreate: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try { await onCreate(name.trim()); }
    catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create this channel. Try again.');
      setBusy(false);
    }
  };
  return (
    <AppDialog titleId="channel-create-title" onDismiss={onCancel} dismissDisabled={busy} busy={busy}>
      <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <AppDialogTitle id="channel-create-title">Create channel</AppDialogTitle>
        <p className="mb-4 text-sm text-muted-foreground">Choose a name for this channel in {groupName}.</p>
        <label className="block text-sm" htmlFor="new-channel-name">Channel name</label>
        <input id="new-channel-name" autoFocus required maxLength={200}
          value={name} onChange={(event) => setName(event.target.value)} disabled={busy}
          className="app-input mt-2 w-full rounded-lg border px-3 py-2" placeholder="e.g. Announcements" />
        {error ? <p role="alert" className="mt-3 text-sm text-destructive">{error}</p> : null}
        <AppDialogActions>
          <Button type="button" variant="quiet" disabled={busy} onClick={onCancel}>Cancel</Button>
          <Button type="submit" disabled={busy || !name.trim()}>{busy ? 'Creating…' : 'Create channel'}</Button>
        </AppDialogActions>
      </form>
    </AppDialog>
  );
}
