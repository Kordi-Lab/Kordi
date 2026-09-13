// Older transports put these status notices in the assistant answer field.
// Match the whole notice so partial answers that mention cancellation survive.
export function isCancellationNotice(text: string) {
  return /^(?:(?:request|response) (?:cancelled|canceled|stopped)(?: by (?:sender|agent owner|participant))?|stopped)[.!]?$/i.test(text.trim());
}

export function cancelledTurnContent(assistantText: string, message: string, error?: string | null) {
  const notices = [assistantText, error ?? '', message]
    .map((value) => value.trim())
    .filter(isCancellationNotice);
  const notice = notices.find((value) => / by /i.test(value)) ?? notices[0] ?? 'Response stopped';
  return {
    assistantText: isCancellationNotice(assistantText) ? '' : assistantText,
    notice,
    error: isCancellationNotice(error ?? '') ? null : error,
  };
}
