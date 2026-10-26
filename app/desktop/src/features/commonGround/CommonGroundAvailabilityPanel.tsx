import type { CloudAuthCapabilitiesStatus } from '@/features/cloud/cloudAuthCapabilities';

import { CgButton, CgProgress } from './parts';

/** Keep the destination reachable while checking or recovering service availability. */
export function CommonGroundAvailabilityPanel({ status, onRetry }: {
  status: CloudAuthCapabilitiesStatus;
  onRetry: () => void;
}) {
  return (
    <section aria-label="Grounding" className="cg-page">
      <div className="cg-scroll">
        <div className="cg-body">
          <h1 className="text-lg font-semibold">Grounding</h1>
          {status === 'loading' ? <CgProgress line="Opening Grounding" /> : (
            <div className="flex flex-col items-start gap-3 py-6">
              <p role={status === 'failed' ? 'alert' : 'status'} className="text-sm text-muted-foreground">
                {status === 'failed'
                  ? 'Could not connect to Grounding. Try again.'
                  : 'Grounding is not available on this server yet.'}
              </p>
              <CgButton onClick={onRetry}>Try again</CgButton>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
