import { CaptionSurface } from './captions/CaptionSurface';
import { CameraStage } from './captions/CameraStage';
import { ControlApp } from './captions/ControlApp';
import { SurfaceErrorBoundary } from './captions/SurfaceErrorBoundary';
import type { Audience } from './captions/types';
import './captions/captions.css';

// Each surface is wrapped separately, and named.
//
// A render error used to unmount the tree and leave a black window, which is exactly what
// the dev server being down looks like, and what a failed launch looks like. Three
// different faults with one appearance and no way to tell them apart. The boundary makes a
// render error say so, and say which of the five windows it was.
function App() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('surface') === 'caption') {
    const audience: Audience = params.get('audience') === 'zh' ? 'zh' : 'en';
    return (
      <SurfaceErrorBoundary surface={`Caption overlay · ${audience}`}>
        <CaptionSurface audience={audience} />
      </SurfaceErrorBoundary>
    );
  }
  if (params.get('surface') === 'camera-stage') {
    return (
      <SurfaceErrorBoundary surface="Camera stage">
        <CameraStage />
      </SurfaceErrorBoundary>
    );
  }
  return (
    <SurfaceErrorBoundary surface="Control panel">
      <ControlApp />
    </SurfaceErrorBoundary>
  );
}

export default App;
