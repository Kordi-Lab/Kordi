export function getInitials(label: string) {
  return label
    .replace(/['’]s/g, '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

export function formatParticipants(participants: string[]) {
  if (participants.length <= 3) {
    return participants.join(' • ');
  }

  return `${participants.slice(0, 2).join(' • ')} • +${participants.length - 2} more`;
}

export function getParticipantLabels(participants: string[]) {
  if (participants.length <= 3) {
    return participants;
  }

  return [...participants.slice(0, 2), `+${participants.length - 2} more`];
}

export function getContactSortLetter(name: string) {
  const first = name.trim().charAt(0).toUpperCase();
  return /^[A-Z]$/.test(first) ? first : '#';
}
