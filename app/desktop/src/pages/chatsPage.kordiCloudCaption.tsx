import { useActiveChatRunsOnKordiCloud } from '@/features/chat/kordiCloudChatRoute';

export const KORDI_CLOUD_RUNTIME_CAPTION = 'Runs on Kordi Cloud';

/** Shown next to the model when the chat's account is hosted-only, so its turns run on Kordi Cloud. */
export function KordiCloudRuntimeCaptionView({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <span
      data-kordi-cloud-runtime=""
      className="shrink-0 whitespace-nowrap text-[11px] leading-none text-slate-400"
      title="This account is stored in your Kordi account, so the model runs on Kordi Cloud, not on this Mac."
    >
      {KORDI_CLOUD_RUNTIME_CAPTION}
    </span>
  );
}

export function KordiCloudRuntimeCaption() {
  return <KordiCloudRuntimeCaptionView show={useActiveChatRunsOnKordiCloud()} />;
}
