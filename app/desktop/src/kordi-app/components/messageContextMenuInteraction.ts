export function isExplicitMessageContextMenuAction(clickDetail: number, receivedPointerDown: boolean) {
  return clickDetail === 0 || receivedPointerDown;
}
