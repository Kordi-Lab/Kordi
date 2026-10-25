export const OPEN_GROUNDING_EVENT = 'kordi-help-open-grounding';
let pendingGroundingAccount: string | null = null;
let pendingScreen: { accountId: string; screen: 'home' | 'build' | 'card' } | null = null;

// Keep the intent until Contacts mounts; an event alone is lost during route changes.
export function requestHelpGrounding(accountId: string, screen?: 'home' | 'build' | 'card') {
  pendingGroundingAccount = accountId;
  pendingScreen = screen ? { accountId, screen } : null;
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


export function consumeHelpGroundingScreen(accountId: string) {
  const screen = pendingScreen?.accountId === accountId ? pendingScreen.screen : null;
  pendingScreen = null;
  return screen;
}
