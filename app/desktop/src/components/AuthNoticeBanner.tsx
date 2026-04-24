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
    <div className="mx-5 mt-4 shrink-0 rounded-[20px] border border-amber-400/20 bg-amber-500/10 px-4 py-3 text-amber-50 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[13px] font-medium text-white">
            <Shield className="h-4 w-4 shrink-0 text-amber-300" />
            {title}
          </div>
          <p className="mt-1 text-[12px] leading-5 text-amber-100/80">{description}</p>
        </div>
        <Button
          variant="secondary"
          className="h-9 shrink-0 rounded-full px-3.5 text-[12px] text-white"
          onClick={onAction}
        >
          {actionLabel}
        </Button>
      </div>
    </div>
  );
}
