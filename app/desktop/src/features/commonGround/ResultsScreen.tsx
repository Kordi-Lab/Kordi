import { useState } from 'react';
import { Copy, LogOut, Users } from 'lucide-react';

import { DetailTile, DetailTiles } from '@/kordi-app/contacts/ContactDetailParts';
import type { CgHost } from './host';
import { groupLine, peopleCount, roomTitle, topicGroupDraft, type CgGroupDraft } from './format';
import { CgAvatar, CgAvatarGrid, CgAvatarStack, CgBack, CgButton, CgGroup, CgHero, CgNotice, CgProgress, CgRow, CgScore, CgSection, CgSegmented, CgTopicDot } from './parts';
import { StartGroupDialog } from './StartGroupDialog';
import { roomClosed, type CgState, type CommonGroundStore } from './store';
import type { CgPerson, CgResults } from './types';

function names(people: CgPerson[], selfId: string) {
  const others = people.filter((person) => person.accountId !== selfId).map((person) => person.name);
  if (others.length < 2) return ['You', ...others].join(' and ');
  return `You, ${others.slice(0, -1).join(', ')} and ${others[others.length - 1]}`;
}

function candidates(results: CgResults, members: CgPerson[], selfId: string): CgPerson[] {
  const byId = new Map<string, CgPerson>();
  for (const person of [...results.people.map((entry) => entry.person), ...members]) {
    if (person.accountId !== selfId && !byId.has(person.accountId)) byId.set(person.accountId, person);
  }
  return [...byId.values()];
}

function GroupsSection({ code, results, state, store, host }: { code: string; results: CgResults; state: CgState; store: CommonGroundStore; host: CgHost }) {
  const groups = results.groups ?? [];
  const invitations = state.support.invitations ? results.invitations ?? [] : [];
  if (!groups.length && !invitations.length) return null;
  return (
    <CgSection title="Groups">
      <CgGroup>
        {groups.map((group) => (
          <CgRow
            key={group.groupSpaceId}
            lead={group.members?.length
              ? <CgAvatarStack people={group.members} total={group.memberCount} size={26} />
              : <span className="cg-icon" aria-hidden="true"><Users className="h-4 w-4" /></span>}
            title={group.name}
            sub={groupLine(group) || undefined}
            trailing={group.joined ? <CgButton onClick={() => host.openGroup(group.groupSpaceId)}>Open</CgButton> : null}
          />
        ))}
        {invitations.map((invitation) => (
          <CgRow
            key={invitation.invitationRef}
            lead={<CgAvatar person={invitation.from} size={32} />}
            title={`${invitation.from.name} invited you to ${invitation.name}`}
            trailing={(
              <CgButton onClick={() => void store.joinInvitation(code, invitation.invitationRef).then((id) => { if (id) host.openGroup(id); })}>
                Join
              </CgButton>
            )}
          />
        ))}
      </CgGroup>
    </CgSection>
  );
}

export function ResultsScreen({ code, state, store, host }: { code: string; state: CgState; store: CommonGroundStore; host: CgHost }) {
  const [tab, setTab] = useState<'people' | 'topics'>('people');
  const [starting, setStarting] = useState<CgGroupDraft | null>(null);
  const [copied, setCopied] = useState(false);
  const results = state.results[code];
  const room = state.rooms[code];
  const selfId = host.self.accountId;
  const closed = roomClosed(state, code);
  if (!results) return <><CgBack onBack={() => store.home()} />{state.notice ? <CgNotice text={state.notice} /> : <CgProgress line="Finding overlap" />}</>;
  const members = room?.members ?? [];
  const everyone = [host.self, ...members];
  const suggestion = results.suggestion;
  const canGroup = state.support.group;
  const startGroup = (theme: { label: string; people: CgPerson[] }) => setStarting(topicGroupDraft(theme, selfId));
  const line = `${peopleCount(everyone.length)} · ${results.topics.length} shared topics`;

  return (
    <>
      <CgBack onBack={() => store.home()} />
      <CgHero
        avatar={<CgAvatarGrid people={everyone} size={72} />}
        title={roomTitle(code, room?.name)}
        line={closed ? `${line} · Closed` : line}
      />
      {closed ? null : (
        <DetailTiles>
          <DetailTile
            icon={<Copy className="h-5 w-5" aria-hidden="true" />}
            label={copied ? 'Copied' : 'Share code'}
            onClick={() => void navigator.clipboard?.writeText(code).then(() => setCopied(true), () => undefined)}
          />
          <DetailTile icon={<LogOut className="h-5 w-5" aria-hidden="true" />} label="Leave" onClick={() => void store.leaveRoom(code)} />
        </DetailTiles>
      )}
      <CgNotice text={state.notice} />
      {results.status === 'matching' ? <CgProgress line="Finding overlap" /> : null}
      {suggestion ? (
        <CgSection title="Suggested">
          <CgGroup>
            <CgRow
              lead={<CgAvatarGrid people={suggestion.people} size={36} />}
              title={suggestion.label}
              sub={names(suggestion.people, selfId)}
              trailing={canGroup ? <CgButton onClick={() => startGroup(suggestion)}>Start group</CgButton> : null}
            />
          </CgGroup>
        </CgSection>
      ) : null}
      <CgSegmented value={tab} onChange={setTab} label="Results" options={[['people', 'People'], ['topics', 'Topics']]} />
      <CgSection>
        <CgGroup>
          {tab === 'people'
            ? results.people.map((entry) => (
              <CgRow
                key={entry.person.accountId}
                lead={<CgAvatar person={entry.person} size={36} />}
                title={entry.person.name}
                sub={entry.headline}
                trailing={<CgScore score={entry.score} />}
                onClick={() => store.open({ name: 'match', accountId: entry.person.accountId })}
              />
            ))
            : results.topics.map((theme) => (
              <CgRow
                key={theme.label}
                lead={<CgTopicDot topic={theme.label} />}
                title={theme.label}
                sub={peopleCount(theme.people.length)}
                trailing={(
                  <span className="cg-row-actions">
                    <CgAvatarGrid people={theme.people} size={30} />
                    {canGroup ? <CgButton onClick={() => startGroup(theme)} label={`Start a group for ${theme.label}`}>Start</CgButton> : null}
                  </span>
                )}
              />
            ))}
          {(tab === 'people' ? results.people : results.topics).length === 0 && results.status !== 'matching'
            ? <CgRow title={<span className="cg-muted">{tab === 'people' ? 'No matches yet' : 'No shared topics yet'}</span>} />
            : null}
        </CgGroup>
      </CgSection>
      <GroupsSection code={code} results={results} state={state} store={store} host={host} />
      {closed ? (
        <div className="cg-actions-end">
          <button type="button" className="cg-button is-danger-quiet" onClick={() => void store.leaveRoom(code)}>Remove</button>
        </div>
      ) : null}
      {starting ? (
        <StartGroupDialog
          name={starting.name}
          people={candidates(results, members, selfId)}
          selected={starting.selected}
          busy={state.busy === 'group'}
          onCancel={() => setStarting(null)}
          onCreate={(name, ids) => void store.createGroup(code, name, ids, starting.topic ?? undefined).then((created) => {
            if (!created) return;
            host.openGroup(created.group.groupSpaceId);
            setStarting(null);
          })}
        />
      ) : null}
    </>
  );
}
