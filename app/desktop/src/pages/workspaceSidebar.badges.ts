/** Rail badges stay one or two characters wide. */
export function formatRailBadgeCount(value: number) {
  return value > 9 ? '9+' : `${value}`;
}
