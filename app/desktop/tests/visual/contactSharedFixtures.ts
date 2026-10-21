import type { Message, MessageAttachment } from '../../src/kordi-app/types';

/** Synthetic shared media for the contact profile previews: no real people or files. */

const SEEDS = ['#8fa3b8', '#b59a7c', '#7fa58e', '#a78bb0', '#c9a46a', '#6f8fa6', '#b38282'];

function swatch(index: number) {
  const color = SEEDS[index % SEEDS.length];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${color}"/><stop offset="1" stop-color="#2b2f36"/></linearGradient></defs><rect width="240" height="240" fill="url(#g)"/><circle cx="76" cy="70" r="46" fill="#fff" fill-opacity=".22"/></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function photo(index: number): MessageAttachment {
  return { kind: 'image', name: `photo-${index + 1}.jpg`, mimeType: 'image/jpeg', previewUrl: swatch(index), widthPixels: 240, heightPixels: 240 };
}

function daysAgo(now: Date, monthOffset: number, day: number) {
  return new Date(now.getFullYear(), now.getMonth() - monthOffset, day, 10, 0).getTime();
}

export function contactSharedVisualMessages(now = new Date()): Message[] {
  const thisMonth = Math.max(2, Math.min(now.getDate(), 28));
  return [
    {
      id: 'shared-1', role: 'person', sender: 'Maya Chen', time: '', timestampMs: daysAgo(now, 1, 9),
      text: 'Reading for Thursday https://www.nature.com/articles/tactile-review',
      attachments: [photo(0), photo(1), photo(2)],
    },
    {
      id: 'shared-2', role: 'user', sender: 'Me', time: '', timestampMs: daysAgo(now, 1, 22),
      text: 'Inventory attached.',
      attachments: [{ kind: 'file', name: 'Lab inventory.xlsx', mimeType: 'application/vnd.ms-excel', sizeBytes: 48 * 1024 }],
    },
    {
      id: 'shared-3', role: 'person', sender: 'Maya Chen', time: '', timestampMs: daysAgo(now, 0, Math.max(1, thisMonth - 1)),
      text: 'Bench photos and the [Sim-to-real transfer survey](https://arxiv.org/abs/2610.01234)',
      attachments: [photo(3), photo(4), photo(5), { kind: 'file', name: 'gripper-test.mp4', mimeType: 'video/mp4', previewUrl: swatch(6) }],
    },
    {
      id: 'shared-4', role: 'user', sender: 'Me', time: '', timestampMs: daysAgo(now, 0, thisMonth),
      text: 'Draft is up, and the setup guide https://frankaemika.github.io/docs/setup',
      attachments: [{ kind: 'file', name: 'Grant draft v3.pdf', mimeType: 'application/pdf', sizeBytes: 1_258_291 }],
    },
  ];
}
