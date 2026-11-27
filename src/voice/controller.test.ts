import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivationMode } from "../config";
import { ok } from "../tools/types";
import {
  type LiveSession,
  type SessionHandlers,
  SPEECH_LEVEL,
  TOOL_WAIT_LIMIT_MS,
  VoiceController,
  type VoiceState,
} from "./controller";

class FakeSession implements LiveSession {
  sent: ArrayBuffer[] = [];
  ended = 0;
  closed = false;
  toolResponses: unknown[] = [];
  constructor(readonly handlers: SessionHandlers) {}
  sendAudio(pcm: ArrayBuffer) {
    this.sent.push(pcm);
  }
  endAudioStream() {
    this.ended++;
  }
  sendToolResponses(responses: unknown[]) {
    this.toolResponses.push(...responses);
  }
  close() {
    this.closed = true;
  }
}

function setup(mode: ActivationMode = "wake_word") {
  let microphone: ((pcm: ArrayBuffer) => void) | null = null;
  const sessions: FakeSession[] = [];
  let resolveConnect: (() => void) | null = null;
  let deferConnect = false;
  let failConnect: string | null = null;
  const states: VoiceState[] = [];

  const audio = {
    startAudio: vi.fn().mockResolvedValue({}),
    stopAudio: vi.fn().mockResolvedValue(undefined),
    startStream: vi.fn(async (onAudio: (pcm: ArrayBuffer) => void) => {
      microphone = onAudio;
    }),
    stopStream: vi.fn(async () => {
      microphone = null;
    }),
    configureWakeWord: vi.fn().mockResolvedValue(undefined),
  };
  const speaker = { enqueue: vi.fn(), clear: vi.fn() };
  const executeTool = vi.fn().mockResolvedValue(ok("done"));

  const controller = new VoiceController({
    audio,
    speaker,
    executeTool,
    mode,
    wakeWordThreshold: 0.5,
    inactivityTimeoutMs: 10_000,
    connect: async (handlers) => {
      if (failConnect) throw new Error(failConnect);
      if (deferConnect) await new Promise<void>((resolve) => (resolveConnect = resolve));
      const session = new FakeSession(handlers);
      sessions.push(session);
      return session;
    },
    onChange: (snapshot) => states.push(snapshot.state),
  });

  return {
    controller,
    audio,
    speaker,
    executeTool,
    states,
    sessions,
    session: (): FakeSession => {
      const last = sessions.at(-1);
      if (!last) throw new Error("no session was opened");
      return last;
    },
    speak: (bytes = 4) => microphone?.(new ArrayBuffer(bytes)),
    deferConnect: () => (deferConnect = true),
    finishConnect: async () => {
      resolveConnect?.();
      await vi.runAllTicks();
      await flush();
    },
    failConnect: (message: string | null) => (failConnect = message),
  };
}

