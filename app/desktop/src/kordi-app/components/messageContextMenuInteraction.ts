import {
  createElement,
  forwardRef,
  useRef,
  type HTMLAttributes,
  type MouseEvent,
  type PointerEvent,
} from 'react';

export function isExplicitMessageContextMenuAction(clickDetail: number, receivedPointerDown: boolean) {
  return clickDetail === 0 || receivedPointerDown;
}

export const MessageContextMenuInteractionGuard = forwardRef<
  HTMLDivElement,
  HTMLAttributes<HTMLDivElement>
>(function MessageContextMenuInteractionGuard({ children, ...props }, ref) {
  const receivedPointerDown = useRef(false);

  return createElement('div', {
    ...props,
    ref,
    onMouseDown: (event: MouseEvent<HTMLDivElement>) => event.stopPropagation(),
    onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
      receivedPointerDown.current = true;
      event.stopPropagation();
    },
    onClickCapture: (event: MouseEvent<HTMLDivElement>) => {
      const isExplicitAction = isExplicitMessageContextMenuAction(
        event.detail,
        receivedPointerDown.current,
      );
      receivedPointerDown.current = false;
      if (isExplicitAction) return;
      event.preventDefault();
      event.stopPropagation();
    },
    onContextMenu: (event: MouseEvent<HTMLDivElement>) => event.preventDefault(),
  }, children);
});
