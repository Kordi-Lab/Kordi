export type CloudSessionStatus = 'loading' | 'signed-out' | 'authenticated';

export function shouldShowCloudLoginGate({
  cloudSessionStatus,
}: {
  cloudSessionStatus: CloudSessionStatus;
}) {
  return cloudSessionStatus === 'signed-out';
}
