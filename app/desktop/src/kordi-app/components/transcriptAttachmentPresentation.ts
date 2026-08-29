import type { Message } from '../types';

export function isAttachmentSending(message: Message) {
  return (message.statusChips ?? []).some((chip) => {
    const normalized = chip.trim().toLowerCase();
    return normalized === 'sending' || normalized === 'pending';
  });
}

export function imageTileClass(index: number, totalCount: number, intrinsicSingleImage = false) {
  if (totalCount <= 1) return intrinsicSingleImage ? 'col-span-6' : 'col-span-6 row-span-3';
  if (totalCount === 2) return 'col-span-3 row-span-3';
  if (totalCount === 3) return index === 0 ? 'col-span-6 row-span-2' : 'col-span-3 row-span-2';
  if (totalCount === 4) return 'col-span-3 row-span-2';
  if (totalCount === 5) return index < 2 ? 'col-span-3 row-span-2' : 'col-span-2 row-span-2';
  if (totalCount === 6) return 'col-span-2 row-span-2';
  return index < 2 ? 'col-span-3 row-span-2' : 'col-span-2 row-span-2';
}