const flush = () =>
  new Promise<void>((resolve) => queueMicrotask(resolve)).then(() => Promise.resolve());

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("VoiceController", () => {
  it("starts idle with the wake word enabled", async () => {
    const t = setup();
    await t.controller.start();
    expect(t.controller.snapshot.state).toBe("idle");
    expect(t.audio.configureWakeWord).toHaveBeenCalledWith(true, 0.5);
    expect(t.audio.startStream).not.toHaveBeenCalled();
  });

  it("reports a microphone error and stays off", async () => {
    const t = setup();
    t.audio.startAudio.mockRejectedValueOnce("no microphone was found");
    await expect(t.controller.start()).rejects.toBe("no microphone was found");
    expect(t.controller.snapshot).toMatchObject({ state: "off", error: "no microphone was found" });
  });

  it("opens a session on the wake word and streams the microphone", async () => {
    const t = setup();
    await t.controller.start();
    await t.controller.wakeWordDetected();
    expect(t.controller.snapshot.state).toBe("listening");
    t.speak();
    expect(t.session().sent).toHaveLength(1);
  });

  it("keeps words spoken while the session connects", async () => {
    const t = setup();
    await t.controller.start();
    t.deferConnect();
    const opening = t.controller.wakeWordDetected();
    await flush();
    expect(t.controller.snapshot.state).toBe("connecting");
    t.speak(2);
    t.speak(6);
    await t.finishConnect();
    await opening;
    expect(t.session().sent.map((b) => b.byteLength)).toEqual([2, 6]);
  });

  it("ignores the wake word outside wake-word mode", async () => {
    const t = setup("push_to_talk");
    await t.controller.start();
    expect(t.audio.configureWakeWord).toHaveBeenCalledWith(false, 0.5);
    await t.controller.wakeWordDetected();
    expect(t.sessions).toHaveLength(0);
  });

  it("does not send the microphone while JARVIS speaks, then resumes", async () => {
    const t = setup();
    await t.controller.start();
    await t.controller.wakeWordDetected();
    t.session().handlers.onAudio("AAAA");
    expect(t.speaker.enqueue).toHaveBeenCalledWith("AAAA");
    expect(t.controller.snapshot.state).toBe("speaking");
    t.speak();
    expect(t.session().sent).toHaveLength(0);
    t.controller.playbackFinished();
    t.speak();
    expect(t.session().sent).toHaveLength(1);
  });

  it("closes the session after silence and returns to idle", async () => {
    const t = setup();
    await t.controller.start();
    await t.controller.wakeWordDetected();
    vi.advanceTimersByTime(9_000);
    t.controller.inputLevel(SPEECH_LEVEL);
    vi.advanceTimersByTime(9_000);
    expect(t.session().closed).toBe(false);
    vi.advanceTimersByTime(1_001);
    await flush();
    expect(t.session().closed).toBe(true);
    expect(t.controller.snapshot.state).toBe("idle");
    expect(t.audio.stopStream).toHaveBeenCalled();
  });

  it("never times out in always-on mode", async () => {
    const t = setup("always_on");
    await t.controller.start();
    expect(t.controller.snapshot.state).toBe("listening");
    vi.advanceTimersByTime(600_000);
    expect(t.session().closed).toBe(false);
  });

  it("reconnects in always-on mode after the session drops", async () => {
    const t = setup("always_on");
    await t.controller.start();
    t.session().handlers.onClose("server went away");
    await flush();
    expect(t.controller.snapshot).toMatchObject({ state: "idle", error: "server went away" });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(t.sessions).toHaveLength(2);
    expect(t.controller.snapshot.state).toBe("listening");
  });

  it("shows connection errors and returns to idle", async () => {
    const t = setup();
    await t.controller.start();
    t.failConnect("API key not valid");
    await t.controller.wakeWordDetected();
    expect(t.controller.snapshot).toMatchObject({ state: "idle", error: "API key not valid" });
    expect(t.audio.stopStream).toHaveBeenCalled();
  });

  it("runs tool calls and returns results, including failures", async () => {
    const t = setup();
    t.executeTool.mockImplementation(async (name: string) =>
      name === "open_app"
        ? ok("Opened Safari.")
        : { ok: false, code: "unknown_tool", error: "nope" },
    );
    await t.controller.start();
    await t.controller.wakeWordDetected();
    t.session().handlers.onToolCalls([
      { id: "1", name: "open_app", args: { app_name: "Safari" } },
      { id: "2", name: "missing", args: {} },
    ]);
    await vi.runAllTimersAsync().catch(() => undefined);
    await flush();
    expect(t.executeTool).toHaveBeenCalledWith("open_app", { app_name: "Safari" });
    expect(t.session().toolResponses).toEqual([
      { id: "1", name: "open_app", response: { output: "Opened Safari." } },
      { id: "2", name: "missing", response: { error: "nope", code: "unknown_tool" } },
    ]);
  });

  it("does not keep the microphone open for a tool that waits too long", async () => {
    const t = setup();
    await t.controller.start();
    await t.controller.wakeWordDetected();
    t.executeTool.mockReturnValue(new Promise(() => undefined));
    t.session().handlers.onToolCalls([{ id: "1", name: "file_controller", args: {} }]);
    await vi.advanceTimersByTimeAsync(TOOL_WAIT_LIMIT_MS);
    expect(t.session().closed).toBe(true);
    expect(t.controller.snapshot.state).toBe("idle");
  });

  it("push-to-talk streams only while the key is held", async () => {
    const t = setup("push_to_talk");
    await t.controller.start();
    await t.controller.shortcutPressed();
    t.speak();
    await t.controller.shortcutReleased();
    t.speak();
    expect(t.session().sent).toHaveLength(1);
    expect(t.session().ended).toBe(1);
    // Holding again interrupts JARVIS and reuses the session.
    t.session().handlers.onAudio("AAAA");
    await t.controller.shortcutPressed();
    expect(t.speaker.clear).toHaveBeenCalled();
    expect(t.sessions).toHaveLength(1);
    expect(t.controller.snapshot.state).toBe("listening");
  });

  it("push-to-talk released while connecting still ends the audio stream", async () => {
    const t = setup("push_to_talk");
    await t.controller.start();
    t.deferConnect();
    const opening = t.controller.shortcutPressed();
    await flush();
    await t.controller.shortcutReleased();
    await t.finishConnect();
    await opening;
    expect(t.session().ended).toBe(1);
  });

  it("the shortcut toggles the conversation in wake-word mode", async () => {
    const t = setup();
    await t.controller.start();
    await t.controller.shortcutPressed();
    expect(t.controller.snapshot.state).toBe("listening");
    await t.controller.shortcutPressed();
    expect(t.session().closed).toBe(true);
    expect(t.controller.snapshot.state).toBe("idle");
  });

  it("mute closes the session and releases the microphone", async () => {
    const t = setup();
    await t.controller.start();
    await t.controller.wakeWordDetected();
    await t.controller.stop();
    expect(t.session().closed).toBe(true);
    expect(t.audio.stopAudio).toHaveBeenCalled();
    expect(t.controller.snapshot.state).toBe("off");
  });

  it("ignores callbacks from a session that was already closed", async () => {
    const t = setup();
    await t.controller.start();
    await t.controller.wakeWordDetected();
    const old = t.session();
    await t.controller.shortcutPressed(); // close
    old.handlers.onAudio("AAAA");
    expect(t.speaker.enqueue).not.toHaveBeenCalled();
    expect(t.controller.snapshot.state).toBe("idle");
  });

  it("switching mode reconfigures the wake word", async () => {
    const t = setup();
    await t.controller.start();
    await t.controller.setMode("always_on");
    expect(t.audio.configureWakeWord).toHaveBeenLastCalledWith(false, 0.5);
    expect(t.controller.snapshot.state).toBe("listening");
  });
});
