// Managed sign-in policy (docs/development/managed-devices.md). The native
// shell reads it from the macOS managed preferences; it never comes from a
// server response, so a server cannot loosen it.

import { CloudAuthError } from '../cloudAuthError';

export type ManagedSignInMethod = 'google' | 'github' | 'email';

/** `null` means the key is missing and does not restrict; an empty list allows nothing. */
export type ManagedSignInPolicy = {
  allowedSignInMethods: ManagedSignInMethod[] | null;
  allowedOrganizations: string[] | null;
};

export const NO_MANAGED_POLICY: ManagedSignInPolicy = { allowedSignInMethods: null, allowedOrganizations: null };
const ALLOW_NOTHING: ManagedSignInPolicy = { allowedSignInMethods: [], allowedOrganizations: [] };

export const MANAGED_ORGANIZATION_REFUSED_MESSAGE = 'This device only allows accounts from your organization.';
export const MANAGED_ORGANIZATION_CHECK_FAILED_MESSAGE = 'Could not check your organization. Try again.';
export const MANAGED_SIGNED_OUT_MESSAGE =
  'You were signed out because this device only allows accounts from your organization.';
export const MANAGED_NO_SIGN_IN_MESSAGE = 'This device does not allow any sign-in method.';
const MANAGED_METHOD_REFUSED_MESSAGE = 'This device does not allow this sign-in method.';

const KNOWN_METHODS: readonly ManagedSignInMethod[] = ['google', 'github', 'email'];

function stringEntries(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) return [];
  return value;
}

function normalizeMethods(value: unknown): ManagedSignInMethod[] | null {
  if (value === null || value === undefined) return null;
  const methods: ManagedSignInMethod[] = [];
  for (const entry of stringEntries(value)) {
    const method = entry.trim().toLowerCase() as ManagedSignInMethod;
    if (KNOWN_METHODS.includes(method) && !methods.includes(method)) methods.push(method);
  }
  return methods;
}

function normalizeOrganizations(value: unknown): string[] | null {
  if (value === null || value === undefined) return null;
  const organizations: string[] = [];
  for (const entry of stringEntries(value)) {
    const id = entry.trim();
    if (id && !organizations.includes(id)) organizations.push(id);
  }
  return organizations;
}

/** Applies the shared rules again to what the native shell returned. */
export function normalizeManagedSignInPolicy(raw: unknown): ManagedSignInPolicy {
  if (raw === null || raw === undefined) return NO_MANAGED_POLICY;
  if (typeof raw !== 'object') return ALLOW_NOTHING;
  const record = raw as Record<string, unknown>;
  return {
    allowedSignInMethods: normalizeMethods(record.allowedSignInMethods),
    allowedOrganizations: normalizeOrganizations(record.allowedOrganizations),
  };
}

export function isMethodAllowed(policy: ManagedSignInPolicy, method: ManagedSignInMethod): boolean {
  return policy.allowedSignInMethods === null || policy.allowedSignInMethods.includes(method);
}

export function anyMethodAllowed(policy: ManagedSignInPolicy): boolean {
  return policy.allowedSignInMethods === null || policy.allowedSignInMethods.length > 0;
}

export function restrictsOrganizations(policy: ManagedSignInPolicy): boolean {
  return policy.allowedOrganizations !== null;
}

/** The organization sent as a sign-in hint: the first allowed one. */
export function organizationHint(policy: ManagedSignInPolicy): string | undefined {
  return policy.allowedOrganizations?.[0];
}

function idIn(allowed: readonly string[], value: unknown): boolean {
  return typeof value === 'string' && allowed.includes(value);
}

/**
 * The membership check over `GET /v1/cloud/account/organizations`: an
 * organization the account belongs to is allowed, or a configured
 * organization admits it as `member` or `reverify` under an allowed id.
 */
export function accountSatisfiesPolicy(response: unknown, policy: ManagedSignInPolicy): boolean {
  const allowed = policy.allowedOrganizations;
  if (allowed === null) return true;
  if (!response || typeof response !== 'object') return false;
  const record = response as { organizations?: unknown; configured?: unknown };
  const organizations = Array.isArray(record.organizations) ? record.organizations : [];
  const configured = Array.isArray(record.configured) ? record.configured : [];
  const member = organizations.some((entry) => (
    Boolean(entry) && typeof entry === 'object' && idIn(allowed, (entry as Record<string, unknown>).organizationId)
  ));
  return member || configured.some((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    const value = entry as Record<string, unknown>;
    return (value.admission === 'member' || value.admission === 'reverify')
      && (idIn(allowed, value.id) || idIn(allowed, value.organizationId));
  });
}

let policyOverride: ManagedSignInPolicy | null = null;
let policyPromise: Promise<ManagedSignInPolicy> | null = null;
let resolvedPolicy: ManagedSignInPolicy | undefined;

export function __setManagedSignInPolicyForTests(policy: ManagedSignInPolicy | null): void {
  policyOverride = policy;
  policyPromise = null;
  resolvedPolicy = undefined;
  signedOutNotice = null;
}

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined'
    && Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

async function readNativePolicy(): Promise<ManagedSignInPolicy> {
  if (!isTauriRuntime()) return NO_MANAGED_POLICY;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return normalizeManagedSignInPolicy(await invoke<unknown>('managed_sign_in_policy'));
  } catch {
    // The command never fails in a matching build; refuse rather than guess.
    return ALLOW_NOTHING;
  }
}

/** The policy, read once per app start. */
export function loadManagedSignInPolicy(): Promise<ManagedSignInPolicy> {
  if (policyOverride) return Promise.resolve(policyOverride);
  policyPromise ??= readNativePolicy().then((policy) => {
    resolvedPolicy = policy;
    return policy;
  });
  return policyPromise;
}

/** The policy when it is already known without waiting, else undefined. */
export function peekManagedSignInPolicy(): ManagedSignInPolicy | undefined {
  if (policyOverride) return policyOverride;
  return resolvedPolicy ?? (isTauriRuntime() ? undefined : NO_MANAGED_POLICY);
}

/** Refuses a sign-in method the policy does not offer, before any request is sent. */
export async function assertManagedSignInMethodAllowed(method: ManagedSignInMethod): Promise<void> {
  if (!isMethodAllowed(await loadManagedSignInPolicy(), method)) {
    throw new CloudAuthError('sign_in_method_not_allowed', MANAGED_METHOD_REFUSED_MESSAGE, 0);
  }
}

let signedOutNotice: string | null = null;

/** Shown on the signed-out screen after the policy ended a saved session. */
export function managedSignedOutNotice(): string | null {
  return signedOutNotice;
}

export function setManagedSignedOutNotice(notice: string | null): void {
  signedOutNotice = notice;
}
