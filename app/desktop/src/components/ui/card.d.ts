import type * as React from 'react';

export type CardProps = React.HTMLAttributes<HTMLDivElement>;

export function Card(props: CardProps): React.JSX.Element;
export function CardHeader(props: CardProps): React.JSX.Element;
export function CardTitle(props: CardProps): React.JSX.Element;
export function CardContent(props: CardProps): React.JSX.Element;
