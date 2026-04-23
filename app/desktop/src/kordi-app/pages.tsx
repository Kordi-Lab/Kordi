import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Eye, Plus, Search, X } from 'lucide-react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { readDesktopWorkspaceTextFile, writeDesktopWorkspaceTextFile } from '@/lib/desktop';
import { cn } from '@/lib/utils';
import { BridgeChip, ContactRequestRow, ContactRow } from './components';
import type { Agent, Contact, ContactClass, ContactRequest } from './types';
import { getContactSortLetter } from './utils';

type ContactsPageProps = {
  filteredGroupedContacts: Array<{ id: ContactClass; label: string; items: Contact[] }>;
  isContactRequestsOpen: boolean;
  onToggleRequests: () => void;
  contactRequests: ContactRequest[];
  activeContactRequestId: string;
  onReviewRequest: (requestId: string) => void;
  contactSearch: string;
  onContactSearchChange: (value: string) => void;
  expandedContactGroups: Record<ContactClass, boolean>;
  onToggleGroup: (groupId: ContactClass) => void;
  activeContactId: string;
  onSelectContact: (groupId: ContactClass, contactId: string) => void;
  contactOverlayMode: 'contact' | 'request' | null;
  activeContact: Contact;
  activeContactRequest?: ContactRequest;
  onCloseOverlay: () => void;
  getStatusBadgeClass: (value: string) => string;
  onMessageContact?: (contact: Contact) => void;
};

