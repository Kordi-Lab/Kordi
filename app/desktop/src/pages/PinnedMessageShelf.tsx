import { useState } from 'react';
import { PinnedMessageBar } from './chatsPage.pins';
import type { ComponentProps } from 'react';

/** Retain the outgoing content until the accordion closes; session keys reset it. */
export function PinnedMessageShelf(props: ComponentProps<typeof PinnedMessageBar>) {
  const [retainedItems, setRetainedItems] = useState(props.items);
  const open = props.items.length > 0;
  if (open && retainedItems !== props.items) setRetainedItems(props.items);
  return (
    <div className="app-pin-shelf" data-open={open} aria-hidden={!open} inert={!open}>
      <div className="app-pin-shelf-clip">
        <PinnedMessageBar {...props} items={open ? props.items : retainedItems} />
      </div>
    </div>
  );
}
