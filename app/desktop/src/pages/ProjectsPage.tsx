import type { Dispatch, RefObject, SetStateAction } from 'react';
import { motion } from 'framer-motion';
import {
  FileText,
  FolderOpen,
  Globe,
  Image as ImageIcon,
  Layers3,
  Paperclip,
  PanelLeftClose,
  PanelLeftOpen,
  Send,
  Square,
  Users,
  X,
} from 'lucide-react';

import { localOwnedAgentSenderLabel, suppressLiveTurnEchoMessages } from '@/app/viewModels/helpers';
import { AuthNoticeBanner } from '@/components/AuthNoticeBanner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  ComposerMentionMenu,
  ComposerModelControls,
  ComposerRuntimeStatus,
  ComposerSlashMenu,
  LiveChatTurnMessage,
  MessageBubble,
  type ComposerAuthOption,
  type ComposerMentionOption,
  type ComposerModelOption,
  type ComposerProviderOption,
} from '@/kordi-app/components';
import type {
  DesktopBridgeHost,
  DesktopBridgeProject,
  DesktopChatContextWindowStatus,
  DesktopChatSlashCommand,
  DesktopChatTurnSnapshot,
  EditFilePreview,
  Message,
} from '@/kordi-app/types';
import { cn } from '@/lib/utils';

type ProjectSession = {
  id: string;
  name: string;
  summary: string;
  lastActive: string;
  status: string;
  participants: string[];
  artifacts: number;
  tasks: number;
  messages: Message[];
};

type ProjectWorkspace = {
  id: string;
  name: string;
  summary: string;
  bridge: string;
  scope: string;
  status: string;
  people: Array<unknown>;
  agents: Array<unknown>;
  pendingInvites: Array<unknown>;
  artifacts: number;
  tasks: number;
  root?: string;
  sharedContext?: string;
  backgroundSystem?: string;
  sharedSources?: Array<{ label: string; path?: string | null; detail?: string | null }>;
  sessions: ProjectSession[];
};

type Attachment = {
  id: string;
  name: string;
  path: string;
  kind: 'image' | 'file';
};

type ProjectsPageProps = {
  isNativeShell: boolean;
  collapseChatSessions: boolean;
  setIsSessionPanelCollapsed: Dispatch<SetStateAction<boolean>>;
  showRightDetailRail: boolean;
  isDetailPanelCollapsed: boolean;
  setIsDetailPanelCollapsed: Dispatch<SetStateAction<boolean>>;
  activeProject: ProjectWorkspace;
  activeProjectSession: ProjectSession;
  desktopSessionRenameDraft: string;
  setDesktopSessionRenameDraft: Dispatch<SetStateAction<string>>;
  isEditingDesktopSessionTitle: boolean;
  setIsEditingDesktopSessionTitle: Dispatch<SetStateAction<boolean>>;
  onRenameDesktopSession: (baselineName: string) => Promise<void>;
  onCreateProjectSession: () => void;
  chatTranscriptScrollRef: RefObject<HTMLDivElement | null>;
  onTranscriptScroll: () => void;
  onOpenSource: (file: EditFilePreview) => void;
  desktopLiveTurn: DesktopChatTurnSnapshot | null;
  filteredProjectSlashCommands: DesktopChatSlashCommand[];
  filteredProjectMentionTargets: ComposerMentionOption[];
  chatSlashMenuIndex: number;
  setChatSlashMenuIndex: Dispatch<SetStateAction<number>>;
  acceptProjectSlashCommand: (value: string) => void;
  acceptProjectMentionTarget: (value: string) => void;
  chatAttachmentInputRef: RefObject<HTMLInputElement | null>;
  chatComposerAttachments: Attachment[];
  saveDesktopAttachments: (files: File[]) => Promise<Attachment[]>;
  removeChatComposerAttachment: (id: string) => void;
  projectComposerText: string;
  updateProjectComposerDraft: (value: string, target: HTMLTextAreaElement) => void;
  setProjectComposerText: (value: string) => void;
  composerControlsRef: RefObject<HTMLDivElement | null>;
  activeRuntimeSessionId?: string;
  activeRuntimeContextStatus?: DesktopChatContextWindowStatus | null;
  activeRuntimeCacheText?: string | null;
  composerSelection: { mode: string; model: string; thinking: string };
  openComposerSelector: { scope: 'chat' | 'project'; type: 'mode' | 'auth' | 'provider' | 'model' | 'thinking' } | null;
  toggleComposerSelector: (scope: 'chat' | 'project', type: 'mode' | 'auth' | 'provider' | 'model' | 'thinking') => void;
  selectComposerValue: (scope: 'chat' | 'project', type: 'mode' | 'auth' | 'provider' | 'model' | 'thinking', value: string) => void;
  composerAuthLabel: string;
  composerAuthOptions: ComposerAuthOption[];
  selectComposerAuthChoice: (scope: 'chat' | 'project', providerId: string, choice: string) => void;
  selectComposerProviderChoice: (scope: 'chat' | 'project', option: ComposerProviderOption) => void;
  composerProviderOptions: ComposerProviderOption[];
  chatModelOptions?: ComposerModelOption[];
  isDesktopChatSending: boolean;
  onStopDesktopChatTurn: () => void;
  onSendProjectMessage: (draftOverride?: string) => void;
  hasAnyAuth: boolean;
  onOpenAuthSettings: () => void;
};

