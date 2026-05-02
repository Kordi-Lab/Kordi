type SessionConfigNoticeLike = {
  role?: string | null;
  text?: string | null;
  detail?: string | null;
};

const SESSION_CONFIG_NOTICE_DETAILS = new Set(['Model updated', 'Thinking updated']);

export function isSessionConfigNoticeMessage(message?: SessionConfigNoticeLike | null) {
  if (!message || message.role !== 'system') return false;
  const detail = message.detail?.trim();
  const text = message.text?.trim() ?? '';
  return Boolean(
    (detail && SESSION_CONFIG_NOTICE_DETAILS.has(detail))
      || text.startsWith('Switched model to ')
      || text.startsWith('Thinking set to '),
  );
}

export function appendOrReplaceTrailingSessionConfigNotice<T extends SessionConfigNoticeLike>(messages: readonly T[], notice: T) {
  const lastMessage = messages[messages.length - 1];
  if (isSessionConfigNoticeMessage(lastMessage)) {
    return {
      messages: [...messages.slice(0, -1), notice],
      appended: false,
    };
  }

  return {
    messages: [...messages, notice],
    appended: true,
  };
}

export function collapseAdjacentSessionConfigNotices<T extends SessionConfigNoticeLike>(messages: readonly T[]) {
  let collapsed: T[] | null = null;

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!isSessionConfigNoticeMessage(message)) {
      collapsed?.push(message);
      continue;
    }

    let latestNotice = message;
    let lastNoticeIndex = index;
    while (lastNoticeIndex + 1 < messages.length && isSessionConfigNoticeMessage(messages[lastNoticeIndex + 1])) {
      lastNoticeIndex += 1;
      latestNotice = messages[lastNoticeIndex];
    }

    if (lastNoticeIndex > index && !collapsed) {
      collapsed = messages.slice(0, index);
    }
    collapsed?.push(latestNotice);
    index = lastNoticeIndex;
  }

  return collapsed ?? messages;
}
