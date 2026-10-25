export const OPEN_GROUNDING_EVENT = 'kordi-help-open-grounding';
let pendingGroundingAccount: string | null = null;

// Keep the intent until Contacts mounts; an event alone is lost during route changes.
export function requestHelpGrounding(accountId: string) {
  pendingGroundingAccount = accountId;
  window.dispatchEvent(new Event(OPEN_GROUNDING_EVENT));
}

export function consumeHelpGrounding(accountId: string) {
  const matched = pendingGroundingAccount === accountId;
  pendingGroundingAccount = null;
  return matched;
}

export function hasHelpGrounding(accountId: string) {
  return pendingGroundingAccount === accountId;
}
