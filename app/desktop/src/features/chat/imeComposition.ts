import { useCallback, useEffect, useRef } from 'react';

export const IME_PROCESS_KEY_CODE = 229;

type ImeKeyboardMetadata = {
  isComposing?: boolean;
  keyCode?: number;
  which?: number;
};

export type ImeCompositionKeyDownEvent = ImeKeyboardMetadata & {
  nativeEvent?: ImeKeyboardMetadata;
};

type ImeCompositionStateScheduler = {
  schedule: (callback: () => void) => number;
  cancel: (timerId: number) => void;
};

export type ImeCompositionState = {
  beginComposition: () => void;
  endComposition: () => void;
  isComposing: () => boolean;
  cancelPendingClear: () => void;
};

function isImeProcessKeyCode(value?: number) {
  return value === IME_PROCESS_KEY_CODE;
}

export function isImeCompositionKeyDown(event: ImeCompositionKeyDownEvent, isCompositionActive: boolean) {
  return Boolean(
    isCompositionActive
    || event.nativeEvent?.isComposing
    || event.isComposing
    || isImeProcessKeyCode(event.nativeEvent?.keyCode)
    || isImeProcessKeyCode(event.nativeEvent?.which)
    || isImeProcessKeyCode(event.keyCode)
    || isImeProcessKeyCode(event.which),
  );
}

export function createImeCompositionState({ schedule, cancel }: ImeCompositionStateScheduler): ImeCompositionState {
  let composing = false;
  let pendingClearTimerId: number | null = null;

  const cancelPendingClear = () => {
    if (pendingClearTimerId === null) return;
    cancel(pendingClearTimerId);
    pendingClearTimerId = null;
  };

  const beginComposition = () => {
    cancelPendingClear();
    composing = true;
  };

  const endComposition = () => {
    cancelPendingClear();
    if (!composing) return;
    pendingClearTimerId = schedule(() => {
      pendingClearTimerId = null;
      composing = false;
    });
  };

  return {
    beginComposition,
    endComposition,
    isComposing: () => composing,
    cancelPendingClear,
  };
}

export function useImeCompositionGuard() {
  const stateRef = useRef<ImeCompositionState | null>(null);

  if (!stateRef.current) {
    stateRef.current = createImeCompositionState({
      schedule: (callback) => window.setTimeout(callback, 0),
      cancel: (timerId) => window.clearTimeout(timerId),
    });
  }

  useEffect(() => () => {
    stateRef.current?.cancelPendingClear();
  }, []);

  const onCompositionStart = useCallback(() => {
    stateRef.current?.beginComposition();
  }, []);

  const onCompositionEnd = useCallback(() => {
    stateRef.current?.endComposition();
  }, []);

  const isComposingKeyDown = useCallback((event: ImeCompositionKeyDownEvent) => (
    isImeCompositionKeyDown(event, stateRef.current?.isComposing() ?? false)
  ), []);

  return {
    onCompositionStart,
    onCompositionEnd,
    isComposingKeyDown,
  };
}
