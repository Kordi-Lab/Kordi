import type { MessageActionMetadata } from '../../kordi-app/types/message';

export const CLOUD_DIRECT_MESSAGE_PREFIX = 'kordi-cloud-message:';

export type CloudDirectMessageEnvelope = {
  schemaVersion: 1;
  kind: 'message';
  text: string;
  messageAction?: MessageActionMetadata | null;
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
    return isCloudDirectMessageEnvelope(parsed) ? parsed : null;
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
