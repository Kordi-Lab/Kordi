import { ChevronDown, Plus, Search } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { IdentityAvatar } from '@/kordi-app/components/IdentityAvatar';
import { cn } from '@/lib/utils';
import { SidebarSessionMetaColumn } from '@/pages/workspaceSidebar.shared';
import type {
  WorkspaceSidebarDirectory,
  WorkspaceSidebarProjects,
} from '@/pages/workspaceSidebar.types';

export function SidebarProjectsPanel({
  projects,
  onOpenCreate,
}: {
  projects: WorkspaceSidebarProjects;
  onOpenCreate: () => void;
}) {
  return (
    <div className="flex h-full flex-col p-2.5 text-white">
      <div className="mb-2 flex items-start justify-between gap-2.5">
        <div>
          <div className="text-[15px] font-semibold text-white">Projects</div>
          <div className="mt-0.5 text-[11px] text-slate-400">
            {projects.runtimeProjects.length} total
          </div>
        </div>
        <Button
          type="button"
          size="icon"
          variant="secondary"
          className="app-icon-button h-8 w-8 rounded-lg border-0"
          title="Create project"
          aria-label="Create project"
          onClick={onOpenCreate}
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="app-input-shell app-workspace-search mb-2 flex items-center gap-2 rounded-lg px-2.5 py-1.5">
        <Search className="h-3.5 w-3.5 text-slate-400" />
        <input
          value={projects.projectSearch}
          onChange={(event) => projects.setProjectSearch(event.target.value)}
          placeholder="Search projects"
          className="w-full bg-transparent text-[13px] text-white outline-none placeholder:text-slate-400"
        />
      </div>

      <ScrollArea className="app-workspace-session-scroll min-h-0 flex-1">
        <div className="w-full space-y-1.5">
          {projects.filteredProjects.map((project) => {
            const isExpanded = projects.expandedProjectIds[project.id] ?? false;

            return (
              <div key={project.id} className="app-project-group rounded-[18px] px-1 py-1">
                <button
                  type="button"
                  onClick={() => {
                    const rememberedSessionId = projects.projectSelectedSessionIds[project.id];
                    const currentProjectSessionId = projects.activeProjectId === project.id
                      ? projects.activeProjectSessionId
                      : (project.sessions.find((session) => session.id === rememberedSessionId)?.id
                        ?? project.sessions[0]?.id
                        ?? '');

                    projects.selectProject(project.id, currentProjectSessionId || undefined);
                    projects.setExpandedProjectIds((current) => ({
                      ...current,
                      [project.id]: current[project.id] === undefined ? true : !current[project.id],
                    }));
                  }}
                  className="app-project-group-toggle flex w-full items-center justify-between gap-2 rounded-[14px] px-3 py-2 text-left transition"
                >
                  <div className="min-w-0">
                    <div className="truncate text-[13px] font-medium text-white">{project.name}</div>
                    <div className="mt-0.5 text-[11px] text-slate-400">
                      {project.sessions.length} sessions
                    </div>
                  </div>
                  <ChevronDown
                    className={cn(
                      'h-4 w-4 text-slate-400 transition',
                      isExpanded ? 'rotate-180' : '',
                    )}
                  />
                </button>

                {isExpanded ? (
                  <div className="app-project-session-list ml-3 mt-1 pl-3">
                    <div className="space-y-0.5">
                      {project.sessions.map((session) => {
                        const isActiveSession = projects.activeProjectId === project.id
                          && projects.activeProjectSessionId === session.id;

                        return (
                          <button
                            key={session.id}
                            type="button"
                            onClick={() => projects.onSelectProjectSession(project.id, session.id)}
                            className={cn(
                              'app-project-session-row block w-full min-w-0 rounded-[12px] border border-transparent px-2.5 py-[0.3125rem] text-left transition',
                              isActiveSession
                                ? 'border-white/10 bg-white/[0.055] text-white'
                                : 'text-slate-300 hover:bg-white/[0.025] hover:text-white',
                            )}
                          >
                            <div className="min-w-0">
                              <div className="flex items-start gap-2.5">
                                <div className="min-w-0 flex-1">
                                  <div className="truncate text-[12px] font-medium">{session.name}</div>
                                </div>
                                <SidebarSessionMetaColumn
                                  timeLabel={session.lastActive}
                                  unreadCount={session.unread}
                                  indicator={session.statusIndicator}
                                  active={isActiveSession}
                                />
                              </div>
                              {session.summary?.trim().length ? (
                                <div
                                  className={cn(
                                    'mt-px truncate text-[11px] leading-[1.05rem]',
                                    isActiveSession ? 'text-slate-300' : 'text-slate-500',
                                  )}
                                >
                                  {session.summary}
                                </div>
                              ) : null}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}

export function SidebarContactsPanel({
  directory,
}: {
  directory: WorkspaceSidebarDirectory;
}) {
  return (
    <div className="h-full p-3">
      <div className="mb-2 flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-slate-300">
        <Search className="h-4 w-4" />
        <span className="text-sm">Search people and agents</span>
      </div>
      <div className="mb-2 grid gap-1.5">
        {directory.groupedContacts.map((group) => (
          <button
            key={group.id}
            onClick={() => {
              directory.setActiveContactGroup(group.id);
              const first = directory.displayedContacts.find(
                (contact) => contact.classType === group.id,
              );
              if (first) directory.setActiveContactId(first.id);
            }}
            className="flex items-center justify-between rounded-xl bg-white/12 px-3 py-2 text-left text-white ring-1 ring-white/15 transition"
          >
            <span className="text-sm font-medium">{group.label}</span>
            <Badge variant="secondary" className="rounded-full text-slate-950">
              A-Z
            </Badge>
          </button>
        ))}
      </div>
    </div>
  );
}

export function SidebarAgentsPanel({
  directory,
}: {
  directory: WorkspaceSidebarDirectory;
}) {
  return (
    <div className="flex h-full flex-col p-3">
      <ScrollArea className="min-h-0 flex-1 pr-2">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <div className="text-sm text-slate-400">Agents</div>
            <div className="text-xl font-semibold text-white">
              {directory.displayedAgents.length} visible identities
            </div>
          </div>
          <Button className="rounded-xl">
            <Plus className="mr-2 h-4 w-4" />
            New
          </Button>
        </div>
        <div className="space-y-3">
          {directory.displayedAgents.map((agent) => (
            <Card
              key={agent.id}
              className="rounded-3xl border-white/10 bg-white/5 text-white shadow-none"
            >
              <CardContent className="p-4">
                <div className="mb-3 flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-3">
                    <IdentityAvatar
                      kind="agent"
                      seed={agent.avatarSeed ?? agent.id}
                      name={agent.name}
                      imageUrl={agent.profileImageUrl}
                      className="h-10 w-10 border border-white/10"
                    />
                    <div className="min-w-0">
                      <div className="truncate font-medium">{agent.name}</div>
                      <div className="truncate text-xs text-slate-400">{agent.id}</div>
                    </div>
                  </div>
                  <Badge variant="outline" className="shrink-0 border-white/20 text-slate-200">
                    {agent.status}
                  </Badge>
                </div>
                <div className="mb-2 text-sm text-slate-300">{agent.role}</div>
                <div className="mb-3 text-xs text-slate-400">Messaging: {agent.messaging}</div>
                <div className="flex items-center justify-between text-xs text-slate-400">
                  <span>{agent.tasks} active tasks</span>
                  <Button size="sm" variant="secondary" className="rounded-xl">
                    Open
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}

export function SidebarSettingsPanel() {
  return (
    <div className="h-full p-3">
      <div className="app-sidebar-panel space-y-1.5 text-white">
        {['Profile', 'Notifications', 'Appearance', 'Privacy', 'Developer'].map((section) => (
          <button
            key={section}
            type="button"
            className="app-sidebar-nav-row flex w-full items-center justify-between rounded-[14px] px-3 py-2.5 text-left transition"
          >
            <div>
              <div className="text-[13px] font-medium">{section}</div>
            </div>
            <ChevronDown className="h-4 w-4 text-slate-400" />
          </button>
        ))}
      </div>
    </div>
  );
}
