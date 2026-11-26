# Migration plan: JARVIS → Tauri v2 (macOS first, Windows later)

This repository replaces the Python/PyQt6 app in [`paveltocto/jarvis-ai`](https://github.com/paveltocto/jarvis-ai). The legacy app stays as the behavioural reference until the migration is finished.

## 1. Goals

- A native, lightweight desktop app that runs in the background at all times.
- **v1 on macOS** (Apple Silicon and Intel), shipped as a signed and notarized `.dmg`.
- **Windows later**, without a rewrite: everything OS-specific is isolated from day one.
- Fix the legacy problems: stubs that report fake success, tools declared without a module, an automation engine that never runs its actions, and microphone audio streamed to the cloud without a wake word.

## 2. Architecture

The split between the two sides:

- **Rust backend**: services that must keep running while the window is hidden (microphone, wake word, global shortcuts, scheduler, rules, Telegram) and every call into the operating system.
- **WebView (TypeScript)**: the UI (orb, widgets, settings), the Gemini Live voice session, audio playback and vision (MediaPipe, OCR).

Reason: macOS throttles JavaScript timers in hidden windows (App Nap). Rust services are not affected.

```
jarvis-desktop/
  src/                         # Frontend (TypeScript + Vite)
    platform.ts                # typed wrapper around the platform_info command
    tools/                     # tool registry + tools implemented in TypeScript
    orb/                       # holographic orb (canvas 2D, port of legacy sphere.html)
    widgets/                   # (phase 2) clock, weather, Spotify, system, todo, notes, files
    settings/                  # (phase 2)
    voice/                     # voice state machine, Gemini Live session, Web Audio playback
    vision/                    # (phase 5) MediaPipe gestures, tesseract.js
  src-tauri/
    src/
      lib.rs                   # app setup
      commands.rs              # Tauri commands exposed to the frontend
      platform/
        mod.rs                 # Platform trait, capabilities, OS selection
        macos.rs               # real implementation (v1)
        windows.rs             # reports Unsupported until phase 8
        unsupported.rs         # Linux and other OSes (development and CI only)
      audio/                   # microphone capture (cpal), resampling, wake word (tract)
      secrets.rs               # API keys in the OS credential store
      shell.rs                 # tray, global shortcut, window helpers
      services/                # (phase 2) scheduler, rules, Telegram, memory, protocols, config
      sandbox/                 # (phase 6) execution of generated code (rquickjs)
    capabilities/              # Tauri v2 permissions per window
  docs/
  .github/workflows/ci.yml     # macOS + Windows
```

### Platform layer (Rust)

`src-tauri/src/platform/mod.rs` defines the `Platform` trait. Every method has a default implementation that returns `PlatformError::Unsupported`. A platform opts in to a feature by overriding the method **and** listing the matching `Capability`.

Rules:

- `#[cfg(target_os = ...)]` appears **only** inside `platform/`.
- Each tool declares `platforms` (operating systems) and `requires` (capabilities). The tool registry **only offers the model the tools the current platform supports**. A tool never reports success for work it did not do.

## 3. Technology

| Area                     | Technology                                                                                                                                                            |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop framework        | **Tauri v2** (WKWebView on macOS, WebView2 on Windows)                                                                                                                |
| Backend                  | **Rust** stable (edition 2024), `serde`, `thiserror`; `tokio` when services arrive                                                                                    |
| Frontend                 | **TypeScript 6 + Vite** (vanilla for the orb; Svelte optional for settings)                                                                                           |
| Tauri plugins            | opener (now); global-shortcut, single-instance, autostart, notification, shell, fs, clipboard-manager, store, http, os, window-state, positioner, updater (as needed) |
| Tray                     | Tauri `TrayIcon` (menu bar on macOS)                                                                                                                                  |
| Microphone               | `cpal`                                                                                                                                                                |
| Wake word                | **openWakeWord** (`hey_jarvis` model, ONNX) run with `tract` (pure Rust, nothing to bundle)                                                                           |
| Voice activity detection | Gemini's server-side VAD; local Silero VAD only if needed later                                                                                                       |
| Voice AI                 | `@google/genai` (Gemini Live API) in the WebView                                                                                                                      |
| Other LLMs               | OpenRouter and DeepSeek over `fetch`                                                                                                                                  |
| Audio playback           | Web Audio API + AudioWorklet                                                                                                                                          |
| Mouse and keyboard       | `enigo`                                                                                                                                                               |
| Screenshots              | `xcap`                                                                                                                                                                |
| Active windows           | `x-win` / `active-win-pos-rs`                                                                                                                                         |
| System stats             | `sysinfo`                                                                                                                                                             |
| Secrets                  | `keyring` v4 (macOS Keychain, Windows Credential Manager)                                                                                                             |
| macOS automation         | AppleScript / JXA through `osascript`                                                                                                                                 |
| Browser automation       | `chromiumoxide` (CDP). A Node sidecar with Playwright only if needed                                                                                                  |
| Gestures                 | `@mediapipe/tasks-vision`                                                                                                                                             |
| OCR                      | `tesseract.js`                                                                                                                                                        |
| Documents                | `pptxgenjs`, `docx`                                                                                                                                                   |
| Google                   | Gmail, Calendar, Drive and Maps REST APIs with OAuth (`oauth2` crate)                                                                                                 |
| Spotify                  | Web API over `fetch`                                                                                                                                                  |
| Telegram                 | Bot API long polling from Rust (`reqwest`)                                                                                                                            |
| Generated-code sandbox   | `rquickjs` (embedded QuickJS with memory and time limits)                                                                                                             |
| Tests                    | `cargo test`, Vitest; WebdriverIO with `tauri-driver` for end-to-end                                                                                                  |
| Code quality             | `clippy`, `rustfmt`, ESLint (typescript-eslint strict), Prettier                                                                                                      |
| CI                       | GitHub Actions: frontend checks on Ubuntu, Rust on `macos-latest` + `windows-latest`                                                                                  |

TypeScript is pinned to 6.x because typescript-eslint does not support TypeScript 7 yet.

## 4. Voice activation (configurable modes)

Legacy behaviour: the microphone is always open and any sound above the noise floor is streamed to Gemini. The wake word only works in sleep mode.

New modes:

1. **"Hey JARVIS" (default).** Audio is processed locally only. On detection: confirmation sound, open the Gemini Live session and stream audio. After N seconds of silence, return to idle and close the session (saves API cost and protects privacy).
2. **Push-to-talk** with a configurable shortcut (default `⌥ Space`; macOS keyboards have no Insert key).
3. **Always listening**, equivalent to the legacy behaviour, with a noise gate.

While JARVIS speaks, microphone streaming pauses (as in legacy). To allow barge-in later, evaluate echo cancellation (`webrtc-audio-processing`).

Audio flow: `cpal` (Rust) → VAD and wake word → 16 kHz PCM over `tauri::ipc::Channel` → WebView → Gemini Live → 24 kHz audio → Web Audio.

## 5. macOS equivalents

| Feature              | Implementation                                                         | Permission                      |
| -------------------- | ---------------------------------------------------------------------- | ------------------------------- |
| Volume and mute      | `osascript -e "set volume output volume N"`                            | —                               |
| Brightness           | brightness keys via `enigo`, or CoreDisplay                            | Accessibility                   |
| Do Not Disturb       | `shortcuts run "JARVIS Focus On/Off"` (user creates the shortcut once) | —                               |
| Power mode           | `pmset -a lowpowermode 0/1`                                            | Administrator password          |
| Open apps            | `open -a`, list with `mdfind` / `/Applications`                        | —                               |
| Windows              | `x-win` + AppleScript (System Events)                                  | Accessibility, Screen Recording |
| Native UI automation | AppleScript / JXA                                                      | Accessibility, Automation       |
| Mouse and keyboard   | `enigo`                                                                | Accessibility                   |
| Screenshots / vision | `xcap`                                                                 | Screen Recording                |
| Terminal             | `zsh`, with user confirmation                                          | —                               |
| WhatsApp             | `whatsapp://send?phone=…&text=…` + Enter key press                     | Accessibility                   |
| Global shortcut      | global-shortcut plugin                                                 | —                               |
| Microphone / camera  | `cpal` / `getUserMedia`                                                | Microphone, Camera              |

Out of scope for v1: reading system notifications (macOS has no public API for it).

## 6. Phases

| Phase                             | Scope                                                                                                                                                                                                                | Estimate    | Status                                |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------- |
| **0. Setup**                      | Repository, Tauri v2 + Vite + TypeScript, platform layer with Windows reporting Unsupported, tool registry, CI for macOS + Windows, legacy tool inventory                                                            | 2–3 days    | **Done**                              |
| **1. Proof of concept**           | Transparent orb window, tray, global shortcut, microphone in Rust → Gemini Live → playback, "Hey JARVIS", permissions onboarding, `open_app`, `weather_report`. **Measure RAM, CPU and voice latency on a real Mac** | 3–5 days    | **Code done**: awaiting test on a Mac |
| **2. Core**                       | Memory, protocols, profile, goals, reminders, scheduler, real rules engine, settings, voices, widgets, import of legacy `config/api_keys.json` into the Keychain                                                     | 1–1.5 weeks | Next                                  |
| **3. Platform-independent tools** | Weather, YouTube, Spotify, web search, files and organizer, documents, Telegram, OpenRouter/DeepSeek, browser (`chromiumoxide`), Gmail, Calendar, morning brief                                                      | 1 week      |                                       |
| **4. macOS integration**          | Everything in section 5                                                                                                                                                                                              | 1.5 weeks   |                                       |
| **5. Vision and gestures**        | `screen_vision`, `vision_guardian`, `visual_click` (OCR), camera, MediaPipe gestures                                                                                                                                 | 1 week      |                                       |
| **6. Safe self-programming**      | `auto_programmer`, `tool_creator`, `self_edit` generate JavaScript that runs in `rquickjs`, with a restricted capability API and user confirmation                                                                   | 1 week      |                                       |
| **7. macOS distribution**         | Universal `.dmg`, code signing and notarization (Apple Developer account), Info.plist, auto-updates                                                                                                                  | 2–3 days    |                                       |
| **8. Windows**                    | `platform/windows.rs` (PowerShell, UI Automation, `enigo`), MSI/NSIS installer, Insert as default shortcut, UI testing on WebView2                                                                                   | 1.5–2 weeks |                                       |

**macOS total: about 7–9 weeks. Windows: 1.5–2 more weeks.**

The decision for every legacy tool (port, merge, redesign, defer) is in [legacy-tool-inventory.md](legacy-tool-inventory.md).

### Info.plist / macOS configuration (phase 1 and 7)

- `NSMicrophoneUsageDescription`, `NSCameraUsageDescription`, `NSAppleEventsUsageDescription` (AppleScript).
- `NSAppSleepDisabled = true` (prevent App Nap).
- `macOSPrivateApi: true` in `tauri.conf.json` for the transparent window. This blocks Mac App Store distribution; it does not affect the `.dmg`.
- Optional `LSUIElement` (hide from the Dock, menu bar only).

## 7. Security

- API keys in the Keychain, never in plain-text JSON.
- Tauri v2 capabilities: each window can only invoke the commands it needs.
- A strict Content Security Policy in `tauri.conf.json`; loosen it per feature (for example `connect-src` for the Gemini endpoint) instead of disabling it.
- `terminal_agent`, `self_edit` and generated-code execution require user confirmation and are logged.
- In "Hey JARVIS" mode, no audio leaves the machine before the wake word.

## 8. Risks

| Risk                                                             | How it is validated                                                     |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Voice latency Rust → WebView → Gemini                            | Phase 1, measured on a Mac                                              |
| "Hey JARVIS" false positives or misses with a Spanish accent     | Phase 1; tune the threshold, or train a custom openWakeWord model       |
| CSS and WebGL differences of the orb between WebKit and WebView2 | Phase 1 on macOS, phase 8 on Windows                                    |
| UI automation without pywinauto                                  | Phase 4 (AppleScript) and phase 8 (UI Automation)                       |
| Code signing and notarization                                    | Phase 7; requires an Apple Developer account                            |
| Rust learning curve                                              | Keep Rust in small modules; keep tool logic in TypeScript when possible |

## 9. Phase 1 notes

What was built and verified (on Linux CI-like conditions, without a microphone or a Mac):

- **Wake word**: Rust port of the openWakeWord streaming pipeline using `tract`. Scores match the reference Python implementation to four decimals on test clips. About 3 ms of CPU per 80 ms of audio in release builds.
- **Audio**: `cpal` capture on a dedicated thread, mono mixdown, custom low-pass + interpolation resampler to 16 kHz, input level events, PCM streaming to the WebView over a Tauri `Channel`. End-to-end test: a simulated 48 kHz microphone playing "hey jarvis" fires exactly one detection.
- **Voice controller**: state machine (`off`, `idle`, `connecting`, `listening`, `speaking`) for the three activation modes. Audio spoken while the session connects is buffered and sent, so "Hey JARVIS, open Safari" works in one breath.
- **Gemini Live**: the SDK (3.x) defaults to API version `v1`, where the Live WebSocket returns HTTP 404; the app pins `v1beta`. Verified against the real endpoint: an invalid key is rejected with a clear message.
- **Tools**: `get_current_time`, `open_app` (macOS `open -a`), `weather_report` (wttr.in).
- **Shell**: transparent always-on-top window, tray menu, global shortcut (`Alt+Space`, press and release events), single instance, API key in the Keychain, microphone onboarding with a link to System Settings.

Known limitations, to check on a Mac (see [TESTING_ON_MAC.md](TESTING_ON_MAC.md)):

- The model never hears itself because the microphone is not sent while JARVIS speaks; it also means you cannot interrupt by voice in wake-word mode. Push-to-talk interrupts.
- The synthetic Spanish-voiced "hey jarvis" clip scored only 0.04 (English voices: 0.98+). A Spanish accent may need a lower threshold (Settings → Wake-word sensitivity) or a custom model.
- The `hey_jarvis` model is licensed CC BY-NC-SA 4.0 (non-commercial). See [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
- Settings live in `localStorage` until the settings store arrives in phase 2.
