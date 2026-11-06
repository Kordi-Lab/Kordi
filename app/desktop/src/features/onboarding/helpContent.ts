import type { NavId } from '@/kordi-app/types';
import type { CloudAccountSettingsTabId } from '@/pages/cloudAccountSettingsNav';

export type HelpAction =
  | { kind: 'navigate'; page: NavId }
  | { kind: 'settings'; tab: CloudAccountSettingsTabId }
  | { kind: 'grounding' | 'support' | 'updates' | 'permissions' };

/** Title of the licenses page that release builds stage under public/licenses. */
export const LICENSES_PAGE_TITLE = 'Open-source licenses';

/** False when the licenses frame loaded another page, such as a dev server's app fallback. */
export function isLicensesDocument(document: Pick<Document, 'title'> | null | undefined): boolean {
  return !document || document.title === LICENSES_PAGE_TITLE;
}
