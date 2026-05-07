import type { ReactNode } from 'react';
import { Bot, CheckCircle2, Link2, LoaderCircle, Users } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { getLocalAgentAvatarSeed, getLocalProfileAvatarSeed, IdentityAvatar, useLocalAgentAvatarSeed, useLocalProfileAvatarSeed } from '@/kordi-app/components/IdentityAvatar';
import type { DesktopBridgeHost, DesktopBridgeInvite, DesktopBridgeProject, DetailTab, Message, SessionArtifact, SessionTaskActivity } from '@/kordi-app/types';
import { cn } from '@/lib/utils';
import { ArtifactInspector } from '@/pages/ArtifactInspector';
import { TaskActivityDashboardPanel } from '@/pages/TaskActivityDashboardPanel';

type ProjectSession = {
  id: string;
  name: string;
  summary: string;
  lastActive: string;
  status: string;
  participants: string[];
  artifacts: number;
  tasks: number;
  taskActivities?: SessionTaskActivity[];
  messages: Message[];
};

type ProjectWorkspace = {
  id: string;
  name: string;
  summary: string;
  bridge: string;
  scope: string;
  status: string;
  people: string[];
  agents: string[];
  pendingInvites: unknown[];
  artifacts: number;
  tasks: number;
  root?: string;
  sharedContext?: string;
  backgroundSystem?: string;
  sharedSources?: Array<{ label: string; path?: string | null; detail?: string | null }>;
  sessions: ProjectSession[];
};

type ProjectDetailPanelProps = {
  isNativeShell: boolean;
  activeDetailTab: DetailTab;
  activeProject: ProjectWorkspace;
  activeProjectSession: ProjectSession;
  activeProjectLastMessage?: { sender?: string; text?: string; time: string };
  activeProjectBridgeHost: DesktopBridgeHost | null;
  activeProjectBridgeProject: DesktopBridgeProject | null;
  isProjectBridgeBusy: boolean;
  bridgeInvite: DesktopBridgeInvite | null;
  onCreateProjectBridgeInvite: () => void;
  onOpenBridgeHosts: () => void;
  onSetTasksTab: () => void;
  getStatusBadgeClass: (value: string) => string;
  artifacts: SessionArtifact[];
  activeArtifactId: string | null;
  onSelectArtifact: (artifactId: string | null) => void;
};

type MetaRowProps = {
  label: string;
  value?: ReactNode;
  valueClassName?: string;
};

function MetaRow({ label, value, valueClassName }: MetaRowProps) {
  return (
    <div className="app-inspector-meta-row">
      <span className="app-inspector-meta-label">{label}</span>
      <span className={['app-inspector-meta-value', valueClassName].filter(Boolean).join(' ')}>{value ?? '—'}</span>
    </div>
  );
}

function EmphasisBlock({ title, children, className = '' }: { title?: string; children: ReactNode; className?: string }) {
  return (
    <div className={['app-inspector-emphasis', className].filter(Boolean).join(' ')}>
      {title ? <div className="mb-1.5 app-inspector-heading">{title}</div> : null}
      <div className="app-inspector-text-block">{children}</div>
    </div>
  );
}

function projectFileKind(path: string): SessionArtifact['kind'] {
  const extension = path.split('.').pop()?.trim().toLowerCase();
  if (!extension) return 'file';
  if (['c', 'cc', 'cpp', 'cs', 'css', 'go', 'h', 'hpp', 'html', 'java', 'js', 'json', 'jsx', 'kt', 'mjs', 'php', 'py', 'rb', 'rs', 'scss', 'sh', 'sql', 'swift', 'toml', 'ts', 'tsx', 'vue', 'xml', 'yaml', 'yml'].includes(extension)) return 'code';
  if (['adoc', 'csv', 'ipynb', 'markdown', 'md', 'mdx', 'pdf', 'rst', 'rtf', 'txt'].includes(extension)) return 'document';
  return 'file';
}

function relatedProjectArtifacts(project: ProjectWorkspace): SessionArtifact[] {
  const artifacts: SessionArtifact[] = [];
  const seenPaths = new Set<string>();
  const pushFile = (path: string, name: string, summary: string) => {
    const normalizedPath = path.trim();
    if (!normalizedPath || seenPaths.has(normalizedPath)) return;
    seenPaths.add(normalizedPath);
    artifacts.push({
      id: normalizedPath,
      path: normalizedPath,
      name,
      kind: projectFileKind(normalizedPath),
      summary,
      timeLabel: 'Related',
    });
  };

  for (const source of project.sharedSources ?? []) {
    if (!source.path?.trim()) continue;
    const name = source.label?.trim() || source.path.split('/').pop() || source.path;
    pushFile(source.path, name, source.detail?.trim() || 'Shared source for this project');
  }

  return artifacts;
}

function mergeArtifacts(primary: SessionArtifact[], related: SessionArtifact[]) {
  const byId = new Map<string, SessionArtifact>();
  for (const artifact of primary) {
    byId.set(artifact.id, artifact);
  }
  for (const artifact of related) {
    if (!byId.has(artifact.id)) {
      byId.set(artifact.id, artifact);
    }
  }
  return Array.from(byId.values());
}

