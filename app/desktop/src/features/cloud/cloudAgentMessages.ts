import type { CloudAccount, CloudMessage } from './authClient';
import { isCloudGroupControlMessage } from './cloudGroupMessages';

const CLOUD_AGENT_RESPONSE_PREFIX = 'kordi-cloud-agent-response:';
const CLOUD_AGENT_CANCEL_PREFIX = 'kordi-cloud-agent-cancel:';
const CLOUD_AGENT_NATIVE_CONTEXT_MESSAGE_LIMIT = 40;
export const CLOUD_AGENT_RUNTIME_SESSION_PREFIX = 'cloud-agent:';

export function isCloudAgentRuntimeSessionId(sessionId: string | null | undefined): boolean {
  return Boolean(sessionId?.startsWith(CLOUD_AGENT_RUNTIME_SESSION_PREFIX));
}

export type CloudAgentResponseEnvelope = {
  kind: 'agent-response';
  requestId: string;
  text: string;
  deliveryState?: 'complete' | 'failed';
};

export const CLOUD_AGENT_NO_PROVIDER_NOTICE = 'No provider configured yet.';

export type CloudAgentFallbackRunStatus = 'queued' | 'leased' | 'running' | 'completed' | 'failed' | 'cancelled' | string;

export function cloudAgentFallbackStatusLabel(status: CloudAgentFallbackRunStatus | null | undefined): string | null {
  switch ((status ?? '').trim().toLowerCase()) {
    case 'queued':
    case 'leased':
      return 'Requesting…';
    case 'running':
      return 'Replying…';
    case 'failed':
      return 'Couldn’t reply';
    case 'cancelled':
      return 'Canceled';
    default:
      return null;
  }
}

export function cloudAgentFallbackErrorNotice(input: { code?: string | null; message?: string | null } | string | null | undefined): string {
  const code = typeof input === 'string' ? input : input?.code;
  const message = typeof input === 'string' ? input : input?.message;
  const normalizedCode = (code ?? '').trim().toLowerCase();
  const normalizedMessage = (message ?? '').trim().toLowerCase();

  if (normalizedCode === 'missing_provider_auth' || normalizedMessage.includes('provider-auth snapshot')) {
    return 'Provider auth is not synced for Cloud fallback yet. Open this device once to sync provider access.';
  }
  if (normalizedCode === 'owner_online') {
    return 'The owner device is online, so Kordi will answer from the device.';
  }
  if (normalizedCode === 'model_provider_error') {
    return 'The provider failed while Kordi was replying. Try again in a moment.';
  }
  if (
    normalizedCode === 'policy_denied'
    || normalizedMessage.includes('owner-local')
    || normalizedMessage.includes('localhost')
    || normalizedMessage.includes('private-network')
    || normalizedMessage.includes('private network')
  ) {
    return "Kordi Cloud can't access that local/private resource while the device is offline.";
  }
  if (normalizedCode.includes('sandbox') || normalizedMessage.includes('sandbox')) {
    return "Kordi Cloud couldn't finish this reply in the sandbox. Try again.";
  }
  return message?.trim() || 'Kordi could not finish this reply. Try again.';
}

export function isCloudAgentNoProviderConfiguredError(value: unknown): boolean {
  const message = value instanceof Error ? value.message : String(value ?? '');
  const normalized = message.trim().toLowerCase();
  if (!normalized) return false;
  return (
    /no\s+\w+\s+credentials\s+are\s+available/.test(normalized)
    || normalized === 'missing_provider_auth'
    || normalized.includes('missing_provider_auth')
    || normalized.includes('provider-auth snapshot')
    || normalized.includes('no provider configured')
    || normalized.includes('no usable provider credential')
    || normalized.includes('no saved accounts or keys')
    || normalized.includes('unknown model:')
    || normalized.includes('add openai_api_key')
    || normalized.includes('add anthropic_api_key')
    || normalized.includes('lm studio local endpoint is not reachable')
    || normalized.includes('ollama local endpoint is not reachable')
  );
}

export function cloudAgentNoProviderNoticeText(): string {
  return CLOUD_AGENT_NO_PROVIDER_NOTICE;
}

