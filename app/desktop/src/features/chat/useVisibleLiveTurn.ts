import { useState } from 'react';
import type { DesktopChatTurnSnapshot } from '@/kordi-app/types';
import { cloudAgentPublicBackgroundToolsFromTurn } from '../cloud/cloudAgentBackgroundSessions';
import { mergeDesktopTurnSnapshot } from './desktopLiveTurns';

function visibleExecution(turn: DesktopChatTurnSnapshot, showReasoning: boolean) {
  return showReasoning ? turn : { ...turn, thinkingText: '', tools: cloudAgentPublicBackgroundToolsFromTurn(turn) };
}

/** Keep one owner's visible trace through the live-to-history handoff. */
export function useVisibleLiveTurn(turn: DesktopChatTurnSnapshot, historical: boolean, showReasoning: boolean) {
  const [state, setState] = useState(() => ({
    input: turn, historical, showReasoning, visible: visibleExecution(turn, showReasoning),
  }));
  if (state.input === turn && state.historical === historical && state.showReasoning === showReasoning) return state.visible;
  const sameTurn = state.showReasoning === showReasoning
    && state.visible.id === turn.id && state.visible.sessionId === turn.sessionId;
  const merged = sameTurn ? mergeDesktopTurnSnapshot(state.visible, turn) : turn;
  let visible = historical ? turn : merged;
  if (sameTurn && showReasoning) {
    const previous = state.visible;
    // Shared task summaries must not replace or duplicate the local tool calls.
    const publicTool = (tool: DesktopChatTurnSnapshot['tools'][number]) =>
      tool.name === 'task_operator' && tool.id.startsWith('background-session:');
    const hasPrivateTools = previous.tools.some(tool => !publicTool(tool));
    const publicOrEmpty = turn.tools.every(publicTool);
    visible = {
      ...visible,
      thinkingText: merged.thinkingText,
      tools: hasPrivateTools ? (publicOrEmpty ? previous.tools : merged.tools) : turn.tools,
    };
  }
  visible = visibleExecution(visible, showReasoning);
  // A render-time adjustment commits one snapshot; an effect would paint the
  // public/empty intermediate state before restoring the owner's trace.
  setState({ input: turn, historical, showReasoning, visible });
  return visible;
}
