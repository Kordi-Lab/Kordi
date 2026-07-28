/**
 * Shared text helpers for detecting collaboration-agent placeholder strings.
 *
 * These were duplicated in `features/collaboration/transcript.ts` and
 * `features/canonical/readModel/messageMapping.ts` (see issue #400).
 * Centralising them keeps the placeholder format in one place so updates
 * can't drift between the two consumers.
 */

const PROCESSING_PLACEHOLDER_PATTERN = /^(?:processing|requesting)(?:\.{0,3}|…)?$/i;

const OUTREACH_CONTEXT_ENVELOPE_PATTERN = /^Context:\s*[\s\S]*?\n\s*Request:\s*\n?([\s\S]*)$/i;

/**
 * Returns true if a collaboration message body is the synthetic "processing..." /
 * "requesting..." placeholder Kordi writes while an agent reply is in flight.
 * Matches optional 0-3 trailing dots or a single ellipsis character.
 */
export function isProcessingPlaceholderText(text: string): boolean {
  return PROCESSING_PLACEHOLDER_PATTERN.test(text.trim());
}

/**
 * Outreach requests serialise as `Context: …\nRequest: <body>`. This strips
 * the envelope so the UI shows just the body; if no envelope is present, the
 * original text is returned unchanged.
 */
export function stripOutreachContextEnvelope(text: string): string {
  const match = OUTREACH_CONTEXT_ENVELOPE_PATTERN.exec(text.trim());
  return match?.[1]?.trim() || text;
}
