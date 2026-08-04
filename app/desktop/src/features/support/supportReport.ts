import type {
  CloudSupportTicketCategory,
  CloudSupportTicketInput,
} from '@/features/cloud/supportClient';

export type SupportReportDraft = {
  category: CloudSupportTicketCategory;
  subject: string;
  description: string;
  includeDiagnostics: boolean;
};

export type SupportReportProposal = {
  displayText: string;
  draft: SupportReportDraft;
};

export type SupportReportDiagnosticValues = {
  appVersion?: string;
  platform?: string;
  osVersion?: string;
};

type BuildSupportReportInput = {
  draft: SupportReportDraft;
  sessionId: string;
  permissionGranted: boolean;
  diagnostics?: SupportReportDiagnosticValues;
  clientSubmissionId: string;
};

const SUPPORT_REPORT_BLOCK_PATTERN = /<kordi-support-report>\s*([\s\S]*?)\s*<\/kordi-support-report>/i;
const SUPPORT_REPORT_BLOCK_START_PATTERN = /<kordi-support-report>/i;
const SUPPORT_REPORT_HEADING_PATTERN = /^\s{0,3}#{1,6}\s+(?:test\s+)?(?:issue\s+ticket|support\s+report)\s*$/im;
const SUPPORT_REPORT_TRAILING_INSTRUCTION_PATTERN = /\n+\s*To submit this[\s\S]*$/i;

function cleanProposalDraft(value: unknown): SupportReportDraft | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const subject = typeof record.subject === 'string' ? record.subject.trim() : '';
  const description = typeof record.description === 'string' ? record.description.trim() : '';
  if (!subject || !description) return null;
  const rawCategory = typeof record.category === 'string'
    ? record.category.trim().toLowerCase()
    : 'issue';
  const category: CloudSupportTicketCategory = rawCategory === 'question'
    || rawCategory === 'feedback'
    ? rawCategory
    : 'issue';
  return {
    category,
    subject: Array.from(subject).slice(0, 160).join(''),
    description: Array.from(description).slice(0, 12_000).join(''),
    includeDiagnostics: false,
  };
}

function structuredProposal(text: string): SupportReportProposal | null {
  const match = text.match(SUPPORT_REPORT_BLOCK_PATTERN);
  if (!match) return null;
  const serialized = match[1]
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  try {
    const draft = cleanProposalDraft(JSON.parse(serialized));
    if (!draft) return null;
    return {
      displayText: text.replace(match[0], '').replace(/\n{3,}/g, '\n\n').trim(),
      draft,
    };
  } catch {
    return null;
  }
}

function inlineMarkdownField(text: string, names: string[]) {
  const label = names.join('|');
  const match = text.match(new RegExp(
    `\\*\\*(?:${label}):\\*\\*\\s*([\\s\\S]*?)(?=\\s+\\*\\*[A-Za-z][A-Za-z ]{1,32}:\\*\\*|\\n\\s*\\n|$)`,
    'i',
  ));
  return match?.[1]?.trim() ?? '';
}

function markdownProposal(text: string): SupportReportProposal | null {
  if (!SUPPORT_REPORT_HEADING_PATTERN.test(text)) return null;
  const subject = inlineMarkdownField(text, ['Title', 'Subject']);
  const descriptionMarker = text.search(/\*\*Description:\*\*/i);
  if (!subject || descriptionMarker < 0) return null;
  const description = text
    .slice(descriptionMarker)
    .replace(SUPPORT_REPORT_TRAILING_INSTRUCTION_PATTERN, '')
    .trim();
  const draft = cleanProposalDraft({ category: 'issue', subject, description });
  return draft ? { displayText: text.trim(), draft } : null;
}

export function parseSupportReportProposal(text: string): SupportReportProposal | null {
  return structuredProposal(text) ?? markdownProposal(text);
}

export function supportReportDisplayText(text: string) {
  const markerIndex = text.search(SUPPORT_REPORT_BLOCK_START_PATTERN);
  return markerIndex >= 0 ? text.slice(0, markerIndex).trimEnd() : text;
}

export function supportProposalSubmissionId(
  sessionId: string,
  draft: SupportReportDraft,
) {
  const value = JSON.stringify([
    sessionId.trim(),
    draft.category,
    draft.subject.trim(),
    draft.description.trim(),
  ]);
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `desktop:model-proposal:${(hash >>> 0).toString(16)}`;
}

export function buildSupportTicketInput({
  draft,
  sessionId,
  permissionGranted,
  diagnostics,
  clientSubmissionId,
}: BuildSupportReportInput): CloudSupportTicketInput {
  if (!permissionGranted) {
    throw new Error('Permission is required before sending this report.');
  }

  const subject = draft.subject.trim();
  const description = draft.description.trim();
  if (!subject || !description) {
    throw new Error('Add a subject and details before reviewing this report.');
  }

  return {
    category: draft.category,
    subject,
    description,
    sessionId: sessionId.trim() || undefined,
    diagnostics: draft.includeDiagnostics ? diagnostics : undefined,
    consent: {
      reportSubmission: true,
      diagnostics: draft.includeDiagnostics,
    },
    clientSubmissionId,
  };
}
