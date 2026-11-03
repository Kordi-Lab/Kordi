import { useId, useState } from 'react';

const PREVIEW_CHARACTERS = 600;
const PREVIEW_LINES = 6;

/** Bound the initial layout, including a single long line, without a scroll box. */
function toolActivityTextPreview(text: string) {
  const prefix = text.slice(0, PREVIEW_CHARACTERS);
  const lines = prefix.split('\n');
  return lines.length > PREVIEW_LINES ? lines.slice(0, PREVIEW_LINES).join('\n') : prefix;
}

export function ToolActivityText({ text, label }: { text: string; label: string }) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  const preview = toolActivityTextPreview(text);
  const truncated = preview.length < text.length;
  return <div className="app-tool-text" data-transcript-stable-disclosure-root="true" data-transcript-stable-disclosure-direction="down">
    {truncated ? <button type="button" className="app-tool-detail-toggle"
      aria-expanded={expanded} aria-controls={id} aria-label={`${expanded ? 'Show less' : 'Show all'} ${label.toLowerCase()}`}
      data-transcript-stable-disclosure="true" onClick={() => setExpanded(value => !value)}>
      {expanded ? 'Show less' : 'Show all'}
    </button> : null}
    <pre id={id} aria-label={label} data-transcript-stable-disclosure-body="true" data-transcript-disclosure-scroll="conversation">
      {expanded ? text : preview}{truncated && !expanded ? '…' : ''}
    </pre>
  </div>;
}
