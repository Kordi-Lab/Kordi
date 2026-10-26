import { useId } from 'react';

import { Button } from '@/components/ui/button';
import { AppDialog, AppDialogActions, AppDialogDescription, AppDialogTitle } from '@/components/ui/dialog';
import { participantSpaceSessionRowTitle } from '@/pages/workspaceSidebar.chatHelpers';
import type { ParticipantSpaceViewModel } from '../types';

export function ContactsGroupChannelsDialog({ space: { title, sessions }, onDismiss, onSelectChannel }: {
  space: ParticipantSpaceViewModel;
  onDismiss: () => void;
  onSelectChannel: (sessionId: string) => void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  return (
    <AppDialog titleId={titleId} descriptionId={descriptionId} onDismiss={onDismiss}>
      <AppDialogTitle id={titleId}>{title}</AppDialogTitle>
      <AppDialogDescription id={descriptionId}>Choose a channel</AppDialogDescription>
      <div className="mt-4 max-h-[min(60dvh,28rem)] overflow-y-auto" aria-label="Channels">
        {sessions.length === 0 ? (
          <p className="app-contacts-muted py-3 text-sm">No channels available.</p>
        ) : sessions.map(({ id, title: channelTitle, updatedAtLabel }) => (
          <Button key={id} variant="quiet" className="w-full justify-between text-left"
            onClick={() => onSelectChannel(id)}>
            <span className="min-w-0 truncate">{participantSpaceSessionRowTitle(channelTitle)}</span>
            <span className="app-contacts-muted shrink-0 text-xs">{updatedAtLabel}</span>
          </Button>
        ))}
      </div>
      <AppDialogActions>
        <Button type="button" variant="quiet" onClick={onDismiss}>Back to Contacts</Button>
      </AppDialogActions>
    </AppDialog>
  );
}
