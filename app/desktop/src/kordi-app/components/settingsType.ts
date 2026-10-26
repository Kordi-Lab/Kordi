/**
 * Settings type styles. The shared settings components in settingsLayout use
 * them, and panels with their own markup use them too, so equivalent text
 * matches on every settings tab.
 */
export const settingsType = {
  /** Page and section headings. */
  heading: 'text-[15px] font-semibold tracking-[-0.01em] text-white',
  /** Small muted group labels in dense lists and the settings rail. */
  label: 'text-[12px] font-medium leading-[18px] text-slate-500',
  rowTitle: 'text-[13px] font-medium leading-5 text-white',
  /** Row descriptions and helper lines under headings. */
  description: 'text-[12px] leading-5 text-slate-400',
  /** A read-only value or status on the right of a row. */
  value: 'text-[13px] leading-5 text-slate-400',
  /** Text of small status pills, such as Experimental or Needs review. */
  badge: 'text-[10px] font-medium leading-4',
} as const;
