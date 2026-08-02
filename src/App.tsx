import { CaptionSurface } from './captions/CaptionSurface';
import { CameraStage } from './captions/CameraStage';
import { ControlApp } from './captions/ControlApp';
import type { Audience } from './captions/types';
import './captions/captions.css';

function App() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('surface') === 'caption') {
    const audience: Audience = params.get('audience') === 'zh' ? 'zh' : 'en';
    return <CaptionSurface audience={audience} />;
  }
  if (params.get('surface') === 'camera-stage') {
    return <CameraStage />;
  }
  return <ControlApp />;
}

export default App;
