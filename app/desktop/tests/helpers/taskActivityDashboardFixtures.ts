import type { DesktopChatTurnSnapshot, Message } from '../../src/kordi-app/types';

export function assistantTurnMessage(turn: DesktopChatTurnSnapshot): Message {
  return {
    id: `message:${turn.id}`,
    role: 'owned-agent',
    sender: 'My Kordi',
    text: turn.assistantText,
    time: '10:00',
    turn,
  };
}

export function userMessage(text: string, id = `user:${text.slice(0, 16)}`): Message {
  return {
    id,
    role: 'user',
    sender: 'Me',
    text,
    time: '10:01',
  };
}
