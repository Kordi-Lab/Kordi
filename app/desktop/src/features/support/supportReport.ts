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
const SUPPORT_REPORT_LEGACY_REFUSAL_PATTERN = /(?:^|\n+)\s*I\s+can(?:not|['’]t)\s+(?:create|submit|send)(?:\s+or\s+(?:create|confirm|submit|send))?\s+(?:an?\s+)?(?:support|issue)\s+(?:ticket|report)[\s\S]*$/i;
const SUPPORT_REPORT_LEGACY_QUOTED_SUBMISSION_PATTERN = /\bTo\s+(?:send|submit)\s+[“"]([^”"]+)[”"]\s+to\s+(?:an?\s+)?(?:human\s+)?maintainer/i;
const SUPPORT_REPORT_LEGACY_FORM_REDIRECT_PATTERN = /(?:^|\n+)\s*(?:If\s+you\s+intended\s+this\s+as\s+(?:a\s+)?support\s+report,\s*)?please\s+(?:submit|send)\s+(?:it|this|the\s+(?:ticket|report))\s+(?:through|using|via)\s+(?:the\s+)?support\s+form[\s\S]*$/i;

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

function firstMarkdownBlockquote(text: string) {
  const lines = text.split(/\r?\n/);
  const quoted: string[] = [];
  let collecting = false;

  for (const line of lines) {
    const match = line.match(/^\s*>\s?(.*)$/);
    if (match) {
      collecting = true;
      quoted.push(match[1]);
      continue;
    }
    if (collecting) break;
  }

  return quoted
    .join('\n')
    .trim()
    .replace(/^[*_]{1,3}\s*/, '')
    .replace(/\s*[*_]{1,3}$/, '')
    .trim();
}

function fallbackProposalSubject(description: string) {
  const firstSentence = description.split(/(?<=[.!?])\s+/u)[0] ?? description;
  const mainClause = firstSentence.split(/,\s+(?:as|because|since|whereas|which|while)\b/i)[0]
    ?? firstSentence;
  const concise = mainClause
    .replace(/^please\s+/i, '')
    .replace(/[.!?]+$/, '')
    .trim();
  if (!concise) return '';
  return concise.charAt(0).toUpperCase() + concise.slice(1);
}

function legacyNarrativeProposal(text: string): SupportReportProposal | null {
  const mentionsTicket = /\b(?:support|issue)\s+(?:ticket|report)\b/i.test(text);
  const mentionsSubmission = /\b(?:maintainers?|support\s+form|send|submit)\b/i.test(text);
  const framesDraft = /\b(?:clearer\s+version|draft|feedback|rephrase|restate|rewrite|suggestion)\b/i
    .test(text);
  const isLegacyRefusal = SUPPORT_REPORT_LEGACY_REFUSAL_PATTERN.test(text);
  if (!mentionsTicket || !mentionsSubmission || (!framesDraft && !isLegacyRefusal)) return null;

  const description = firstMarkdownBlockquote(text)
    || text.match(SUPPORT_REPORT_LEGACY_QUOTED_SUBMISSION_PATTERN)?.[1]?.trim()
    || '';
  const subject = fallbackProposalSubject(description);
  if (!subject || !description) return null;

  const category: CloudSupportTicketCategory = /\b(?:feedback|suggestion)\b/i.test(text)
    ? 'feedback'
    : 'issue';
  const draft = cleanProposalDraft({ category, subject, description });
  if (!draft) return null;

  const displayText = text
    .replace(SUPPORT_REPORT_LEGACY_REFUSAL_PATTERN, '')
    .replace(SUPPORT_REPORT_LEGACY_FORM_REDIRECT_PATTERN, '')
    .trim();
  return {
    displayText: displayText
      || 'I drafted this support request. Review it below before anything is sent.',
    draft,
  };
}

export function parseSupportReportProposal(text: string): SupportReportProposal | null {
  return structuredProposal(text) ?? markdownProposal(text) ?? legacyNarrativeProposal(text);
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
