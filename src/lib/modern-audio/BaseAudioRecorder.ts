import { DEBUG_CONFIG, PERFORMANCE_CONFIG } from '../config/performance.js';

/* global chrome */

/**
 * Base class for audio recording with AudioWorklet and ScriptProcessor fallback
 * Provides shared functionality for all audio recorders (speaker and participant)
 */
export abstract class BaseAudioRecorder {
  protected sampleRate: number;
  protected stream: MediaStream | null = null;
  protected audioContext: AudioContext | null = null;
  protected mediaStreamSource: MediaStreamAudioSourceNode | null = null;
  protected analyserNode: AnalyserNode | null = null;
  protected audioWorkletNode: AudioWorkletNode | null = null;
  protected scriptProcessor: ScriptProcessorNode | null = null;
  protected dummyGain: GainNode | null = null;
  protected useAudioWorklet: boolean = false;
  protected recording: boolean = false;
  protected onAudioData: ((data: { mono: Int16Array; raw: Int16Array }) => void) | null = null;
  protected _audioChunkCount: number = 0;
  private transportResampleSourceRate = 0;
  private transportResampleTargetRate = 0;
  private transportResampleInputFrames = 0;
  private transportResampleOutputFrames = 0;
  private transportResampleLastSample = 0;
  private transportResampleHasLastSample = false;

  constructor(sampleRate: number = 24000) {
    this.sampleRate = sampleRate;
    // Pre-bind method to avoid runtime binding
    this._processAudioData = this._processAudioData.bind(this);
  }

  /**
   * Get the current sample rate
   */
  getSampleRate(): number {
    return this.sampleRate;
  }

  /**
   * Which transport actually carried the audio.
   *
   * Exposed because the fallback used to be invisible: `addModule` failure was
   * caught, written to console.warn, and the session continued. Nobody watching a
   * meeting reads the renderer console, so a degraded capture path looked
   * identical to a healthy one until the captions came out as nonsense. The
   * operator now gets told.
   */
  getCaptureTransport(): 'audio-worklet' | 'script-processor' {
    return this.useAudioWorklet ? 'audio-worklet' : 'script-processor';
  }

  /**
   * Get the current recording status
   */
  getStatus(): 'ended' | 'paused' | 'recording' {
    if (!this.stream) {
      return 'ended';
    } else if (!this.recording) {
      return 'paused';
    } else {
      return 'recording';
    }
  }

  /**
   * Check if currently recording
   */
  isRecording(): boolean {
    return this.recording;
  }

