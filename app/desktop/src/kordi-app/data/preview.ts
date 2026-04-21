export const settingsEditPreview = {
  files: [
    {
      path: 'src/KordiApp.tsx',
      additions: 33,
      deletions: 55,
      sourceLines: [
        { number: 1036, text: '  }', kind: 'context' },
        { number: 1037, text: "  if (controlType === 'action') {", kind: 'context' },
        { number: 1038, text: '    return (', kind: 'context' },
        { number: 1039, text: '      <div className="flex items-center justify-end gap-2.5">', kind: 'add' },
        { number: 1040, text: '        <div className="text-[13px] font-medium text-slate-300">{item.value}</div>', kind: 'add' },
        {
          number: 1041,
          text: '        <button className="rounded-xl bg-white/10 px-3 py-1.5 text-[13px] font-medium text-white transition hover:bg-white/15">',
          kind: 'add',
        },
        { number: 1042, text: "          {item.control?.actionLabel ?? 'Set'}", kind: 'context' },
        { number: 1043, text: '        </button>', kind: 'context' },
        { number: 1044, text: '      </div>', kind: 'context' },
        { number: 1045, text: '    );', kind: 'context' },
      ],
      lines: [
        { kind: 'context' as const, oldNumber: 1037, newNumber: 1037, text: "if (controlType === 'action') {" },
        { kind: 'context' as const, oldNumber: 1038, newNumber: 1038, text: '  return (' },
        { kind: 'remove' as const, oldNumber: 1039, text: '<div className=\"flex items-center justify-end gap-3\">' },
        { kind: 'remove' as const, oldNumber: 1040, text: '<div className=\"text-[14px] font-medium text-slate-300\">{item.value}</div>' },
        {
          kind: 'remove' as const,
          oldNumber: 1041,
          text: '<button className=\"rounded-2xl bg-white/10 px-4 py-2 text-[14px] font-medium text-white transition hover:bg-white/15\">',
        },
        { kind: 'add' as const, newNumber: 1039, text: '<div className=\"flex items-center justify-end gap-2.5\">' },
        { kind: 'add' as const, newNumber: 1040, text: '<div className=\"text-[13px] font-medium text-slate-300\">{item.value}</div>' },
        {
          kind: 'add' as const,
          newNumber: 1041,
          text: '<button className=\"rounded-xl bg-white/10 px-3 py-1.5 text-[13px] font-medium text-white transition hover:bg-white/15\">',
        },
        { kind: 'context' as const, oldNumber: 1042, newNumber: 1042, text: "{item.control?.actionLabel ?? 'Set'}" },
        { kind: 'context' as const, oldNumber: 1043, newNumber: 1043, text: '</button>' },
      ],
    },
  ],
};
