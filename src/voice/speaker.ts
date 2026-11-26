import type { Speaker } from "./controller";
import { base64ToBytes, pcm16ToFloat32 } from "./pcm";

/** Gemini Live returns 24 kHz mono PCM16. */
const OUTPUT_SAMPLE_RATE = 24_000;
/** Small lead time so consecutive chunks join without gaps. */
const SCHEDULE_AHEAD_S = 0.03;

/**
 * Plays streamed PCM chunks back to back with Web Audio and reports when the
 * queue drains. Also exposes the output level for the orb animation.
 */
export class PcmSpeaker implements Speaker {
  #context: AudioContext | null = null;
  #analyser: AnalyserNode | null = null;
  #sources = new Set<AudioBufferSourceNode>();
  #nextStart = 0;
  #levelBuffer: Float32Array<ArrayBuffer> = new Float32Array(1024);
  #onIdle: () => void;

  constructor(onIdle: () => void) {
    this.#onIdle = onIdle;
  }

  enqueue(base64Pcm: string): void {
    const samples = pcm16ToFloat32(base64ToBytes(base64Pcm));
    if (samples.length === 0) return;
    const context = this.#ensureContext();
    const buffer = context.createBuffer(1, samples.length, OUTPUT_SAMPLE_RATE);
    buffer.copyToChannel(samples, 0);

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.#analyser ?? context.destination);
    const start = Math.max(context.currentTime + SCHEDULE_AHEAD_S, this.#nextStart);
    source.start(start);
    this.#nextStart = start + buffer.duration;
    this.#sources.add(source);
    source.onended = () => {
      this.#sources.delete(source);
      if (this.#sources.size === 0) this.#onIdle();
    };
  }

  clear(): void {
    for (const source of this.#sources) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // Already stopped.
      }
    }
    this.#sources.clear();
    this.#nextStart = 0;
  }

  /** Current output RMS, `0..1`. */
  level(): number {
    if (!this.#analyser || this.#sources.size === 0) return 0;
    this.#analyser.getFloatTimeDomainData(this.#levelBuffer);
    let sum = 0;
    for (const value of this.#levelBuffer) sum += value * value;
    return Math.sqrt(sum / this.#levelBuffer.length);
  }

  #ensureContext(): AudioContext {
    if (!this.#context) {
      this.#context = new AudioContext({ sampleRate: OUTPUT_SAMPLE_RATE });
      this.#analyser = this.#context.createAnalyser();
      this.#analyser.fftSize = this.#levelBuffer.length;
      this.#analyser.connect(this.#context.destination);
    }
    // WebKit may create the context suspended until the page has had user interaction.
    if (this.#context.state === "suspended") void this.#context.resume();
    return this.#context;
  }
}
