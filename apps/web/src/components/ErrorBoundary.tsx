import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * If a screen crashes, show a calm page with a way back instead of a blank white one.
 * Nothing a person typed is lost on the server: saves only happen when a button is pressed.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Screen crashed', error, info.componentStack);
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert" className="grid min-h-screen place-items-center bg-ground px-6">
        <div className="w-full max-w-[380px] border border-line border-l-[5px] border-l-red bg-surface p-5">
          <h1 className="display text-2xl leading-tight text-navy">Something went wrong</h1>
          <p className="mt-1.5 text-ink-2">This screen hit a problem. Anything already saved is safe. Reload to carry on.</p>
          <div className="mt-4 grid grid-cols-2 gap-3">
            <a href="/" className="btn no-underline">
              Go home
            </a>
            <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
              Reload
            </button>
          </div>
        </div>
      </div>
    );
  }
}
