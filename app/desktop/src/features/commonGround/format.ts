// Small formatting helpers shared by the Common ground screens.

export function roomTitle(code: string, name: string | undefined) {
  return name?.trim() || `Room ${code}`;
}

const TOPIC_TONES = ['pink', 'cyan', 'amber', 'accent', 'violet'] as const;

/** A stable color for a topic label. */
export function topicTone(topic: string): string {
  let hash = 0;
  for (const char of topic) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return TOPIC_TONES[hash % TOPIC_TONES.length];
}

function pad(value: number) {
  return String(value).padStart(2, '0');
}

/** Today and the next full hour, in local time. */
export function defaultMeetSlot(now = new Date()): { date: string; time: string } {
  const next = new Date(now);
  next.setMinutes(0, 0, 0);
  next.setHours(next.getHours() + 1);
  return { date: `${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())}`, time: `${pad(next.getHours())}:00` };
}

/** Local date, time and minutes as the meet request's ISO start and end. */
export function meetTimes(date: string, time: string, minutes: number): { startAt: string; endAt: string } | null {
  const start = new Date(`${date}T${time}`);
  if (Number.isNaN(start.getTime())) return null;
  return { startAt: start.toISOString(), endAt: new Date(start.getTime() + minutes * 60_000).toISOString() };
}

export function peopleCount(count: number) {
  return count === 1 ? '1 person' : `${count} people`;
}
