import type { Dispatch, SetStateAction } from 'react';

import { navItems } from '@/kordi-app/data';
import { LEFT_RAIL_WIDTH } from '@/kordi-app/layout';
import type { NavId } from '@/kordi-app/types';
import { cn } from '@/lib/utils';
import { SidebarProfileControl } from '@/pages/workspaceSidebar.profile';
import {
  SidebarUpdater,
  type SidebarUpdaterProps,
} from '@/pages/workspaceSidebar.update';
import type { WorkspaceSidebarAccount } from '@/pages/workspaceSidebar.types';

function formatUnreadCount(value: number) {
  return value > 99 ? '99+' : `${value}`;
}

export function WorkspaceNavigationRail({
  isNativeShell,
  activeNav,
  setActiveNav,
  totalUnread,
  pendingContactRequestCount,
  account,
  updater,
}: {
  isNativeShell: boolean;
  activeNav: NavId;
  setActiveNav: Dispatch<SetStateAction<NavId>>;
  totalUnread: number;
  pendingContactRequestCount: number;
  account: WorkspaceSidebarAccount;
  updater: Omit<SidebarUpdaterProps, 'isNativeShell'>;
}) {
  return (
    <div
      className={cn(
        'app-left-glass flex shrink-0 flex-col items-center justify-between px-2.5 pb-2.5',
        isNativeShell ? 'pt-11' : 'pt-2.5',
      )}
      style={{ width: `${LEFT_RAIL_WIDTH}px` }}
    >
      <div className="flex w-full flex-col items-center gap-4">
        {!isNativeShell ? (
          <div className="flex w-full items-center justify-center gap-1.5 px-2.5 pt-1.5">
            <span className="h-3 w-3 rounded-full bg-[#ff5f57] shadow-[0_0_0_1px_rgba(0,0,0,0.18)]" />
            <span className="h-3 w-3 rounded-full bg-[#febc2e] shadow-[0_0_0_1px_rgba(0,0,0,0.18)]" />
            <span className="h-3 w-3 rounded-full bg-[#28c840] shadow-[0_0_0_1px_rgba(0,0,0,0.18)]" />
          </div>
        ) : null}
        <div className="flex w-full flex-col items-center gap-3">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = activeNav === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveNav(item.id)}
                className="app-workspace-nav-button relative mx-auto grid h-11 w-11 place-items-center rounded-[14px] p-0"
                data-active={active ? 'true' : 'false'}
                aria-label={item.label}
                aria-current={active ? 'page' : undefined}
                title={item.label}
              >
                <span className="relative grid h-8 w-8 place-items-center rounded-[14px]">
                  <Icon className="h-5 w-5" />
                  {item.id === 'chats' && totalUnread > 0 ? (
                    <span className="absolute -right-1.5 -top-1.5 inline-flex min-w-[1rem] items-center justify-center rounded-full bg-white px-1 py-[0.1rem] text-[8px] font-semibold leading-none text-slate-950 shadow-[0_0_0_1px_rgba(15,23,42,0.55)]">
                      {formatUnreadCount(totalUnread)}
                    </span>
                  ) : null}
                  {item.id === 'contacts' && pendingContactRequestCount > 0 ? (
                    <span
                      className="absolute -right-1.5 -top-1.5 inline-flex min-w-[1rem] items-center justify-center rounded-full bg-emerald-300 px-1 py-[0.1rem] text-[8px] font-semibold leading-none text-slate-950 shadow-[0_0_0_1px_rgba(15,23,42,0.55)]"
                      aria-label={`${formatUnreadCount(pendingContactRequestCount)} pending contact request${pendingContactRequestCount === 1 ? '' : 's'}`}
                    >
                      {formatUnreadCount(pendingContactRequestCount)}
                    </span>
                  ) : null}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="app-nav-rail-bottom flex w-full flex-col items-center gap-2">
        <SidebarUpdater
          isNativeShell={isNativeShell}
          {...updater}
        />
        <SidebarProfileControl
          localProfileAvatarSeed={account.localProfileAvatarSeed}
          cloudAccount={account.cloudAccount}
          cloudAccountDialogTab={account.cloudAccountDialogTab}
          setCloudAccountDialogTab={account.setCloudAccountDialogTab}
          cloudSettings={account.cloudSettings}
          onUpdateCloudProfile={account.onUpdateCloudProfile}
          onCloudSignOut={account.onCloudSignOut}
          onCreateAppInvite={account.onCreateAppInvite}
        />
      </div>
    </div>
  );
}