export type CloudAgentCancelEnvelope = {
  kind: 'agent-cancel';
  requestId: string;
};

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodeBase64Url(value: string): string {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function encodeCloudAgentResponse(input: { requestId: string; text: string; deliveryState?: 'complete' | 'failed' }): string {
  const envelope: CloudAgentResponseEnvelope = {
    kind: 'agent-response',
    requestId: input.requestId,
    text: input.text,
    ...(input.deliveryState ? { deliveryState: input.deliveryState } : {}),
  };
  return `${CLOUD_AGENT_RESPONSE_PREFIX}${encodeBase64Url(JSON.stringify(envelope))}`;
}

export function parseCloudAgentResponse(body: string): CloudAgentResponseEnvelope | null {
  if (!body.startsWith(CLOUD_AGENT_RESPONSE_PREFIX)) return null;
  try {
    const parsed = JSON.parse(decodeBase64Url(body.slice(CLOUD_AGENT_RESPONSE_PREFIX.length))) as Partial<CloudAgentResponseEnvelope>;
    if (parsed.kind !== 'agent-response') return null;
    if (typeof parsed.requestId !== 'string' || typeof parsed.text !== 'string') return null;
    const deliveryState = parsed.deliveryState === 'failed' || parsed.deliveryState === 'complete'
      ? parsed.deliveryState
      : undefined;
    return {
      kind: 'agent-response',
      requestId: parsed.requestId,
      text: parsed.text,
      ...(deliveryState ? { deliveryState } : {}),
    };
  } catch {
    return null;
  }
}

export function encodeCloudAgentCancel(input: { requestId: string }): string {
  const envelope: CloudAgentCancelEnvelope = {
    kind: 'agent-cancel',
    requestId: input.requestId,
  };
  return `${CLOUD_AGENT_CANCEL_PREFIX}${encodeBase64Url(JSON.stringify(envelope))}`;
}

export function parseCloudAgentCancel(body: string): CloudAgentCancelEnvelope | null {
  if (!body.startsWith(CLOUD_AGENT_CANCEL_PREFIX)) return null;
  try {
    const parsed = JSON.parse(decodeBase64Url(body.slice(CLOUD_AGENT_CANCEL_PREFIX.length))) as Partial<CloudAgentCancelEnvelope>;
    if (parsed.kind !== 'agent-cancel') return null;
    if (typeof parsed.requestId !== 'string') return null;
    return {
      kind: 'agent-cancel',
      requestId: parsed.requestId,
    };
  } catch {
    return null;
  }
}

export function isCloudAgentControlMessage(body: string): boolean {
  return Boolean(parseCloudAgentCancel(body));
}

export function normalizedCloudAgentMention(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function localAgentMentionKeys(account: CloudAccount, options: { allowFirstPerson?: boolean } = {}): Set<string> {
  const names = [
    account.displayName,
    account.primaryEmail?.split('@')[0],
  ]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  const keys = new Set<string>();
  if (options.allowFirstPerson !== false) {
    keys.add('kordi');
    keys.add('mykordi');
  }
  for (const name of names) {
    const normalizedName = normalizedCloudAgentMention(name);
    keys.add(`${normalizedName}kordi`);
    keys.add(`${normalizedName}skordi`);
    if (options.allowFirstPerson !== false) {
      keys.add(`my${normalizedName}kordi`);
      keys.add(`my${normalizedName}skordi`);
    }
  }
  return keys;
}

function cloudMessageMentionsAnyAgentKey(text: string, keys: Set<string>): boolean {
  const mentions = text.match(/@[\p{L}\p{N}._'-]+/gu) ?? [];
  return mentions.some((mention) => {
    const normalized = normalizedCloudAgentMention(mention.slice(1));
    return keys.has(normalized) || (normalized.includes('kordi') && [...keys].some((key) => key !== 'kordi' && normalized === key));
  });
}

export function cloudMessageMentionsFirstPersonAgent(text: string): boolean {
  const mentions = text.match(/@[\p{L}\p{N}._'-]+/gu) ?? [];
  return mentions.some((mention) => {
    const normalized = normalizedCloudAgentMention(mention.slice(1));
    return normalized === 'kordi' || normalized === 'mykordi' || normalized.startsWith('my');
  });
}

export function cloudMessageMentionsLocalAgent(
  text: string,
  account: CloudAccount,
  options: { allowFirstPerson?: boolean } = {},
): boolean {
  return cloudMessageMentionsAnyAgentKey(text, localAgentMentionKeys(account, options));
}

export function cloudMessageIsSelfAgentRequest(message: CloudMessage, account: CloudAccount): boolean {
  if (message.fromAccountId !== account.accountId || message.toAccountId !== account.accountId) return false;
  if (!message.body.trim()) return false;
  if (isCloudGroupControlMessage(message.body) || parseCloudAgentResponse(message.body) || parseCloudAgentCancel(message.body)) return false;
  return true;
}

export function cloudMessageMentionsNamedAgent(text: string, ownerOrAgentName: string | null | undefined): boolean {
  const owner = ownerOrAgentName?.trim();
  if (!owner) return false;
  const normalizedOwner = normalizedCloudAgentMention(owner.replace(/'s\s+Kordi$/i, '').replace(/Kordi$/i, ''));
  return cloudMessageMentionsAnyAgentKey(text, new Set([
    `${normalizedOwner}kordi`,
    `${normalizedOwner}skordi`,
  ].filter(Boolean)));
}

export function promptTextForCloudAgentMention(text: string): string {
  const withoutMentions = text.replace(/@[\p{L}\p{N}._'-]+\s*/gu, '').trim();
  return withoutMentions || text.trim();
}

function cloudMessageCreatedAtMs(message: CloudMessage): number {
  const value = Date.parse(message.createdAt);
  return Number.isFinite(value) ? value : 0;
}

function cloudContextMessageText(message: CloudMessage): string | null {
  if (parseCloudAgentCancel(message.body) || isCloudGroupControlMessage(message.body)) return null;
  const response = parseCloudAgentResponse(message.body);
  return (response?.text ?? message.body).trim() || null;
}

export type CloudAgentNativeContextMessage = {
  id: string;
  authorName: string;
  authorKind: 'human' | 'agent';
  text: string;
  createdAtMs: number;
};

export function cloudAgentNativeContextMessagesFromDirectCloudSession({
  messages,
  requestMessage,
  localAccountId,
  localHumanName = 'Me',
  peerHumanName = 'Peer',
  localAgentName = 'My Kordi',
  peerAgentName = "Peer's Kordi",
}: {
  messages: CloudMessage[];
  requestMessage: CloudMessage;
  localAccountId: string;
  localHumanName?: string;
  peerHumanName?: string;
  localAgentName?: string;
  peerAgentName?: string;
}): CloudAgentNativeContextMessage[] {
  const requestCreatedAtMs = cloudMessageCreatedAtMs(requestMessage);
  const sorted = [...messages].sort((left, right) => cloudMessageCreatedAtMs(left) - cloudMessageCreatedAtMs(right));
  return sorted
    .filter((message) => message.messageId !== requestMessage.messageId)
    .filter((message) => cloudMessageCreatedAtMs(message) <= requestCreatedAtMs)
    .flatMap((message) => {
      const text = cloudContextMessageText(message);
      if (!text) return [];
      const isLocal = message.fromAccountId === localAccountId;
      const isAgentResponse = Boolean(parseCloudAgentResponse(message.body));
      const authorName = isAgentResponse
        ? (isLocal ? localAgentName : peerAgentName)
        : (isLocal ? localHumanName : peerHumanName);
      return [{
        id: message.messageId,
        authorName,
        authorKind: isAgentResponse ? 'agent' as const : 'human' as const,
        text,
        createdAtMs: cloudMessageCreatedAtMs(message),
      }];
    })
    .slice(-CLOUD_AGENT_NATIVE_CONTEXT_MESSAGE_LIMIT);
}

export function compactCloudAgentNativeContextMessages(
  messages: CloudAgentNativeContextMessage[],
): CloudAgentNativeContextMessage[] {
  const byId = new Map<string, CloudAgentNativeContextMessage>();
  [...messages]
    .sort((left, right) => left.createdAtMs - right.createdAtMs)
    .forEach((message) => {
      const id = message.id.trim();
      const text = message.text.trim();
      const authorName = message.authorName.trim();
      if (!id || !text || !authorName) return;
      byId.set(id, { ...message, id, text, authorName });
    });
  return [...byId.values()].slice(-CLOUD_AGENT_NATIVE_CONTEXT_MESSAGE_LIMIT);
}