  /**
   * Immediately release the microphone device by stopping all live tracks.
   *
   * This is a synchronous best-effort teardown for page/window close: it frees
   * the OS capture endpoint right away instead of waiting for the (async)
   * end()/cleanup() path or for process teardown. On Windows, closing the app
   * without cleanly stopping the mic tracks can leave the WASAPI capture
   * endpoint stranded, so the next launch's getUserMedia fails with
   * "NotReadableError: Could not start audio source". Stopping the tracks here
   * makes the release deterministic. Full graph cleanup still happens in
   * cleanup(); this only guarantees the device itself is let go.
   */
  releaseStream(): void {
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }
  }

  /**
   * Get the URL for the AudioWorklet processor
   * Handles both extension and regular web/Electron environments
   */
  protected getAudioWorkletProcessorUrl(): string {
    // The worklet lives in this directory, beside its only consumer, and is
    // referenced relative to this file.
    //
    // It used to live in `src/services/worklets/`, three directories away from
    // anything that loaded it, reached by a URL string. An import crawler cannot
    // see a string, so a cleanup that removed the unreachable `src/services/`
    // tree took the worklet with it - and because `addModule` failure is caught
    // and degraded rather than raised, the only symptom was gibberish captions.
    // Colocating it means the file cannot be orphaned without also orphaning the
    // recorder, and `worklet-asset.test.ts` fails if this path stops resolving.
    //
    // The Chrome-extension branch that used to sit here is gone with the
    // extension: it was a second way for this URL to be wrong.
    return new URL('./worklets/audio-recorder-worklet-processor.js', import.meta.url)
      .href;
  }

  /**
   * Check if AudioWorklet is supported
   */
  protected isAudioWorkletSupported(): boolean {
    return typeof AudioWorkletNode !== 'undefined' &&
           this.audioContext !== null &&
           this.audioContext.audioWorklet !== undefined;
  }

  /**
   * Get the logger prefix for this recorder
   * Override in subclasses for specific logging
   */
  protected abstract getLogPrefix(): string;

  /**
   * Whether to connect audio to destination for playback
   * Override in subclasses (e.g., TabAudioRecorder needs this for tab capture)
   */
  protected shouldConnectToDestination(): boolean {
    return false;
  }

  /**
   * Setup real-time audio processing with AudioWorklet or ScriptProcessor fallback
   */
  protected async setupRealtimeAudioProcessing(): Promise<void> {
    if (!this.audioContext || !this.stream) {
      throw new Error('AudioContext and stream required for real-time processing');
    }

    // Create MediaStreamSource
    this.mediaStreamSource = this.audioContext.createMediaStreamSource(this.stream);

    // Side-branch analyser tap for waveform visualization.
    // AnalyserNode is pull-based — consumers read getByteTimeDomainData()
    // from a requestAnimationFrame loop. It does NOT need to connect to a
    // destination, and does NOT affect the existing downstream audio path.
    this.analyserNode = this.audioContext.createAnalyser();
    this.analyserNode.fftSize = 2048;
    this.mediaStreamSource.connect(this.analyserNode);

    // Check if AudioWorklet is supported
    this.useAudioWorklet = this.isAudioWorkletSupported();

    if (this.useAudioWorklet) {
      try {
        console.info(`${this.getLogPrefix()} Using AudioWorklet for audio processing`);

        // Load the AudioWorklet module
        const workletUrl = this.getAudioWorkletProcessorUrl();
        await this.audioContext.audioWorklet.addModule(workletUrl);

        // Create AudioWorkletNode
        this.audioWorkletNode = new AudioWorkletNode(this.audioContext, 'audio-recorder-processor');

        // Handle messages from the worklet
        this.audioWorkletNode.port.onmessage = (event) => {
          if (event.data.type === 'audioData') {
            const { pcmData } = event.data;

            // Log periodically to verify data flow
            if (DEBUG_CONFIG.ENABLE_AUDIO_CHUNK_LOGGING) {
              this._audioChunkCount = (this._audioChunkCount || 0) + 1;
              if (this._audioChunkCount % DEBUG_CONFIG.AUDIO_CHUNK_LOG_INTERVAL === 0) {
                console.debug(`${this.getLogPrefix()} AudioWorklet chunk ${this._audioChunkCount}, PCM length: ${pcmData.length}`);
              }
            }

            // Send audio data through callback
            this._processAudioData(pcmData);
          }
        };

        // Connect nodes
        this.mediaStreamSource.connect(this.audioWorkletNode);

        // Connect to destination if needed (e.g., for tab capture audio passthrough)
        if (this.shouldConnectToDestination()) {
          this.mediaStreamSource.connect(this.audioContext.destination);
        } else {
          // Create dummy gain node to keep worklet active
          this.dummyGain = this.audioContext.createGain();
          this.dummyGain.gain.value = 0; // Mute the output
          this.audioWorkletNode.connect(this.dummyGain);
          this.dummyGain.connect(this.audioContext.destination);
        }

      } catch (error) {
        console.warn(`${this.getLogPrefix()} Failed to setup AudioWorklet, falling back to ScriptProcessor:`, error);
        this.useAudioWorklet = false;
        await this.setupScriptProcessorFallback();
      }
    } else {
      console.info(`${this.getLogPrefix()} AudioWorklet not supported, using ScriptProcessor fallback`);
      await this.setupScriptProcessorFallback();
    }

    console.info(`${this.getLogPrefix()} Real-time audio processing setup complete`);
  }

  /**
   * Bring captured audio to the rate the transport actually claims.
   *
   * This is the fix for a bug that resurfaced repeatedly under different triggers.
   * The capture AudioContext runs at 48 kHz deliberately, while the session sent
   * to OpenAI declares 24 kHz PCM. The AudioWorklet path resampled; the
   * ScriptProcessor fallback below did not, and sent 48 kHz samples labelled as
   * 24 kHz. Decoded at half rate, speech comes out as confident nonsense - so the
   * symptom was never "capture is broken", it was "the transcription is
   * gibberish", which sent every previous investigation looking at the model, the
   * prompt and the API instead of at the microphone.
   *
   * Any future failure in the worklet path therefore degrades transport without
   * corrupting the audio. Frame positions are retained between callbacks: a
   * 44.1 kHz context does not divide evenly into the typical callback size, so
   * restarting the conversion on each callback would gradually skew or drop the
   * transport timeline.
   */
  protected resampleForTransport(input: Int16Array): Int16Array {
    const sourceRate = this.audioContext?.sampleRate ?? 0;
    const targetRate = this.sampleRate;
    if (!sourceRate || !targetRate) {
      throw new Error('Cannot resample PCM without source and transport sample rates');
    }
    if (sourceRate === targetRate) {
      this.resetTransportResampler();
      return input;
    }

    if (
      this.transportResampleSourceRate !== sourceRate ||
      this.transportResampleTargetRate !== targetRate
    ) {
      this.resetTransportResampler();
      this.transportResampleSourceRate = sourceRate;
      this.transportResampleTargetRate = targetRate;
    }

    const inputStart = this.transportResampleInputFrames;
    const inputEnd = inputStart + input.length;
    const ratio = sourceRate / targetRate;
    const output: number[] = [];
    const sourcePositionForOutput = (outputFrame: number) =>
      sourceRate > targetRate
        // Sampling at the centre preserves the previous 48 kHz → 24 kHz pair
        // averaging behaviour while still allowing fractional rates.
        ? (outputFrame + 0.5) * ratio - 0.5
        : outputFrame * ratio;
    const sampleAt = (frame: number) => {
      if (frame === inputStart - 1 && this.transportResampleHasLastSample) {
        return this.transportResampleLastSample;
      }
      return input[frame - inputStart];
    };

    while (true) {
      const sourcePosition = sourcePositionForOutput(this.transportResampleOutputFrames);
      const leftFrame = Math.floor(sourcePosition);
      const rightFrame = Math.ceil(sourcePosition);
      // Interpolation needs the right endpoint. Hold this output for the next
      // callback when that endpoint falls on the callback boundary.
      if (rightFrame >= inputEnd) break;
      const left = sampleAt(leftFrame);
      const right = sampleAt(rightFrame);
      if (left === undefined || right === undefined) break;
      output.push(Math.round(left + (right - left) * (sourcePosition - leftFrame)));
      this.transportResampleOutputFrames += 1;
    }

    this.transportResampleInputFrames = inputEnd;
    if (input.length) {
      this.transportResampleLastSample = input[input.length - 1];
      this.transportResampleHasLastSample = true;
    }
    return Int16Array.from(output);
  }

  /** Flush the final interpolated samples before a fallback recorder stops. */
  protected flushTransportResampler(): Int16Array {
    if (!this.transportResampleHasLastSample) return new Int16Array(0);
    const ratio = this.transportResampleSourceRate / this.transportResampleTargetRate;
    const output: number[] = [];
    const sourcePositionForOutput = (outputFrame: number) =>
      this.transportResampleSourceRate > this.transportResampleTargetRate
        ? (outputFrame + 0.5) * ratio - 0.5
        : outputFrame * ratio;

    while (true) {
      const sourcePosition = sourcePositionForOutput(this.transportResampleOutputFrames);
      if (sourcePosition >= this.transportResampleInputFrames) break;
      const leftFrame = Math.floor(sourcePosition);
      if (leftFrame !== this.transportResampleInputFrames - 1) break;
      output.push(this.transportResampleLastSample);
      this.transportResampleOutputFrames += 1;
    }
    this.resetTransportResampler();
    return Int16Array.from(output);
  }

  protected flushTransportResamplerToCallback(): void {
    const tail = this.flushTransportResampler();
    if (tail.length) this._processAudioData(tail);
  }

  protected resetTransportResampler(): void {
    this.transportResampleSourceRate = 0;
    this.transportResampleTargetRate = 0;
    this.transportResampleInputFrames = 0;
    this.transportResampleOutputFrames = 0;
    this.transportResampleLastSample = 0;
    this.transportResampleHasLastSample = false;
  }

  /**
   * Setup ScriptProcessor as fallback for browsers without AudioWorklet support
   */
  protected async setupScriptProcessorFallback(): Promise<void> {
    if (!this.audioContext || !this.mediaStreamSource) {
      throw new Error('AudioContext and source required for ScriptProcessor');
    }

    // A new graph is a new transport timeline. Deliver any held final sample
    // first, then reset the fractional phase for the replacement context.
    this.flushTransportResamplerToCallback();
    this.resetTransportResampler();

    const bufferSize = PERFORMANCE_CONFIG.SCRIPT_PROCESSOR_BUFFER_SIZE;
    this.scriptProcessor = this.audioContext.createScriptProcessor(bufferSize, 1, 1);

    this.scriptProcessor.onaudioprocess = (event) => {
      const inputBuffer = event.inputBuffer;
      const inputData = inputBuffer.getChannelData(0);

      // Convert to PCM16
      const pcmData = new Int16Array(inputData.length);
      const len = inputData.length;

      const chunkSize = PERFORMANCE_CONFIG.PCM_CONVERSION_CHUNK_SIZE;
      for (let i = 0; i < len; i += chunkSize) {
        const end = Math.min(i + chunkSize, len);
        for (let j = i; j < end; j++) {
          const sample = inputData[j];
          pcmData[j] = sample >= 0
            ? Math.min(32767, sample * 32767)
            : Math.max(-32768, sample * 32768);
        }
      }

      // Log periodically
      if (DEBUG_CONFIG.ENABLE_AUDIO_CHUNK_LOGGING) {
        this._audioChunkCount = (this._audioChunkCount || 0) + 1;
        if (this._audioChunkCount % DEBUG_CONFIG.AUDIO_CHUNK_LOG_INTERVAL === 0) {
          console.debug(`${this.getLogPrefix()} ScriptProcessor chunk ${this._audioChunkCount}, PCM length: ${pcmData.length}`);
        }
      }

      // Resampled to the transport's declared rate. Without this the fallback
      // sends 48 kHz audio into a 24 kHz session - see resampleForTransport.
      this._processAudioData(this.resampleForTransport(pcmData));
    };

    // Connect the nodes
    this.mediaStreamSource.connect(this.scriptProcessor);

    // Connect to destination if needed
    if (this.shouldConnectToDestination()) {
      this.mediaStreamSource.connect(this.audioContext.destination);
      // ScriptProcessor needs to be connected to destination to work
      this.scriptProcessor.connect(this.audioContext.destination);
    } else {
      // Create a dummy gain node with zero volume
      this.dummyGain = this.audioContext.createGain();
      this.dummyGain.gain.value = 0;
      this.scriptProcessor.connect(this.dummyGain);
      this.dummyGain.connect(this.audioContext.destination);
    }
  }

  /**
   * Process audio data through callback
   */
  protected _processAudioData(pcmData: Int16Array): void {
    if (this.onAudioData && typeof this.onAudioData === 'function' && pcmData.length > 0 && this.recording) {
      try {
        this.onAudioData({
          mono: pcmData,
          raw: pcmData,
        });
      } catch (error) {
        console.error(`${this.getLogPrefix()} Error in onAudioData callback:`, error);
      }
    }
  }

  /**
   * Start the recording (send start command to worklet and set flag)
   */
  protected startRecording(): void {
    this.resetTransportResampler();
    this.recording = true;
    console.info(`${this.getLogPrefix()} Recording started`);

    // Send start command to worklet
    if (this.audioWorkletNode) {
      this.audioWorkletNode.port.postMessage({ type: 'start' });
    }
  }

  /**
   * Stop the recording (send stop command to worklet and set flag)
   */
  protected stopRecording(): void {
    console.info(`${this.getLogPrefix()} Pausing recording`);

    // Send stop command to worklet
    if (this.audioWorkletNode) {
      this.audioWorkletNode.port.postMessage({ type: 'stop' });
    }

    this.flushTransportResamplerToCallback();
    this.resetTransportResampler();
    this.recording = false;
  }

  /**
   * Clean up all audio resources
   */
  protected async cleanup(): Promise<void> {
    if (this.recording) this.flushTransportResamplerToCallback();
    this.resetTransportResampler();
    // Stop all tracks
    if (this.stream) {
      const tracks = this.stream.getTracks();
      tracks.forEach((track) => track.stop());
      this.stream = null;
    }

    // Clean up audio processing nodes
    if (this.audioWorkletNode) {
      this.audioWorkletNode.disconnect();
      this.audioWorkletNode.port.close();
      this.audioWorkletNode = null;
    }

    if (this.scriptProcessor) {
      this.scriptProcessor.disconnect();
      this.scriptProcessor = null;
    }

    if (this.dummyGain) {
      this.dummyGain.disconnect();
      this.dummyGain = null;
    }

    if (this.analyserNode) {
      this.analyserNode.disconnect();
      this.analyserNode = null;
    }

    if (this.mediaStreamSource) {
      this.mediaStreamSource.disconnect();
      this.mediaStreamSource = null;
    }

    // Clean up AudioContext
    if (this.audioContext && this.audioContext.state !== 'closed') {
      await this.audioContext.close();
      this.audioContext = null;
    }

    this.recording = false;
    this.onAudioData = null;

    console.info(`${this.getLogPrefix()} Audio capture ended`);
  }
}
