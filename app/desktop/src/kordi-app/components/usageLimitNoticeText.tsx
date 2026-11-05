import { useOrganizationRole } from '@/features/cloud/usageClient';
import { openUsageSettings, usageLimitNoticeCopy } from '@/features/cloud/usageLimitNotice';
import type { MessageUsageLimit } from '@/kordi-app/types/message';

/** A System agent limit notice, worded for the viewer's role in the paying organization. */
export function UsageLimitNoticeText({ limit }: { limit: MessageUsageLimit }) {
  const role = useOrganizationRole(limit.reached === 'stopped' ? null : limit.organizationId);
  const copy = usageLimitNoticeCopy(limit, role);
  return (
    <span className="whitespace-pre-wrap break-words" data-kordi-copy-surface="message" data-usage-limit={limit.reached}>
      {copy.text}
      {copy.showUsageLink ? (
        <>
          {' '}
          <button type="button" className="app-markdown-link cursor-pointer border-0 bg-transparent p-0 font-[inherit]" onClick={openUsageSettings}>
            View usage
          </button>
        </>
      ) : null}
    </span>
  );
}
