import type { ChatSidebarRow } from './chatSidebarRows';

export const CHANNEL_HEIGHT = 46;
export const HEADER_HEIGHT = 64;
export const OVERSCAN = 4;

export type ParticipantSpaceBlock = {
  header: Extract<ChatSidebarRow, { kind: 'space' }>;
  channels: ChatSidebarRow[];
};

export function participantSpaceBlocks(rows: readonly ChatSidebarRow[]): ParticipantSpaceBlock[] {
  const blocks: ParticipantSpaceBlock[] = [];
  for (const row of rows) {
    if (row.kind === 'space') blocks.push({ header: row, channels: [] });
    else blocks[blocks.length - 1]?.channels.push(row);
  }
  return blocks;
}

export function visibleChannelRange(count: number, offset: number, viewportHeight: number) {
  const start = Math.max(0, Math.min(count, Math.floor(offset / CHANNEL_HEIGHT) - OVERSCAN));
  const end = Math.max(start, Math.min(count, Math.ceil((offset + viewportHeight) / CHANNEL_HEIGHT) + OVERSCAN));
  return { start, end };
}
