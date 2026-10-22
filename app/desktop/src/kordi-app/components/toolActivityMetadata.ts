import { FileText, Pencil, Search, TerminalSquare, Wrench } from 'lucide-react';
import type { DesktopChatToolSnapshot } from '../types';
import { normalizeSessionArtifactId } from '@/features/chat/artifacts';
import { progressToolIsActive } from './turnProgressLabels';
import { toolTimelineToolLabel } from './toolTimeline';

export function toolActivityMetadata(tool: DesktopChatToolSnapshot) {
  let args: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(tool.arguments || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
  } catch { /* Streaming arguments may be incomplete. */ }
  const string = (keys: string[]) => keys.map(key => args[key]).find(value => typeof value === 'string' && value.trim()) as string | undefined;
  const name = tool.name.toLowerCase();
  const command = /bash|shell|command|terminal/.test(name) ? string(['command', 'cmd', 'script', 'input']) : undefined;
  const candidate = /read|view|cat|edit|write|patch|file/.test(name)
    ? tool.artifactPath || string(['path', 'file_path', 'filepath', 'file', 'target_file', 'relative_path']) : undefined;
  const path = candidate && !/^[a-z][a-z\d+.-]*:\/\//i.test(candidate) ? normalizeSessionArtifactId(candidate) : undefined;
  const editing = /edit|write|patch/.test(name);
  const searching = /search|grep|glob|find/.test(name);
  const active = progressToolIsActive(tool);
  const label = command ? active ? 'Running' : 'Ran' : path ? editing ? active ? 'Editing' : 'Edited' : active ? 'Reading' : 'Read' : toolTimelineToolLabel(tool);
  const Icon = command ? TerminalSquare : path ? editing ? Pencil : FileText : searching ? Search : Wrench;
  return { command, path, label, Icon };
}
