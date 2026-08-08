import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LoaderCircle, Send, StopCircle } from 'lucide-react';

import { Button } from '@/components/ui/button';
import type { AttachmentItem } from '@/features/chat/composerController.types';
import { friendlyAttachmentName } from '@/features/chat/composerAttachments';
import { composerAttachmentItemFromStoredPath } from '@/features/chat/useComposerInputActions';
import { extractClipboardFiles, extractPastedLocalFilePaths } from '@/features/chat/pasteAttachments';
import { mapDesktopMessagesForTranscript } from '@/features/chat/useDesktopTranscriptAdapter';
import {
  storeDesktopChatAttachment,
  storeDesktopChatAttachmentPath,
  type DesktopChatMessageRoute,
} from '@/lib/desktop';
import { formatDesktopClockTime } from '@/lib/time';
import { cn } from '@/lib/utils';
import {
  ComposerModelControls,
  ComposerRuntimeStatus,
  LiveChatTurnMessage,
  MessageBubble,
  type ComposerModelOption,
  type ComposerProviderOption,
} from '../components';
import {
  ComposerAttachmentAddMenu,
  ComposerAttachmentList,
} from '../components/composerAttachments';
import { getLocalProfileAvatarSeed } from '../components/IdentityAvatar';
import type { ComposerScope, ComposerSelectorType, DesktopChatSessionDetail, DesktopChatTurnSnapshot, Message } from '../types';

type BuilderRouteSelection = {
  mode: string;
  model: string;
  thinking: string;
  authProvider?: string | null;
  authChoice?: string | null;
};

function normalizeProviderId(value?: string | null) {
  const normalized = value?.trim().toLowerCase() ?? '';
  return normalized === 'openai-codex' ? 'openai' : normalized;
}

function authChoiceFromProviderOption(option: ComposerProviderOption) {
  return option.value.includes('::') ? option.value.split('::').slice(1).join('::') : null;
}

function builderRouteFromDetail(
  detail: DesktopChatSessionDetail | null | undefined,
  modelOptions: ComposerModelOption[],
): BuilderRouteSelection {
  const provider = normalizeProviderId(detail?.provider);
  const model = detail?.model?.trim() ?? '';
  const matchedModel = modelOptions.find((option) => option.value === model)
    ?? modelOptions.find((option) => (
      normalizeProviderId(option.provider) === provider
      && (option.label === model || option.value.endsWith(`/${model}`))
    ));
  return {
    mode: 'Agent',
    model: matchedModel?.value ?? (provider && model ? `${provider}/${model}` : model || modelOptions[0]?.value || ''),
    thinking: detail?.thinking?.trim() || 'medium',
    authProvider: provider || null,
    authChoice: null,
  };
}

