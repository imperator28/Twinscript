function pcmRms(samples) {
  if (!samples?.length) return 0;
  let sum = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const normalized = samples[index] / 32768;
    sum += normalized * normalized;
  }
  return Math.sqrt(sum / samples.length);
}

class VadGate {
  constructor({
    enabled = true,
    threshold = 0.012,
    preRollMs = 300,
    postRollMs = 650,
    maxBufferedMs = 1200,
  } = {}) {
    this.enabled = enabled;
    this.threshold = threshold;
    this.preRollMs = preRollMs;
    this.postRollMs = postRollMs;
    this.maxBufferedMs = maxBufferedMs;
    this.preRoll = [];
    this.preRollDuration = 0;
    this.speaking = false;
    this.silenceMs = 0;
  }

  push(samples, durationMs) {
    if (!this.enabled) return { chunks: [samples], speaking: true, rms: pcmRms(samples) };

    const rms = pcmRms(samples);
    const speech = rms >= this.threshold;

    if (!this.speaking) {
      this.preRoll.push(samples);
      this.preRollDuration += durationMs;
      while (
        this.preRoll.length > 1 &&
        this.preRollDuration > Math.min(this.preRollMs, this.maxBufferedMs)
      ) {
        const removed = this.preRoll.shift();
        this.preRollDuration -= (removed.length / 24000) * 1000;
      }
      if (!speech) return { chunks: [], speaking: false, rms };

      this.speaking = true;
      this.silenceMs = 0;
      const chunks = this.preRoll;
      this.preRoll = [];
      this.preRollDuration = 0;
      return { chunks, speaking: true, started: true, rms };
    }

    if (speech) {
      this.silenceMs = 0;
      return { chunks: [samples], speaking: true, rms };
    }

    this.silenceMs += durationMs;
    if (this.silenceMs <= this.postRollMs) {
      return { chunks: [samples], speaking: true, rms };
    }

    this.speaking = false;
    this.silenceMs = 0;
    this.preRoll = [samples];
    this.preRollDuration = durationMs;
    return { chunks: [], speaking: false, ended: true, rms };
  }

  reset() {
    this.preRoll = [];
    this.preRollDuration = 0;
    this.speaking = false;
    this.silenceMs = 0;
  }
}

module.exports = { VadGate, pcmRms };
