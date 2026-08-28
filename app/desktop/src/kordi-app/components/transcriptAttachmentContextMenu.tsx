import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { AddAttachmentToMediaLibraryAction } from './addAttachmentToMediaLibraryAction';
import { AttachmentActions } from './transcriptAttachmentActions';
import { shouldCloseAttachmentContextMenuForTarget, type AttachmentContextMenuState } from './transcriptAttachmentContextMenuState';

function PortalLayer({ children }: { children: ReactNode }) {
  if (typeof document === 'undefined' || !document.body) return <>{children}</>;
  return createPortal(children, document.body);
}

export function AttachmentContextMenu({ state, onClose }: { state: AttachmentContextMenuState; onClose: () => void }) {
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      if (shouldCloseAttachmentContextMenuForTarget(menuRef.current, event.target)) onClose();
    }
    window.addEventListener('pointerdown', handlePointerDown, true);
    return () => window.removeEventListener('pointerdown', handlePointerDown, true);
  }, [onClose]);

  return (
    <PortalLayer>
      <div
        ref={menuRef}
        data-attachment-image-context-menu="true"
        className="app-transient-surface fixed z-[230] rounded-[14px] border p-1.5"
        style={{ left: state.x, top: state.y }}
        onContextMenu={(event) => event.preventDefault()}
      >
        <AddAttachmentToMediaLibraryAction attachment={state.attachment} onAdded={onClose} />
        <AttachmentActions attachment={state.attachment} variant="menu" />
      </div>
    </PortalLayer>
  );
}
