const {
  DEFAULT_FRAME_RATE,
  DEFAULT_HEIGHT,
  DEFAULT_WIDTH,
  computeGeometry,
} = require('./camera-frame-transport');

class CameraStageFramePublisher {
  constructor({
    regionPublisher,
    width = DEFAULT_WIDTH,
    height = DEFAULT_HEIGHT,
    frameRate = DEFAULT_FRAME_RATE,
    now = () => process.hrtime.bigint(),
    onError = () => {},
  }) {
    if (!regionPublisher) throw new Error('regionPublisher is required');
    this.regionPublisher = regionPublisher;
    this.width = width;
    this.height = height;
    this.frameRate = frameRate;
    this.now = now;
    this.onError = onError;
    this.geometry = computeGeometry({ width, height });
    this.window = null;
    this.paintHandler = null;
  }

  async start(window) {
    if (!window?.webContents) throw new Error('offscreen camera window is required');
    if (this.window === window) return;
    if (this.window) await this.stop();

    await this.regionPublisher.start();
    this.window = window;
    const contents = window.webContents;
    this.paintHandler = (_event, _dirtyRect, image) => {
      if (!image || image.isEmpty?.()) return;
      let frame = image;
      const size = frame.getSize?.() || {};
      if (size.width !== this.width || size.height !== this.height) {
        frame = frame.resize({
          width: this.width,
          height: this.height,
          quality: 'good',
        });
      }
      if (!frame || frame.isEmpty?.()) return;
      const bitmap = frame.toBitmap();
      if (!bitmap || bitmap.length !== this.geometry.payloadBytes) {
        this.onError(
          new Error(
            `Offscreen camera frame has ${bitmap?.length || 0} bytes; ` +
              `expected ${this.geometry.payloadBytes}`,
          ),
        );
        return;
      }
      void this.regionPublisher.publish(bitmap, this.now()).catch(this.onError);
    };
    contents.setFrameRate?.(this.frameRate);
    contents.on('paint', this.paintHandler);
    contents.startPainting?.();
  }

  async stop() {
    const window = this.window;
    this.window = null;
    if (window?.webContents && this.paintHandler) {
      window.webContents.removeListener('paint', this.paintHandler);
      window.webContents.stopPainting?.();
    }
    this.paintHandler = null;
    await this.regionPublisher.stop();
  }

  metrics() {
    return this.regionPublisher.metrics?.() || {
      publishedFrames: 0,
      droppedFrames: 0,
    };
  }
}

module.exports = { CameraStageFramePublisher };

