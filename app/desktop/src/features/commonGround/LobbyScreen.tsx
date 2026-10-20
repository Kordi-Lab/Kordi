import { LogOut, Sparkles } from 'lucide-react';

import { DetailTile, DetailTiles } from '@/kordi-app/contacts/ContactDetailParts';
import { peopleCount, roomTitle } from './format';
import type { CgHost } from './host';
import { CgAvatar, CgAvatarGrid, CgBack, CgHero, CgNotice, CgProgress } from './parts';
import type { CgState, CommonGroundStore } from './store';

export function LobbyScreen({ code, state, store, host }: { code: string; state: CgState; store: CommonGroundStore; host: CgHost }) {
  const room = state.rooms[code];
  if (!room) return <><CgBack onBack={() => store.back()} /><CgProgress line="Joining" /></>;
  const everyone = [host.self, ...room.members];
  const finding = state.busy === 'find';
  return (
    <>
      <CgBack onBack={() => store.back()} />
      <CgHero
        avatar={<CgAvatarGrid people={everyone} size={72} />}
        title={roomTitle(code, room.name)}
        line={room.name ? `Room ${code} · ${peopleCount(everyone.length)}` : peopleCount(everyone.length)}
      />
      <DetailTiles>
        <DetailTile
          icon={<Sparkles className="h-5 w-5" aria-hidden="true" />}
          label="Find common ground"
          tone="primary"
          disabled={room.members.length < 2 || finding}
          onClick={() => void store.findCommonGround(code)}
        />
        <DetailTile icon={<LogOut className="h-5 w-5" aria-hidden="true" />} label="Leave" onClick={() => void store.leaveRoom(code)} />
      </DetailTiles>
      <CgNotice text={state.notice} />
      {finding ? <CgProgress line={`Reading ${everyone.length} cards`} /> : null}
      <div className="cg-members">
        <div className="cg-member">
          <CgAvatar person={host.self} size={52} isSelf />
          <span>You</span>
        </div>
        {room.members.map((member) => (
          <button key={member.accountId} type="button" className="cg-member" onClick={() => store.open({ name: 'person', accountId: member.accountId })}>
            <CgAvatar person={member} size={52} />
            <span>{member.name}</span>
          </button>
        ))}
      </div>
      {room.members.length === 0 ? <div className="cg-hint">Waiting for others</div> : null}
    </>
  );
}
