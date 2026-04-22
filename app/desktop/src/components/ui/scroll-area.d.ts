import type * as React from 'react';

export type ScrollAreaProps = React.HTMLAttributes<HTMLDivElement>;

export const ScrollArea: React.ForwardRefExoticComponent<
  ScrollAreaProps & React.RefAttributes<HTMLDivElement>
>;
