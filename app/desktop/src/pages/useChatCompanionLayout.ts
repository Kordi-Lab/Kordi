import { useRef, useState } from 'react';
import { focusCompanionToggleFromPanel, useCompanionPanelPresence } from './useCompanionPanelPresence';
import type {
  DragEvent,
  PointerEvent as ReactPointerEvent,
  KeyboardEvent,
} from 'react';

import type { Conversation } from '@/kordi-app/types';
import {
  CHAT_COMPANION_DRAG_TYPE,
  chatCompanionSideForPaneKinds,
  chatCompanionSideFromDropPosition,
  clampChatSplitFraction,
  humanSideForCompanionSide,
  type CompanionSide,
} from '@/pages/chatsPage.model';

type UseChatCompanionLayoutInput = {
  pageConversationId: string;
  activePaneKind: 'human' | 'agent' | null;
  companionConversation: Conversation | null;
  hasOverview?: boolean;
  onHide?: () => void;
};

/** The split track is one hairline; the divider's hit area extends over both panes. */
const SPLIT_DIVIDER_WIDTH = 1;

export function useChatCompanionLayout({
  pageConversationId,
  activePaneKind,
  companionConversation,
  hasOverview = false,
  onHide,
}: UseChatCompanionLayoutInput) {
  const [humanPaneSide, setHumanPaneSide] = useState<CompanionSide>('left');
  const [foldedState, setFoldedState] = useState({
    pageConversationId,
    value: false,
  });
  const isFolded = foldedState.pageConversationId === pageConversationId
    ? foldedState.value
    : false;
  if (foldedState.pageConversationId !== pageConversationId) {
    setFoldedState({
      pageConversationId,
      value: false,
    });
  }
  const [splitLeftFraction, setSplitLeftFraction] = useState(0.5);
  const [dropPreviewSide, setDropPreviewSide] = useState<CompanionSide | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const side = chatCompanionSideForPaneKinds(activePaneKind, humanPaneSide);
  const isVisible = Boolean((companionConversation || hasOverview) && !isFolded);
  const panelMotion = useCompanionPanelPresence(isVisible, pageConversationId);

  const placeCompanion = (nextSide: CompanionSide) => {
    setHumanPaneSide(humanSideForCompanionSide(activePaneKind, nextSide));
  };
  const updateDropPreview = (event: DragEvent<HTMLElement>) => {
    if (!companionConversation || isFolded) return null;
    const rect = event.currentTarget.getBoundingClientRect();
    const nextSide = chatCompanionSideFromDropPosition(
      event.clientX,
      rect.left,
      rect.width,
    );
    setDropPreviewSide(nextSide);
    return nextSide;
  };
  const onDragStart = (event: DragEvent<HTMLElement>) => {
    if (!companionConversation) return;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(CHAT_COMPANION_DRAG_TYPE, companionConversation.id);
    setIsDragging(true);
    setDropPreviewSide(side);
  };
  const onDragEnd = () => {
    setIsDragging(false);
    setDropPreviewSide(null);
  };
  const onDragOver = (event: DragEvent<HTMLElement>) => {
    if (!isDragging) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    updateDropPreview(event);
  };
  const onDrop = (event: DragEvent<HTMLElement>) => {
    if (!isDragging) return;
    event.preventDefault();
    const nextSide = updateDropPreview(event);
    if (nextSide) placeCompanion(nextSide);
    setIsDragging(false);
    setDropPreviewSide(null);
  };

  const updateSplit = (clientX: number) => {
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    if (rect.width <= 0) return;
    setSplitLeftFraction(
      clampChatSplitFraction((clientX - rect.left) / rect.width),
    );
  };
  const onDividerPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsResizing(true);
    event.currentTarget.setPointerCapture(event.pointerId);
    updateSplit(event.clientX);
  };
  const onDividerPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    updateSplit(event.clientX);
  };
  const onDividerPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    setIsResizing(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const onDividerKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home') return;
    event.preventDefault();
    setSplitLeftFraction(current => event.key === 'Home' ? 0.5 : clampChatSplitFraction(current + (event.key === 'ArrowLeft' ? -0.05 : 0.05)));
  };

  return {
    side,
    isVisible,
    isPresent: panelMotion.present,
    motionDuration: isResizing ? 0 : panelMotion.duration,
    isFolded,
    isDragging,
    dropPreviewSide,
    containerRef,
    // Keep all three tracks, including the zero-width closed track, so the
    // browser can interpolate space continuously and reverse mid-transition.
    gridColumns: side === 'right'
      ? `minmax(280px, 1fr) ${isVisible ? SPLIT_DIVIDER_WIDTH : 0}px minmax(${isVisible ? 280 : 0}px, ${isVisible ? (1 - splitLeftFraction) / splitLeftFraction : 0}fr)`
      : `minmax(${isVisible ? 280 : 0}px, ${isVisible ? splitLeftFraction / (1 - splitLeftFraction) : 0}fr) ${isVisible ? SPLIT_DIVIDER_WIDTH : 0}px minmax(280px, 1fr)`,
    panelWidth: `clamp(280px, calc((100cqw - ${SPLIT_DIVIDER_WIDTH}px) * ${side === 'right' ? 1 - splitLeftFraction : splitLeftFraction}), calc(100cqw - ${280 + SPLIT_DIVIDER_WIDTH}px))`,
    setFolded: (value: boolean) => {
      if (value) {
        focusCompanionToggleFromPanel();
        onHide?.();
      }
      setFoldedState({ pageConversationId, value });
    },
    placeCompanion,
    clearDropPreview: () => setDropPreviewSide(null),
    onDragStart,
    onDragEnd,
    onDragOver,
    onDrop,
    onDividerKeyDown,
    splitPercent: Math.round(splitLeftFraction * 100),
    onDividerPointerDown,
    onDividerPointerMove,
    onDividerPointerUp,
  };
}
