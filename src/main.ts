import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import { audioBackend, errorMessage, events, secrets, shell, system } from "./backend";
import {
  type ActivationMode,
  DEFAULT_VOICE_SHORTCUT,
  loadSettings,
  type Settings,
  saveSettings,
  shortcutLabel,
  VOICE_SHORTCUTS,
  VOICES,
} from "./config";
import { Orb } from "./orb/orb";
import { getPlatformInfo, type PlatformInfo } from "./platform";
import { createToolRegistry } from "./tools";
import type { ToolContext } from "./tools/types";
import { VoiceController, type VoiceSnapshot } from "./voice/controller";
import { createGeminiSessionFactory } from "./voice/gemini-live";
import { toFunctionDeclarations } from "./voice/schema";
import { PcmSpeaker } from "./voice/speaker";
import { buildSystemInstruction } from "./voice/system-prompt";

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing element #${id}`);
  return found as T;
}

const ui = {
  orbCanvas: element<HTMLCanvasElement>("orb"),
  status: element<HTMLParagraphElement>("status"),
  hint: element<HTMLParagraphElement>("hint"),
  notice: element<HTMLDivElement>("notice"),
  noticeText: element<HTMLParagraphElement>("notice-text"),
  noticeAction: element<HTMLButtonElement>("notice-action"),
  mute: element<HTMLButtonElement>("mute"),
  mode: element<HTMLSelectElement>("mode"),
  voiceView: element<HTMLElement>("voice-view"),
  settingsView: element<HTMLElement>("settings-view"),
  settingsIntro: element<HTMLParagraphElement>("settings-intro"),
  settingsForm: element<HTMLFormElement>("settings-form"),
  settingsError: element<HTMLParagraphElement>("settings-error"),
  apiKey: element<HTMLInputElement>("api-key"),
  threshold: element<HTMLInputElement>("threshold"),
  voice: element<HTMLSelectElement>("voice"),
  voiceShortcut: element<HTMLSelectElement>("voice-shortcut"),
  model: element<HTMLInputElement>("model"),
  removeKey: element<HTMLButtonElement>("remove-key"),
  closeSettings: element<HTMLButtonElement>("close-settings"),
};

const STATUS: Record<VoiceSnapshot["state"], string> = {
  off: "Microphone off",
  idle: "Standing by",
  connecting: "Connecting…",
  listening: "Listening…",
  speaking: "Speaking",
};

function idleHint(mode: ActivationMode, shortcut: string): string {
  switch (mode) {
    case "wake_word":
      return `Say “Hey JARVIS” or press ${shortcut}`;
    case "push_to_talk":
      return `Hold ${shortcut} and speak`;
    case "always_on":
      return "Reconnecting…";
  }
}

interface NoticeAction {
  label: string;
  run: () => void;
}

function showNotice(message: string, action?: NoticeAction): void {
  ui.noticeText.textContent = message;
  ui.notice.hidden = false;
  ui.noticeAction.hidden = !action;
  ui.noticeAction.textContent = action?.label ?? "";
  ui.noticeAction.onclick = action ? () => action.run() : null;
}

function hideNotice(): void {
  ui.notice.hidden = true;
}

class App {
  readonly #orb = new Orb(ui.orbCanvas);
  readonly #registry = createToolRegistry();
  readonly #speaker = new PcmSpeaker(() => this.#controller?.playbackFinished());
  #settings: Settings = loadSettings();
  #platform: PlatformInfo = { os: "other", arch: "unknown", capabilities: [] };
  #controller: VoiceController | null = null;
  #apiKey: string | null = null;
  #muted = false;

