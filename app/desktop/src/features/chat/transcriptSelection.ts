import {
  useCallback,
  useRef,
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from 'react';

import {
  clearNativeTextSelection,
  isEditableSelectionTarget,
  isSelectAllShortcut,
} from '@/features/contentSelection';

export type TranscriptSelectionProps = {
  selectionMode?: boolean;
  onSelectAllMessages?: () => void;
  onCancelMessageSelection?: () => void;
};

type UseTranscriptSelectionViewportPropsArgs = TranscriptSelectionProps & {
  cancelTailAlignment: () => void;
  viewportRef: RefObject<HTMLDivElement | null>;
};

export function useTranscriptSelectionViewportProps({
  cancelTailAlignment,
  viewportRef,
  selectionMode = false,
  onSelectAllMessages,
  onCancelMessageSelection,
}: UseTranscriptSelectionViewportPropsArgs) {
  const pointerFocusPendingRef = useRef(false);

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) {
      event.currentTarget.dataset.transcriptKeyboardFocus = 'true';
    }
    if (isEditableSelectionTarget(event.target)) return;
    if (isSelectAllShortcut(event)) {
      event.preventDefault();
      clearNativeTextSelection();
      onSelectAllMessages?.();
      return;
    }
    if (event.key !== 'Escape' || !selectionMode) return;
    event.preventDefault();
    clearNativeTextSelection();
    onCancelMessageSelection?.();
  }, [onCancelMessageSelection, onSelectAllMessages, selectionMode]);

  const onPointerDownCapture = useCallback((event: PointerEvent<HTMLDivElement>) => {
    cancelTailAlignment();
    delete event.currentTarget.dataset.transcriptKeyboardFocus;
    if (event.button !== 0 || isEditableSelectionTarget(event.target)) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('button, a, select, [role="button"]')) return;
    pointerFocusPendingRef.current = true;
    try {
      viewportRef.current?.focus({ preventScroll: true });
    } finally {
      pointerFocusPendingRef.current = false;
    }
  }, [cancelTailAlignment, viewportRef]);

  const onFocus = useCallback((event: FocusEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (pointerFocusPendingRef.current) {
      delete event.currentTarget.dataset.transcriptKeyboardFocus;
      return;
    }
    event.currentTarget.dataset.transcriptKeyboardFocus = 'true';
  }, []);

  const onBlur = useCallback((event: FocusEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    delete event.currentTarget.dataset.transcriptKeyboardFocus;
  }, []);

  return {
    onBlur,
    onFocus,
    onKeyDown,
    onPointerDownCapture,
    tabIndex: 0,
    role: 'region',
    'aria-label': 'Conversation messages',
    'data-message-selection-mode': selectionMode ? 'true' : undefined,
  } as const;
}
