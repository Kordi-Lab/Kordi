import type { DesktopChatState, DesktopChatTurnSnapshot } from '@/kordi-app/types';

import {
  createDesktopTurnRenderAlias,
  reconcileDesktopMessagesWithTurnRenderAliases,
  type DesktopTurnRenderAlias,
} from './desktopLiveTurns';

const MAX_TURN_RENDER_ALIASES = 256;

export function createDesktopTurnRenderAliasRegistry() {
  const aliases = new Map<string, DesktopTurnRenderAlias>();

  return {
    register(turn: DesktopChatTurnSnapshot, fallbackTimestampMs = Date.now()) {
      const existing = aliases.get(turn.id);
      const alias = createDesktopTurnRenderAlias(turn, fallbackTimestampMs);
      if (!alias.entryId && existing?.entryId) alias.entryId = existing.entryId;
      aliases.delete(turn.id);
      aliases.set(turn.id, alias);
      while (aliases.size > MAX_TURN_RENDER_ALIASES) {
        const oldestTurnId = aliases.keys().next().value;
        if (!oldestTurnId) break;
        aliases.delete(oldestTurnId);
      }
      return alias;
    },

    reconcile(state: DesktopChatState | null | undefined) {
      if (!state) return state;
      const messages = reconcileDesktopMessagesWithTurnRenderAliases(
        state.activeSessionId,
        state.activeSession.messages,
        aliases,
      );
      if (messages === state.activeSession.messages) return state;
      return {
        ...state,
        activeSession: { ...state.activeSession, messages },
      };
    },
  };
}
