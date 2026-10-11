import { IdentityAvatar } from '@/kordi-app/components/IdentityAvatar';

import type { DocumentReaderPerson } from './documentReaderHost';
import { formatKordiNumber } from './documentReaderModel';

export function PeopleCard({
  person,
  onMessage,
  actionLabel = 'Message',
}: {
  person: DocumentReaderPerson;
  /** Missing when the person is the viewer or cannot be messaged from here. */
  onMessage?: () => void;
  actionLabel?: string;
}) {
  const kordiNumber = formatKordiNumber(person.kordiId);
  return (
    <div className="app-document-people" role="dialog" aria-label="People">
      <div className="app-document-people-caption">People</div>
      <div className="app-document-people-row">
        <IdentityAvatar
          kind="human"
          seed={person.accountId || person.displayName}
          name={person.displayName}
          imageUrl={person.avatarUrl ?? null}
          className="app-document-avatar"
        />
        <div className="app-document-people-who">
          <div className="app-document-people-name">{person.displayName}</div>
          {kordiNumber ? <div className="app-document-people-sub">Kordi {kordiNumber}</div> : null}
        </div>
        {onMessage ? (
          <button type="button" className="app-document-people-action" onClick={onMessage}>{actionLabel}</button>
        ) : null}
      </div>
    </div>
  );
}
