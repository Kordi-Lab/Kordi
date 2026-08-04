export { collaborationProfileImageUrl } from '@/features/collaboration/conversationPresentation';
import { isSelfReferenceName } from '@/lib/identityLabels';

export function sanitizeRemotePeerName(
  ...candidates: Array<string | null | undefined>
): string {
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (trimmed && !isSelfReferenceName(trimmed)) return trimmed;
  }
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (trimmed) return trimmed;
  }
  return 'Kordi user';
}
