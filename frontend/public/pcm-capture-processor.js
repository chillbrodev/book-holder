/**
 * Turns mic audio into the exact bytes Amazon Transcribe streaming wants:
 * 16 kHz, mono, 16-bit signed little-endian PCM.
 *
 * Why an AudioWorklet and not MediaRecorder — the obvious tool for "record the
 * mic" — is in docs/capture-plan.md §3. Short version: Transcribe streaming
 * accepts pcm, flac and ogg-opus, and MediaRecorder portably produces none of
 * them. Chrome gives WebM/Opus, Safari gives MP4/AAC, and WebM chunks aren't
 * independently decodable, so they can't be re-framed into a stream without
 * demuxing them first. MediaRecorder still earns a place in this app, but for
 * the S3 session recording rather than the wire.
 *
 * Lives in public/ rather than src/ because addModule() loads a processor by URL
 * at runtime — it is a separate script in its own global scope, not a module the
 * bundler can inline into the app.
 *
 * Runs on the audio render thread, so everything here is allocation-light and
 * branch-light on purpose: overrunning the render quantum drops audio, and
 * dropped audio reads downstream as her having not said a word.
 */

/** Full-scale for 16-bit signed samples. 32767, not 32768, so that +1.0 and
 * -1.0 both stay in range instead of wrapping to a loud click at the negative
 * extreme. */
const INT16_MAX = 32767;

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { targetSampleRate, chunkMilliseconds } = options.processorOptions;

    // `sampleRate` is a global in the worklet scope: the AudioContext's real
    // rate. The hook asks for a 16 kHz context so this is usually 1 and the
    // resampling below is a no-op — but a browser is free to ignore that request
    // and hand back 48 kHz, in which case this has to do the work rather than
    // silently ship audio at the wrong rate. Transcribe would accept it (it is
    // told 16 kHz) and transcribe pitched-up nonsense.
    this.ratio = sampleRate / targetSampleRate;

    this.chunkSamples = Math.round((targetSampleRate * chunkMilliseconds) / 1000);
    this.chunk = new Int16Array(this.chunkSamples);
    this.chunkLength = 0;

    // Box-filter resampler state, carried across render quanta because the ratio
    // is not generally an integer and a quantum is only 128 frames — resetting
    // per call would drift.
    this.sum = 0;
    this.count = 0;
    this.carry = 0;
  }

  #emitSample(value) {
    const clamped = Math.max(-1, Math.min(1, value));
    this.chunk[this.chunkLength++] = clamped * INT16_MAX;

    if (this.chunkLength === this.chunkSamples) {
      // Transferred, not copied: the buffer leaves this thread entirely, so a
      // fresh one is allocated for the next chunk. Copying would keep a hot
      // allocation off the render thread but doubles the work per chunk.
      const full = this.chunk;
      this.chunk = new Int16Array(this.chunkSamples);
      this.chunkLength = 0;
      this.port.postMessage(full.buffer, [full.buffer]);
    }
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    // No input yet (the graph is still connecting) is normal, not an error —
    // returning true keeps the processor alive to try again next quantum.
    if (!channel) return true;

    for (let i = 0; i < channel.length; i++) {
      this.sum += channel[i];
      this.count++;
      this.carry++;

      // Averaging the input samples that fall into each output sample, rather
      // than picking one and discarding the rest. Plain decimation aliases
      // high-frequency content down into the speech band as a metallic buzz,
      // which is exactly the kind of artefact that degrades a transcript while
      // still sounding "fine" to someone checking the recording.
      if (this.carry >= this.ratio) {
        this.#emitSample(this.sum / this.count);
        this.sum = 0;
        this.count = 0;
        this.carry -= this.ratio;
      }
    }

    return true;
  }
}

registerProcessor('pcm-capture-processor', PcmCaptureProcessor);
