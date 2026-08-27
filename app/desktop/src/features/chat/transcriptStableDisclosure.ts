export type TranscriptDisclosureDirection = 'up' | 'down';

export function transcriptDisclosureDirection(
  growth: number,
  availableAbove: number,
  availableBelow: number,
): TranscriptDisclosureDirection {
  if (growth <= availableBelow) return 'down';
  if (growth <= availableAbove) return 'up';
  return availableAbove > availableBelow ? 'up' : 'down';
}

export function transcriptDisclosureBody(root: HTMLElement | null) {
  return root?.querySelector<HTMLElement>('[data-transcript-stable-disclosure-body="true"]') ?? null;
}

export function clearTranscriptDisclosureConstraint(body: HTMLElement | null) {
  if (!body || !body.hasAttribute('data-transcript-disclosure-constrained')) return;
  body.removeAttribute('data-transcript-disclosure-constrained');
  body.style.removeProperty('--app-transcript-disclosure-max-height');
}

export function constrainTranscriptDisclosureBody(body: HTMLElement, maxHeight: number) {
  const value = `${maxHeight}px`;
  if (
    body.dataset.transcriptDisclosureConstrained === 'true'
    && body.style.getPropertyValue('--app-transcript-disclosure-max-height') === value
  ) return;
  body.dataset.transcriptDisclosureConstrained = 'true';
  body.style.setProperty('--app-transcript-disclosure-max-height', value);
}

export function forcedTranscriptDisclosureDirection(root: HTMLElement | null) {
  const value = root?.dataset.transcriptStableDisclosureDirection;
  return value === 'up' || value === 'down' ? value : null;
}
