import { useLayoutEffect, useRef, useState, type MouseEvent, type PointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { clearNativeTextSelection } from '@/features/contentSelection';
import { MessageContextMenuContent, type MessageContextMenuActionHandlers } from './messageContextMenuContent';
import { MessageContextMenuInteractionGuard } from './messageContextMenuInteraction';
import { messageContextMenuPosition } from './messageContextMenuPosition';
import { messageContextMenuMediaAttachment } from './messageContextMenuTarget';
import type { Message, MessageAttachment } from '../types';

type ContextMenuState = {
  x: number;
  y: number;
  clientX: number;
  clientY: number;
  targetRect: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>;
  mediaAttachment: MessageAttachment | null;
};

export function MessageContextMenuHost({
  msg, id, className, children, onPointerDown, onPointerEnter, onPointerMove,
  onPointerUp, onPointerCancel, dragSelectHandleId, dragSelectState, dragSelectLabel,
  onReplyMessage, onOpenMessageThread, onForwardMessage, onEditMessage, onDeleteMessage, onSelectMessage, onRequestPinMessage,
  onRequestUnpinMessage, onReactMessage, isPinned, imageGallery,
}: {
  msg: Message;
  id?: string;
  className?: string;
  children: ReactNode;
  onPointerDown?: (event: PointerEvent<HTMLDivElement>) => void;
  onPointerEnter?: (event: PointerEvent<HTMLDivElement>) => void;
  onPointerMove?: (event: PointerEvent<HTMLDivElement>) => void;
  onPointerUp?: (event: PointerEvent<HTMLDivElement>) => void;
  onPointerCancel?: (event: PointerEvent<HTMLDivElement>) => void;
  dragSelectHandleId?: string;
  dragSelectState?: 'idle' | 'selected' | 'unselected';
  dragSelectLabel?: string;
  imageGallery?: readonly MessageAttachment[];
} & MessageContextMenuActionHandlers) {
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const openMenu = (event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    clearNativeTextSelection();
    const eventTarget = event.target instanceof Element ? event.target : null;
    const anchorElement = eventTarget?.closest('[data-message-context-menu-anchor="true"]') ?? null;
    const targetRect = (anchorElement ?? event.currentTarget).getBoundingClientRect();
    setMenu({
      ...messageContextMenuPosition({
        clientX: event.clientX,
        clientY: event.clientY,
        targetRect,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      }),
      clientX: event.clientX,
      clientY: event.clientY,
      targetRect,
      mediaAttachment: messageContextMenuMediaAttachment(msg, eventTarget),
    });
  };

  useLayoutEffect(() => {
    if (!menu || !menuRef.current) return;
    const menuElement = menuRef.current;
    const positionMenu = () => {
      const rect = menuElement.getBoundingClientRect();
      setMenu((current) => {
        if (!current) return null;
        const next = messageContextMenuPosition({
          clientX: current.clientX,
          clientY: current.clientY,
          targetRect: current.targetRect,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          menuWidth: rect.width,
          menuHeight: rect.height,
        });
        return Math.abs(next.x - current.x) > 0.5 || Math.abs(next.y - current.y) > 0.5
          ? { ...current, ...next }
          : current;
      });
    };
    positionMenu();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(positionMenu);
    observer?.observe(menuElement);
    return () => observer?.disconnect();
  }, [menu]);

  useLayoutEffect(() => {
    if (!menu || typeof document === 'undefined') return;
    const closeIfOutsideMenu = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && menuRef.current?.contains(target)) return;
      setMenu(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenu(null);
    };
    document.addEventListener('pointerdown', closeIfOutsideMenu, true);
    document.addEventListener('contextmenu', closeIfOutsideMenu, true);
    document.addEventListener('keydown', closeOnEscape, true);
    return () => {
      document.removeEventListener('pointerdown', closeIfOutsideMenu, true);
      document.removeEventListener('contextmenu', closeIfOutsideMenu, true);
      document.removeEventListener('keydown', closeOnEscape, true);
    };
  }, [menu]);

  const menuLayer = menu ? (
    <MessageContextMenuInteractionGuard
      ref={menuRef}
      className="app-message-context-menu fixed z-[260]"
      style={{ left: menu.x, top: menu.y }}
      role="menu"
    >
      <MessageContextMenuContent
        msg={msg}
        onClose={() => setMenu(null)}
        onReplyMessage={onReplyMessage}
        onOpenMessageThread={onOpenMessageThread}
        onForwardMessage={onForwardMessage}
        onEditMessage={onEditMessage}
        onDeleteMessage={onDeleteMessage}
        onSelectMessage={onSelectMessage}
        onRequestPinMessage={onRequestPinMessage}
        onRequestUnpinMessage={onRequestUnpinMessage}
        onReactMessage={onReactMessage}
        isPinned={isPinned}
        mediaAttachment={menu.mediaAttachment}
        mediaGallery={imageGallery}
      />
    </MessageContextMenuInteractionGuard>
  ) : null;

  return (
    <div
      id={id}
      data-transcript-message-root="true"
      data-message-context-menu-target="true"
      data-message-selection-drag-handle={dragSelectHandleId}
      data-message-selection-drag-state={dragSelectState}
      aria-label={dragSelectLabel}
      onMouseDownCapture={(event) => {
        if (event.button === 2) event.preventDefault();
      }}
      onContextMenu={openMenu}
      onPointerDown={onPointerDown}
      onPointerEnter={onPointerEnter}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      className={className}
    >
      {children}
      {menuLayer && typeof document !== 'undefined' ? createPortal(menuLayer, document.body) : menuLayer}
    </div>
  );
}
