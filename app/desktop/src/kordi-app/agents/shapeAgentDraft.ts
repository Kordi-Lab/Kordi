export type ShapeAgentResourceInput = {
  kind: 'url' | 'text' | 'file';
  value: string;
};

export type ShapeAgentSkillDraft = {
  name: string;
  description: string;
};

export type ShapeAgentDraft = {
  name: string;
  role: string;
  description: string;
  systemPrompt: string;
  sourceSummary: string;
  boundaries: string[];
  skills: ShapeAgentSkillDraft[];
};

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function classifyResource(value: string): ShapeAgentResourceInput['kind'] {
  if (/^https?:\/\//i.test(value)) return 'url';
  if (/^(~|\.|\/|[A-Za-z]:[\\/])/.test(value) || /\.(md|txt|pdf|docx?|json|csv|html?)$/i.test(value)) return 'file';
  return 'text';
}

export function parseShapeResources(raw: string): ShapeAgentResourceInput[] {
  return raw
    .split(/[\n,]+/)
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => ({ kind: classifyResource(value), value }));
}

function cleanStringList(value: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const entry of value) {
    const text = cleanText(entry).slice(0, maxLen).trim();
    if (!text || result.includes(text)) continue;
    result.push(text);
    if (result.length >= maxItems) break;
  }
  return result;
}

function cleanSkills(value: unknown): ShapeAgentSkillDraft[] {
  if (!Array.isArray(value)) return [];
  const result: ShapeAgentSkillDraft[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const record = objectRecord(entry);
    const name = cleanText(record?.name).slice(0, 80).trim();
    const description = cleanText(record?.description).slice(0, 240).trim();
    if (!name || !description || seen.has(name)) continue;
    seen.add(name);
    result.push({ name, description });
    if (result.length >= 8) break;
  }
  return result;
}

export function normalizeShapeAgentDraft(value: unknown): ShapeAgentDraft | null {
  const record = objectRecord(value);
  if (!record) return null;
  const name = cleanText(record.name);
  const role = cleanText(record.role);
  const description = cleanText(record.description);
  const systemPrompt = cleanText(record.systemPrompt);
  const sourceSummary = cleanText(record.sourceSummary);
  if (!name || !role || !systemPrompt) return null;
  return {
    name,
    role,
    description,
    systemPrompt,
    sourceSummary,
    boundaries: cleanStringList(record.boundaries, 10, 240),
    skills: cleanSkills(record.skills),
  };
}

function stripMarkdownJsonFence(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced?.[1]?.trim() ?? trimmed;
}

export function parseShapeAgentDraftJson(raw: string): ShapeAgentDraft | null {
  try {
    return normalizeShapeAgentDraft(JSON.parse(stripMarkdownJsonFence(raw)));
  } catch {
    return null;
  }
}
