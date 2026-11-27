import type { ActivationMode } from "../config";
import type { ToolResult } from "../tools/types";

/**
 * Voice state machine. It owns no I/O: the microphone backend, the Gemini
 * session and the speaker are injected, so the behaviour can be tested with
 * fakes.
 *
 * States:
 * - `off`: microphone released (muted by the user or not started).
 * - `idle`: microphone open, nothing leaves the machine. In wake-word mode
 *   the local detector is listening for "Hey JARVIS".
 * - `connecting`: opening the Gemini session. Microphone audio is buffered
 *   so words spoken right after the wake word are not lost.
 * - `listening`: session open, microphone audio is streamed.
 * - `speaking`: JARVIS is talking. Microphone audio is not sent, so the
 *   model does not hear itself through the speakers.
 */
export type VoiceState = "off" | "idle" | "connecting" | "listening" | "speaking";

export interface VoiceSnapshot {
  state: VoiceState;
  mode: ActivationMode;
  error: string | null;
}

export interface AudioBackend {
  startAudio(): Promise<unknown>;
  stopAudio(): Promise<void>;
  startStream(onAudio: (pcm: ArrayBuffer) => void): Promise<void>;
  stopStream(): Promise<void>;
  configureWakeWord(enabled: boolean, threshold: number): Promise<void>;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResponse {
  id: string;
  name: string;
  response: Record<string, unknown>;
}

export interface SessionHandlers {
  onAudio(base64Pcm: string): void;
  onTurnComplete(): void;
  onInterrupted(): void;
  onToolCalls(calls: ToolCall[]): void;
  onClose(reason: string): void;
}

export interface LiveSession {
  sendAudio(pcm: ArrayBuffer): void;
  /** Tells the server the microphone stopped (push-to-talk release). */
  endAudioStream(): void;
  sendToolResponses(responses: ToolResponse[]): void;
  close(): void;
}

export type SessionFactory = (handlers: SessionHandlers) => Promise<LiveSession>;

export interface Speaker {
  enqueue(base64Pcm: string): void;
  /** Stops playback immediately. */
  clear(): void;
}

export interface VoiceControllerOptions {
  audio: AudioBackend;
  connect: SessionFactory;
  speaker: Speaker;
  executeTool(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  mode: ActivationMode;
  wakeWordThreshold: number;
  inactivityTimeoutMs: number;
  onChange(snapshot: VoiceSnapshot): void;
}

/** Microphone RMS above this counts as the user speaking (resets the silence timer). */
export const SPEECH_LEVEL = 0.02;
/** Audio kept while the session connects (~5 s of 32 ms blocks). */
const MAX_BUFFERED_BLOCKS = 160;
const ALWAYS_ON_RETRY_MS = 5_000;
/**
 * Longest the session waits for a tool. A tool may be waiting for the user to
 * answer a dialog, and the microphone must not stay open until they do. It is
 * longer than the slowest network timeout a tool uses.
 */
export const TOOL_WAIT_LIMIT_MS = 100_000;

export class VoiceController {
  #options: VoiceControllerOptions;
  #state: VoiceState = "off";
  #error: string | null = null;
  #session: LiveSession | null = null;
  /** Incremented on every open/close so late callbacks from old sessions are ignored. */
  #generation = 0;
  #buffer: ArrayBuffer[] = [];
  #streaming = false;
  #talkKeyHeld = false;
  #silenceTimer: ReturnType<typeof setTimeout> | null = null;
  #retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: VoiceControllerOptions) {
    this.#options = options;
  }

