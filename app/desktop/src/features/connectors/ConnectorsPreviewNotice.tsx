/** Shown only while the panel serves sample data from the preview client. */
export function ConnectorsPreviewNotice({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <p className="m-0 py-1 text-[12px] leading-5 text-slate-500">
      Showing sample connectors. Nothing here is connected to a real account.
    </p>
  );
}