export function ProjectDetailPanel({
  isNativeShell,
  activeDetailTab,
  activeProject,
  activeProjectSession,
  activeProjectLastMessage,
  activeProjectBridgeHost,
  activeProjectBridgeProject,
  isProjectBridgeBusy,
  bridgeInvite,
  onCreateProjectBridgeInvite,
  onOpenBridgeHosts,
  onSetTasksTab,
  getStatusBadgeClass,
  artifacts,
  activeArtifactId,
  onSelectArtifact,
}: ProjectDetailPanelProps) {
  const currentLocalProfileAvatarSeed = useLocalProfileAvatarSeed();
  const currentLocalAgentAvatarSeed = useLocalAgentAvatarSeed(activeProject.name);
  const projectArtifacts = mergeArtifacts(artifacts, relatedProjectArtifacts(activeProject));

  if (activeDetailTab === 'info') {
    return (
      <div className="app-detail-sheet">
        <section className="app-detail-section">
          <div className="app-detail-kicker">Overview</div>
          <div className="space-y-3">
            <EmphasisBlock>
              <div className="app-inspector-text-block">{activeProject.sharedContext ?? activeProject.summary}</div>
              {activeProject.backgroundSystem ? <div className="mt-2 app-inspector-subtext">{activeProject.backgroundSystem}</div> : null}
            </EmphasisBlock>
            <div className="app-inspector-inline-meta">
              <span><strong>Shared sources:</strong>&nbsp;{activeProject.sharedSources?.length ?? 0}</span>
              {activeProject.root ? <span className="min-w-0"><strong>Root:</strong>&nbsp;<span className="truncate">{activeProject.root}</span></span> : null}
              {activeProjectBridgeHost ? <span><strong>Bridge:</strong>&nbsp;{activeProjectBridgeHost.displayName || activeProjectBridgeHost.serverUrl}</span> : null}
              {activeProjectBridgeProject ? <span><strong>Status:</strong>&nbsp;Invite-ready</span> : null}
            </div>
          </div>
        </section>

        <section className="app-detail-section">
          <div className="app-detail-kicker">Project info</div>
          <div className="space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="app-inspector-heading">{activeProject.name}</div>
                <div className="mt-1 app-inspector-subtext">{activeProject.scope}</div>
              </div>
              <Badge variant="outline" className={cn('rounded-full px-2.5 py-1 text-[10px]', getStatusBadgeClass(activeProject.status))}>
                {activeProject.status}
              </Badge>
            </div>
            <div className="app-inspector-meta-list">
              <MetaRow label="Bridge" value={activeProject.bridge} />
              <MetaRow label="Sessions" value={activeProject.sessions.length} />
              <MetaRow label="Shared sources" value={activeProject.sharedSources?.length ?? activeProject.artifacts} />
            </div>
          </div>
        </section>

        <section className="app-detail-section">
          <div className="app-detail-kicker">Bridge collaboration</div>
          <div className="space-y-3">
            <EmphasisBlock title="Active bridge host">
              <div className="break-all text-[color:var(--utility-foreground)]">{activeProjectBridgeHost?.serverUrl || 'No active bridge host selected'}</div>
              <div className="mt-1 app-inspector-subtext">
                {activeProjectBridgeProject
                  ? `${activeProjectBridgeProject.name} • ${activeProjectBridgeProject.memberCount} members on this bridge`
                  : 'This workspace is not on the current bridge host yet.'}
              </div>
            </EmphasisBlock>
            <div className="app-inspector-actions">
              <Button
                className="justify-start rounded-[14px] px-3 py-2 text-[12px]"
                onClick={onCreateProjectBridgeInvite}
                disabled={isProjectBridgeBusy || !activeProjectBridgeHost}
              >
                {isProjectBridgeBusy ? <LoaderCircle className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Link2 className="mr-2 h-3.5 w-3.5" />}
                {activeProjectBridgeProject ? 'Copy project invite' : 'Create project and copy invite'}
              </Button>
              <Button variant="secondary" className="justify-start rounded-[14px] border-0 px-3 py-2 text-[12px]" onClick={onOpenBridgeHosts}>
                <Users className="mr-2 h-3.5 w-3.5" />
                Open Bridge hosts
              </Button>
            </div>
            {bridgeInvite && activeProjectBridgeProject && bridgeInvite.projectId === activeProjectBridgeProject.id ? (
              <div className="app-inspector-emphasis border border-cyan-500/20 bg-cyan-500/10 text-cyan-100">
                <div className="mb-1.5 text-[13px] font-semibold">Latest invite copied</div>
                <div className="break-all text-[12px]">{bridgeInvite.projectId}</div>
                <div className="mt-1 break-all text-[12px]">{bridgeInvite.inviteToken}</div>
              </div>
            ) : null}
          </div>
        </section>

        <section className="app-detail-section">
          <div className="app-detail-kicker">Project actions</div>
          <div className="app-inspector-actions">
            <Button variant="secondary" className="justify-start rounded-[14px] border-0 px-3 py-2 text-[12px]">
              <Users className="mr-2 h-3.5 w-3.5" />
              Invite people
            </Button>
            <Button variant="secondary" className="justify-start rounded-[14px] border-0 px-3 py-2 text-[12px]">
              <Bot className="mr-2 h-3.5 w-3.5" />
              Invite agent
            </Button>
            <Button
              variant="outline"
              className="justify-start rounded-[14px] border-white/15 px-3 py-2 text-[12px] text-slate-200"
              onClick={onSetTasksTab}
            >
              <CheckCircle2 className="mr-2 h-3.5 w-3.5" />
              Review invites
            </Button>
          </div>
        </section>

        <section className="app-detail-section">
          <div className="app-detail-kicker">Members</div>
          <div className="app-inspector-list">
            {[...activeProject.people, ...activeProject.agents].map((member) => {
              const isAgent = activeProject.agents.includes(member);

              return (
                <div key={member} className="app-inspector-list-row">
                  <span className="flex min-w-0 items-center gap-2">
                    <IdentityAvatar
                      kind={isAgent ? 'agent' : 'human'}
                      seed={/^(you|me)$/i.test(member) ? (currentLocalProfileAvatarSeed || getLocalProfileAvatarSeed()) : isAgent ? (currentLocalAgentAvatarSeed || getLocalAgentAvatarSeed(member)) : member}
                      name={member}
                      className="h-7 w-7 border border-white/10"
                    />
                    <span className="truncate text-[13px] text-[color:var(--utility-foreground)]">{member}</span>
                  </span>
                  <Badge variant="secondary" className="app-badge-neutral rounded-full px-2.5 py-1">
                    Active
                  </Badge>
                </div>
              );
            })}
          </div>
        </section>
      </div>
    );
  }

  if (activeDetailTab === 'context') {
    return (
      <div className="app-detail-sheet">
        <section className="app-detail-section">
          <div className="app-detail-kicker">Project context</div>
          <div className="space-y-3">
            <EmphasisBlock title="Project summary">{activeProject.sharedContext ?? activeProject.summary}</EmphasisBlock>
            {activeProject.backgroundSystem ? <EmphasisBlock title="Background system">{activeProject.backgroundSystem}</EmphasisBlock> : null}
            <EmphasisBlock title="Active session">{activeProjectSession.summary}</EmphasisBlock>
          </div>
        </section>

        <section className="app-detail-section">
          <div className="app-detail-kicker">Latest activity</div>
          <div className="app-inspector-meta-list">
            <MetaRow label="Last active" value={activeProjectSession.lastActive} />
            <MetaRow label="Latest message" value={activeProjectLastMessage?.sender} valueClassName="max-w-[10rem] truncate" />
            <MetaRow
              label="Session status"
              value={
                <Badge variant="secondary" className={cn('rounded-full px-2.5 py-1', getStatusBadgeClass(activeProjectSession.status))}>
                  {activeProjectSession.status}
                </Badge>
              }
            />
          </div>
        </section>
      </div>
    );
  }

  if (activeDetailTab === 'artifacts') {
    return (
      <div className="app-detail-sheet">
        <ArtifactInspector
          isNativeShell={isNativeShell}
          artifacts={projectArtifacts}
          activeArtifactId={activeArtifactId}
          onSelectArtifact={onSelectArtifact}
          previewBaseRoot={activeProject.root}
          folderBrowserRoot={activeProject.root}
          emptyMessage="No generated or related project files yet."
          footer={
            <section className="app-detail-section">
              <div className="app-detail-kicker">Shared information sources</div>
              {(activeProject.sharedSources ?? []).length > 0 ? (
                <div className="app-inspector-list">
                  {(activeProject.sharedSources ?? []).map((source, index) => (
                    <div key={`${source.label}-${source.path ?? index}`} className="app-inspector-source-row">
                      <div className="app-inspector-heading">{source.label}</div>
                      {source.path ? <div className="mt-1 break-all app-inspector-subtext">{source.path}</div> : null}
                      {source.detail ? <div className="mt-1 app-inspector-text-block">{source.detail}</div> : null}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="app-inspector-empty">No shared project sources configured yet.</div>
              )}
            </section>
          }
        />
      </div>
    );
  }

  return (
    <div className="app-detail-sheet">
      <TaskActivityDashboardPanel
        messages={activeProjectSession.messages}
        taskActivities={activeProjectSession.taskActivities ?? []}
        emptyMessage="No delegated tasks in this project session yet."
        artifacts={projectArtifacts}
      />
      {activeProject.pendingInvites.length > 0 ? (
        <section className="app-detail-section">
          <div className="app-detail-kicker">Pending invites</div>
          <div className="app-inspector-emphasis">
            <div className="mb-2">
              <Badge variant="secondary" className="app-badge-attention px-2.5 py-1">
                {activeProject.pendingInvites.length}
              </Badge>
            </div>
            <div className="app-inspector-text-block">Membership approvals still waiting at the project level.</div>
          </div>
        </section>
      ) : null}
    </div>
  );
}
