import type { CloudAccount, CloudMessage } from './authClient';
import { isCloudGroupControlMessage } from './cloudGroupMessages';

const CLOUD_AGENT_RESPONSE_PREFIX = 'kordi-cloud-agent-response:';
const CLOUD_AGENT_CANCEL_PREFIX = 'kordi-cloud-agent-cancel:';
const CLOUD_AGENT_CONTEXT_MESSAGE_LIMIT = 40;
export const CLOUD_AGENT_RUNTIME_SESSION_PREFIX = 'cloud-agent:';

export function isCloudAgentRuntimeSessionId(sessionId: string | null | undefined): boolean {
  return Boolean(sessionId?.startsWith(CLOUD_AGENT_RUNTIME_SESSION_PREFIX));
}

export type CloudAgentResponseEnvelope = {
  kind: 'agent-response';
  requestId: string;
  text: string;
};

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

export function encodeCloudAgentResponse(input: { requestId: string; text: string }): string {
  const envelope: CloudAgentResponseEnvelope = {
    kind: 'agent-response',
    requestId: input.requestId,
    text: input.text,
  };
  return `${CLOUD_AGENT_RESPONSE_PREFIX}${encodeBase64Url(JSON.stringify(envelope))}`;
}

export function parseCloudAgentResponse(body: string): CloudAgentResponseEnvelope | null {
  if (!body.startsWith(CLOUD_AGENT_RESPONSE_PREFIX)) return null;
  try {
    const parsed = JSON.parse(decodeBase64Url(body.slice(CLOUD_AGENT_RESPONSE_PREFIX.length))) as Partial<CloudAgentResponseEnvelope>;
    if (parsed.kind !== 'agent-response') return null;
    if (typeof parsed.requestId !== 'string' || typeof parsed.text !== 'string') return null;
    return {
      kind: 'agent-response',
      requestId: parsed.requestId,
      text: parsed.text,
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

export function cloudMessageMentionsNamedAgent(text: string, ownerOrAgentName: string | null | undefined): boolean {
  const owner = ownerOrAgentName?.trim();
  if (!owner) return false;
  const normalizedOwner = normalizedCloudAgentMention(owner.replace(/'s\s+Kordi$/i, '').replace(/Kordi$/i, ''));
  const normalizedFull = normalizedCloudAgentMention(owner);
  return cloudMessageMentionsAnyAgentKey(text, new Set([
    `${normalizedOwner}kordi`,
    `${normalizedOwner}skordi`,
    normalizedFull,
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

export function buildCloudAgentPromptWithSharedContext({
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
}): string {
  const requestText = promptTextForCloudAgentMention(requestMessage.body);
  const sorted = [...messages].sort((left, right) => cloudMessageCreatedAtMs(left) - cloudMessageCreatedAtMs(right));
  const requestCreatedAtMs = cloudMessageCreatedAtMs(requestMessage);
  const contextLines = sorted
    .filter((message) => message.messageId !== requestMessage.messageId)
    .filter((message) => cloudMessageCreatedAtMs(message) <= requestCreatedAtMs)
    .slice(-CLOUD_AGENT_CONTEXT_MESSAGE_LIMIT)
    .flatMap((message) => {
      const text = cloudContextMessageText(message);
      if (!text) return [];
      const isLocal = message.fromAccountId === localAccountId;
      const isAgentResponse = Boolean(parseCloudAgentResponse(message.body));
      const speaker = isAgentResponse
        ? (isLocal ? localAgentName : peerAgentName)
        : (isLocal ? localHumanName : peerHumanName);
      return [`${speaker}: ${text}`];
    });

  if (contextLines.length === 0) return requestText;
  return [
    'Use the shared Cloud conversation below as the single context window for both the humans and their Kordi agents.',
    'Answer only the current request. Do not repeat the transcript.',
    '',
    'Shared conversation:',
    ...contextLines,
    '',
    `Current request from ${requestMessage.fromAccountId === localAccountId ? localHumanName : peerHumanName}: ${requestText}`,
  ].join('\n');
}
