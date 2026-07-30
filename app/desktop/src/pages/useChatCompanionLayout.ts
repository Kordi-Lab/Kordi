import { useRef, useState } from 'react';
import type {
  DragEvent,
  PointerEvent as ReactPointerEvent,
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
};

export function useChatCompanionLayout({
  pageConversationId,
  activePaneKind,
  companionConversation,
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
  const containerRef = useRef<HTMLDivElement | null>(null);
  const side = chatCompanionSideForPaneKinds(activePaneKind, humanPaneSide);
  const isVisible = Boolean(companionConversation && !isFolded);

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
    event.currentTarget.setPointerCapture(event.pointerId);
    updateSplit(event.clientX);
  };
  const onDividerPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    updateSplit(event.clientX);
  };
  const onDividerPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return {
    side,
    isVisible,
    isFolded,
    isDragging,
    dropPreviewSide,
    containerRef,
    gridColumns: isVisible
      ? `minmax(280px, ${splitLeftFraction}fr) 10px minmax(280px, ${1 - splitLeftFraction}fr)`
      : undefined,
    setFolded: (value: boolean) => setFoldedState({
      pageConversationId,
      value,
    }),
    placeCompanion,
    clearDropPreview: () => setDropPreviewSide(null),
    onDragStart,
    onDragEnd,
    onDragOver,
    onDrop,
    onDividerPointerDown,
    onDividerPointerMove,
    onDividerPointerUp,
  };
}
