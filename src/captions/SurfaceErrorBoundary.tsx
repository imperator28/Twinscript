import { Component, type ErrorInfo, type ReactNode } from 'react';

// A render error used to produce a black window and nothing else.
//
// React unmounts the whole tree when a render throws and nothing catches it, so every
// mistake in the control panel - a variable referenced before its declaration, a bad
// property read during an early render - looked identical to the dev server being down,
// to the app failing to launch, and to the camera stage rendering a blank frame. There
// was no way to tell those apart from the window.
//
// This is deliberately NOT mounted around the audience surfaces' content in a way that
// could paint over the camera feed: it renders only when the tree below it has already
// failed, at which point that surface is showing nothing anyway.

interface Props {
  /** Named so the message can say which window failed - three of them look alike. */
  surface: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class SurfaceErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Kept on the console as well as on screen: the stack is what makes the message
    // actionable, and it is too long to put in the window.
    console.error(`[${this.props.surface}] render failed`, error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <main className="surface-error" role="alert">
        <div>
          <p className="eyebrow">{this.props.surface.toUpperCase()}</p>
          <h1>This window hit an error</h1>
          <p className="supporting-copy">
            Captions and any running session are unaffected in the other windows. Reloading
            this one is safe.
          </p>
          {/* The message, verbatim. A generic apology would leave the operator with the
              same black window and less information than the console already has. */}
          <pre>{error.message || String(error)}</pre>
          <div className="button-row">
            <button
              className="button button--primary"
              onClick={() => window.location.reload()}
            >
              Reload this window
            </button>
          </div>
        </div>
      </main>
    );
  }
}
