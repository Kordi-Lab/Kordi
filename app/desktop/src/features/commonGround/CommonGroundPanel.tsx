import { CommonGroundPage } from './CommonGroundPage';
import type { CgHost } from './host';
import { commonGroundStoreFor } from './useCommonGround';

/** The page for the signed-in account; loaded on demand from Contacts. */
export default function CommonGroundPanel({ host }: { host: CgHost }) {
  return <CommonGroundPage store={commonGroundStoreFor(host.self.accountId, Boolean(host.profiles))} host={host} />;
}
