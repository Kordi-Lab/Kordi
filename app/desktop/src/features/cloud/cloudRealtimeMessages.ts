export type CloudRealtimeMessageAction =
  | { kind: 'refresh' }
  | null;

export function decodeCloudRealtimeMessageFrame(
  data: unknown,
  _accountId: string,
): CloudRealtimeMessageAction {
  const parsed: unknown = JSON.parse(
    typeof data === 'string' ? data : '',
  );
  if (!parsed || typeof parsed !== 'object') return null;
  const frame = parsed as {
    subject?: string;
  };
  const subject = frame.subject;
  if (
    subject?.startsWith('kordi.events.sync.changed.')
    || subject?.startsWith('kordi.events.message.read.')
    || subject?.startsWith('kordi.events.message.arrived.')
  ) {
    return { kind: 'refresh' };
  }
  return null;
}
