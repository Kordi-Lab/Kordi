import { useId, useState } from 'react';
import type { DesktopChatToolSnapshot } from '../types';
import { toolActivityMetadata } from './toolActivityMetadata';
import { toolTimelineDisplayArguments } from './toolTimeline';
import { ProgressDisclosure } from './ProgressDisclosure';
import { ToolActivityText } from './ToolActivityText';

/** Short results read inline; only raw input and long text need a disclosure. */
export function ToolActivityRow({ tool, onOpenFile }: { tool: DesktopChatToolSnapshot; onOpenFile?: (path: string) => void }) {
  const [inputExpanded, setInputExpanded] = useState(false);
  const inputId = useId();
  const { command, path, label, query, Icon } = toolActivityMetadata(tool);
  const output = tool.resultText && tool.liveOutput && !tool.resultText.includes(tool.liveOutput)
    ? `${tool.liveOutput}\n\n${tool.resultText}` : tool.resultText || tool.liveOutput;
  const failed = tool.isError || /error|failed/.test(tool.status);
  return <div className="app-tool-activity">
    <div className="app-tool-activity-line" data-failed={failed || undefined}>
      <div className="app-tool-activity-label">
        <Icon size={14} aria-hidden="true" />
        <span>{label}{command ? ` ${command.replace(/\s+/g, ' ')}` : ''}{query ? <span className="app-tool-query"> · “{query}”</span> : null}</span>
      </div>
      {path ? onOpenFile ? <button type="button" className="app-tool-file-link" title={path} onClick={() => onOpenFile(path)}>{path.split('/').pop()}</button> : <span className="app-tool-file-name">{path.split('/').pop()}</span> : null}
      {failed ? <span className="app-tool-activity-error">Failed</span> : null}
    </div>
    <div className={`app-tool-output${command || path ? ' app-tool-output-code' : ''}`}>
      {output ? <ToolActivityText text={output} label={command ? 'Shell output' : 'Tool output'} /> : null}
      {tool.arguments ? <div className="app-tool-input-details" data-transcript-stable-disclosure-root="true" data-transcript-stable-disclosure-direction="down">
        <button type="button" className="app-tool-detail-toggle" aria-expanded={inputExpanded} aria-controls={inputId}
          data-transcript-stable-disclosure="true" onClick={() => setInputExpanded(value => !value)}>
          {inputExpanded ? 'Hide input' : 'View input'}
        </button>
        <ProgressDisclosure id={inputId} expanded={inputExpanded}><div className="app-tool-input-content">
          <ToolActivityText text={toolTimelineDisplayArguments(tool)} label="Tool input" />
        </div></ProgressDisclosure>
      </div> : null}
    </div>
  </div>;
}
