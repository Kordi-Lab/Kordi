import { useMemo } from 'react';

import { assembleMainContentSlot } from '@/app/assembleMainContentSlot';
import { assembleOverlaySlots } from '@/app/assembleOverlaySlots';
import { assembleRightDetailSlot } from '@/app/assembleRightDetailSlot';
import { assembleSidebarSlot } from '@/app/assembleSidebarSlot';

import type { KordiShellArgs } from '@/app/kordiShellSlots.types';

export function assembleKordiShellSlots(args: KordiShellArgs) {
  const rightDetailRail = assembleRightDetailSlot(args.rightDetail);

  return {
    sidebar: assembleSidebarSlot(args.sidebar),
    mainContent: assembleMainContentSlot({
      ...args.mainContent,
      rightDetailRail,
    }),
    rightDetailRail,
    ...assembleOverlaySlots(args.overlay),
  };
}

export function useKordiShellSlots(args: KordiShellArgs) {
  const rightDetailRail = useMemo(
    () => assembleRightDetailSlot(args.rightDetail),
    [args.rightDetail],
  );
  const sidebar = useMemo(
    () => assembleSidebarSlot(args.sidebar),
    [args.sidebar],
  );
  const mainContent = useMemo(
    () => assembleMainContentSlot({ ...args.mainContent, rightDetailRail }),
    [args.mainContent, rightDetailRail],
  );
  const overlays = useMemo(
    () => assembleOverlaySlots(args.overlay),
    [args.overlay],
  );

  return useMemo(() => ({
    sidebar,
    mainContent,
    rightDetailRail,
    ...overlays,
  }), [mainContent, overlays, rightDetailRail, sidebar]);
}
