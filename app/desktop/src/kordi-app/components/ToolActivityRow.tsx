import { useId, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { DesktopChatToolSnapshot } from '../types';
import { toolActivityDisplayOutput, toolActivityMetadata } from './toolActivityMetadata';
import { toolTimelineDisplayArguments } from './toolTimeline';
import { ProgressDisclosure } from './ProgressDisclosure';
import { ToolActivityText } from './ToolActivityText';
import { useRememberedDisclosure } from './rememberedDisclosure';

/** Each tool reads as one line; its output and raw input open only on request. */
export function ToolActivityRow({ tool, onOpenFile, stateKey }: {
  tool: DesktopChatToolSnapshot; onOpenFile?: (path: string) => void; stateKey?: string;
}) {
  const [expanded, toggle] = useRememberedDisclosure(stateKey ?? `tool:${tool.id}`, false);
  const [inputExpanded, setInputExpanded] = useState(false);
  const detailsId = useId();
  const inputId = useId();
  const { command, path, label, query, target, Icon } = toolActivityMetadata(tool);
  const rawOutput = tool.resultText && tool.liveOutput && !tool.resultText.includes(tool.liveOutput)
    ? `${tool.liveOutput}\n\n${tool.resultText}` : tool.resultText || tool.liveOutput;
  const output = rawOutput ? toolActivityDisplayOutput(rawOutput) : rawOutput;
  const failed = tool.isError || /error|failed/.test(tool.status);
  const expandable = Boolean(output || tool.arguments);
  const commandText = command?.replace(/\s+/g, ' ');
  const summary = <>
    <Icon size={14} aria-hidden="true" />
    <span className="app-tool-activity-summary" title={commandText}>
      {label}{commandText ? ` ${commandText}` : ''}
      {query ? <span className="app-tool-query"> · “{query}”</span> : null}
      {target ? <span className="app-tool-query"> · {target}</span> : null}
    </span>
  </>;
  return <div className="app-tool-activity" data-expanded={expanded}
    data-transcript-stable-disclosure-root="true" data-transcript-stable-disclosure-direction="down">
    <div className="app-tool-activity-line" data-failed={failed || undefined}>
      {expandable ? <button type="button" className="app-tool-activity-label app-tool-activity-toggle"
        aria-expanded={expanded} aria-controls={detailsId} data-transcript-stable-disclosure="true" onClick={toggle}>
        {summary}
        <ChevronRight aria-hidden="true" size={13} className={expanded ? 'rotate-90' : undefined} />
      </button> : <div className="app-tool-activity-label">{summary}</div>}
      {path ? onOpenFile ? <button type="button" className="app-tool-file-link" title={path} onClick={() => onOpenFile(path)}>{path.split('/').pop()}</button> : <span className="app-tool-file-name">{path.split('/').pop()}</span> : null}
      {failed ? <span className="app-tool-activity-error">Failed</span> : null}
    </div>
    {expandable ? <ProgressDisclosure id={detailsId} expanded={expanded}>
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
    </ProgressDisclosure> : null}
  </div>;
}
