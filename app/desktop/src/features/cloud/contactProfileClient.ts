// Typed call for `GET /v1/cloud/contacts/{accountId}/profile` (issue #1945). The response is
// normalized defensively so a partial or older payload never breaks the contact pane.

import { defaultCloudAuthClient } from './authClient';
import { loadSession } from './session';

export type CloudContactProfileKind = 'person' | 'agent' | 'system';

export type CloudContactProfileAgent = {
  agentId: string;
  /** `cloud-agent:<owner>` on current servers, not a contacts-list account. */
  accountId: string | null;
  displayName: string;
  /** An https URL or a `kordi-avatar://` marker; avatar components resolve both. */
  avatarUrl: string | null;
  avatarSeed: string | null;
};

export type CloudContactProfileOwner = {
  accountId: string;
  kordiId: string | null;
  displayName: string;
  avatarUrl: string | null;
};

export type CloudContactProfileGroup = {
  groupId: string;
  title: string;
  avatarUrl: string | null;
};

export type CloudContactProfileCommonGround = {
  workingOn: string[];
  canHelp: string[];
  lookingFor: string[];
};

export type CloudContactProfile = {
  accountId: string;
  kordiId: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  about: string | null;
  kind: CloudContactProfileKind;
  isSelf: boolean;
  isContact: boolean;
  presence: { status: 'online' | 'offline'; lastSeenAt: string | null } | null;
  defaultAgent: CloudContactProfileAgent | null;
  owner: CloudContactProfileOwner | null;
  contactSince: string | null;
  shared: {
    mediaCount: number;
    linkCount: number;
    documentCount: number;
    groups: CloudContactProfileGroup[];
  };
  commonGround: CloudContactProfileCommonGround | null;
};

/** Contact profile route version a server advertises, or null when it offers none. */
export function contactProfileVersionFromCapabilities(
  capabilities: { contactProfileVersion?: number | null } | null | undefined,
): number | null {
  const version = capabilities?.contactProfileVersion;
  return typeof version === 'number' && version > 0 ? version : null;
}

type ProfileRequest = <T>(path: string, init: RequestInit, fallbackMessage: string) => Promise<T>;

export type FetchContactProfileOptions = {
  request?: ProfileRequest;
  token?: () => Promise<string | null>;
  signal?: AbortSignal;
};

async function sessionToken(): Promise<string | null> {
  const session = await loadSession();
  return session?.token ?? null;
}

/** Loads the richer profile of a contact, an agent whose owner is a contact, or a system contact. */
export async function fetchContactProfile(accountId: string, options: FetchContactProfileOptions = {}): Promise<CloudContactProfile> {
  const trimmed = accountId.trim();
  if (!trimmed) throw new Error('Missing account.');
  const token = await (options.token ?? sessionToken)();
  if (!token) throw new Error('Sign in again to load this profile.');
  const request: ProfileRequest = options.request
    ?? ((path, init, fallback) => defaultCloudAuthClient().request(path, init, fallback));
  const body = await request<unknown>(
    `/v1/cloud/contacts/${encodeURIComponent(trimmed)}/profile`,
    { method: 'GET', headers: { authorization: `Bearer ${token}` }, signal: options.signal },
    'Could not load profile.',
  );
  const profile = normalizeContactProfile(body);
  if (!profile) throw new Error('Could not load profile.');
  return profile;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function textList(value: unknown, limit = 4): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(text).filter((item): item is string => Boolean(item)).slice(0, limit);
}

function normalizeAgent(value: unknown): CloudContactProfileAgent | null {
  const row = record(value);
  const agentId = text(row?.agentId);
  if (!row || !agentId) return null;
  return {
    agentId,
    accountId: text(row.accountId),
    // Empty stays empty so the pane can name a stock agent after its owner.
    displayName: text(row.displayName) ?? '',
    avatarUrl: text(row.avatarUrl),
    avatarSeed: text(record(row.avatar)?.seed),
  };
}

function normalizeOwner(value: unknown): CloudContactProfileOwner | null {
  const row = record(value);
  const accountId = text(row?.accountId);
  if (!row || !accountId) return null;
  return { accountId, kordiId: text(row.kordiId), displayName: text(row.displayName) ?? 'Kordi user', avatarUrl: text(row.avatarUrl) };
}

function normalizeGroups(value: unknown): CloudContactProfileGroup[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const row = record(item);
    const groupId = text(row?.groupId);
    if (!row || !groupId) return [];
    return [{ groupId, title: text(row.title) ?? 'Group', avatarUrl: text(row.avatarUrl) }];
  }).slice(0, 20);
}

function normalizeCommonGround(value: unknown): CloudContactProfileCommonGround | null {
  const row = record(value);
  if (!row) return null;
  const card = { workingOn: textList(row.workingOn), canHelp: textList(row.canHelp), lookingFor: textList(row.lookingFor) };
  return card.workingOn.length || card.canHelp.length || card.lookingFor.length ? card : null;
}

export function normalizeContactProfile(value: unknown): CloudContactProfile | null {
  const row = record(value);
  const accountId = text(row?.accountId);
  if (!row || !accountId) return null;
  const kind: CloudContactProfileKind = row.kind === 'agent' || row.kind === 'system' ? row.kind : 'person';
  const presenceRow = record(row.presence);
  const shared = record(row.shared);
  return {
    accountId,
    kordiId: text(row.kordiId),
    displayName: text(row.displayName),
    avatarUrl: text(row.avatarUrl),
    about: text(row.about),
    kind,
    isSelf: row.isSelf === true,
    isContact: row.isContact === true,
    presence: presenceRow
      ? { status: presenceRow.status === 'online' ? 'online' : 'offline', lastSeenAt: text(presenceRow.lastSeenAt) }
      : null,
    defaultAgent: kind === 'person' ? normalizeAgent(row.defaultAgent) : null,
    owner: kind === 'agent' ? normalizeOwner(row.owner) : null,
    contactSince: text(row.contactSince),
    shared: {
      mediaCount: count(shared?.mediaCount),
      linkCount: count(shared?.linkCount),
      documentCount: count(shared?.documentCount),
      groups: normalizeGroups(shared?.groups),
    },
    commonGround: normalizeCommonGround(row.commonGround),
  };
}

/**
 * Deletes a contact in both directions: `DELETE /v1/cloud/contacts/{accountId}` (204, 404 when
 * not a contact). Lives here rather than in authClient.ts, which is past the file-size ratchet.
 */
export async function removeCloudContact(accountId: string, options: FetchContactProfileOptions = {}): Promise<void> {
  const trimmed = accountId.trim();
  if (!trimmed) throw new Error('Missing account.');
  const token = await (options.token ?? sessionToken)();
  if (!token) throw new Error('Sign in again to delete this contact.');
  const request: ProfileRequest = options.request
    ?? ((path, init, fallback) => defaultCloudAuthClient().request(path, init, fallback));
  await request<void>(
    `/v1/cloud/contacts/${encodeURIComponent(trimmed)}`,
    { method: 'DELETE', headers: { authorization: `Bearer ${token}` }, signal: options.signal },
    'Could not delete contact.',
  );
}
