/**
 * Who asked for a composer change. Only a person's own choice (a selector, the
 * model menu, a slash command) announces itself in the transcript; a change
 * the app makes on its own applies silently.
 */
export type ComposerSelectionOrigin = 'user' | 'automatic';

export type ComposerSelectionOptions = { origin?: ComposerSelectionOrigin };

export function composerSelectionIsAutomatic(options?: ComposerSelectionOptions) {
  return options?.origin === 'automatic';
}