export function ContactsPage({
  filteredGroupedContacts,
  isContactRequestsOpen,
  onToggleRequests,
  contactRequests,
  activeContactRequestId,
  onReviewRequest,
  contactSearch,
  onContactSearchChange,
  expandedContactGroups,
  onToggleGroup,
  activeContactId,
  onSelectContact,
  contactOverlayMode,
  activeContact,
  activeContactRequest,
  onCloseOverlay,
  getStatusBadgeClass,
  onMessageContact,
}: ContactsPageProps) {
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1">
      <div className="flex h-full min-h-0 w-full flex-col">
        <div className="border-b border-white/10 px-5 py-4">
          <div className="w-full">
            <div className="mb-1 text-white">
              <h2 className="text-xl font-semibold">Contacts</h2>
            </div>
            <div className="text-sm text-slate-400">
              Classified as my agents, other users’ agents, and other users. Compact list, detail on selection.
            </div>
          </div>
        </div>

        <div className="relative min-h-0 flex-1 px-4 py-4">
          <div className="flex h-full w-full min-h-0 flex-col">
            <div className="mb-4">
              <button
                type="button"
                onClick={onToggleRequests}
                className="app-surface-muted flex w-full items-center justify-between gap-3 rounded-2xl px-3 py-2.5 text-left transition"
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium text-white">New requests</div>
                  <div className="text-[11px] text-slate-400">Open the request inbox and review it on the right.</div>
                </div>
                <div className="flex items-center gap-2">
                  <div className="app-badge-attention px-2 py-0.5 text-[10px] font-medium">{contactRequests.length}</div>
                  <ChevronDown className={cn('h-4 w-4 text-slate-400 transition', isContactRequestsOpen ? 'rotate-180' : '')} />
                </div>
              </button>
              {isContactRequestsOpen && (
                <div className="mt-2 grid gap-2">
                  {contactRequests.map((request) => (
                    <ContactRequestRow
                      key={request.id}
                      request={request}
                      active={activeContactRequestId === request.id}
                      onReview={() => onReviewRequest(request.id)}
                    />
                  ))}
                </div>
              )}
            </div>

            <div className="mb-4 flex items-center justify-between">
              <div>
                <div className="text-sm font-medium text-white">Contacts</div>
                <div className="text-xs text-slate-400">Foldable classes with quick letter jump.</div>
              </div>
              <Button variant="secondary" className="app-control-chip rounded-xl border-0">
                <Plus className="mr-2 h-4 w-4" />
                Add
              </Button>
            </div>

            <div className="app-input-shell mb-4 flex items-center gap-2 rounded-2xl px-3 py-2 text-slate-300">
              <Search className="h-4 w-4" />
              <input
                value={contactSearch}
                onChange={(event) => onContactSearchChange(event.target.value)}
                placeholder="Search contacts"
                className="w-full bg-transparent text-sm text-slate-100 outline-none placeholder:text-slate-400"
              />
            </div>

            <div className="relative min-h-0 flex-1">
              <ScrollArea className="h-full pr-2">
                <div className="space-y-3">
                  {filteredGroupedContacts.map((group) => (
                    <div key={group.id}>
                      <button
                        type="button"
                        onClick={() => onToggleGroup(group.id)}
                        className="app-surface-muted flex w-full items-center justify-between rounded-2xl px-3 py-3 text-left transition"
                      >
                        <div className="flex items-center gap-3">
                          {expandedContactGroups[group.id] ? (
                            <ChevronDown className="h-4 w-4 text-slate-300" />
                          ) : (
                            <ChevronRight className="h-4 w-4 text-slate-300" />
                          )}
                          <span className="text-base font-medium text-white">{group.label}</span>
                        </div>
                        <div className="text-sm text-slate-400">{group.items.length}</div>
                      </button>
                      {expandedContactGroups[group.id] && (
                        <div className="px-3 pb-1 pt-3">
                          <div className="space-y-1">
                            {group.items.length > 0 ? (
                              group.items.map((contact, index) => {
                                const letter = getContactSortLetter(contact.name);
                                const previousLetter = index > 0 ? getContactSortLetter(group.items[index - 1].name) : null;
                                const showLetterHeader = index === 0 || previousLetter !== letter;

                                return (
                                  <div key={contact.id}>
                                    {showLetterHeader && <div className="px-3 pb-1 pt-3 text-[12px] font-medium text-slate-400">{letter}</div>}
                                    <ContactRow
                                      contact={contact}
                                      active={activeContactId === contact.id}
                                      onSelect={() => onSelectContact(group.id, contact.id)}
                                    />
                                  </div>
                                );
                              })
                            ) : (
                              <div className="rounded-2xl px-3 py-3 text-sm text-slate-400">No contacts match this search.</div>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </ScrollArea>
            </div>
          </div>

          {contactOverlayMode && (
            <div className="app-overlay absolute inset-0 z-10 flex items-center justify-center px-4 py-8 backdrop-blur-[2px]">
              <div className="app-modal-panel w-full max-w-[420px] rounded-[28px] border border-white/10 p-4 text-white shadow-[var(--app-shadow-float)]">
                <div className="mb-4 flex items-start justify-between gap-3">
                  <div>
                    <div className="text-[11px] uppercase tracking-[0.24em] text-slate-400">
                      {contactOverlayMode === 'contact' ? 'Contact detail' : 'Request review'}
                    </div>
                    <div className="mt-1 text-lg font-semibold">
                      {contactOverlayMode === 'contact' ? activeContact.name : activeContactRequest?.title}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={onCloseOverlay}
                    className="app-icon-button rounded-full p-2 text-slate-300 transition hover:text-white"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
                {contactOverlayMode === 'contact' ? (
                  <div>
                    <div className="mb-4 flex items-center gap-3">
                      <Avatar className="h-12 w-12 border border-white/10">
                        <AvatarFallback className="bg-slate-800 text-slate-100">{activeContact.initials}</AvatarFallback>
                      </Avatar>
                      <div>
                        <div className="text-sm text-slate-300">
                          {activeContact.entityType} • {activeContact.subtitle}
                        </div>
                        <div className="mt-2 flex flex-wrap gap-2">
                          <Badge className={cn('rounded-full px-2.5 py-1', getStatusBadgeClass(activeContact.status))}>{activeContact.status}</Badge>
                          <Badge variant="secondary" className="app-badge-neutral rounded-full px-2.5 py-1">
                            Owner: {activeContact.owner}
                          </Badge>
                        </div>
                      </div>
                    </div>
                    <div className="mb-4 text-sm text-slate-300">{activeContact.detail}</div>
                    <div className="mb-3 text-[11px] uppercase tracking-[0.22em] text-slate-400">Joined bridges</div>
                    <div className="mb-4 flex flex-wrap gap-2">
                      {activeContact.bridges.map((bridge) => (
                        <BridgeChip key={bridge} bridge={bridge} />
                      ))}
                    </div>
                    <div className="mb-3 text-[11px] uppercase tracking-[0.22em] text-slate-400">Discoverable on</div>
                    <div className="mb-5 flex flex-wrap gap-2">
                      {activeContact.discoverableOn.map((bridge) => (
                        <BridgeChip key={bridge} bridge={bridge} />
                      ))}
                    </div>
                    <div className="grid gap-2">
                      <Button className="rounded-xl" onClick={() => onMessageContact?.(activeContact)} disabled={!onMessageContact || !activeContact.bridgeHostId || !activeContact.bridgePeerNodeId}>
                        Message
                      </Button>
                      <Button variant="secondary" className="rounded-xl">
                        <Eye className="mr-2 h-4 w-4" />
                        View full profile
                      </Button>
                    </div>
                  </div>
                ) : activeContactRequest ? (
                  <div>
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <div className="app-badge-neutral px-2.5 py-1 text-[10px] font-medium">{activeContactRequest.time}</div>
                    </div>
                    <div className="mb-5 text-sm text-slate-300">{activeContactRequest.detail}</div>
                    <div className="grid gap-2">
                      <Button className="rounded-xl">Accept</Button>
                      <Button variant="secondary" className="rounded-xl">
                        Reject
                      </Button>
                      <Button variant="secondary" className="rounded-xl" onClick={onCloseOverlay}>
                        Close review
                      </Button>
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

type AgentsPageProps = {
  agents: Agent[];
  activeAgentId: string;
  activeAgent?: Agent;
  onOpenAgent: (agentId: string) => void;
  getStatusBadgeClass: (value: string) => string;
  onMessageAgent?: (agent: Agent) => void;
};

type AgentConfigDraft = {
  systemPrompt: string;
  loadedSkills: string[];
};

type PersistedAgentConfig = AgentConfigDraft & {
  loadedTools: string[];
  loadedPlugins: string[];
  editHistory: AgentEditHistoryEntry[];
};

type AgentEditHistoryEntry = {
  path: string;
  action: string;
  timestamp: string;
};

type AgentSaveFeedback = {
  tone: 'idle' | 'info' | 'success' | 'error';
  text: string;
};

const AGENT_CONFIG_STORAGE_KEY = 'kordi.agent-config-drafts.v1';

function buildAgentDraft(agent: Agent): AgentConfigDraft {
  return {
    systemPrompt: agent.systemPrompt,
    loadedSkills: agent.loadedSkills,
  };
}

function buildPersistedAgentConfig(agent: Agent): PersistedAgentConfig {
  return {
    ...buildAgentDraft(agent),
    loadedTools: agent.loadedTools,
    loadedPlugins: agent.loadedPlugins,
    editHistory: [],
  };
}

function getAgentConfigPath(agent: Agent) {
  return agent.identityFiles.find((file) => file.endsWith('config.json')) ?? null;
}

function isRepoFilePath(path: string) {
  return !path.includes('://') && !path.includes(' • ');
}

function formatHistoryPath(path: string) {
  return path.split('/').join(' › ');
}

function getAgentInitials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

function AgentConfigList({ items, emptyLabel }: { items: string[]; emptyLabel: string }) {
  if (items.length === 0) {
    return <div className="text-sm text-slate-500">{emptyLabel}</div>;
  }

  return (
    <div className="flex flex-wrap gap-2">
      {items.map((item) => (
        <Badge key={item} variant="outline" className="rounded-full border-white/10 px-2.5 py-1 text-[11px] text-slate-200">
          {item}
        </Badge>
      ))}
    </div>
  );
}

function buildIdentityFilePreview(agent: Agent, config: AgentConfigDraft, file: string) {
  if (file.endsWith('.json')) {
    return JSON.stringify(
      {
        id: agent.id,
        name: agent.name,
        role: agent.role,
        loadedSkills: config.loadedSkills,
        loadedTools: agent.loadedTools,
        loadedPlugins: agent.loadedPlugins,
      },
      null,
      2,
    );
  }

  if (file.endsWith('identity.md')) {
    return [
      `# ${agent.name}`,
      '',
      `- id: ${agent.id}`,
      `- role: ${agent.role}`,
      `- contact: ${agent.contactId}`,
      `- messaging: ${agent.messaging}`,
      `- bridge: ${agent.bridgesConfig}`,
    ].join('\n');
  }

  if (file.endsWith('.toml')) {
    return [
      `agent_id = "${agent.id}"`,
      `model = "${agent.defaultModel}"`,
      `provider = "${agent.defaultProvider}"`,
      `scope = "private"`,
      `skills = [${config.loadedSkills.map((skill) => `"${skill}"`).join(', ')}]`,
    ].join('\n');
  }

  return [
    `# ${file.split('/').pop()}`,
    '',
    `## System prompt`,
    config.systemPrompt,
    '',
    `## Loaded skills`,
    ...(config.loadedSkills.length > 0 ? config.loadedSkills.map((skill) => `- ${skill}`) : ['- none']),
  ].join('\n');
}

function parsePersistedAgentConfig(raw: string, agent: Agent): PersistedAgentConfig {
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedAgentConfig> & { editHistory?: unknown };
    return {
      systemPrompt: typeof parsed.systemPrompt === 'string' ? parsed.systemPrompt : agent.systemPrompt,
      loadedSkills: Array.isArray(parsed.loadedSkills)
        ? parsed.loadedSkills.filter((entry): entry is string => typeof entry === 'string')
        : agent.loadedSkills,
      loadedTools: Array.isArray(parsed.loadedTools)
        ? parsed.loadedTools.filter((entry): entry is string => typeof entry === 'string')
        : agent.loadedTools,
      loadedPlugins: Array.isArray(parsed.loadedPlugins)
        ? parsed.loadedPlugins.filter((entry): entry is string => typeof entry === 'string')
        : agent.loadedPlugins,
      editHistory: Array.isArray(parsed.editHistory)
        ? parsed.editHistory.flatMap((entry) => {
            if (!entry || typeof entry !== 'object') return [];
            const record = entry as Record<string, unknown>;
            if (typeof record.path !== 'string' || typeof record.action !== 'string' || typeof record.timestamp !== 'string') {
              return [];
            }
            return [{ path: record.path, action: record.action, timestamp: record.timestamp } satisfies AgentEditHistoryEntry];
          })
        : [],
    };
  } catch {
    return buildPersistedAgentConfig(agent);
  }
}

function readStoredAgentDrafts() {
  if (typeof window === 'undefined') return {} as Record<string, AgentConfigDraft>;

  try {
    const raw = window.localStorage.getItem(AGENT_CONFIG_STORAGE_KEY);
    if (!raw) return {} as Record<string, AgentConfigDraft>;
    const parsed = JSON.parse(raw) as Record<string, Partial<AgentConfigDraft>>;
    return Object.fromEntries(
      Object.entries(parsed).map(([agentId, draft]) => [
        agentId,
        {
          systemPrompt: typeof draft.systemPrompt === 'string' ? draft.systemPrompt : '',
          loadedSkills: Array.isArray(draft.loadedSkills)
            ? draft.loadedSkills.filter((entry): entry is string => typeof entry === 'string')
            : [],
        },
      ]),
    );
  } catch {
    return {} as Record<string, AgentConfigDraft>;
  }
}

function AgentInspectorSection({ title, detail, children, className }: { title: string; detail?: string; children: ReactNode; className?: string }) {
  return (
    <section className={cn('rounded-[18px] border border-white/8 bg-white/[0.025] p-4', className)}>
      <div className="text-[12px] font-medium text-white">{title}</div>
      {detail ? <div className="mt-1 text-[12px] leading-5 text-slate-400">{detail}</div> : null}
      <div className="mt-3">{children}</div>
    </section>
  );
}

export function AgentsPage({
  agents,
  activeAgentId,
  activeAgent,
  onOpenAgent,
  getStatusBadgeClass,
  onMessageAgent,
}: AgentsPageProps) {
  const [agentDrafts, setAgentDrafts] = useState<Record<string, AgentConfigDraft>>(() => readStoredAgentDrafts());
  const [persistedAgentConfigs, setPersistedAgentConfigs] = useState<Record<string, PersistedAgentConfig>>({});
  const [selectedIdentityFileByAgentId, setSelectedIdentityFileByAgentId] = useState<Record<string, string>>({});
  const [editingSectionByAgentId, setEditingSectionByAgentId] = useState<Record<string, 'prompt' | 'skills' | null>>({});
  const [saveFeedbackByAgentId, setSaveFeedbackByAgentId] = useState<Record<string, AgentSaveFeedback>>({});
  const [activeFilePreview, setActiveFilePreview] = useState<{ status: 'idle' | 'loading' | 'ready' | 'error'; text: string; error?: string }>({ status: 'idle', text: '' });

  const availableSkills = useMemo(
    () => Array.from(new Set(agents.flatMap((agent) => agent.loadedSkills))).sort((left, right) => left.localeCompare(right)),
    [agents],
  );

  const agentConfigs = useMemo(
    () =>
      Object.fromEntries(
        agents.map((agent) => {
          const persisted = persistedAgentConfigs[agent.id] ?? buildPersistedAgentConfig(agent);
          return [
            agent.id,
            {
              systemPrompt: agentDrafts[agent.id]?.systemPrompt ?? persisted.systemPrompt,
              loadedSkills: agentDrafts[agent.id]?.loadedSkills ?? persisted.loadedSkills,
            },
          ];
        }),
      ) as Record<string, AgentConfigDraft>,
    [agentDrafts, agents, persistedAgentConfigs],
  );

  const activeAgentConfig = activeAgent ? agentConfigs[activeAgent.id] ?? buildAgentDraft(activeAgent) : null;
  const activePersistedConfig = activeAgent ? persistedAgentConfigs[activeAgent.id] ?? buildPersistedAgentConfig(activeAgent) : null;
  const activeIdentityFile = activeAgent
    ? selectedIdentityFileByAgentId[activeAgent.id] ?? activeAgent.identityFiles[0] ?? null
    : null;
  const activeConfigPath = activeAgent ? getAgentConfigPath(activeAgent) : null;
  const activeSaveFeedback = activeAgent
    ? saveFeedbackByAgentId[activeAgent.id] ?? { tone: 'idle', text: activeConfigPath ? `Loaded from ${activeConfigPath}` : 'Using preview data' }
    : null;
  const activeEditingSection = activeAgent ? editingSectionByAgentId[activeAgent.id] ?? null : null;
  const canUseNativeFileAccess = typeof window !== 'undefined' && typeof window.__TAURI_INTERNALS__ !== 'undefined';

  const updateAgentDraft = (agentId: string, apply: (current: AgentConfigDraft) => AgentConfigDraft) => {
    setAgentDrafts((current) => {
      const fallbackAgent = agents.find((agent) => agent.id === agentId) ?? activeAgent ?? agents[0];
      const baseline = current[agentId] ?? buildAgentDraft(fallbackAgent);
      return {
        ...current,
        [agentId]: apply(baseline),
      };
    });
    setSaveFeedbackByAgentId((current) => ({
      ...current,
      [agentId]: { tone: 'info', text: 'Unsaved changes' },
    }));
  };

  const resetAgentDraft = (agent: Agent) => {
    const persisted = persistedAgentConfigs[agent.id] ?? buildPersistedAgentConfig(agent);
    setAgentDrafts((current) => ({
      ...current,
      [agent.id]: {
        systemPrompt: persisted.systemPrompt,
        loadedSkills: persisted.loadedSkills,
      },
    }));
    setEditingSectionByAgentId((current) => ({ ...current, [agent.id]: null }));
    setSaveFeedbackByAgentId((current) => ({
      ...current,
      [agent.id]: { tone: 'info', text: activeConfigPath ? `Reverted to ${activeConfigPath}` : 'Reverted to saved values' },
    }));
  };

  useEffect(() => {
    if (typeof window === 'undefined') return;

    window.localStorage.setItem(AGENT_CONFIG_STORAGE_KEY, JSON.stringify(agentDrafts));
  }, [agentDrafts]);

  useEffect(() => {
    let cancelled = false;

    const loadPersistedConfigs = async () => {
      const nextEntries = await Promise.all(
        agents.map(async (agent) => {
          const configPath = getAgentConfigPath(agent);
          if (!canUseNativeFileAccess || !configPath || !isRepoFilePath(configPath)) {
            return [agent.id, buildPersistedAgentConfig(agent)] as const;
          }

          try {
            const raw = await readDesktopWorkspaceTextFile(configPath);
            return [agent.id, parsePersistedAgentConfig(raw, agent)] as const;
          } catch {
            return [agent.id, buildPersistedAgentConfig(agent)] as const;
          }
        }),
      );

      if (cancelled) return;
      setPersistedAgentConfigs(Object.fromEntries(nextEntries));
    };

    void loadPersistedConfigs();
    return () => {
      cancelled = true;
    };
  }, [agents, canUseNativeFileAccess]);

  useEffect(() => {
    let cancelled = false;

    const loadActiveFilePreview = async () => {
      if (!activeAgent || !activeAgentConfig || !activeIdentityFile) {
        if (!cancelled) setActiveFilePreview({ status: 'idle', text: '' });
        return;
      }

      if (canUseNativeFileAccess && isRepoFilePath(activeIdentityFile)) {
        setActiveFilePreview({ status: 'loading', text: '' });
        try {
          const raw = await readDesktopWorkspaceTextFile(activeIdentityFile);
          if (!cancelled) setActiveFilePreview({ status: 'ready', text: raw });
          return;
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unable to load file preview';
          if (!cancelled) {
            setActiveFilePreview({
              status: 'error',
              text: buildIdentityFilePreview(activeAgent, activeAgentConfig, activeIdentityFile),
              error: message,
            });
          }
          return;
        }
      }

      if (!cancelled) {
        setActiveFilePreview({
          status: 'ready',
          text: buildIdentityFilePreview(activeAgent, activeAgentConfig, activeIdentityFile),
        });
      }
    };

    void loadActiveFilePreview();
    return () => {
      cancelled = true;
    };
  }, [activeAgent, activeAgentConfig, activeIdentityFile, canUseNativeFileAccess]);

  const saveAgentConfig = async (agent: Agent, section: 'prompt' | 'skills') => {
    const configPath = getAgentConfigPath(agent);
    const draft = agentConfigs[agent.id] ?? buildAgentDraft(agent);
    const persisted = persistedAgentConfigs[agent.id] ?? buildPersistedAgentConfig(agent);

    if (!canUseNativeFileAccess || !configPath || !isRepoFilePath(configPath)) {
      setEditingSectionByAgentId((current) => ({ ...current, [agent.id]: null }));
      setSaveFeedbackByAgentId((current) => ({
        ...current,
        [agent.id]: { tone: 'success', text: `Saved ${section} locally` },
      }));
      return;
    }

    setSaveFeedbackByAgentId((current) => ({
      ...current,
      [agent.id]: { tone: 'info', text: `Saving to ${configPath}…` },
    }));

    const nextPersisted: PersistedAgentConfig = {
      systemPrompt: draft.systemPrompt,
      loadedSkills: draft.loadedSkills,
      loadedTools: persisted.loadedTools,
      loadedPlugins: persisted.loadedPlugins,
      editHistory: [
        {
          path: configPath,
          action: section === 'prompt' ? 'Saved system prompt' : 'Saved loaded skills',
          timestamp: new Date().toLocaleString(),
        },
        ...persisted.editHistory,
      ].slice(0, 12),
    };

    try {
      await writeDesktopWorkspaceTextFile(configPath, `${JSON.stringify(nextPersisted, null, 2)}\n`);
      setPersistedAgentConfigs((current) => ({ ...current, [agent.id]: nextPersisted }));
      setEditingSectionByAgentId((current) => ({ ...current, [agent.id]: null }));
      setSaveFeedbackByAgentId((current) => ({
        ...current,
        [agent.id]: { tone: 'success', text: `${section === 'prompt' ? 'System prompt' : 'Skills'} saved to ${configPath}` },
      }));
      if (activeIdentityFile === configPath) {
        setActiveFilePreview({ status: 'ready', text: `${JSON.stringify(nextPersisted, null, 2)}\n` });
      }
    } catch (error) {
      setSaveFeedbackByAgentId((current) => ({
        ...current,
        [agent.id]: { tone: 'error', text: error instanceof Error ? error.message : 'Unable to save agent config' },
      }));
    }
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 p-4">
      <div className="grid h-full min-h-0 w-full gap-px overflow-hidden rounded-[22px] border border-white/8 bg-white/[0.04] xl:grid-cols-[310px_minmax(0,1fr)]">
        <aside className="flex min-h-0 flex-col bg-white/[0.02] text-white">
          <div className="border-b border-white/6 px-4 py-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-[14px] font-medium text-white">Agents</div>
                <div className="mt-1 text-[12px] leading-5 text-slate-400">{agents.length} visible identities • isolated configuration</div>
              </div>
              <Button className="app-control-chip h-9 w-9 rounded-[12px] border-0 p-0">
                <Plus className="h-4 w-4" />
              </Button>
            </div>
          </div>

          <ScrollArea className="min-h-0 flex-1">
            <div className="space-y-1 p-2">
              {agents.map((agent) => {
                const config = agentConfigs[agent.id] ?? buildAgentDraft(agent);
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

        <section className="flex min-h-0 min-w-0 flex-col bg-[rgba(20,20,24,0.42)] text-white">
          {activeAgent && activeAgentConfig ? (
            <>
              <div className="border-b border-white/6 px-5 py-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="text-[12px] font-medium text-slate-400">Agent configuration</div>
                    <div className="mt-1 text-[24px] font-semibold tracking-[-0.02em] text-white">{activeAgent.name}</div>
                    <div className="mt-1 text-[13px] text-slate-400">{activeAgent.id} • isolated settings for this identity only</div>
                    {activeSaveFeedback ? (
                      <div className={cn(
                        'mt-2 text-[12px]',
                        activeSaveFeedback.tone === 'success'
                          ? 'text-emerald-300'
                          : activeSaveFeedback.tone === 'error'
                            ? 'text-rose-300'
                            : 'text-slate-400',
                      )}>
                        {activeSaveFeedback.text}
                      </div>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button variant="secondary" className="rounded-xl text-[12px]" onClick={() => resetAgentDraft(activeAgent)}>
                      Reset
                    </Button>
                    <Button
                      className="rounded-xl text-[12px]"
                      onClick={() => onMessageAgent?.({ ...activeAgent, ...activeAgentConfig, loadedSkills: activeAgentConfig.loadedSkills })}
                      disabled={!onMessageAgent || !activeAgent.bridgeHostId || !activeAgent.bridgePeerNodeId}
                    >
                      Message
                    </Button>
                  </div>
                </div>
              </div>

              <ScrollArea className="min-h-0 flex-1">
                <div className="space-y-5 px-5 py-5">
                  <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
                    <AgentInspectorSection title="System prompt" detail="Keep this short, explicit, and identity-specific.">
                      <div className="mb-3 flex items-center justify-between gap-2">
                        <div className="text-[11px] text-slate-500">Source: {activeConfigPath ?? 'draft only'}</div>
                        {activeEditingSection === 'prompt' ? (
                          <div className="flex items-center gap-2">
                            <Button variant="secondary" className="h-8 rounded-[10px] px-3 text-[12px]" onClick={() => resetAgentDraft(activeAgent)}>
                              Cancel
                            </Button>
                            <Button className="h-8 rounded-[10px] px-3 text-[12px]" onClick={() => void saveAgentConfig(activeAgent, 'prompt')}>
                              Save
                            </Button>
                          </div>
                        ) : (
                          <Button variant="secondary" className="h-8 rounded-[10px] px-3 text-[12px]" onClick={() => setEditingSectionByAgentId((current) => ({ ...current, [activeAgent.id]: 'prompt' }))}>
                            Edit
                          </Button>
                        )}
                      </div>
                      {activeEditingSection === 'prompt' ? (
                        <textarea
                          rows={9}
                          value={activeAgentConfig.systemPrompt}
                          onChange={(event) => updateAgentDraft(activeAgent.id, (current) => ({ ...current, systemPrompt: event.target.value }))}
                          className="app-input-shell app-settings-field min-h-[188px] w-full rounded-[14px] px-3 py-2 text-[13px] text-white outline-none"
                          placeholder="Add the standing instruction for this agent"
                        />
                      ) : (
                        <div className="rounded-[14px] border border-white/6 bg-white/[0.03] px-4 py-3 text-[13px] leading-7 text-slate-200">
                          {activeAgentConfig.systemPrompt}
                        </div>
                      )}
                    </AgentInspectorSection>

                    <AgentInspectorSection title="Loaded skills" detail="Toggle the skills this agent should carry.">
                      <div className="mb-3 flex items-center justify-between gap-2">
                        <div className="text-[11px] text-slate-500">Persisted in {activeConfigPath ?? 'draft only'}</div>
                        {activeEditingSection === 'skills' ? (
                          <div className="flex items-center gap-2">
                            <Button variant="secondary" className="h-8 rounded-[10px] px-3 text-[12px]" onClick={() => resetAgentDraft(activeAgent)}>
                              Cancel
                            </Button>
                            <Button className="h-8 rounded-[10px] px-3 text-[12px]" onClick={() => void saveAgentConfig(activeAgent, 'skills')}>
                              Save
                            </Button>
                          </div>
                        ) : (
                          <Button variant="secondary" className="h-8 rounded-[10px] px-3 text-[12px]" onClick={() => setEditingSectionByAgentId((current) => ({ ...current, [activeAgent.id]: 'skills' }))}>
                            Edit
                          </Button>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {availableSkills.map((skill) => {
                          const selected = activeAgentConfig.loadedSkills.includes(skill);
                          return (
                            <button
                              key={skill}
                              type="button"
                              disabled={activeEditingSection !== 'skills'}
                              onClick={() => updateAgentDraft(activeAgent.id, (current) => ({
                                ...current,
                                loadedSkills: selected
                                  ? current.loadedSkills.filter((entry) => entry !== skill)
                                  : [...current.loadedSkills, skill].sort((left, right) => left.localeCompare(right)),
                              }))}
                              className={cn(
                                'rounded-full border px-3 py-1.5 text-[12px] transition',
                                selected
                                  ? 'border-white/14 bg-white/[0.08] text-white'
                                  : 'border-white/8 bg-transparent text-slate-400',
                                activeEditingSection === 'skills'
                                  ? 'hover:border-white/12 hover:text-slate-200'
                                  : 'cursor-default opacity-80',
                              )}
                            >
                              {skill}
                            </button>
                          );
                        })}
                      </div>
                    </AgentInspectorSection>
                  </div>

                  <div className="grid gap-5 xl:grid-cols-[280px_minmax(0,1fr)]">
                    <AgentInspectorSection title="Identity files" detail="Select a file to inspect its contents.">
                      <div className="space-y-1.5">
                        {activeAgent.identityFiles.map((file) => {
                          const selected = activeIdentityFile === file;
                          return (
                            <button
                              key={file}
                              type="button"
                              onClick={() => setSelectedIdentityFileByAgentId((current) => ({ ...current, [activeAgent.id]: file }))}
                              className={cn(
                                'block w-full rounded-[12px] px-3 py-2 text-left text-[12px] transition',
                                selected ? 'bg-white/[0.08] text-white' : 'text-slate-300 hover:bg-white/[0.04]',
                              )}
                            >
                              <div className="truncate">{file.split('/').pop()}</div>
                              <div className="mt-0.5 truncate text-[11px] text-slate-500">{file}</div>
                            </button>
                          );
                        })}
                      </div>
                    </AgentInspectorSection>

                    <AgentInspectorSection title="File preview" detail={activeIdentityFile ?? 'No file selected'} className="bg-[#16161a]">
                      <div className="overflow-hidden rounded-[14px] border border-white/6 bg-black/20">
                        <div className="border-b border-white/6 px-4 py-2 text-[11px] text-slate-500">
                          {activeFilePreview.status === 'loading'
                            ? 'Loading real file…'
                            : activeFilePreview.status === 'error'
                              ? `Preview fallback • ${activeFilePreview.error ?? 'Unable to read file'}`
                              : 'Preview'}
                        </div>
                        <pre className="max-h-[420px] overflow-auto px-4 py-4 font-mono text-[12px] leading-6 text-slate-300">{activeFilePreview.text}</pre>
                      </div>
                    </AgentInspectorSection>
                  </div>

                  <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                    <AgentInspectorSection title="Tools and plugins">
                      <div className="space-y-4">
                        <div>
                          <div className="mb-2 text-[11px] text-slate-500">Loaded tools</div>
                          <AgentConfigList items={activePersistedConfig?.loadedTools ?? activeAgent.loadedTools} emptyLabel="No tools loaded for this identity." />
                        </div>
                        <div>
                          <div className="mb-2 text-[11px] text-slate-500">Loaded plugins</div>
                          <AgentConfigList items={activePersistedConfig?.loadedPlugins ?? activeAgent.loadedPlugins} emptyLabel="No plugins loaded for this identity." />
                        </div>
                      </div>
                    </AgentInspectorSection>

                    <AgentInspectorSection title="Identity metadata">
                      <div className="overflow-hidden rounded-[14px] border border-white/6 bg-white/[0.02]">
                        {[
                          ['Default provider', activeAgent.defaultProvider],
                          ['Default model', activeAgent.defaultModel],
                          ['Bridge config', activeAgent.bridgesConfig],
                          ['Contact ID', activeAgent.contactId],
                        ].map(([label, value], index) => (
                          <div key={label} className={cn('flex items-start justify-between gap-3 px-3 py-2.5 text-[12px]', index > 0 && 'border-t border-white/6')}>
                            <div className="text-slate-500">{label}</div>
                            <div className="max-w-[60%] text-right text-slate-200">{value}</div>
                          </div>
                        ))}
                      </div>
                    </AgentInspectorSection>
                  </div>

                  <AgentInspectorSection title="Edit history" detail="Recent saved changes, shown in file path style.">
                    <div className="overflow-hidden rounded-[14px] border border-white/6 bg-white/[0.02]">
                      {(activePersistedConfig?.editHistory ?? []).length > 0 ? (
                        (activePersistedConfig?.editHistory ?? []).map((entry, index) => (
                          <div key={`${entry.path}-${entry.timestamp}-${index}`} className={cn('px-3 py-3', index > 0 && 'border-t border-white/6')}>
                            <div className="font-mono text-[11px] text-slate-400">{formatHistoryPath(entry.path)}</div>
                            <div className="mt-1 text-[13px] text-slate-100">{entry.action}</div>
                            <div className="mt-1 text-[11px] text-slate-500">{entry.timestamp}</div>
                          </div>
                        ))
                      ) : (
                        <div className="px-3 py-3 text-[13px] text-slate-500">No saved edits yet.</div>
                      )}
                    </div>
                  </AgentInspectorSection>

                  <AgentInspectorSection title="Recent activity">
                    <div className="overflow-hidden rounded-[14px] border border-white/6 bg-white/[0.02]">
                      {activeAgent.lastActivities.map((activity, index) => (
                        <div key={activity} className={cn('px-3 py-2.5 text-[13px] text-slate-200', index > 0 && 'border-t border-white/6')}>
                          {activity}
                        </div>
                      ))}
                    </div>
                  </AgentInspectorSection>
                </div>
              </ScrollArea>
            </>
          ) : (
            <div className="flex h-full items-center justify-center px-6 text-center text-slate-400">
              Select an agent to inspect its prompt, identity files, skills, tools, and plugins.
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

export { AuthPage } from './auth/AuthPage';
