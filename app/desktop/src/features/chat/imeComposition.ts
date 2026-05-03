export const IME_PROCESS_KEY_CODE = 229;

type ImeKeyboardMetadata = {
  isComposing?: boolean;
  keyCode?: number;
  which?: number;
};

export type ImeCompositionKeyDownEvent = ImeKeyboardMetadata & {
  nativeEvent?: ImeKeyboardMetadata;
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
