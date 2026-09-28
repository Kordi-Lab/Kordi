// Account choices this app has seen, so a route can tell a hosted copy with no
// local counterpart (for example a sign-in published from another Mac) from an
// account on this Mac. Hosted-only prefixes need no registry; see routeAccountChoice.ts.
//
// This Mac's choices start unknown (null) and are unknown again while its
// accounts reload. Until they load, no hosted copy counts as hosted-only, so a
// turn for an account on this Mac never goes to Kordi Cloud by mistake.

let hostedChoices: ReadonlySet<string> = new Set();
let localChoices: ReadonlySet<string> | null = null;
let localProviderIds: ReadonlySet<string> = new Set();

/** Live hosted snapshot choices of the signed-in Kordi account. */
export function setHostedAccountChoices(choices: Iterable<string>) {
  hostedChoices = new Set(choices);
}

/** Account choices saved on this Mac, or null while they have not loaded. */
export function setLocalAccountChoices(choices: Iterable<string> | null) {
  localChoices = choices === null ? null : new Set(choices);
}

/** Providers with an account saved on this Mac. */
export function setLocalProviderIds(ids: Iterable<string>) {
  localProviderIds = new Set(ids);
}

export function registeredAccountChoices() {
  return { hostedChoices, localChoices, localProviderIds };
}
