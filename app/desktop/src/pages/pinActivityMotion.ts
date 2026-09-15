// Only newly performed actions animate. A virtual row remount or sync replay
// must not restart the feedback animation.
const revealedByDocument = new WeakMap<Document, Set<string>>();

export function revealPinActivity(element: HTMLElement, id: string): Animation | null {
  if (typeof element.animate !== 'function') return null;
  let revealed = revealedByDocument.get(element.ownerDocument);
  if (!revealed) { revealed = new Set(); revealedByDocument.set(element.ownerDocument, revealed); }
  if (revealed.has(id)) return null;
  revealed.add(id);
  if (revealed.size > 512) revealed.delete(revealed.values().next().value!);
  const styles = getComputedStyle(element);
  const token = styles.getPropertyValue('--app-motion-base').trim();
  const match = /^(\d*\.?\d+)(ms|s)$/.exec(token);
  const duration = match ? Number(match[1]) * (match[2] === 's' ? 1000 : 1) : 220;
  const reduced = element.ownerDocument.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  return element.animate(reduced ? [{ opacity: 0.7 }, { opacity: 1 }] : [
    { opacity: 0, transform: 'translateY(25%)' },
    { opacity: 1, transform: 'translateY(0)' },
  ], {
    duration: reduced ? 100 : Math.min(duration, 280),
    easing: styles.getPropertyValue('--app-motion-ease').trim() || 'cubic-bezier(0.23, 1, 0.32, 1)',
  });
}
