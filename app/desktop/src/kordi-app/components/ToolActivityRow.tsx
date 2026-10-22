import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { DesktopChatToolSnapshot } from '../types';
import { toolActivityMetadata } from './toolActivityMetadata';
import { toolTimelineDisplayArguments } from './toolTimeline';
import { ProgressDisclosure } from './ProgressDisclosure';

/** The action row itself is the disclosure; file buttons open a companion tab. */
export function ToolActivityRow({ tool, onOpenFile }: { tool: DesktopChatToolSnapshot; onOpenFile?: (path: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const { command, path, label, Icon } = toolActivityMetadata(tool);
  const output = tool.resultText && tool.liveOutput && !tool.resultText.includes(tool.liveOutput)
    ? `${tool.liveOutput}\n\n${tool.resultText}` : tool.resultText || tool.liveOutput;
  const expandable = Boolean(tool.arguments || output);
  const failed = tool.isError || /error|failed/.test(tool.status);
  return <div className="app-tool-activity" data-transcript-stable-disclosure-root="true" data-transcript-stable-disclosure-direction="down">
    <div className="app-tool-activity-line" data-failed={failed || undefined}>
      <button type="button" className="app-tool-activity-toggle" disabled={!expandable}
        aria-expanded={expandable ? expanded : undefined} aria-label={`${label}${path ? ` ${path.split('/').pop()}` : command ? ` ${command}` : ''}${failed ? ', failed' : ''}`}
        data-transcript-stable-disclosure="true" onClick={() => setExpanded(value => !value)}>
        <Icon size={14} aria-hidden="true" />
        <span>{label}{command ? ` ${command.replace(/\s+/g, ' ')}` : ''}</span>
        {expandable ? <ChevronRight size={12} aria-hidden="true" className={expanded ? 'rotate-90' : undefined} /> : null}
      </button>
      {path ? onOpenFile ? <button type="button" className="app-tool-file-link" title={path} onClick={() => onOpenFile(path)}>{path.split('/').pop()}</button> : <span className="app-tool-file-name">{path.split('/').pop()}</span> : null}
      {failed ? <span className="app-tool-activity-error">Failed</span> : null}
    </div>
    <ProgressDisclosure expanded={expanded}><div className="app-tool-output">
      <div className="app-tool-output-heading">{command ? 'Shell' : 'Tool output'}</div>
      <pre tabIndex={0} aria-label={command ? 'Shell output' : 'Tool output'}>
        {command ? <><span className="app-tool-input">$ {command}</span>{'\n\n'}</> : null}
        {output || toolTimelineDisplayArguments(tool)}
      </pre>
      {tool.arguments && output && !command ? <details className="app-tool-input-details"><summary>Input</summary><pre tabIndex={0}>{toolTimelineDisplayArguments(tool)}</pre></details> : null}
    </div></ProgressDisclosure>
  </div>;
}
