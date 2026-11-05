export function browserCanonicalScope(accountId: string, organizationId?: string) {
  return JSON.stringify([accountId, organizationId ?? null]);
}
