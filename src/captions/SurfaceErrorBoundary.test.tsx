import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SurfaceErrorBoundary } from './SurfaceErrorBoundary';

function Boom({ message }: { message: string }): JSX.Element {
  throw new Error(message);
}

describe('SurfaceErrorBoundary', () => {
  beforeEach(() => {
    // React logs the caught error itself; silencing keeps the run readable without hiding
    // the assertion below that the boundary logs its own annotated line.
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('renders children when nothing throws', () => {
    render(
      <SurfaceErrorBoundary surface="Control panel">
        <p>working</p>
      </SurfaceErrorBoundary>,
    );
    expect(screen.getByText('working')).toBeVisible();
  });

  it('shows the failure instead of unmounting to a blank window', () => {
    // The behaviour this exists for: a render error used to leave a black window, which is
    // indistinguishable from the dev server being down or the app failing to launch.
    render(
      <SurfaceErrorBoundary surface="Control panel">
        <Boom message="checklistHasItems is not defined" />
      </SurfaceErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeVisible();
    expect(screen.getByRole('heading', { name: /hit an error/i })).toBeVisible();
  });

  it('names which window failed', () => {
    // Five windows, all of which look alike when blank.
    render(
      <SurfaceErrorBoundary surface="Camera stage">
        <Boom message="nope" />
      </SurfaceErrorBoundary>,
    );
    expect(screen.getByText('CAMERA STAGE')).toBeVisible();
  });

  it('shows the error message verbatim', () => {
    // A generic apology would leave the operator with the same blank window and less
    // information than the console already has.
    render(
      <SurfaceErrorBoundary surface="Control panel">
        <Boom message="Cannot read properties of undefined (reading 'onStatus')" />
      </SurfaceErrorBoundary>,
    );
    expect(
      screen.getByText("Cannot read properties of undefined (reading 'onStatus')"),
    ).toBeVisible();
  });

  it('offers a reload, because one window failing is recoverable', () => {
    render(
      <SurfaceErrorBoundary surface="Control panel">
        <Boom message="nope" />
      </SurfaceErrorBoundary>,
    );
    expect(
      screen.getByRole('button', { name: 'Reload this window' }),
    ).toBeVisible();
    // Says the other windows are unaffected: a caption overlay failing must not read as
    // "the meeting is over".
    expect(screen.getByText(/unaffected in the other windows/)).toBeVisible();
  });

  it('logs the surface and the stack for the console', () => {
    render(
      <SurfaceErrorBoundary surface="Caption overlay · zh">
        <Boom message="nope" />
      </SurfaceErrorBoundary>,
    );
    expect(console.error).toHaveBeenCalledWith(
      '[Caption overlay · zh] render failed',
      expect.any(Error),
      expect.any(String),
    );
  });
});
