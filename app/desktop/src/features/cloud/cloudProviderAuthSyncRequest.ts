export const CLOUD_PROVIDER_AUTH_SYNC_REQUEST_EVENT = 'kordi-cloud-provider-auth-sync-request';

export type CloudProviderAuthSyncRequestDetail = {
  handled: boolean;
  resolve: () => void;
  reject: (error: unknown) => void;
};

type CloudProviderAuthSyncEventTarget = Pick<Window, 'dispatchEvent'> & {
  CustomEvent: typeof CustomEvent;
};

function browserEventTarget(): CloudProviderAuthSyncEventTarget | null {
  return typeof window === 'undefined' ? null : window;
}

export function requestCloudProviderAuthSync(
  target: CloudProviderAuthSyncEventTarget | null = browserEventTarget(),
): Promise<boolean> {
  if (!target) return Promise.resolve(false);

  return new Promise<boolean>((resolve, reject) => {
    const detail: CloudProviderAuthSyncRequestDetail = {
      handled: false,
      resolve: () => resolve(true),
      reject,
    };
    target.dispatchEvent(new target.CustomEvent(
      CLOUD_PROVIDER_AUTH_SYNC_REQUEST_EVENT,
      { detail },
    ));
    if (!detail.handled) resolve(false);
  });
}
