const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;
const HEX_RE = /^[0-9a-fA-F]+$/;
const NODE_ID_RE = /^(?:kd_[A-Za-z0-9_-]{3,64}|[A-Za-z0-9][A-Za-z0-9._-]{2,63})$/;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const RUNTIME_RE = /^[A-Za-z0-9._-]{2,40}$/;
const ROLE_RE = /^[a-z][a-z0-9_-]{1,31}$/;

function isTrimmed(value: string): boolean {
  return value.trim() === value;
}

export function validateNodeId(nodeId: unknown): string | null {
  if (typeof nodeId !== 'string' || !nodeId) {
    return 'nodeId is required';
  }
  if (!isTrimmed(nodeId)) {
    return 'nodeId must not contain leading or trailing whitespace';
  }
  if (!NODE_ID_RE.test(nodeId)) {
    return 'nodeId must be 3-65 chars and use only letters, numbers, dot, underscore, or dash';
  }
  return null;
}

export function validateDisplayName(value: unknown, field = 'displayName'): string | null {
  if (typeof value !== 'string' || !value.trim()) {
    return `${field} is required`;
  }
  if (!isTrimmed(value)) {
    return `${field} must not contain leading or trailing whitespace`;
  }
  if (value.length > 80) {
    return `${field} must be 80 characters or fewer`;
  }
  return null;
}

export function validateOwnerName(value: unknown): string | null {
  return validateDisplayName(value, 'ownerName');
}

export function validateRuntime(value: unknown): string | null {
  if (typeof value !== 'string' || !value) {
    return 'runtime is required';
  }
  if (!isTrimmed(value)) {
    return 'runtime must not contain leading or trailing whitespace';
  }
  if (!RUNTIME_RE.test(value)) {
    return 'runtime must be 2-40 chars and use only letters, numbers, dot, underscore, or dash';
  }
  return null;
}

export function validateSlug(value: unknown): string | null {
  if (typeof value !== 'string' || !value) {
    return 'slug is required';
  }
  if (!isTrimmed(value)) {
    return 'slug must not contain leading or trailing whitespace';
  }
  if (!SLUG_RE.test(value)) {
    return 'slug must be lowercase letters, numbers, and dashes only';
  }
  return null;
}

export function validateEndpoint(value: unknown): string | null {
  if (typeof value !== 'string' || !value) {
    return 'endpoint is required';
  }
  if (!isTrimmed(value)) {
    return 'endpoint must not contain leading or trailing whitespace';
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'endpoint must be a valid URL';
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'endpoint must use http or https';
  }
  if (!url.hostname) {
    return 'endpoint must include a hostname';
  }
  if (url.username || url.password) {
    return 'endpoint must not include embedded credentials';
  }
  if (value.length > 2048) {
    return 'endpoint must be 2048 characters or fewer';
  }

  return null;
}

export function validatePublicKey(value: unknown): string | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  if (typeof value !== 'string') {
    return 'publicKey must be a string';
  }
  if (!isTrimmed(value)) {
    return 'publicKey must not contain leading or trailing whitespace';
  }

  if (HEX_RE.test(value) && (value.length === 64 || value.length === 128)) {
    return null;
  }
  if (BASE58_RE.test(value) && value.length >= 32 && value.length <= 64) {
    return null;
  }

  return 'publicKey must be hex or base58 with a valid key length';
}

export function validateDescription(value: unknown, field = 'description'): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    return `${field} must be a string`;
  }
  if (value.length > 2000) {
    return `${field} must be 2000 characters or fewer`;
  }
  return null;
}

export function validatePositiveInteger(
  value: unknown,
  field: string,
  { allowZero = false }: { allowZero?: boolean } = {}
): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (!Number.isInteger(value)) {
    return `${field} must be an integer`;
  }
  const minimum = allowZero ? 0 : 1;
  if ((value as number) < minimum) {
    return `${field} must be ${allowZero ? 'zero or greater' : 'greater than zero'}`;
  }
  return null;
}

export function validateSkillName(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) {
    return 'name is required';
  }
  if (!isTrimmed(value)) {
    return 'name must not contain leading or trailing whitespace';
  }
  if (value.length > 80) {
    return 'name must be 80 characters or fewer';
  }
  return null;
}

export function validateAgentRole(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string' || !value) {
    return 'agentRole must be a non-empty string';
  }
  if (!isTrimmed(value)) {
    return 'agentRole must not contain leading or trailing whitespace';
  }
  if (!ROLE_RE.test(value)) {
    return 'agentRole must use lowercase letters, numbers, underscores, or dashes';
  }
  return null;
}
