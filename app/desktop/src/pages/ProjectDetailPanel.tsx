import type { ReactNode } from 'react';
import { Bot, CheckCircle2, Link2, LoaderCircle, Users } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { DesktopBridgeHost, DesktopBridgeInvite, DesktopBridgeProject, DetailTab, SessionArtifact } from '@/kordi-app/types';
import { cn } from '@/lib/utils';
import { ArtifactInspector } from '@/pages/ArtifactInspector';

type ProjectSession = {
  id: string;
  name: string;
  summary: string;
  lastActive: string;
  status: string;
  participants: string[];
  artifacts: number;
  tasks: number;
  messages: Array<{ sender?: string; text: string; time: string }>;
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
  onOpenProjectSettings: () => void;
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
  onOpenProjectSettings,
  onSetTasksTab,
  getStatusBadgeClass,
  artifacts,
  activeArtifactId,
  onSelectArtifact,
}: ProjectDetailPanelProps) {
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
            <div className="app-inspector-actions">
              <Button variant="secondary" className="justify-start rounded-[14px] border-0 px-3 py-2 text-[12px]" onClick={onOpenProjectSettings}>
                Edit project info
              </Button>
            </div>
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
            {[...activeProject.people, ...activeProject.agents].map((member) => (
              <div key={member} className="app-inspector-list-row">
                <span className="truncate text-[13px] text-[color:var(--utility-foreground)]">{member}</span>
                <Badge variant="secondary" className="app-badge-neutral rounded-full px-2.5 py-1">
                  Active
                </Badge>
              </div>
            ))}
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
          artifacts={artifacts}
          activeArtifactId={activeArtifactId}
          onSelectArtifact={onSelectArtifact}
          emptyMessage="No generated code or docs in this project session yet."
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
      <section className="app-detail-section">
        <div className="app-detail-kicker">Tasks</div>
        <div className="space-y-3">
          <EmphasisBlock title="Project tasks">
            <div className="mb-2">
              <Badge className="app-badge-neutral px-2.5 py-1">{activeProject.tasks}</Badge>
            </div>
            Open tasks tracked across all project sessions.
          </EmphasisBlock>
          <EmphasisBlock title="Pending invites">
            <div className="mb-2">
              <Badge variant="secondary" className="app-badge-attention px-2.5 py-1">
                {activeProject.pendingInvites.length}
              </Badge>
            </div>
            Membership approvals still waiting at the project level.
          </EmphasisBlock>
        </div>
      </section>
    </div>
  );
}
