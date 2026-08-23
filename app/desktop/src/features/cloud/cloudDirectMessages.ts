import { normalizedMessageMentions } from '@/features/chat/messageMentions';
import type { MessageActionMetadata, MessageMention } from '../../kordi-app/types/message';
import type { DesktopChatMessageRoute } from '@/lib/desktop';

export const CLOUD_DIRECT_MESSAGE_PREFIX = 'kordi-cloud-message:';
export const CLOUD_AGENT_SESSION_IDENTITY_MESSAGE_KIND =
  'canonical-history-agent-identity';

export type CloudDirectMessageEnvelope = {
  schemaVersion: 1;
  kind: 'message';
  text: string;
  mentions?: MessageMention[];
  messageAction?: MessageActionMetadata | null;
  targetCloudAgentId?: string | null;
  targetCloudAgentName?: string | null;
  targetCloudAgentOwnerAccountId?: string | null;
  targetCloudAgentOwnerName?: string | null;
  agentRuntimeRoute?: (DesktopChatMessageRoute & {
    defaultModel?: string | null;
    defaultAuthProvider?: string | null;
    defaultAuthChoice?: string | null;
  }) | null;
};

function encodeBase64Url(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodeBase64Url(value: string) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

function isCloudDirectMessageEnvelope(value: unknown): value is CloudDirectMessageEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.schemaVersion === 1
    && record.kind === 'message'
    && typeof record.text === 'string';
}

export function encodeCloudDirectMessageEnvelope(input: CloudDirectMessageEnvelope): string {
  return `${CLOUD_DIRECT_MESSAGE_PREFIX}${encodeBase64Url(JSON.stringify(input))}`;
}

export function parseCloudDirectMessageEnvelope(body: string): CloudDirectMessageEnvelope | null {
  if (!body.startsWith(CLOUD_DIRECT_MESSAGE_PREFIX)) return null;
  try {
    const parsed = JSON.parse(decodeBase64Url(body.slice(CLOUD_DIRECT_MESSAGE_PREFIX.length)));
    if (!isCloudDirectMessageEnvelope(parsed)) return null;
    const { mentions: rawMentions, ...envelope } = parsed;
    const mentions = normalizedMessageMentions(rawMentions);
    return { ...envelope, ...(mentions ? { mentions } : {}) };
  } catch {
    return null;
  }
}

export function cloudDirectMessageDisplayText(body: string): string {
  return parseCloudDirectMessageEnvelope(body)?.text ?? body;
}

export function cloudDirectMessageAction(body: string): MessageActionMetadata | null {
  return parseCloudDirectMessageEnvelope(body)?.messageAction ?? null;
}

export function cloudDirectMessageMentions(body: string): MessageMention[] | undefined {
  return parseCloudDirectMessageEnvelope(body)?.mentions;
}

export function cloudDirectMessageTargetCloudAgentId(body: string): string | null {
  const agentId = parseCloudDirectMessageEnvelope(body)?.targetCloudAgentId?.trim() ?? '';
  return agentId.startsWith('cloud_agent_') ? agentId : null;
}

export function cloudDirectMessageTargetCloudAgentName(body: string): string | null {
  return parseCloudDirectMessageEnvelope(body)?.targetCloudAgentName?.trim() || null;
}

export function cloudDirectMessageTargetCloudAgentOwnerAccountId(body: string): string | null {
  return parseCloudDirectMessageEnvelope(body)?.targetCloudAgentOwnerAccountId?.trim() || null;
}

export function cloudDirectMessageAgentRuntimeRoute(body: string): DesktopChatMessageRoute | null {
  const route = parseCloudDirectMessageEnvelope(body)?.agentRuntimeRoute;
  if (!route || typeof route !== 'object') return null;
  const model = typeof route.defaultModel === 'string' ? route.defaultModel.trim() : typeof route.model === 'string' ? route.model.trim() : '';
  const authProvider = typeof route.defaultAuthProvider === 'string' ? route.defaultAuthProvider.trim() : typeof route.authProvider === 'string' ? route.authProvider.trim() : '';
  const authChoice = typeof route.defaultAuthChoice === 'string' ? route.defaultAuthChoice.trim() : typeof route.authChoice === 'string' ? route.authChoice.trim() : '';
  const thinking = typeof route.thinking === 'string' ? route.thinking.trim() : '';
  return model || thinking ? {
    ...(model ? { model } : {}),
    ...(authProvider ? { authProvider } : {}),
    ...(authChoice ? { authChoice } : {}),
    ...(thinking ? { thinking } : {}),
  } : null;
}

export function cloudDirectMessageTargetsOwnedHostedCloudAgent(body: string, accountId: string): boolean {
  const targetAgentId = cloudDirectMessageTargetCloudAgentId(body);
  const targetOwnerAccountId = cloudDirectMessageTargetCloudAgentOwnerAccountId(body);
  return Boolean(targetAgentId && targetOwnerAccountId && targetOwnerAccountId === accountId.trim());
}
