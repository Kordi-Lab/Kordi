import { useId, useLayoutEffect, useRef, useState } from 'react';
import { forwardedMessageContent } from '@/features/chat/forwardedContent';
import type { Message } from '../types';
import { MarkdownContent } from './markdown';
import { ForwardedFromHeader } from './forwardedFromHeader';

const COLLAPSED_HEIGHT = 320;

/** A copied answer is independent of its original session and mention identities. */
export function ForwardedMessageContent({ message }: { message: Message }) {
  const { text, comment } = forwardedMessageContent(message);
  const contentId = useId();
  const contentRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const measure = () => setOverflows(content.scrollHeight > COLLAPSED_HEIGHT + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, [text]);
  return <div className="app-forwarded-content" data-transcript-stable-disclosure-root="true">
    <ForwardedFromHeader senderLabel={message.messageAction?.source.senderLabel} />
    {comment ? <div className="app-forwarded-comment"><MarkdownContent text={comment} tone="inherit" preserveLineBreaks showLinkIcons copySurface="message" /></div> : null}
    <div id={contentId} className="app-forwarded-body" data-forward-expanded={expanded}
      style={{ maxHeight: expanded ? undefined : COLLAPSED_HEIGHT, overflow: expanded ? undefined : 'clip' }}>
      <div ref={contentRef}>
        <MarkdownContent text={text} tone="inherit" preserveLineBreaks showLinkIcons copySurface="message" />
      </div>
    </div>
    {overflows ? <button type="button" className="app-forwarded-toggle" aria-expanded={expanded} aria-controls={contentId}
      data-transcript-stable-disclosure="true" onClick={() => setExpanded(value => !value)}>
      {expanded ? 'Collapse' : 'Show full message'}
    </button> : null}
  </div>;
}
