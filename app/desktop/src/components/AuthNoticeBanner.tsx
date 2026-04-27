import { Shield } from 'lucide-react';

import { Button } from '@/components/ui/button';

type AuthNoticeBannerProps = {
  title: string;
  description: string;
  actionLabel?: string;
  onAction: () => void;
};

export function AuthNoticeBanner({
  title,
  description,
  actionLabel = 'Open Authentication',
  onAction,
}: AuthNoticeBannerProps) {
  return (
    <div className="app-auth-notice mx-5 mt-4 shrink-0 rounded-[20px] px-4 py-3">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          <div className="app-auth-notice-title flex items-center gap-2 text-[13px] font-medium">
            <Shield className="app-auth-notice-icon h-4 w-4 shrink-0" />
            {title}
          </div>
          <p className="app-auth-notice-description mt-1 text-[12px] leading-5">{description}</p>
        </div>
        <Button
          variant="secondary"
          className="app-auth-notice-action h-9 shrink-0 rounded-full px-3.5 text-[12px]"
          onClick={onAction}
        >
          {actionLabel}
        </Button>
      </div>
    </div>
  );
}
