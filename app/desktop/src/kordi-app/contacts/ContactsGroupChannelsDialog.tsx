import { useId } from 'react';

import { Button } from '@/components/ui/button';
import { AppDialog, AppDialogActions, AppDialogDescription, AppDialogTitle } from '@/components/ui/dialog';
import { participantSpaceSessionRowTitle } from '@/pages/workspaceSidebar.chatHelpers';
import type { ParticipantSpaceViewModel } from '../types';

export function ContactsGroupChannelsDialog({ space, onDismiss, onSelectChannel }: {
  space: ParticipantSpaceViewModel;
  onDismiss: () => void;
  onSelectChannel: (sessionId: string) => void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  return (
    <AppDialog titleId={titleId} descriptionId={descriptionId} onDismiss={onDismiss}>
      <AppDialogTitle id={titleId}>{space.title}</AppDialogTitle>
      <AppDialogDescription id={descriptionId}>Choose a channel</AppDialogDescription>
      <div className="mt-4 max-h-[min(60dvh,28rem)] overflow-y-auto" aria-label="Channels">
        {space.sessions.length === 0 ? (
          <p className="app-contacts-muted py-3 text-sm">No channels available.</p>
        ) : space.sessions.map((session) => (
          <button key={session.id} type="button" className="app-contacts-channel-row flex w-full items-center justify-between gap-3 rounded-lg px-3 py-3 text-left"
            onClick={() => onSelectChannel(session.id)}>
            <span className="min-w-0 truncate text-sm font-medium">{participantSpaceSessionRowTitle(session.title)}</span>
            {session.updatedAtLabel ? <span className="app-contacts-muted shrink-0 text-xs">{session.updatedAtLabel}</span> : null}
          </button>
        ))}
      </div>
      <AppDialogActions>
        <Button type="button" variant="quiet" onClick={onDismiss}>Back to Contacts</Button>
      </AppDialogActions>
    </AppDialog>
  );
}
