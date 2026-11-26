# Testing phase 1 on a Mac

Phase 1 was developed and unit-tested on Linux without a microphone. These checks need a real Mac. Write down the results (and any error text) so they can be fixed in the next iteration.

## Setup

```bash
xcode-select --install          # once
curl https://sh.rustup.rs -sSf | sh   # once
corepack enable                 # once, for pnpm
pnpm install
pnpm tauri dev
```

The first build takes several minutes (Rust dependencies are compiled with optimizations so the wake word runs in real time).

When run with `pnpm tauri dev`, macOS attributes microphone access to **your terminal app** (Terminal, iTerm, VS Code). Allow it when prompted, or enable it under System Settings › Privacy & Security › Microphone. A built app (`pnpm tauri build`) asks for itself.

You need a Gemini API key from https://aistudio.google.com/apikey.

## Checklist

### Window and shell

- [ ] The window is a rounded dark panel with no title bar, floating above other windows, and can be dragged by the top bar or the orb.
- [ ] The **—** button hides it; the menu bar icon › "Show/Hide JARVIS" brings it back.
- [ ] Launching the app a second time focuses the running one instead of opening another.
- [ ] Menu bar icon › "Quit JARVIS" exits.

### Onboarding

- [ ] The first launch shows Settings asking for the API key.
- [ ] Saving a key stores it in the Keychain: open **Keychain Access**, search for `com.jarvis.desktop`.
- [ ] macOS asks for microphone access. If you deny it, the panel shows "Microphone unavailable" with a button that opens the right System Settings page.

### "Hey JARVIS" (default mode)

- [ ] Idle shows "Standing by". Saying **"Hey JARVIS"** switches to "Listening…" within about half a second.
- [ ] Try different distances and volumes. If it rarely triggers, lower Settings › Wake-word sensitivity (for example 0.3). Note the value that works for your voice and accent.
- [ ] Normal conversation, TV or music for a few minutes does **not** trigger it (note any false triggers).
- [ ] "Hey JARVIS, what time is it?" in one breath: the question is not cut off.
- [ ] After about 12 seconds of silence, it returns to "Standing by".

### Conversation and tools

- [ ] Ask in Spanish: it answers in Spanish with the selected voice.
- [ ] "Abre Safari" (or another app): the app opens. Ask for an app that does not exist: JARVIS says it could not open it (it must not claim success).
- [ ] "¿Qué clima hace en Lima?": answers with real data.
- [ ] Audio plays without crackles or gaps. If the first response is silent, note it (WebKit audio autoplay).

### Other modes and controls

- [ ] **Push to talk**: hold **⌃⌥ Space**, speak, release; JARVIS answers. Holding again while it speaks interrupts it.
- [ ] **Always listening**: the conversation stays open without the wake word.
- [ ] In "Hey JARVIS" mode, **⌃⌥ Space** starts a conversation, and pressing it again ends it.
- [ ] The mic button (and menu bar › Mute) releases the microphone: the orange microphone indicator in the menu bar disappears.
- [ ] Pressing ⌃⌥ Space does not open Gemini or ChatGPT (both claim ⌥ Space by default).
- [ ] Changing **Voice shortcut** in Settings takes effect at once: the old shortcut stops working, the new one works and the hint shows it; the choice survives a restart.
- [ ] If the chosen shortcut cannot be registered, Settings shows the error and keeps the previous shortcut.

### Measurements (for the Electron vs Tauri decision)

Open **Activity Monitor**, search for "jarvis" and also include the "WebKit" processes that belong to it (_View › All Processes, Hierarchically_). Record:

| Measurement                                                                   | Value |
| ----------------------------------------------------------------------------- | ----- |
| Memory, idle in "Standing by" (app + its WebKit processes)                    |       |
| CPU %, idle in "Standing by"                                                  |       |
| CPU %, during a conversation                                                  |       |
| Time from the end of your question to the start of the answer (rough, by ear) |       |
| Mac model and macOS version                                                   |       |

For lower numbers, also measure a release build: `pnpm tauri build`, then open `src-tauri/target/release/bundle/macos/JARVIS.app`.
