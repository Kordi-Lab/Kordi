import { useId, useState } from 'react';
import { Brain, Pencil, Trash2 } from 'lucide-react';

import { AppDialog, AppDialogActions, AppDialogDescription, AppDialogTitle } from '@/components/ui/dialog';
import { SettingsSwitch } from '@/kordi-app/components/settingsLayout';
import { profileDesign } from './cardDesign';
import { AddTopic, CardLine } from './CardLines';
import { CardMemories } from './CardMemories';
import { cardSources, cardTimeline, cardTopics, firstCiters, sourceLook } from './cardReferences';
import { CardNow, CardTimeline } from './CardTimeline';
import { CardLookButton, CardLookPopover } from './CardLookPopover';
import { useLookPopover } from './cardLook';
import { CgButton, CgNotice, CgProgress } from './parts';
import { CardGlyph } from './ProfileCard';
import { DeleteProfileDialog } from './ProfileDialogs';
import { PROFILE_FOCUS_MAX, PROFILE_NAME_MAX, renameError, renamePatch } from './profiles';
import { currentProfile, type CgState, type CommonGroundStore } from './store';
import { newMemoriesLine, useProfileMemories } from './storeMemories';
import { CG_TOPIC_SECTIONS, type CgOwnCard, type CgProfileKind, type CgTopicKey, type CgTopicLists } from './types';
import { ownerIsCurrent, shortDay } from './wallet';

function lists(card: CgOwnCard): CgTopicLists {
  return { workingOn: [...card.workingOn], interests: [...card.interests], canHelp: [...card.canHelp], lookingFor: [...card.lookingFor] };
}

function DeleteCardDialog({ busy, onCancel, onDelete }: { busy: boolean; onCancel: () => void; onDelete: () => void }) {
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

/** Rename in place: the name (and focus) lines become fields; Enter or leaving saves, Escape cancels. */
export function RenameFields({ name, focus, kind, withFocus = true, onSave, onCancel }: {
  name: string;
  focus: string;
  kind: CgProfileKind;
  withFocus?: boolean;
  onSave: (name: string, focus: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState({ name, focus });
  const [error, setError] = useState<string | null>(null);
  const save = () => {
    const refused = renameError(kind, draft.name);
    setError(refused);
    if (!refused) onSave(draft.name.trim(), draft.focus.trim());
  };
  const keys = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter') save();
    if (event.key === 'Escape') { event.stopPropagation(); onCancel(); }
  };
  return (
    <div
      className="cg-cardpage-fields"
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) save(); }}
    >
      <input autoFocus className="cg-cardpage-name-in" value={draft.name} maxLength={PROFILE_NAME_MAX} aria-label="Name" aria-invalid={error ? true : undefined} onKeyDown={keys} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
      {withFocus ? <input className="cg-cardpage-focus-in" value={draft.focus} maxLength={PROFILE_FOCUS_MAX} placeholder="Focus, optional" aria-label="Focus" onKeyDown={keys} onChange={(event) => setDraft({ ...draft, focus: event.target.value })} /> : null}
      {error ? <div className="cg-cardpage-error" role="alert">{error}</div> : null}
    </div>
  );
}

/**
 * The card page: a slim header, Now, the topics with their references, the memories filed to the
 * profile (`memoryVersion` 2), the timeline, the sources, and Share my card.
 */
