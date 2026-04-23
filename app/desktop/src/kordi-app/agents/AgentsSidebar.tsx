import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import type { Agent } from '../types';
import { getAgentInitials, type AgentConfigDraft } from './model';

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
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[14px] font-medium text-white">Agents</div>
            <div className="mt-1 text-[12px] leading-5 text-slate-400">{agents.length} visible identities • isolated configuration</div>
          </div>
          <Button className="app-control-chip h-9 w-9 rounded-[12px] border-0 p-0">
            <span className="text-lg leading-none">+</span>
          </Button>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-1 p-2">
          {agents.map((agent) => {
            const config = agentConfigs[agent.id];
            const isSelected = activeAgentId === agent.id;

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
                  <Avatar className="h-9 w-9 border border-white/8">
                    <AvatarFallback className={cn('text-[11px]', isSelected ? 'bg-[#e7e1d8] text-[#201d1a]' : 'bg-white/[0.05] text-slate-200')}>
                      {getAgentInitials(agent.name)}
                    </AvatarFallback>
                  </Avatar>
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
                    <div className="mt-3 flex items-center gap-3 text-[11px] text-slate-500">
                      <span>{agent.identityFiles.length} files</span>
                      <span>{config.loadedSkills.length} skills</span>
                      <span>{agent.loadedPlugins.length} plugins</span>
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
