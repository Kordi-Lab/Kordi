import { useState } from 'react';
import { CalendarPlus, Check, Clock, MessageCircle, Sparkles, UserPlus } from 'lucide-react';

import { DetailTile, DetailTiles } from '@/kordi-app/contacts/ContactDetailParts';
import type { CgHost } from './host';
import { MeetDialog } from './MeetDialog';
import { canMeet, contactActionFor, CONTACT_ACTION_LABELS } from './relationship';
import type { CgState, CommonGroundStore } from './store';
import type { CgPerson } from './types';

const ICON = 'h-5 w-5';

/** Add, Accept, Requested or Message, then Meet; driven by the person's relationship. */
export function PersonActions({ person, state, store, host, onFind }: {
  person: CgPerson;
  state: CgState;
  store: CommonGroundStore;
  host: CgHost;
  onFind?: () => void;
}) {
  const [meeting, setMeeting] = useState(false);
  const [busy, setBusy] = useState(false);
  // `state` keeps this in step with the store; the lookup reads the newest relationship.
  const relationship = state.relationships[person.accountId] ?? store.relationshipFor(person.accountId) ?? person.relationship;
  const action = contactActionFor(relationship, state.support.contact);
  const showMeet = state.support.meet && Boolean(relationship);
  const meetOk = canMeet(relationship);
  const act = async (work: () => Promise<void>) => {
    setBusy(true);
    try { await work(); } finally { setBusy(false); }
  };

  const contactTile = () => {
    if (action === 'hidden') return null;
    const label = CONTACT_ACTION_LABELS[action];
    if (action === 'message') {
      return (
        <DetailTile
          key="contact"
          icon={<MessageCircle className={ICON} aria-hidden="true" />}
          label={label}
          tone="primary"
          disabled={busy}
          onClick={() => void act(async () => { if (await store.chat(person.accountId)) host.openChat(person); })}
        />
      );
    }
    if (action === 'requested') return <DetailTile key="contact" icon={<Clock className={ICON} aria-hidden="true" />} label={label} disabled onClick={() => undefined} />;
    if (action === 'accept') {
      return (
        <DetailTile
          key="contact"
          icon={<Check className={ICON} aria-hidden="true" />}
          label={label}
          tone="primary"
          disabled={busy}
          onClick={() => void act(async () => {
            const requestId = relationship?.requestId;
            if (!requestId || !relationship) return;
            await host.acceptRequest(requestId);
            store.setRelationship(person.accountId, { ...relationship, contact: true, request: null, requestId: null });
            host.contactsChanged();
          })}
        />
      );
    }
    return (
      <DetailTile
        key="contact"
        icon={<UserPlus className={ICON} aria-hidden="true" />}
        label={label}
        tone="primary"
        disabled={busy}
        onClick={() => void act(async () => { await store.addContact(person.accountId); host.contactsChanged(); })}
      />
    );
  };

  const tiles = [
    onFind ? <DetailTile key="find" icon={<Sparkles className={ICON} aria-hidden="true" />} label="Find common ground" onClick={onFind} /> : null,
    contactTile(),
    showMeet ? (
      <DetailTile key="meet" icon={<CalendarPlus className={ICON} aria-hidden="true" />} label="Meet" disabled={!meetOk || busy} onClick={() => setMeeting(true)} />
    ) : null,
  ].filter(Boolean);
  if (!tiles.length) return null;

  return (
    <>
      <DetailTiles>{tiles}</DetailTiles>
      {showMeet && !meetOk ? <div className="cg-hint">Add each other to meet</div> : null}
      {meeting ? (
        <MeetDialog
          name={person.name}
          busy={busy}
          onCancel={() => setMeeting(false)}
          onSubmit={(input) => void act(async () => {
            if (await store.meet(person.accountId, input)) {
              setMeeting(false);
              host.openChat(person);
            }
          })}
        />
      ) : null}
    </>
  );
}
