import { useId, useState } from 'react';
import { Plus } from 'lucide-react';

import { AppDialog, AppDialogActions, AppDialogDescription, AppDialogTitle } from '@/components/ui/dialog';
import { SettingsSwitch } from '@/kordi-app/components/settingsLayout';
import { cn } from '@/lib/utils';
import { CgBack, CgButton, CgGroup, CgNotice, CgRow, CgSection } from './parts';
import { topicTone } from './format';
import type { CgState, CommonGroundStore } from './store';
import { CG_TOPIC_SECTIONS, type CgOwnCard, type CgTopicKey, type CgTopicLists } from './types';

export const TOPIC_MAX_CHARS = 40;

function lists(card: CgOwnCard): CgTopicLists {
  return { workingOn: [...card.workingOn], interests: [...card.interests], canHelp: [...card.canHelp], lookingFor: [...card.lookingFor] };
}

function AddTopic({ onAdd }: { onAdd: (topic: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  if (!editing) {
    return (
      <button type="button" className="cg-tag is-add" onClick={() => setEditing(true)}>
        <Plus className="h-3.5 w-3.5" aria-hidden="true" />
        Add
      </button>
    );
  }
  const commit = () => {
    const topic = text.replace(/\s+/g, ' ').trim();
    setEditing(false);
    setText('');
    if (topic) onAdd(topic);
  };
  return (
    <span className="cg-tag is-add is-editing">
      <input
        autoFocus
        value={text}
        maxLength={TOPIC_MAX_CHARS}
        size={Math.max(9, text.length + 1)}
        placeholder="New topic"
        aria-label="New topic"
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit();
          if (event.key === 'Escape') {
            event.stopPropagation();
            setEditing(false);
            setText('');
          }
        }}
      />
      {text.length >= TOPIC_MAX_CHARS - 10 ? <span className="cg-count">{text.length}/{TOPIC_MAX_CHARS}</span> : null}
    </span>
  );
}

function DeleteDialog({ busy, onCancel, onDelete }: { busy: boolean; onCancel: () => void; onDelete: () => void }) {
  const titleId = useId();
  const lineId = useId();
  return (
    <AppDialog titleId={titleId} descriptionId={lineId} onDismiss={onCancel} busy={busy} dismissDisabled={busy}>
      <AppDialogTitle id={titleId}>Delete your card?</AppDialogTitle>
      <AppDialogDescription id={lineId}>Your matches and rooms go with it.</AppDialogDescription>
      <AppDialogActions>
        <CgButton quiet onClick={onCancel} disabled={busy}>Cancel</CgButton>
        <button type="button" className="cg-button is-danger" onClick={onDelete} disabled={busy}>Delete</button>
      </AppDialogActions>
    </AppDialog>
  );
}

export function CardScreen({ state, store }: { state: CgState; store: CommonGroundStore }) {
  const [confirming, setConfirming] = useState(false);
  const card = state.owner?.card;
  if (!card || !state.owner) return null;
  const update = (key: CgTopicKey, next: string[]) => void store.saveTopics({ ...lists(card), [key]: next });
  return (
    <>
      <CgBack onBack={() => store.back()} />
      {CG_TOPIC_SECTIONS.map(([key, title]) => (
        <CgSection key={key} title={title}>
          <CgGroup className="cg-tags">
            {card[key].map((topic) => {
              const hidden = card.hidden.includes(topic);
              return (
                <span key={topic} className={cn('cg-tag', `tone-${topicTone(topic)}`, hidden && 'is-muted')}>
                  <i aria-hidden="true" />
                  <button
                    type="button"
                    className="cg-tag-text"
                    title={hidden ? 'Hidden' : topic}
                    aria-label={hidden ? `Show ${topic}` : `Hide ${topic}`}
                    onClick={() => void store.toggleHidden(topic)}
                  >
                    {topic}
                  </button>
                  <button type="button" className="cg-tag-x" aria-label={`Remove ${topic}`} onClick={() => update(key, card[key].filter((item) => item !== topic))}>×</button>
                </span>
              );
            })}
            <AddTopic
              onAdd={(topic) => {
                if (card[key].some((item) => item.toLowerCase() === topic.toLowerCase())) return;
                update(key, [...card[key], topic]);
              }}
            />
          </CgGroup>
        </CgSection>
      ))}
      <CgSection>
        <CgGroup>
          <CgRow
            title="Share my card"
            trailing={<SettingsSwitch label="Share my card" enabled={state.owner.sharing} disabled={state.busy === 'sharing'} onChange={(on) => void store.setSharing(on)} />}
          />
        </CgGroup>
      </CgSection>
      <CgNotice text={state.notice} />
      <div className="cg-footer-actions">
        <CgButton quiet onClick={() => store.open({ name: 'build' })}>Rebuild</CgButton>
        <button type="button" className="cg-button is-danger-quiet" onClick={() => setConfirming(true)}>Delete card</button>
      </div>
      {confirming ? (
        <DeleteDialog
          busy={state.busy === 'delete'}
          onCancel={() => setConfirming(false)}
          onDelete={() => void store.deleteCard().then(() => setConfirming(false))}
        />
      ) : null}
    </>
  );
}
