import { useMemo } from 'react';
import { ChatProjectsProvider } from '@/features/projects/ChatProjectsProvider';
import { type ChatProjects } from '@/features/projects/chatProjects';
import { createDesktopProject, createDesktopProjectFromFolder } from '@/lib/desktop';

import { assembleMainContentSlot } from '@/app/assembleMainContentSlot';
import { assembleOverlaySlots } from '@/app/assembleOverlaySlots';
import { assembleRightDetailSlot } from '@/app/assembleRightDetailSlot';
import { assembleSidebarSlot } from '@/app/assembleSidebarSlot';

import type { KordiShellArgs } from '@/app/kordiShellSlots.types';

function chatProjects(args: KordiShellArgs['sidebar']): ChatProjects {
  return {
    enabled: args.isNativeShell,
    projects: args.runtimeProjects,
    assign: args.handleMoveChatSessionToProject,
    create: async (sessionId, name, folder) => {
      const project = folder
        ? await createDesktopProjectFromFolder(folder, name)
        : await createDesktopProject(name);
      await args.handleMoveChatSessionToProject(sessionId, project.root);
    },
  };
}

export function assembleKordiShellSlots(args: KordiShellArgs) {
  const rightDetailRail = assembleRightDetailSlot(args.rightDetail);

  const projects = chatProjects(args.sidebar);
  return {
    sidebar: <ChatProjectsProvider value={projects}>{assembleSidebarSlot(args.sidebar)}</ChatProjectsProvider>,
    mainContent: <ChatProjectsProvider value={projects}>{assembleMainContentSlot({
      ...args.mainContent,
      rightDetailRail,
    })}</ChatProjectsProvider>,
    rightDetailRail,
    ...assembleOverlaySlots(args.overlay),
  };
}

export function useKordiShellSlots(args: KordiShellArgs) {
  const projects = useMemo(() => chatProjects(args.sidebar), [args.sidebar]);
  const rightDetailRail = useMemo(
    () => assembleRightDetailSlot(args.rightDetail),
    [args.rightDetail],
  );
  const sidebar = useMemo(
    () => <ChatProjectsProvider value={projects}>{assembleSidebarSlot(args.sidebar)}</ChatProjectsProvider>,
    [args.sidebar, projects],
  );
  const mainContent = useMemo(
    () => <ChatProjectsProvider value={projects}>{assembleMainContentSlot({ ...args.mainContent, rightDetailRail })}</ChatProjectsProvider>,
    [args.mainContent, rightDetailRail, projects],
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
