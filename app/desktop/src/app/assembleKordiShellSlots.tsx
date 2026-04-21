import { assembleMainContentSlot } from '@/app/assembleMainContentSlot';
import { assembleOverlaySlots } from '@/app/assembleOverlaySlots';
import { assembleRightDetailSlot } from '@/app/assembleRightDetailSlot';
import { assembleSidebarSlot } from '@/app/assembleSidebarSlot';

import type { KordiShellArgs } from '@/app/kordiShellSlots.types';

export function assembleKordiShellSlots(args: KordiShellArgs) {
  return {
    sidebar: assembleSidebarSlot(args.sidebar),
    mainContent: assembleMainContentSlot(args.mainContent),
    rightDetailRail: assembleRightDetailSlot(args.rightDetail),
    ...assembleOverlaySlots(args.overlay),
  };
}
