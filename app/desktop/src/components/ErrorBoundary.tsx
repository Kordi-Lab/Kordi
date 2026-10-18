import { Component, type ReactNode } from 'react';

import { reportRenderError } from '@/lib/renderErrors';

type ErrorBoundaryProps = {
  /** Names the area in the log line. */
  area: string;
  /** A new value clears a caught error (another document opened). */
  resetKey?: string;
  fallback: (reset: () => void) => ReactNode;
  children: ReactNode;
};

type ErrorBoundaryState = { failed: boolean; resetKey: string | undefined };

/**
 * Keeps a render error inside one area: the area shows its fallback and the
 * rest of the app keeps running. Logs a content-free summary of the error.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { failed: false, resetKey: this.props.resetKey };

  static getDerivedStateFromError(): Partial<ErrorBoundaryState> {
    return { failed: true };
  }

  static getDerivedStateFromProps(props: ErrorBoundaryProps, state: ErrorBoundaryState): Partial<ErrorBoundaryState> | null {
    return props.resetKey === state.resetKey ? null : { failed: false, resetKey: props.resetKey };
  }

  componentDidCatch(error: unknown) {
    reportRenderError(this.props.area, error);
  }

  reset = () => this.setState({ failed: false });

  render() {
    return this.state.failed ? this.props.fallback(this.reset) : this.props.children;
  }
}

/** A pane of the app shell that failed to render: one line and a retry. */
export function PaneErrorBoundary({ area, children }: { area: string; children: ReactNode }) {
  return (
    <ErrorBoundary
      area={area}
      fallback={(reset) => (
        <div className="app-pane-fallback" role="alert">
          <span>Something went wrong here</span>
          <button type="button" onClick={reset}>Try again</button>
        </div>
      )}
    >
      {children}
    </ErrorBoundary>
  );
}
