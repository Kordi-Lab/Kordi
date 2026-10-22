// Pair code operations for the Grounding store: look up the room behind four typed
// digits before joining, and create a code for a new meetup.

import { commonGroundErrorCode, commonGroundErrorMessage, isRouteMissing, type CommonGroundClient } from './client';
import type { CgScreen, CgState } from './store';
import type { CgCreateRoomInput, CgRoom, CgRoomPreview, CgRoomSummary } from './types';

/** The parts of the store these operations use. */
export type CgRoomStoreHost = {
  readonly client: CommonGroundClient;
  getSnapshot: () => CgState;
  set: (patch: Partial<CgState>) => void;
  open: (screen: CgScreen) => void;
  openRoom: (code: string) => void;
  loadRooms: () => Promise<void>;
};

/**
 * What four digits lead to: a room already in your list opens, an open room shows its name,
 * kind and people before you join, and an unknown code is not found. Servers without the
 * preview route show the code alone and join as before.
 */
export type CgCodeLookup =
  | { status: 'joined'; code: string }
  | { status: 'preview'; room: CgRoomPreview }
  | { status: 'missing'; code: string }
  | { status: 'error'; message: string };

export async function lookUpCode(host: CgRoomStoreHost, code: string): Promise<CgCodeLookup> {
  if (host.getSnapshot().roomList.some((room) => room.code === code && room.open)) return { status: 'joined', code };
  try {
    return { status: 'preview', room: await host.client.previewRoom(code) };
  } catch (error) {
    if (isRouteMissing(error)) return { status: 'preview', room: { code, name: '', kind: null, memberCount: null } };
    if (commonGroundErrorCode(error) === 'common_ground_room_not_found') return { status: 'missing', code };
    return { status: 'error', message: commonGroundErrorMessage(error) };
  }
}

function summaryOf(room: CgRoom, input: CgCreateRoomInput): CgRoomSummary {
  const now = new Date().toISOString();
  return {
    code: room.code,
    name: room.name || input.name,
    open: room.open !== false,
    memberCount: room.members.length + 1,
    joinedAt: now,
    lastActivityAt: now,
    themeCount: 0,
    kind: room.kind ?? input.kind,
    profileId: room.profileId ?? input.profileId ?? null,
  };
}

/** Opens a meetup on a new code; it goes to the top of Rooms. Errors behave like a join's. */
export async function createRoom(host: CgRoomStoreHost, input: CgCreateRoomInput): Promise<CgRoom | null> {
  try {
    host.set({ busy: 'create', notice: null });
    const room = await host.client.createRoom(input);
    const { rooms, roomList } = host.getSnapshot();
    host.set({
      rooms: { ...rooms, [room.code]: room },
      roomList: [summaryOf(room, input), ...roomList.filter((entry) => entry.code !== room.code)],
    });
    void host.loadRooms();
    return room;
  } catch (error) {
    if (commonGroundErrorCode(error) === 'common_ground_no_card') host.open({ name: 'build' });
    else host.set({ notice: commonGroundErrorMessage(error) });
    return null;
  } finally {
    if (host.getSnapshot().busy === 'create') host.set({ busy: null });
  }
}