  async init(): Promise<void> {
    this.#orb.start();
    this.#bindUi();
    await this.#bindBackendEvents();
    this.#platform = await getPlatformInfo();
    this.#fillShortcutOptions();
    await this.#applyStoredShortcut();

    try {
      this.#apiKey = await secrets.get("gemini_api_key");
    } catch (error) {
      showNotice(`Could not read the Keychain: ${errorMessage(error)}`);
    }
    if (!this.#apiKey) {
      this.#openSettings(
        "Add your Gemini API key to start. It is stored in the macOS Keychain, never in a file.",
      );
      this.#render({ state: "off", mode: this.#settings.activationMode, error: null });
      return;
    }
    await this.#startVoice();
  }

  #fillShortcutOptions(): void {
    ui.voiceShortcut.replaceChildren(
      ...VOICE_SHORTCUTS.map(
        (item) => new Option(shortcutLabel(item.accelerator, this.#platform.os), item.accelerator),
      ),
    );
  }

  /** The backend registers the default at startup; switch to the stored choice. */
  async #applyStoredShortcut(): Promise<void> {
    if (this.#settings.voiceShortcut === DEFAULT_VOICE_SHORTCUT) return;
    try {
      await shell.setVoiceShortcut(this.#settings.voiceShortcut);
    } catch (error) {
      showNotice(
        `${errorMessage(error)}. Using ${shortcutLabel(DEFAULT_VOICE_SHORTCUT, this.#platform.os)} instead.`,
      );
      this.#settings = { ...this.#settings, voiceShortcut: DEFAULT_VOICE_SHORTCUT };
      saveSettings(this.#settings);
    }
  }

  #toolContext(): ToolContext {
    return {
      os: this.#platform.os,
      capabilities: this.#platform.capabilities,
      now: () => new Date(),
      fetch: (input, init) => window.fetch(input, init),
      system: { openApp: (name) => system.openApp(name) },
    };
  }

  async #startVoice(): Promise<void> {
    await this.#controller?.stop();
    this.#controller = null;
    if (!this.#apiKey) return;

    const controller = new VoiceController({
      audio: audioBackend,
      speaker: this.#speaker,
      connect: createGeminiSessionFactory({
        apiKey: this.#apiKey,
        model: this.#settings.liveModel,
        voice: this.#settings.voice,
        systemInstruction: () => buildSystemInstruction(new Date()),
        tools: () => toFunctionDeclarations(this.#registry.declarations(this.#platform)),
      }),
      executeTool: (name, args) => this.#registry.execute(name, args, this.#toolContext()),
      mode: this.#settings.activationMode,
      wakeWordThreshold: this.#settings.wakeWordThreshold,
      inactivityTimeoutMs: this.#settings.inactivityTimeoutMs,
      onChange: (snapshot) => this.#render(snapshot),
    });
    this.#controller = controller;
    if (this.#muted) return this.#render(controller.snapshot);

    try {
      await controller.start();
      hideNotice();
    } catch (error) {
      this.#showMicrophoneProblem(errorMessage(error));
    }
  }

  #showMicrophoneProblem(message: string): void {
    const canOpenSettings = this.#platform.capabilities.includes("privacy_settings");
    showNotice(
      `Microphone unavailable: ${message}. Allow JARVIS under System Settings › Privacy & Security › Microphone, then retry.`,
      canOpenSettings
        ? {
            label: "Open Microphone settings",
            run: () => void system.openPrivacySettings("microphone"),
          }
        : { label: "Retry", run: () => void this.#startVoice() },
    );
  }

  #render(snapshot: VoiceSnapshot): void {
    this.#orb.setState(snapshot.state);
    ui.status.textContent = this.#muted ? "Muted" : STATUS[snapshot.state];
    ui.hint.textContent =
      snapshot.state === "idle"
        ? idleHint(snapshot.mode, shortcutLabel(this.#settings.voiceShortcut, this.#platform.os))
        : snapshot.state === "listening" && snapshot.mode === "push_to_talk"
          ? "Release to send"
          : "";
    ui.mute.setAttribute("aria-pressed", String(this.#muted));
    ui.mode.value = snapshot.mode;
    if (snapshot.error) {
      const keyProblem = /api key/i.test(snapshot.error);
      showNotice(
        snapshot.error,
        keyProblem ? { label: "Update API key", run: () => this.#openSettings("") } : undefined,
      );
    } else if (snapshot.state === "listening") hideNotice();
  }

  async #toggleMute(): Promise<void> {
    this.#muted = !this.#muted;
    if (this.#muted) {
      await this.#controller?.stop();
    } else {
      try {
        await this.#controller?.start();
      } catch (error) {
        this.#showMicrophoneProblem(errorMessage(error));
      }
    }
    if (this.#controller) this.#render(this.#controller.snapshot);
  }

  #bindUi(): void {
    ui.mute.addEventListener("click", () => void this.#toggleMute());
    ui.mode.addEventListener("change", () => {
      const mode = ui.mode.value as ActivationMode;
      this.#settings = { ...this.#settings, activationMode: mode };
      saveSettings(this.#settings);
      void this.#controller?.setMode(mode);
    });
    element("open-settings").addEventListener("click", () => this.#openSettings(""));
    element("hide-window").addEventListener("click", () => void getCurrentWindow().hide());
    element("get-key").addEventListener(
      "click",
      () => void openUrl("https://aistudio.google.com/apikey"),
    );
    ui.closeSettings.addEventListener("click", () => this.#closeSettings());
    ui.removeKey.addEventListener("click", () => void this.#removeKey());
    ui.settingsForm.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.#saveSettings();
    });
    for (const voice of VOICES) ui.voice.add(new Option(voice, voice));
  }

  async #bindBackendEvents(): Promise<void> {
    await Promise.all([
      events.audioLevel((rms) => {
        this.#controller?.inputLevel(rms);
        const state = this.#controller?.snapshot.state;
        this.#orb.setLevel(
          state === "speaking" ? this.#speaker.level() * 3 : state === "listening" ? rms * 12 : 0,
        );
      }),
      events.wakeWord(() => void this.#controller?.wakeWordDetected()),
      events.voiceShortcut(
        (state) =>
          void (state === "pressed"
            ? this.#controller?.shortcutPressed()
            : this.#controller?.shortcutReleased()),
      ),
      events.toggleMute(() => void this.#toggleMute()),
      events.audioError((message) => showNotice(message)),
      events.shellError((message) => showNotice(message)),
    ]);
  }

  #openSettings(intro: string): void {
    ui.settingsIntro.textContent = intro;
    ui.settingsIntro.hidden = !intro;
    ui.apiKey.value = "";
    ui.apiKey.placeholder = this.#apiKey
      ? "Saved in the Keychain (leave empty to keep)"
      : "Paste your key";
    ui.threshold.value = String(this.#settings.wakeWordThreshold);
    ui.voice.value = this.#settings.voice;
    ui.voiceShortcut.value = this.#settings.voiceShortcut;
    ui.model.value = this.#settings.liveModel;
    ui.removeKey.hidden = !this.#apiKey;
    ui.closeSettings.hidden = !this.#apiKey;
    ui.settingsError.hidden = true;
    ui.voiceView.hidden = true;
    ui.settingsView.hidden = false;
  }

  #closeSettings(): void {
    ui.settingsView.hidden = true;
    ui.voiceView.hidden = false;
  }

  async #saveSettings(): Promise<void> {
    const newKey = ui.apiKey.value.trim();
    if (!newKey && !this.#apiKey) {
      ui.settingsError.textContent = "An API key is required.";
      ui.settingsError.hidden = false;
      return;
    }
    try {
      if (newKey) await secrets.set("gemini_api_key", newKey);
    } catch (error) {
      ui.settingsError.textContent = `Could not save the key: ${errorMessage(error)}`;
      ui.settingsError.hidden = false;
      return;
    }
    const previous = this.#settings;
    const voiceShortcut = ui.voiceShortcut.value;
    if (voiceShortcut !== previous.voiceShortcut) {
      try {
        await shell.setVoiceShortcut(voiceShortcut);
      } catch (error) {
        ui.voiceShortcut.value = previous.voiceShortcut;
        ui.settingsError.textContent = errorMessage(error);
        ui.settingsError.hidden = false;
        return;
      }
    }
    this.#settings = {
      ...previous,
      wakeWordThreshold: Number(ui.threshold.value),
      voice: ui.voice.value,
      voiceShortcut,
      liveModel: ui.model.value.trim() || previous.liveModel,
    };
    saveSettings(this.#settings);
    this.#closeSettings();

    const sessionChanged =
      Boolean(newKey) ||
      previous.voice !== this.#settings.voice ||
      previous.liveModel !== this.#settings.liveModel;
    if (newKey) this.#apiKey = newKey;
    if (sessionChanged || !this.#controller) {
      await this.#startVoice();
    } else {
      await this.#controller.setWakeWordThreshold(this.#settings.wakeWordThreshold);
      // Refresh the idle hint in case the shortcut changed.
      this.#render(this.#controller.snapshot);
    }
  }

  async #removeKey(): Promise<void> {
    try {
      await secrets.delete("gemini_api_key");
    } catch (error) {
      ui.settingsError.textContent = errorMessage(error);
      ui.settingsError.hidden = false;
      return;
    }
    this.#apiKey = null;
    await this.#controller?.stop();
    this.#controller = null;
    this.#openSettings("Key removed. Add a Gemini API key to use JARVIS again.");
  }
}

window.addEventListener("DOMContentLoaded", () => {
  new App()
    .init()
    .catch((error: unknown) => showNotice(`JARVIS failed to start: ${errorMessage(error)}`));
});
