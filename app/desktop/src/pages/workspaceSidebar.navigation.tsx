import { isBrowserAppRuntime } from '@web/auth/browserAppRuntime';
import type { Dispatch, SetStateAction } from 'react';

import { navItems } from '@/kordi-app/data';
import { LEFT_RAIL_WIDTH } from '@/kordi-app/layout';
import type { NavId } from '@/kordi-app/types';
import { cn } from '@/lib/utils';
import { SidebarProfileControl } from '@/pages/workspaceSidebar.profile';
import {
  useSidebarUpdater,
  type SidebarUpdaterProps,
} from '@/pages/workspaceSidebar.update';
import type { WorkspaceSidebarAccount } from '@/pages/workspaceSidebar.types';
import { HelpEntry } from '@/features/onboarding/HelpEntry';
import { formatRailBadgeCount } from '@/pages/workspaceSidebar.badges';

export function WorkspaceNavigationRail({
  isNativeShell,
  activeNav,
  setActiveNav,
  agentUnread,
  contactUnread,
  pendingContactRequestCount,
  account,
  updater,
  onOpenSupport,
  onOpenSession,
}: {
  isNativeShell: boolean;
  activeNav: NavId;
  setActiveNav: Dispatch<SetStateAction<NavId>>;
  agentUnread: number;
  contactUnread: number;
  pendingContactRequestCount: number;
  account: WorkspaceSidebarAccount;
  updater: Omit<SidebarUpdaterProps, 'isNativeShell'>;
  onOpenSupport?: () => Promise<void> | void;
  onOpenSession: (id: string) => void;
}) {
  const browserApp = isBrowserAppRuntime();
  const NavigationControl = browserApp ? 'a' : 'button';
  const { menuAction, popover } = useSidebarUpdater({ isNativeShell, ...updater });
  return (
    <div
      className={cn(
        'app-left-glass flex shrink-0 flex-col items-center justify-between px-2 pb-2',
        isNativeShell ? 'pt-10' : 'pt-2.5',
      )}
      style={{ width: `${LEFT_RAIL_WIDTH}px` }}
    >
      <div className="flex w-full flex-col items-center gap-4">
        <div className="flex w-full flex-col items-center gap-2">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = activeNav === item.id;
            const unread = item.id === 'agent-chats' ? agentUnread : item.id === 'chats' ? contactUnread : 0;
            const requests = item.id === 'contacts' ? pendingContactRequestCount : 0;
            const badgeCount = unread > 0 ? unread : requests;
            return (
              <NavigationControl
                key={item.id}
                type={browserApp ? undefined : 'button'}
                href={browserApp ? `/app/${item.id === 'agents' ? 'factory' : item.id}` : undefined}
                onClick={(event) => {
                  if (browserApp && (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0)) return;
                  event.preventDefault();
                  setActiveNav(item.id);
                }}
                className="app-workspace-nav-button relative mx-auto grid h-8 w-8 place-items-center rounded-[10px] p-0"
                data-help-target={`nav-${item.id}`}
                data-active={active ? 'true' : 'false'}
                aria-label={unread > 0
                  ? `${item.label}, ${unread} unread message${unread === 1 ? '' : 's'}`
                  : requests > 0
                    ? `${item.label}, ${requests} pending contact request${requests === 1 ? '' : 's'}`
                    : item.label}
                aria-current={active ? 'page' : undefined}
                title={item.label}
              >
                <span className="grid h-6 w-6 place-items-center rounded-[10px]">
                  <Icon className="h-[18px] w-[18px]" />
                </span>
                {badgeCount > 0 ? (
                  <span className="app-nav-rail-unread-badge" aria-hidden="true">
                    {formatRailBadgeCount(badgeCount)}
                  </span>
                ) : null}
              </NavigationControl>
            );
          })}
        </div>
      </div>

      <div className="app-nav-rail-bottom flex w-full flex-col items-center gap-2">
        {popover}
        <HelpEntry
          updateAction={menuAction}
          activeNav={activeNav}
          setActiveNav={setActiveNav}
          account={account}
          onOpenSupport={onOpenSupport}
          onOpenSession={onOpenSession}
        />
        <SidebarProfileControl
          localProfileAvatarSeed={account.localProfileAvatarSeed}
          cloudAccount={account.cloudAccount}
          cloudAccountDialogTab={account.cloudAccountDialogTab}
          setCloudAccountDialogTab={account.setCloudAccountDialogTab}
          cloudSettings={account.cloudSettings}
          cloudMemoryVersion={account.cloudMemoryVersion}
          onUpdateCloudProfile={account.onUpdateCloudProfile}
          onRequestCloudEmailCode={account.onRequestCloudEmailCode}
          onVerifyCloudEmail={account.onVerifyCloudEmail}
          onCloudEmailAlreadyVerified={account.onCloudEmailAlreadyVerified}
          onCloudSignOut={account.onCloudSignOut}
          onCreateAppInvite={account.onCreateAppInvite}
        />
      </div>
    </div>
  );
}