function attachmentFormatLabel(name: string, mimeType?: string) {
  return name.split('.').pop()?.trim().toUpperCase()
    || mimeType?.split('/').pop()?.trim().toUpperCase()
    || 'FILE';
}
function optimisticMessage(text: string, attachments: AttachmentItem[], avatar: {
  seed?: string | null;
  displayName?: string | null;
  imageUrl?: string | null;
}): Message {
  const timestampMs = Date.now();
  return {
    id: `agent-builder-optimistic:${text}`,
    role: 'user',
    sender: 'Me',
    senderType: 'human',
    senderAvatarSeed: avatar.seed?.trim() || getLocalProfileAvatarSeed(),
    senderProfileImageUrl: avatar.imageUrl?.trim() || null,
    sourceSenderLabel: avatar.displayName?.trim() || 'Me',
    isOwnMessage: true,
    text,
    attachments: attachments.map((attachment) => ({
      kind: attachment.kind,
      name: attachment.name,
      formatLabel: attachment.formatLabel,
      previewUrl: attachment.previewUrl,
      mimeType: attachment.mimeType,
      localPath: attachment.path,
      sizeBytes: attachment.sizeBytes,
    })),
    time: formatDesktopClockTime(timestampMs),
    timestampMs,
  };
}
export function AgentStudioConversation({
  targetName,
  creating,
  artifactKind = 'agent',
  localProfileAvatarSeed,
  localProfileDisplayName,
  localProfileImageUrl,
  sessionId,
  detail,
  activeTurn,
  optimisticPrompt,
  optimisticAttachments = [],
  opening,
  error,
  modelOptions = [],
  providerOptions = [],
  onSend,
  onStop,
  onOpenAuthSettings,
}: {
  targetName: string;
  creating: boolean;
  artifactKind?: 'agent' | 'skill' | 'tool' | 'plugin';
  localProfileAvatarSeed?: string | null;
  localProfileDisplayName?: string | null;
  localProfileImageUrl?: string | null;
  sessionId?: string | null;
  detail?: DesktopChatSessionDetail | null;
  activeTurn?: DesktopChatTurnSnapshot | null;
  optimisticPrompt?: string | null;
  optimisticAttachments?: AttachmentItem[];
  opening: boolean;
  error?: string | null;
  modelOptions?: ComposerModelOption[];
  providerOptions?: ComposerProviderOption[];
  onSend: (
    text: string,
    attachments?: AttachmentItem[],
    route?: DesktopChatMessageRoute | null,
  ) => Promise<void> | void;
  onStop: () => Promise<void> | void;
  onOpenAuthSettings?: () => void;
}) {
  const [draft, setDraft] = useState('');
  const [hasSubmittedMessage, setHasSubmittedMessage] = useState(false);
  const [attachments, setAttachments] = useState<AttachmentItem[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const attachmentInputRef = useRef<HTMLInputElement | null>(null);
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null);
  const attachmentsRef = useRef<AttachmentItem[]>([]);
  const lastResolvedSessionIdRef = useRef(sessionId ?? null);
  const [routeOverride, setRouteOverride] = useState<{
    sessionId: string | null;
    selection: BuilderRouteSelection;
  } | null>(null);
  const [openRouteSelector, setOpenRouteSelector] = useState<{
    scope: ComposerScope;
    type: ComposerSelectorType;
  } | null>(null);
  const busy = opening || Boolean(activeTurn && !activeTurn.completed);
  const suggestions = creating
    ? artifactKind === 'agent'
      ? [
          'I want to create an agent that helps me with…',
          'Give this agent clear boundaries for…',
          'Suggest only the capabilities this agent needs',
        ]
      : [
          `I want to create a ${artifactKind} for…`,
          `Define the inputs and outputs for this ${artifactKind}`,
          `Review this ${artifactKind} for unnecessary access`,
        ]
    : [
        'I want this agent to help me with…',
        'Review this agent for skills it does not need',
        'Suggest useful skills for this agent',
      ];
  const messages = useMemo(() => {
    if (!detail || !sessionId) return [];
    return mapDesktopMessagesForTranscript(sessionId, detail.messages, {
      agent: 'agent-builder',
      agentDisplayName: 'Kordi Factory',
      human: localProfileAvatarSeed,
      humanDisplayName: localProfileDisplayName,
      humanProfileImageUrl: localProfileImageUrl,
    });
  }, [detail, localProfileAvatarSeed, localProfileDisplayName, localProfileImageUrl, sessionId]);
  const defaultRouteSelection = useMemo(
    () => builderRouteFromDetail(detail, modelOptions),
    [detail, modelOptions],
  );
  const routeSelection = routeOverride?.sessionId === (sessionId ?? null)
    ? routeOverride.selection
    : defaultRouteSelection;
  const showOptimistic = optimisticPrompt !== null || optimisticAttachments.length > 0;
  const hasUserMessage = Boolean(detail?.messages.some((message) => message.role === 'user'));
  const showSuggestions = !hasSubmittedMessage && !hasUserMessage && !showOptimistic && !activeTurn;
  const hasVisibleRuntimeFailure = Boolean(error && messages.some((message) => (
    message.turn?.completed
    && !message.turn.succeeded
    && [message.turn.error, message.turn.message, message.detail]
      .some((value) => value?.trim() === error.trim())
  )));
  const standaloneErrorTurn = useMemo<DesktopChatTurnSnapshot | null>(() => {
    if (!error || hasVisibleRuntimeFailure) return null;
    return {
      id: 'agent-builder-client-error',
      sessionId: sessionId ?? 'agent-builder',
      prompt: '',
      status: 'failed',
      message: 'Request failed',
      assistantText: '',
      thinkingText: '',
      tools: [],
      completed: true,
      succeeded: false,
      startedAtMs: null,
      completedAtMs: null,
      error,
    };
  }, [error, hasVisibleRuntimeFailure, sessionId]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, [activeTurn?.assistantText, activeTurn?.thinkingText, messages.length, optimisticAttachments.length, optimisticPrompt]);

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  useEffect(() => () => {
    attachmentsRef.current.forEach((attachment) => {
      if (attachment.previewUrl?.startsWith('blob:')) URL.revokeObjectURL(attachment.previewUrl);
    });
  }, []);

  useEffect(() => {
    const nextSessionId = sessionId ?? null;
    if (!nextSessionId) return;
    const previousSessionId = lastResolvedSessionIdRef.current;
    lastResolvedSessionIdRef.current = nextSessionId;
    if (!previousSessionId || previousSessionId === nextSessionId) return;

    setDraft('');
    setHasSubmittedMessage(false);
    setAttachmentError(null);
    setRouteOverride(null);
    setOpenRouteSelector(null);
    setAttachments((current) => {
      current.forEach((attachment) => {
        if (attachment.previewUrl?.startsWith('blob:')) URL.revokeObjectURL(attachment.previewUrl);
      });
      return [];
    });
  }, [sessionId]);

  const addFiles = async (files: File[]) => {
    if (files.length === 0) return;
    setAttachmentError(null);
    try {
      const saved = await Promise.all(files.map(async (file) => {
        const kind = file.type.startsWith('image/') ? ('image' as const) : ('file' as const);
        const name = friendlyAttachmentName(file.name || 'attachment.bin', kind);
        const path = await storeDesktopChatAttachment(name, Array.from(new Uint8Array(await file.arrayBuffer())));
        return {
          id: `${name}-${path}`,
          name,
          path,
          kind,
          mimeType: file.type || null,
          formatLabel: attachmentFormatLabel(name, file.type),
          previewUrl: kind === 'image' ? URL.createObjectURL(file) : null,
          sizeBytes: file.size,
        } satisfies AttachmentItem;
      }));
      setAttachments((current) => {
        const seen = new Set(current.map((attachment) => attachment.path));
        return [...current, ...saved.filter((attachment) => !seen.has(attachment.path))];
      });
    } catch (attachError) {
      setAttachmentError(attachError instanceof Error ? attachError.message : 'Unable to attach file.');
    }
  };

  const addPaths = async (paths: string[]) => {
    if (paths.length === 0) return;
    setAttachmentError(null);
    try {
      const saved = await Promise.all(paths.map(async (path) => {
        const stored = await storeDesktopChatAttachmentPath(path);
        return composerAttachmentItemFromStoredPath({ sourcePath: path, stored });
      }));
      setAttachments((current) => {
        const seen = new Set(current.map((attachment) => attachment.path));
        return [...current, ...saved.filter((attachment) => !seen.has(attachment.path))];
      });
    } catch (attachError) {
      setAttachmentError(attachError instanceof Error ? attachError.message : 'Unable to attach file.');
    }
  };

  const removeAttachment = (id: string) => {
    setAttachments((current) => {
      const removed = current.find((attachment) => attachment.id === id);
      if (removed?.previewUrl?.startsWith('blob:')) URL.revokeObjectURL(removed.previewUrl);
      return current.filter((attachment) => attachment.id !== id);
    });
  };

  const applySuggestion = (suggestion: string) => {
    setDraft(suggestion);
    composerInputRef.current?.focus();
  };

  const updateRouteSelection = useCallback((
    update: (current: BuilderRouteSelection) => BuilderRouteSelection,
  ) => {
    const targetSessionId = sessionId ?? null;
    setRouteOverride((current) => ({
      sessionId: targetSessionId,
      selection: update(
        current?.sessionId === targetSessionId
          ? current.selection
          : builderRouteFromDetail(detail, modelOptions),
      ),
    }));
  }, [detail, modelOptions, sessionId]);

  const toggleRouteSelector = useCallback((scope: ComposerScope, type: ComposerSelectorType) => {
    setOpenRouteSelector((current) => (
      current?.scope === scope && current.type === type ? null : { scope, type }
    ));
  }, []);

  const selectRouteValue = useCallback((
    _scope: ComposerScope,
    type: ComposerSelectorType,
    value: string,
  ) => {
    if (type === 'model') {
      const selected = modelOptions.find((option) => option.value === value);
      updateRouteSelection((current) => ({
        ...current,
        model: value,
        authProvider: normalizeProviderId(selected?.provider) || current.authProvider || null,
      }));
    } else if (type === 'thinking') {
      updateRouteSelection((current) => ({ ...current, thinking: value }));
    }
    setOpenRouteSelector(null);
  }, [modelOptions, updateRouteSelection]);

  const selectRouteProvider = useCallback((
    _scope: ComposerScope,
    option: ComposerProviderOption,
  ) => {
    const providerId = normalizeProviderId(option.providerId);
    const firstModel = modelOptions.find(
      (candidate) => normalizeProviderId(candidate.provider) === providerId,
    );
    updateRouteSelection((current) => ({
      ...current,
      model: firstModel?.value ?? current.model,
      authProvider: option.providerId,
      authChoice: authChoiceFromProviderOption(option),
    }));
    setOpenRouteSelector(null);
  }, [modelOptions, updateRouteSelection]);

  const selectRouteAuth = useCallback((
    _scope: ComposerScope,
    providerId: string,
    choice: string,
  ) => {
    updateRouteSelection((current) => ({
      ...current,
      authProvider: providerId,
      authChoice: choice,
    }));
    setOpenRouteSelector(null);
  }, [updateRouteSelection]);

  const submit = async () => {
    const text = draft.trim();
    if ((!text && attachments.length === 0) || busy || !sessionId) return;
    const submittedAttachments = attachments;
    setHasSubmittedMessage(true);
    setDraft('');
    setAttachments([]);
    try {
      await onSend(text, submittedAttachments, {
        model: routeSelection.model || null,
        thinking: routeSelection.thinking || null,
        authProvider: routeSelection.authProvider || null,
        authChoice: routeSelection.authChoice || null,
      });
    } finally {
      submittedAttachments.forEach((attachment) => {
        if (attachment.previewUrl?.startsWith('blob:')) URL.revokeObjectURL(attachment.previewUrl);
      });
    }
  };

  return (
    <section className="app-agent-studio-conversation" aria-label="Kordi Factory conversation">
      <div ref={scrollRef} className="app-agent-studio-messages app-agent-studio-native-transcript" aria-live="polite">
        {messages.map((message) => <MessageBubble key={message.id} msg={message} densityMode="agent-compact" plainAgentResponse onOpenAuthSettings={onOpenAuthSettings} />)}
        {showOptimistic && (optimisticPrompt || optimisticAttachments.length > 0) ? (
          <MessageBubble
            msg={optimisticMessage(optimisticPrompt ?? '', optimisticAttachments, {
              seed: localProfileAvatarSeed,
              displayName: localProfileDisplayName,
              imageUrl: localProfileImageUrl,
            })}
            densityMode="agent-compact"
            plainAgentResponse
          />
        ) : null}
        {activeTurn && !activeTurn.completed ? (
          <LiveChatTurnMessage
            turn={activeTurn}
            sender="Kordi Factory"
            plainAgentResponse
            onStopActiveTurn={() => void onStop()}
            onOpenAuthSettings={onOpenAuthSettings}
          />
        ) : null}
        {opening ? (
          <div className="app-agent-studio-runtime-note" role="status"><LoaderCircle className="h-3.5 w-3.5 animate-spin" />Opening the private Factory workspace…</div>
        ) : null}
        {standaloneErrorTurn ? (
          <LiveChatTurnMessage
            turn={standaloneErrorTurn}
            sender="Kordi Factory"
            plainAgentResponse
            onOpenAuthSettings={onOpenAuthSettings}
          />
        ) : null}
      </div>

      <footer className="app-agent-studio-composer-wrap">
        {showSuggestions ? (
          <div className="app-agent-studio-suggestions" aria-label="Suggested requests">
            {suggestions.map((suggestion) => (
              <button key={suggestion} type="button" onClick={() => applySuggestion(suggestion)}>{suggestion}</button>
            ))}
          </div>
        ) : null}
        <div className="app-composer-shell rounded-[26px] p-3">
          <input
            ref={attachmentInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(event) => {
              void addFiles(Array.from(event.currentTarget.files ?? []));
              event.currentTarget.value = '';
            }}
          />
          <div
            className={cn(
              'app-composer-input rounded-[18px] transition',
              attachments.length > 0 ? 'px-3 pb-1.5 pt-1' : 'px-4 py-2.5',
            )}
          >
            <ComposerAttachmentList attachments={attachments} onRemove={removeAttachment} />
            <textarea
              ref={composerInputRef}
              rows={1}
              value={draft}
              onChange={(event) => setDraft(event.currentTarget.value)}
              onPaste={(event) => {
                const files = extractClipboardFiles(event.clipboardData);
                if (files.length > 0) {
                  event.preventDefault();
                  void addFiles(files);
                  return;
                }
                const paths = extractPastedLocalFilePaths(
                  event.clipboardData.getData('text/plain'),
                  event.clipboardData.getData('text/uri-list'),
                );
                if (paths.length > 0) {
                  event.preventDefault();
                  void addPaths(paths);
                }
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void submit();
                }
              }}
              className="min-h-[24px] max-h-[220px] w-full resize-none overflow-y-auto bg-transparent px-0 py-0 text-[15px] leading-6 text-[color:var(--utility-foreground)] outline-none placeholder:text-[color:var(--utility-muted-text)]"
              placeholder={creating ? 'Describe what you want Kordi Factory to build or change…' : `Ask Kordi Factory to build or refine ${targetName}…`}
              aria-label="Message Kordi Factory"
            />
            {attachmentError ? <div className="pt-1 text-[11px] text-rose-500" role="alert">{attachmentError}</div> : null}
          </div>
          <div className="app-composer-meta mt-2 flex items-center justify-between gap-4 pt-2.5">
            <div className="flex shrink-0 items-center gap-2 overflow-visible pr-1">
              <ComposerAttachmentAddMenu
                inputRef={attachmentInputRef}
                disabled={busy || opening || !sessionId}
              />
            </div>
            <div className="flex min-w-0 shrink items-center gap-2 overflow-visible">
              <ComposerRuntimeStatus contextStatus={detail?.contextWindowStatus} />
              <ComposerModelControls
                scope="chat"
                selection={routeSelection}
                openSelector={openRouteSelector}
                onToggleSelector={toggleRouteSelector}
                onSelectValue={selectRouteValue}
                authLabel={detail?.providerLabel ?? 'Provider'}
                authOptions={[]}
                onSelectAuthChoice={selectRouteAuth}
                onSelectProviderChoice={selectRouteProvider}
                providerOptions={providerOptions}
                modelOptions={modelOptions.length > 0 ? modelOptions : undefined}
                compact
              />
              {activeTurn && !activeTurn.completed ? (
                <Button
                  type="button"
                  className="app-composer-send h-10 w-10 shrink-0 rounded-full p-0"
                  aria-label="Stop Kordi Factory"
                  title="Stop Kordi Factory"
                  onClick={() => void onStop()}
                >
                  <StopCircle className="h-4 w-4" />
                </Button>
              ) : (
                <Button
                  type="button"
                  className="app-composer-send h-10 w-10 shrink-0 rounded-full p-0"
                  aria-label="Send to Kordi Factory"
                  title="Send to Kordi Factory"
                  disabled={opening || !sessionId || (!draft.trim() && attachments.length === 0)}
                  onClick={() => void submit()}
                >
                  <Send className="h-4 w-4" />
                </Button>
              )}
            </div>
          </div>
        </div>
      </footer>
    </section>
  );
}