export function CardScreen({ state, store, memoryRouting = false }: { state: CgState; store: CommonGroundStore; memoryRouting?: boolean }) {
  const [confirming, setConfirming] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const look = useLookPopover();
  const routed = useProfileMemories(store, state.profileId, memoryRouting);
  const card = state.owner?.card;
  if (!card || !state.owner) return null;
  // Switching cards keeps the new name off the old topics until the new card arrives.
  if (!ownerIsCurrent(state)) return <><CgProgress line="Opening card" /><CgNotice text={state.notice} /></>;
  const profile = currentProfile(state);
  const design = profile ? profileDesign(profile) : 'work';
  const name = profile?.name ?? 'Your card';
  const update = (key: CgTopicKey, next: string[]) => void store.saveTopics({ ...lists(card), [key]: next });
  const lineCount = CG_TOPIC_SECTIONS.reduce((sum, [key]) => sum + card[key].length, 0);
  const meta = [`${lineCount} ${lineCount === 1 ? 'line' : 'lines'}`, card.builtAt ? `built ${shortDay(card.builtAt)}` : ''].filter(Boolean).join(' · ');
  const fresh = memoryRouting ? newMemoriesLine(state.owner.memoriesSinceBuild) : null;
  const sources = cardSources(card);
  const owners = firstCiters(card);
  const onCard = new Set(cardTopics(card));
  const timeline = cardTimeline(card);
  return (
    <div className="cg-cardpage">
      <div className="cg-cardpage-head">
        {profile ? (
          <span className="cg-look-anchor">
            <CardLookButton design={design} icon={profile.icon} kind={profile.kind} className="cg-cardpage-glyph" open={look.open} onToggle={look.toggle} />
            {look.open ? (
              <CardLookPopover
                design={design}
                icon={profile.icon}
                onClose={look.close}
                onDesign={(next) => void store.setLook(profile.profileId, { design: next })}
                onIcon={(next) => void store.setLook(profile.profileId, { icon: next })}
              />
            ) : null}
          </span>
        ) : <span className="cg-cardpage-glyph" data-design={design}><CardGlyph design={design} /></span>}
        <div className="cg-cardpage-title">
          {renaming && profile ? (
            <RenameFields
              name={profile.name}
              focus={profile.focus ?? ''}
              kind={profile.kind}
              onCancel={() => setRenaming(false)}
              onSave={(nextName, nextFocus) => {
                setRenaming(false);
                const patch = renamePatch(profile, nextName, nextFocus);
                if (Object.keys(patch).length) void store.updateProfile(profile.profileId, patch);
              }}
            />
          ) : (
            <>
              <h2>{name}</h2>
              {profile?.focus ? <div className="cg-cardpage-focus">{profile.focus}</div> : null}
              <div className="cg-cardpage-meta">{meta}{fresh ? <span data-cg-new-memories=""> · {fresh}</span> : null}</div>
            </>
          )}
        </div>
        {profile ? (
          <button type="button" className="cg-mbtn is-ghost" onClick={() => setRenaming(true)} disabled={renaming}>
            <Pencil className="h-[13px] w-[13px]" aria-hidden="true" />Rename
          </button>
        ) : null}
        <button type="button" className="cg-mbtn is-ghost is-danger" onClick={() => setConfirming(true)}>
          <Trash2 className="h-[13px] w-[13px]" aria-hidden="true" />Delete
        </button>
        <button type="button" className="cg-mbtn is-primary" onClick={() => store.open({ name: 'build', memory: true })}>
          <Brain className="h-[13px] w-[13px]" aria-hidden="true" />Rebuild from memory
        </button>
      </div>
      <CardNow topics={timeline.now} onCard={onCard} />
      {CG_TOPIC_SECTIONS.map(([key, title]) => (
        <section key={key}>
          <h3 className="cg-msec">{title}</h3>
          <div className="cg-panel cg-lines">
            {card[key].map((topic) => (
              <CardLine
                key={topic}
                card={card}
                topic={topic}
                owners={owners}
                onHide={() => void store.toggleHidden(topic)}
                onRemove={() => update(key, card[key].filter((item) => item !== topic))}
              />
            ))}
            <div className="cg-line-foot">
              <AddTopic
                onAdd={(topic) => {
                  if (card[key].some((item) => item.toLowerCase() === topic.toLowerCase())) return;
                  update(key, [...card[key], topic]);
                }}
              />
            </div>
          </div>
        </section>
      ))}
      {profile ? (
        <CardMemories
          memories={routed.memories}
          profiles={state.profiles}
          profileId={profile.profileId}
          onMove={(memoryId, target) => void routed.move(memoryId, target)}
          onRemove={(memoryId) => void routed.remove(memoryId)}
        />
      ) : null}
      <CardTimeline rows={timeline.rows} earlier={timeline.earlier} onCard={onCard} />
      {sources.length ? (
        <>
          <h3 className="cg-msec">Sources</h3>
          <div className="cg-panel">
            {sources.map(({ source }) => {
              const { Icon, tint } = sourceLook(source);
              return (
                <div key={source} className="cg-mrow">
                  <span className="cg-src-icon" style={{ background: tint }}><Icon className="h-[15px] w-[15px]" aria-hidden="true" /></span>
                  <span className="cg-mrow-text">
                    <span className="cg-mrow-title">{source}</span>
                    {card.builtAt ? <span className="cg-mrow-sub">Read {shortDay(card.builtAt)}</span> : null}
                  </span>
                </div>
              );
            })}
          </div>
        </>
      ) : null}
      <div className="cg-panel cg-cardpage-share">
        <div className="cg-mrow">
          <span className="cg-mrow-text"><span className="cg-mrow-title">Share my card</span></span>
          <SettingsSwitch label="Share my card" enabled={state.owner.sharing} disabled={state.busy === 'sharing'} onChange={(on) => void store.setSharing(on)} />
        </div>
      </div>
      <CgNotice text={state.notice} />
      {confirming && profile ? (
        <DeleteProfileDialog
          profile={profile}
          busy={state.busy === 'profile'}
          onCancel={() => setConfirming(false)}
          onDelete={() => void store.deleteProfile(profile.profileId).then(() => setConfirming(false))}
        />
      ) : null}
      {confirming && !profile ? (
        <DeleteCardDialog
          busy={state.busy === 'delete'}
          onCancel={() => setConfirming(false)}
          onDelete={() => void store.deleteCard().then(() => setConfirming(false))}
        />
      ) : null}
    </div>
  );
}
