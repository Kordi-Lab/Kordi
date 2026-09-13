import { useState } from 'react';
import type { DesktopChatTurnSnapshot } from '@/kordi-app/types';
import { mergeDesktopTurnSnapshot } from './desktopLiveTurns';

function withoutReasoning(turn: DesktopChatTurnSnapshot, showReasoning: boolean) {
  return showReasoning || !turn.thinkingText ? turn : { ...turn, thinkingText: '' };
}

/** Keep one owner's visible trace through the live-to-history handoff. */
export function useVisibleLiveTurn(turn: DesktopChatTurnSnapshot, historical: boolean, showReasoning: boolean) {
  const [state, setState] = useState(() => ({
    input: turn, historical, showReasoning, visible: withoutReasoning(turn, showReasoning),
  }));
  if (state.input === turn && state.historical === historical && state.showReasoning === showReasoning) return state.visible;
  const sameTurn = state.showReasoning === showReasoning
    && state.visible.id === turn.id && state.visible.sessionId === turn.sessionId;
  let visible = sameTurn && !historical ? mergeDesktopTurnSnapshot(state.visible, turn) : turn;
  if (sameTurn && showReasoning && state.visible.thinkingText.length > visible.thinkingText.length) {
    visible = { ...visible, thinkingText: state.visible.thinkingText };
  }
  visible = withoutReasoning(visible, showReasoning);
  // A render-time adjustment commits one snapshot; an effect would paint the
  // public/empty intermediate state before restoring the owner's trace.
  setState({ input: turn, historical, showReasoning, visible });
  return visible;
}
