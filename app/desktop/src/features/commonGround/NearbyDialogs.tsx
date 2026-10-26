import { useId, useState } from 'react';

import { AppDialog, AppDialogActions, AppDialogDescription, AppDialogTitle } from '@/components/ui/dialog';
import { SettingsSwitch } from '@/kordi-app/components/settingsLayout';
import { cn } from '@/lib/utils';
import { profileDesign } from './cardDesign';
import { MeetDatePicker, MeetTimePicker } from './MeetPickers';
import { nearbyCards, NEARBY_RANGES, NEED_TEXT_MAX } from './nearbyFormat';
import { defaultNeedWindow, needDraft, needDraftError, slotOf, type NeedDraft, type NeedSlot } from './nearbyRequest';
import { CgButton, CgNotice } from './parts';
import { CardGlyph } from './ProfileCard';
import type { CgProfile } from './types';
import type { CgNeed } from './typesNearby';

/** Turn on Nearby?: the card to share and background alerts; Turn on consents. */
export function NearbyConsentDialog({ profiles, initialProfileId, busy, notice, onCancel, onTurnOn }: {
  profiles: CgProfile[];
  initialProfileId: string | null;
  busy: boolean;
  notice: string | null;
  onCancel: () => void;
  onTurnOn: (profileId: string, background: boolean) => void;
}) {
  const titleId = useId();
  const lineId = useId();
  const cards = nearbyCards(profiles);
  const [cardId, setCardId] = useState(() => (cards.find((card) => card.profileId === initialProfileId) ?? cards[0])?.profileId ?? '');
  const [background, setBackground] = useState(true);
  const card = cards.find((item) => item.profileId === cardId);
  return (
    <AppDialog titleId={titleId} descriptionId={lineId} onDismiss={onCancel} busy={busy} dismissDisabled={busy} className="cg-dialog cg-nb-dialog">
      <AppDialogTitle id={titleId}>Turn on Nearby?</AppDialogTitle>
      <AppDialogDescription id={lineId}>People nearby who turn this on see your card and a rough distance. You see theirs.</AppDialogDescription>
      <div className="cg-pop-label">Share</div>
      <div className="cg-pop-cards" role="radiogroup" aria-label="Card">
        {cards.map((item) => {
          const design = profileDesign(item);
          return (
            <button
              key={item.profileId}
              type="button"
              role="radio"
              aria-checked={item.profileId === cardId}
              aria-label={item.name}
              title={item.name}
              className={cn('cg-pop-card', item.profileId === cardId && 'is-on')}
              data-design={design}
              onClick={() => setCardId(item.profileId)}
            >
              <CardGlyph design={design} icon={item.icon} kind={item.kind} />
            </button>
          );
        })}
        {card ? <span className="cg-pop-pick">{card.name}</span> : null}
      </div>
      <div className="cg-nb-swrow is-first">
        <span>Alerts in the background</span>
        <SettingsSwitch enabled={background} label="Alerts in the background" onChange={setBackground} />
      </div>
      <CgNotice text={notice} />
      <AppDialogActions>
        <CgButton quiet onClick={onCancel} disabled={busy}>Not now</CgButton>
        <CgButton onClick={() => { if (card) onTurnOn(card.profileId, background); }} disabled={busy || !card}>Turn on</CgButton>
      </AppDialogActions>
    </AppDialog>
  );
}

function SlotField({ label, slot, today, onChange }: { label: string; slot: NeedSlot; today: string; onChange: (slot: NeedSlot) => void }) {
  return (
    <div className="cg-meet-field cg-nb-slot" role="group" aria-label={label}>
      <span>{label}</span>
      <MeetDatePicker value={slot.date} min={today} onChange={(date) => onChange({ ...slot, date })} />
      <MeetTimePicker date={slot.date} value={slot.time} min={null} onChange={(time) => onChange({ ...slot, time })} />
    </div>
  );
}

/** New request, or Edit request with Paused and Delete request. */
export function NearbyRequestDialog({ need, busy, notice, onCancel, onSave, onDelete }: {
  need: CgNeed | null;
  busy: boolean;
  notice: string | null;
  onCancel: () => void;
  onSave: (draft: NeedDraft, initial: NeedDraft) => void;
  onDelete: () => void;
}) {
  const titleId = useId();
  const [opened] = useState(() => new Date());
  const [initial] = useState(() => needDraft(need, opened));
  const [draft, setDraft] = useState(initial);
  const edit = Boolean(need);
  const error = needDraftError(draft, edit ? initial : null);
  const ready = Boolean(draft.text.trim()) && !error && !busy;
  const today = slotOf(opened).date;
  const update = (patch: Partial<NeedDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const timeWindow = draft.window;
  return (
    <AppDialog titleId={titleId} onDismiss={onCancel} busy={busy} dismissDisabled={busy} className="cg-dialog cg-meet cg-nb-dialog">
      <AppDialogTitle id={titleId}>{edit ? 'Edit request' : 'New request'}</AppDialogTitle>
      <form className="cg-meet-form" onSubmit={(event) => { event.preventDefault(); if (ready) onSave(draft, initial); }}>
        <textarea
          autoFocus={!edit}
          className="cg-meet-input cg-nb-area"
          rows={2}
          value={draft.text}
          maxLength={NEED_TEXT_MAX}
          placeholder="Who are you looking for?"
          aria-label="Who are you looking for?"
          onChange={(event) => update({ text: event.target.value })}
        />
        <div className="cg-meet-field" role="group" aria-label="Within">
          <span>Within</span>
          <div className="cg-meet-chips" role="radiogroup" aria-label="Within">
            {NEARBY_RANGES.map(([value, label]) => (
              <button key={value} type="button" role="radio" aria-checked={draft.range === value} className={cn('cg-meet-chip', draft.range === value && 'is-on')} onClick={() => update({ range: value })}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="cg-nb-swrow">
          <span>Time window</span>
          <SettingsSwitch enabled={Boolean(timeWindow)} label="Time window" onChange={(on) => update({ window: on ? initial.window ?? defaultNeedWindow() : null })} />
        </div>
        {timeWindow ? (
          <div className="cg-meet-pair">
            <SlotField label="From" slot={timeWindow.from} today={today} onChange={(from) => update({ window: { ...timeWindow, from } })} />
            <SlotField label="Until" slot={timeWindow.until} today={today} onChange={(until) => update({ window: { ...timeWindow, until } })} />
          </div>
        ) : null}
        {edit ? (
          <div className="cg-nb-swrow">
            <span>Paused</span>
            <SettingsSwitch enabled={draft.paused} label="Paused" onChange={(paused) => update({ paused })} />
          </div>
        ) : null}
        <CgNotice text={error ?? notice} />
        <AppDialogActions className="cg-nb-actions">
          {edit ? <button type="button" className="cg-button is-danger-quiet" disabled={busy} onClick={onDelete}>Delete request</button> : null}
          <CgButton quiet onClick={onCancel} disabled={busy}>Cancel</CgButton>
          <CgButton type="submit" disabled={!ready}>Save</CgButton>
        </AppDialogActions>
      </form>
    </AppDialog>
  );
}
