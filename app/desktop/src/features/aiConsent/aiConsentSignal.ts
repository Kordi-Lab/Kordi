// Dependency-free relay from the cloud error parser to the AI consent store, so
// low-level request code never imports React or the store.

type Listener = () => void;

const listeners = new Set<Listener>();

export function onAiConsentRequired(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** A server refused an AI action with `ai_consent_required`. */
export function signalAiConsentRequired(): void {
  for (const listener of [...listeners]) listener();
}