export function ProjectsPage({
  isNativeShell,
  collapseChatSessions,
  setIsSessionPanelCollapsed,
  showRightDetailRail,
  isDetailPanelCollapsed,
  setIsDetailPanelCollapsed,
  activeProject,
  activeProjectSession,
  desktopSessionRenameDraft,
  setDesktopSessionRenameDraft,
  isEditingDesktopSessionTitle,
  setIsEditingDesktopSessionTitle,
  onRenameDesktopSession,
  onCreateProjectSession,
  chatTranscriptScrollRef,
  onTranscriptScroll,
  onOpenSource,
  desktopLiveTurn,
  filteredProjectSlashCommands,
  filteredProjectMentionTargets,
  chatSlashMenuIndex,
  setChatSlashMenuIndex,
  acceptProjectSlashCommand,
  acceptProjectMentionTarget,
  chatAttachmentInputRef,
  chatComposerAttachments,
  saveDesktopAttachments,
  removeChatComposerAttachment,
  projectComposerText,
  updateProjectComposerDraft,
  setProjectComposerText,
  composerControlsRef,
  activeRuntimeSessionId,
  activeRuntimeContextStatus,
  activeRuntimeCacheText,
  composerSelection,
  openComposerSelector,
  toggleComposerSelector,
  selectComposerValue,
  composerAuthLabel,
  composerAuthOptions,
  selectComposerAuthChoice,
  selectComposerProviderChoice,
  composerProviderOptions,
  chatModelOptions,
  isDesktopChatSending,
  onStopDesktopChatTurn,
  onSendProjectMessage,
  hasAnyAuth,
  onOpenAuthSettings,
}: ProjectsPageProps) {
  const canSubmitProjectMessage = projectComposerText.trim().length > 0 || chatComposerAttachments.length > 0;
  const activeProjectLiveTurn = desktopLiveTurn?.sessionId === activeProjectSession.id ? desktopLiveTurn : undefined;
  const transcriptMessages = suppressLiveTurnEchoMessages(activeProjectSession.messages, activeProjectLiveTurn);
  const shouldRenderLiveTurn = Boolean(activeProjectLiveTurn && !activeProjectLiveTurn.completed);
  const liveTurnSender = localOwnedAgentSenderLabel(activeProjectSession);

  if (isNativeShell && !activeProject.id) {
    return (
      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <div className="app-page-header shrink-0 flex items-start justify-between gap-3 px-4 py-2.5 shadow-[inset_0_-1px_0_var(--app-divider)]">
          <div>
            <div className="text-[17px] font-semibold text-white" data-kordi-window-drag="false">Projects</div>
            <div className="mt-1 text-[12px] text-slate-400">Projects should start explicitly from the + menu, not from ordinary chats.</div>
          </div>
        </div>
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="max-w-md rounded-[24px] border border-white/10 bg-white/[0.03] p-6 text-center text-slate-300">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-white/[0.05] text-white">
              <FolderOpen className="h-6 w-6" />
            </div>
            <div className="text-[16px] font-medium text-white">No project yet</div>
            <p className="mt-2 text-[13px] leading-6 text-slate-400">
              Normal sessions stay in Chats by default. Use the + menu to start a project from scratch or from an existing folder.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div className="app-page-header shrink-0 flex items-start justify-between gap-3 px-4 py-2.5 shadow-[inset_0_-1px_0_var(--app-divider)]">
        <div className="flex min-w-0 items-start gap-2.5">
          <button
            type="button"
            onClick={() => setIsSessionPanelCollapsed((collapsed) => !collapsed)}
            className="app-icon-button app-utility-button grid h-7.5 w-7.5 shrink-0 place-items-center rounded-[12px] text-slate-100 transition"
            aria-label={collapseChatSessions ? 'Open project panel' : 'Close project panel'}
            title={collapseChatSessions ? 'Open project panel' : 'Close project panel'}
          >
            {collapseChatSessions ? <PanelLeftOpen className="h-3.5 w-3.5" /> : <PanelLeftClose className="h-3.5 w-3.5" />}
          </button>
          <div className="min-w-0 flex-1">
            <div className="app-page-header-title-row mb-1 flex min-w-0 items-center gap-1.5 text-white">
              {isNativeShell && activeRuntimeSessionId === activeProjectSession.id ? (
                isEditingDesktopSessionTitle ? (
                  <input
                    value={desktopSessionRenameDraft}
                    onChange={(event) => setDesktopSessionRenameDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        event.currentTarget.blur();
                      }
                      if (event.key === 'Escape') {
                        event.preventDefault();
                        setDesktopSessionRenameDraft(activeProjectSession.name);
                        setIsEditingDesktopSessionTitle(false);
                      }
                    }}
                    onBlur={() => {
                      void onRenameDesktopSession(activeProjectSession.name);
                    }}
                    autoFocus
                    data-kordi-window-drag="false"
                    className="min-w-[220px] max-w-full rounded-lg bg-transparent px-1 py-0.5 text-left text-[17px] font-semibold text-white outline-none ring-1 ring-white/10 placeholder:text-slate-500 focus:ring-white/20"
                    placeholder="Session name"
                  />
                ) : (
                  <h2
                    onDoubleClick={() => {
                      setDesktopSessionRenameDraft(activeProjectSession.name);
                      setIsEditingDesktopSessionTitle(true);
                    }}
                    className="min-w-0 max-w-full truncate rounded-lg px-1 py-0.5 text-left text-[17px] font-semibold text-white transition hover:bg-white/5"
                    data-kordi-window-drag="false"
                    title="Double-click to rename session"
                  >
                    {activeProjectSession.name}
                  </h2>
                )
              ) : (
                <h2 className="min-w-0 max-w-full truncate text-[17px] font-semibold" data-kordi-window-drag="false">{activeProjectSession.name}</h2>
              )}
              <Badge variant="outline" className="shrink-0 whitespace-nowrap rounded-full border-white/15 px-2 py-0.5 text-[10px] leading-none text-slate-200">
                {activeProject.status}
              </Badge>
            </div>
            <div className="mb-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-slate-300">
              <span className="truncate">{activeProject.name}</span>
            </div>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] leading-5 text-slate-400">
              <span className="inline-flex items-center gap-1"><Globe className="h-3 w-3" /> {activeProject.bridge}</span>
              <span className="inline-flex items-center gap-1"><Users className="h-3 w-3" /> {activeProject.people.length + activeProject.agents.length} members</span>
              <span className="inline-flex items-center gap-1"><Layers3 className="h-3 w-3" /> {activeProject.sessions.length} sessions</span>
              <span className="inline-flex items-center gap-1"><FolderOpen className="h-3 w-3" /> {activeProject.artifacts} artifacts</span>
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2 self-start">
          {isNativeShell && activeProject.root ? (
            <Button
              type="button"
              variant="secondary"
              onClick={onCreateProjectSession}
              className="app-utility-button mt-0.5 h-8 rounded-full px-3 text-[12px] text-slate-100 transition"
              title="Create a new session in this project"
            >
              New session
            </Button>
          ) : null}
          {showRightDetailRail && (
            <Button
              type="button"
              variant="secondary"
              onClick={() => setIsDetailPanelCollapsed((collapsed) => !collapsed)}
              className="app-icon-button app-utility-button mt-0.5 h-8 rounded-full px-3 text-[12px] text-slate-100 transition"
              aria-label={isDetailPanelCollapsed ? 'Open project details' : 'Hide project details'}
              title={isDetailPanelCollapsed ? 'Open project details' : 'Hide project details'}
            >
              {isDetailPanelCollapsed ? 'Details' : 'Hide details'}
            </Button>
          )}
        </div>
      </div>

      {!hasAnyAuth ? (
        <AuthNoticeBanner
          title="No provider connected yet"
          description="Connect a cloud provider, save an API key, or choose a local LM Studio/Ollama server before running project conversations."
          onAction={onOpenAuthSettings}
        />
      ) : null}

      <div className="min-h-0 flex-1 overflow-hidden">
        <ScrollArea
          ref={chatTranscriptScrollRef}
          className="h-full min-h-0 px-3.5 py-3 sm:px-4 sm:py-3.5"
          onScroll={onTranscriptScroll}
        >
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-1">
            {transcriptMessages.map((msg, idx) => (
              <MessageBubble
                key={`${activeProjectSession.id}-${msg.time}-${idx}`}
                msg={msg}
                onOpenSource={onOpenSource}
              />
            ))}
            {shouldRenderLiveTurn && activeProjectLiveTurn ? <LiveChatTurnMessage turn={activeProjectLiveTurn} sender={liveTurnSender} /> : null}
          </motion.div>
        </ScrollArea>
      </div>

      <div className="shrink-0 px-5 pb-4 pt-3">
        <div className="app-composer-shell rounded-[26px] p-3">
          <div className="relative">
            {filteredProjectSlashCommands.length > 0 ? (
              <ComposerSlashMenu
                items={filteredProjectSlashCommands}
                selectedIndex={Math.min(chatSlashMenuIndex, filteredProjectSlashCommands.length - 1)}
                onSelect={acceptProjectSlashCommand}
              />
            ) : filteredProjectMentionTargets.length > 0 ? (
              <ComposerMentionMenu
                items={filteredProjectMentionTargets}
                selectedIndex={Math.min(chatSlashMenuIndex, filteredProjectMentionTargets.length - 1)}
                onSelect={acceptProjectMentionTarget}
              />
            ) : null}
            <div
              className={cn(
                'app-composer-input rounded-[18px] transition',
                chatComposerAttachments.length > 0 ? 'px-3 pb-1.5 pt-1' : 'px-4 py-2.5',
              )}
            >
              <input
                ref={chatAttachmentInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={(event) => {
                  const files = Array.from(event.target.files ?? []);
                  if (files.length > 0) {
                    void saveDesktopAttachments(files);
                  }
                  event.currentTarget.value = '';
                }}
              />
              {chatComposerAttachments.length > 0 ? (
                <div className="mb-1 flex flex-wrap items-center gap-1.5">
                  {chatComposerAttachments.map((attachment) => (
                    <div
                      key={attachment.id}
                      className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-full border border-[color:var(--app-divider)] bg-[color:var(--app-control-bg)] px-2.5 text-[11px] text-[color:var(--utility-foreground)]"
                    >
                      {attachment.kind === 'image' ? <ImageIcon className="h-3.5 w-3.5 shrink-0 text-sky-300" /> : <FileText className="h-3.5 w-3.5 shrink-0 text-slate-300" />}
                      <span className="max-w-[220px] truncate leading-none">{attachment.name}</span>
                      <button
                        type="button"
                        onClick={() => removeChatComposerAttachment(attachment.id)}
                        className="text-[color:var(--utility-muted-text)] transition hover:text-[color:var(--utility-foreground)]"
                        aria-label={`Remove ${attachment.name}`}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
              <textarea
                rows={1}
                value={projectComposerText}
                onChange={(event) => updateProjectComposerDraft(event.target.value, event.target)}
                onPaste={(event) => {
                  const files = Array.from(event.clipboardData.files ?? []);
                  if (files.length > 0) {
                    event.preventDefault();
                    void saveDesktopAttachments(files);
                  }
                }}
                onKeyDown={(event) => {
                  if (filteredProjectSlashCommands.length > 0) {
                    if (event.key === 'ArrowDown') {
                      event.preventDefault();
                      setChatSlashMenuIndex((current) => (current + 1) % filteredProjectSlashCommands.length);
                      return;
                    }
                    if (event.key === 'ArrowUp') {
                      event.preventDefault();
                      setChatSlashMenuIndex((current) => (current - 1 + filteredProjectSlashCommands.length) % filteredProjectSlashCommands.length);
                      return;
                    }
                    if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
                      event.preventDefault();
                      acceptProjectSlashCommand(filteredProjectSlashCommands[Math.min(chatSlashMenuIndex, filteredProjectSlashCommands.length - 1)]?.value ?? filteredProjectSlashCommands[0].value);
                      return;
                    }
                  }
                  if (filteredProjectMentionTargets.length > 0) {
                    if (event.key === 'ArrowDown') {
                      event.preventDefault();
                      event.stopPropagation();
                      setChatSlashMenuIndex((current) => (current + 1) % filteredProjectMentionTargets.length);
                      return;
                    }
                    if (event.key === 'ArrowUp') {
                      event.preventDefault();
                      event.stopPropagation();
                      setChatSlashMenuIndex((current) => (current - 1 + filteredProjectMentionTargets.length) % filteredProjectMentionTargets.length);
                      return;
                    }
                    if (((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      event.stopPropagation();
                      acceptProjectMentionTarget(filteredProjectMentionTargets[Math.min(chatSlashMenuIndex, filteredProjectMentionTargets.length - 1)]?.value ?? filteredProjectMentionTargets[0].value);
                      return;
                    }
                  }
                  if (event.key === 'Escape' && filteredProjectSlashCommands.length > 0) {
                    event.preventDefault();
                    setProjectComposerText('/');
                    return;
                  }
                  if (event.key === 'Escape' && filteredProjectMentionTargets.length > 0) {
                    event.preventDefault();
                    setProjectComposerText(projectComposerText.replace(/(^|\s)@([^\s@]*)$/, '$1'));
                    return;
                  }
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    if (canSubmitProjectMessage) {
                      onSendProjectMessage(event.currentTarget.value);
                    }
                  }
                }}
                className="min-h-[24px] max-h-[220px] w-full resize-none overflow-y-auto bg-transparent px-0 py-0 text-[15px] leading-6 text-[color:var(--utility-foreground)] outline-none placeholder:text-[color:var(--utility-muted-text)]"
                placeholder="Post to this project session, ask a member, or start a new topic…"
              />
            </div>
          </div>
          <div ref={composerControlsRef} className="app-composer-meta mt-2 flex items-center justify-between gap-4 pt-2.5">
            <div className="flex shrink-0 items-center gap-2 overflow-visible pr-1">
              <Button
                size="icon"
                variant="secondary"
                className="app-icon-button h-9 w-9 shrink-0 rounded-full border-0"
                onClick={() => chatAttachmentInputRef.current?.click()}
                title="Add attachment"
                aria-label="Add attachment"
              >
                <Paperclip className="h-4 w-4" />
              </Button>
            </div>
            <div className="flex min-w-0 shrink-0 items-center gap-3 overflow-visible">
              {isNativeShell && activeRuntimeSessionId === activeProjectSession.id ? (
                <ComposerRuntimeStatus
                  contextStatus={activeRuntimeContextStatus}
                  cacheText={activeRuntimeCacheText}
                />
              ) : null}
              <ComposerModelControls
                scope="project"
                selection={composerSelection}
                openSelector={openComposerSelector}
                onToggleSelector={toggleComposerSelector}
                onSelectValue={(scope, type, value) => {
                  void selectComposerValue(scope, type, value);
                }}
                authLabel={composerAuthLabel}
                authOptions={composerAuthOptions}
                onSelectAuthChoice={(scope, providerId, choice) => {
                  void selectComposerAuthChoice(scope, providerId, choice);
                }}
                onSelectProviderChoice={(scope, option) => {
                  void selectComposerProviderChoice(scope, option);
                }}
                providerOptions={composerProviderOptions}
                modelOptions={chatModelOptions && chatModelOptions.length > 0 ? chatModelOptions : undefined}
              />
              <Button
                className={cn(
                  'app-composer-send h-10 w-10 shrink-0 rounded-full p-0',
                  isDesktopChatSending && desktopLiveTurn?.sessionId === activeProjectSession.id ? 'bg-rose-500/90 text-white hover:bg-rose-500' : '',
                )}
                onClick={() => {
                  if (isDesktopChatSending && desktopLiveTurn?.sessionId === activeProjectSession.id) {
                    onStopDesktopChatTurn();
                    return;
                  }
                  if (canSubmitProjectMessage) {
                    onSendProjectMessage();
                  }
                }}
                disabled={isDesktopChatSending && desktopLiveTurn?.sessionId === activeProjectSession.id ? !desktopLiveTurn || desktopLiveTurn.completed : !canSubmitProjectMessage}
              >
                {isDesktopChatSending && desktopLiveTurn?.sessionId === activeProjectSession.id ? <Square className="h-3.5 w-3.5 fill-current" /> : <Send className="h-4 w-4" />}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
