import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { IdentityAvatar } from '../components/IdentityAvatar';
import type { Agent } from '../types';
import type { AgentConfigDraft } from './model';

export function AgentsSidebar({
  agents,
  activeAgentId,
  agentConfigs,
  getStatusBadgeClass,
  onOpenAgent,
}: {
  agents: Agent[];
  activeAgentId: string;
  agentConfigs: Record<string, AgentConfigDraft>;
  getStatusBadgeClass: (value: string) => string;
  onOpenAgent: (agentId: string) => void;
}) {
  return (
    <aside className="flex min-h-0 flex-col bg-white/[0.02] text-white">
      <div className="border-b border-white/6 px-4 py-4">
        <div>
          <div className="text-[14px] font-medium text-white">Agents</div>
          <div className="mt-1 text-[12px] leading-5 text-slate-400">{agents.length} visible identities • choose one to inspect in the middle and edit files on the right</div>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-1 p-2">
          {agents.length === 0 ? <div className="px-3 py-4 text-[13px] text-slate-500">No visible agents in this runtime yet.</div> : null}
          {agents.map((agent) => {
            const config = agentConfigs[agent.id];
            const isSelected = activeAgentId === agent.id;
            const fileSummary = agent.exposesIdentityFiles === false ? 'Files unavailable' : `${agent.identityFiles.length} files`;
            const skillSummary = agent.exposesLoadedSkills === false ? 'Skills unavailable' : `${config.loadedSkills.length} skills`;
            const pluginSummary = agent.exposesLoadedPlugins === false ? 'Plugins unavailable' : `${agent.loadedPlugins.length} plugins`;

            return (
              <button
                key={agent.id}
                type="button"
                onClick={() => onOpenAgent(agent.id)}
                className={cn(
                  'block w-full rounded-[16px] px-3 py-3 text-left transition',
                  isSelected
                    ? 'bg-white/[0.08] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]'
                    : 'hover:bg-white/[0.035]',
                )}
              >
                <div className="flex items-start gap-3">
                  <IdentityAvatar
                    kind="agent"
                    seed={agent.avatarSeed ?? agent.id}
                    name={agent.name}
                    imageUrl={agent.profileImageUrl}
                    className="h-9 w-9 border border-white/8"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-[13px] font-medium text-white">{agent.name}</div>
                        <div className="mt-0.5 truncate text-[11px] text-slate-400">{agent.role}</div>
                      </div>
                      <Badge variant="outline" className={cn('shrink-0 rounded-full px-2 py-0.5 text-[10px]', getStatusBadgeClass(agent.status))}>
                        {agent.status}
                      </Badge>
                    </div>
                    <div className="mt-2 line-clamp-2 text-[12px] leading-5 text-slate-300">{config.systemPrompt}</div>
                    <div className="mt-3 flex flex-wrap items-center gap-3 text-[11px] text-slate-500">
                      <span>{fileSummary}</span>
                      <span>{skillSummary}</span>
                      <span>{pluginSummary}</span>
                    </div>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </ScrollArea>
    </aside>
  );
}
