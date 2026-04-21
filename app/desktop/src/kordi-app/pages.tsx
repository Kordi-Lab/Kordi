import { ChevronDown, ChevronRight, Eye, Plus, Search, X } from 'lucide-react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
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
  isAgentOverlayOpen: boolean;
  onOpenAgent: (agentId: string) => void;
  onCloseOverlay: () => void;
  getStatusBadgeClass: (value: string) => string;
  onMessageAgent?: (agent: Agent) => void;
};

export function AgentsPage({
  agents,
  activeAgentId,
  activeAgent,
  isAgentOverlayOpen,
  onOpenAgent,
  onCloseOverlay,
  getStatusBadgeClass,
  onMessageAgent,
}: AgentsPageProps) {
  return (
    <div className="relative flex h-full min-h-0 min-w-0 flex-1 p-4">
      <div className="h-full w-full">
        <ScrollArea className="h-full pr-2">
          <div className="w-full">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <div className="text-sm text-slate-400">Agents</div>
                <div className="text-xl font-semibold text-white">{agents.length} visible identities</div>
              </div>
              <Button className="app-control-chip rounded-xl border-0">
                <Plus className="mr-2 h-4 w-4" />
                New
              </Button>
            </div>
            <div className="grid gap-3 lg:grid-cols-2">
              {agents.map((agent) => (
                <Card
                  key={agent.id}
                  className="app-surface-card rounded-3xl text-white transition hover:-translate-y-[1px]"
                  onClick={() => onOpenAgent(agent.id)}
                >
                  <CardContent className="p-4">
                    <div className="mb-3 flex items-start justify-between gap-3">
                      <div>
                        <div className="font-medium">{agent.name}</div>
                        <div className="text-xs text-slate-400">{agent.id}</div>
                      </div>
                      <Badge variant="outline" className={cn('rounded-full px-2.5 py-1', getStatusBadgeClass(agent.status))}>
                        {agent.status}
                      </Badge>
                    </div>
                    <div className="mb-2 text-sm text-slate-300">{agent.role}</div>
                    <div className="mb-3 text-xs text-slate-400">Messaging: {agent.messaging}</div>
                    <div className="flex items-center justify-between text-xs text-slate-400">
                      <span>{agent.tasks} active tasks</span>
                      <Button
                        size="sm"
                        variant="secondary"
                        className="rounded-xl"
                        onClick={(event) => {
                          event.stopPropagation();
                          onOpenAgent(agent.id);
                        }}
                      >
                        Open
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        </ScrollArea>
      </div>
      {isAgentOverlayOpen && activeAgent && (
        <div className="app-overlay absolute inset-0 z-10 flex items-center justify-center px-4 py-8 backdrop-blur-[2px]">
          <div className="app-modal-panel w-full max-w-[520px] rounded-[28px] border border-white/10 p-5 text-white shadow-[var(--app-shadow-float)]">
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <div className="text-[11px] uppercase tracking-[0.24em] text-slate-400">Agent settings</div>
                <div className="mt-1 text-2xl font-semibold">{activeAgent.name}</div>
                <div className="mt-1 text-sm text-slate-400">{activeAgent.id}</div>
              </div>
              <button
                type="button"
                onClick={onCloseOverlay}
                className="app-icon-button rounded-full p-2 text-slate-300 transition hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="mb-4 grid gap-3 sm:grid-cols-2">
              <div className="app-detail-block rounded-2xl p-3">
                <div className="mb-1 text-[11px] uppercase tracking-[0.18em] text-slate-400">Default provider</div>
                <div className="text-sm font-medium">{activeAgent.defaultProvider}</div>
              </div>
              <div className="app-detail-block rounded-2xl p-3">
                <div className="mb-1 text-[11px] uppercase tracking-[0.18em] text-slate-400">Default model</div>
                <div className="text-sm font-medium">{activeAgent.defaultModel}</div>
              </div>
              <div className="app-detail-block rounded-2xl p-3">
                <div className="mb-1 text-[11px] uppercase tracking-[0.18em] text-slate-400">Bridge config</div>
                <div className="text-sm font-medium">{activeAgent.bridgesConfig}</div>
              </div>
              <div className="app-detail-block rounded-2xl p-3">
                <div className="mb-1 text-[11px] uppercase tracking-[0.18em] text-slate-400">Contact ID</div>
                <div className="text-sm font-medium">{activeAgent.contactId}</div>
              </div>
            </div>
            <div className="app-detail-block mb-4 rounded-2xl p-3">
              <div className="mb-1 text-[11px] uppercase tracking-[0.18em] text-slate-400">System prompt</div>
              <div className="text-sm text-slate-200">{activeAgent.systemPrompt}</div>
            </div>
            <div className="app-detail-block mb-4 rounded-2xl p-3">
              <div className="mb-1 text-[11px] uppercase tracking-[0.18em] text-slate-400">x.md</div>
              <div className="text-sm font-medium text-slate-200">{activeAgent.xMd}</div>
            </div>
            <div className="app-detail-block rounded-2xl p-3">
              <div className="mb-2 text-[11px] uppercase tracking-[0.18em] text-slate-400">Last activities</div>
              <div className="space-y-2">
                {activeAgent.lastActivities.map((activity) => (
                  <div key={activity} className="app-surface-muted rounded-xl px-3 py-2 text-sm text-slate-200">
                    {activity}
                  </div>
                ))}
              </div>
            </div>
            <div className="mt-4 grid gap-2">
              <Button className="rounded-xl" onClick={() => onMessageAgent?.(activeAgent)} disabled={!onMessageAgent || !activeAgent.bridgeHostId || !activeAgent.bridgePeerNodeId}>
                Message
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export { AuthPage } from './auth/AuthPage';