  get snapshot(): VoiceSnapshot {
    return { state: this.#state, mode: this.#options.mode, error: this.#error };
  }

  /** Opens the microphone. Throws if it cannot be opened (for example, no permission). */
  async start(): Promise<void> {
    if (this.#state !== "off") return;
    try {
      await this.#options.audio.startAudio();
    } catch (error) {
      this.#fail(error);
      throw error;
    }
    await this.#applyWakeWordSetting();
    this.#setState("idle");
    if (this.#options.mode === "always_on") await this.#openSession();
  }

  /** Releases the microphone and closes any session (mute). */
  async stop(): Promise<void> {
    this.#clearRetry();
    await this.#closeSession();
    await this.#options.audio.stopAudio();
    this.#setState("off");
  }

  async setMode(mode: ActivationMode): Promise<void> {
    if (mode === this.#options.mode) return;
    this.#options.mode = mode;
    if (this.#state === "off") return this.#emit();
    await this.#closeSession();
    await this.#applyWakeWordSetting();
    this.#setState("idle");
    if (mode === "always_on") await this.#openSession();
  }

  async setWakeWordThreshold(threshold: number): Promise<void> {
    this.#options.wakeWordThreshold = threshold;
    if (this.#state !== "off") await this.#applyWakeWordSetting();
  }

  /** The local detector heard "Hey JARVIS". */
  async wakeWordDetected(): Promise<void> {
    if (this.#state === "idle" && this.#options.mode === "wake_word") {
      await this.#openSession();
    }
  }

  async shortcutPressed(): Promise<void> {
    if (this.#state === "off") return;
    if (this.#options.mode === "push_to_talk") {
      this.#talkKeyHeld = true;
      this.#clearSilenceTimer();
      this.#options.speaker.clear();
      if (this.#session) {
        await this.#startStreaming();
        this.#setState("listening");
      } else {
        await this.#openSession();
      }
      return;
    }
    // Wake-word and always-on modes: the shortcut toggles the conversation.
    if (this.#state === "idle") {
      await this.#openSession();
    } else if (this.#options.mode === "wake_word") {
      await this.#closeSession();
      this.#setState("idle");
    }
  }

  async shortcutReleased(): Promise<void> {
    if (this.#options.mode !== "push_to_talk" || !this.#talkKeyHeld) return;
    this.#talkKeyHeld = false;
    await this.#stopStreaming();
    this.#session?.endAudioStream();
    this.#armSilenceTimer();
  }

  /** Microphone level from the backend (every 50 ms). */
  inputLevel(rms: number): void {
    if (this.#state === "listening" && rms >= SPEECH_LEVEL) this.#armSilenceTimer();
  }

  /** The speaker finished everything that was queued. */
  playbackFinished(): void {
    if (this.#state !== "speaking") return;
    this.#setState("listening");
    this.#armSilenceTimer();
  }

  async #openSession(): Promise<void> {
    this.#clearRetry();
    const generation = ++this.#generation;
    this.#error = null;
    this.#buffer = [];
    this.#setState("connecting");
    await this.#startStreaming();

    let session: LiveSession;
    try {
      session = await this.#options.connect(this.#handlers(generation));
    } catch (error) {
      if (generation !== this.#generation) return;
      await this.#stopStreaming();
      this.#error = describe(error);
      this.#setState("idle");
      this.#scheduleRetry();
      return;
    }
    if (generation !== this.#generation) {
      // Closed or muted while connecting.
      session.close();
      return;
    }
    this.#session = session;
    for (const block of this.#buffer) session.sendAudio(block);
    this.#buffer = [];
    // Push-to-talk key released before the session was ready.
    if (this.#options.mode === "push_to_talk" && !this.#talkKeyHeld) session.endAudioStream();
    this.#setState("listening");
    this.#armSilenceTimer();
  }

  async #closeSession(): Promise<void> {
    this.#generation++;
    this.#clearSilenceTimer();
    this.#talkKeyHeld = false;
    this.#buffer = [];
    await this.#stopStreaming();
    this.#options.speaker.clear();
    const session = this.#session;
    this.#session = null;
    session?.close();
  }

  #handlers(generation: number): SessionHandlers {
    const current = () => generation === this.#generation;
    return {
      onAudio: (pcm) => {
        if (!current()) return;
        this.#clearSilenceTimer();
        this.#options.speaker.enqueue(pcm);
        this.#setState("speaking");
      },
      onTurnComplete: () => {
        if (current() && this.#state === "listening") this.#armSilenceTimer();
      },
      onInterrupted: () => {
        if (!current()) return;
        this.#options.speaker.clear();
        this.playbackFinished();
      },
      onToolCalls: (calls) => {
        if (current()) void this.#runTools(calls, generation);
      },
      onClose: (reason) => {
        if (!current()) return;
        this.#session = null;
        void this.#closeSession().then(() => {
          if (this.#state === "off") return;
          // A normal close (code 1000) is not an error; anything else is shown.
          if (reason) this.#error = reason;
          this.#setState("idle");
          this.#scheduleRetry();
        });
      },
    };
  }

  async #runTools(calls: ToolCall[], generation: number): Promise<void> {
    this.#clearSilenceTimer();
    const limit = setTimeout(() => {
      if (generation !== this.#generation || this.#options.mode === "always_on") return;
      void this.#closeSession().then(() => this.#setState("idle"));
    }, TOOL_WAIT_LIMIT_MS);
    const responses = await Promise.all(
      calls.map(async ({ id, name, args }) => {
        const result = await this.#options.executeTool(name, args);
        const response = result.ok
          ? { output: result.output }
          : { error: result.error, code: result.code };
        return { id, name, response };
      }),
    ).finally(() => clearTimeout(limit));
    if (generation !== this.#generation || !this.#session) return;
    this.#session.sendToolResponses(responses);
    if (this.#state === "listening") this.#armSilenceTimer();
  }

  async #startStreaming(): Promise<void> {
    if (this.#streaming) return;
    this.#streaming = true;
    await this.#options.audio.startStream((pcm) => this.#onMicrophone(pcm));
  }

  async #stopStreaming(): Promise<void> {
    if (!this.#streaming) return;
    this.#streaming = false;
    await this.#options.audio.stopStream();
  }

  #onMicrophone(pcm: ArrayBuffer): void {
    if (this.#state === "connecting") {
      this.#buffer.push(pcm);
      if (this.#buffer.length > MAX_BUFFERED_BLOCKS) this.#buffer.shift();
    } else if (this.#state === "listening") {
      this.#session?.sendAudio(pcm);
    }
    // While speaking, microphone audio is dropped to avoid echo.
  }

  #armSilenceTimer(): void {
    this.#clearSilenceTimer();
    if (this.#options.mode === "always_on" || this.#talkKeyHeld) return;
    this.#silenceTimer = setTimeout(() => {
      this.#silenceTimer = null;
      if (this.#state !== "listening") return;
      void this.#closeSession().then(() => this.#setState("idle"));
    }, this.#options.inactivityTimeoutMs);
  }

  #clearSilenceTimer(): void {
    if (this.#silenceTimer !== null) clearTimeout(this.#silenceTimer);
    this.#silenceTimer = null;
  }

  #scheduleRetry(): void {
    if (this.#options.mode !== "always_on" || this.#state === "off") return;
    this.#clearRetry();
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      if (this.#state === "idle" && this.#options.mode === "always_on") void this.#openSession();
    }, ALWAYS_ON_RETRY_MS);
  }

  #clearRetry(): void {
    if (this.#retryTimer !== null) clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
  }

  async #applyWakeWordSetting(): Promise<void> {
    await this.#options.audio.configureWakeWord(
      this.#options.mode === "wake_word",
      this.#options.wakeWordThreshold,
    );
  }

  #fail(error: unknown): void {
    this.#error = describe(error);
    this.#emit();
  }

  #setState(state: VoiceState): void {
    if (state === this.#state) return;
    this.#state = state;
    this.#emit();
  }

  #emit(): void {
    this.#options.onChange(this.snapshot);
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return JSON.stringify(error);
}
