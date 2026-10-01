import { useContext, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { NativeChatTitlebarContext } from '@/app/nativeChatTitlebarContext';
import { CompanionTitlebarContext } from './companionTitlebarContext';

/** Keep the original panel header and menus on the native main-chat title row. */
export function CompanionTitlebar({ children }: { children: ReactNode }) {
  const native = useContext(NativeChatTitlebarContext);
  const panel = useContext(CompanionTitlebarContext);
  if (!native?.companion || !panel) return children;

  return createPortal(
    <div className="app-native-companion-titlebar" data-side={panel.side} data-open={panel.isVisible}
      aria-hidden={!panel.isVisible} inert={!panel.isVisible} style={{ width: panel.isVisible ? '100%' : 0 }}>
      <div className="app-native-companion-titlebar-surface" style={{ width: panel.width }}>
        {children}
      </div>
    </div>,
    native.companion,
  );
}
