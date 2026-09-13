// Older transports put these status notices in the assistant answer field.
// Match the whole notice so partial answers that mention cancellation survive.
export function isCancellationNotice(text: string) {
  return /^(?:(?:request|response) (?:cancelled|canceled|stopped)(?: by (?:sender|agent owner|participant))?|stopped)[.!]?$/i.test(text.trim());
}

export function cancelledTurnContent(assistantText: string, message: string, error?: string | null) {
  const notice = isCancellationNotice(assistantText)
    ? assistantText.trim()
    : isCancellationNotice(error ?? '')
      ? error!.trim()
      : isCancellationNotice(message)
        ? message.trim()
        : 'Response stopped';
  return {
    assistantText: isCancellationNotice(assistantText) ? '' : assistantText,
    notice,
    error: isCancellationNotice(error ?? '') ? null : error,
  };
}
