# JARVIS Desktop

A voice-first desktop assistant inspired by JARVIS, built with [Tauri v2](https://v2.tauri.app/), Rust and TypeScript. It is the successor of the Python app in [`paveltocto/jarvis-ai`](https://github.com/paveltocto/jarvis-ai).

**Status:** phase 1 (voice proof of concept) is implemented and awaiting testing on a Mac: see [TESTING_ON_MAC.md](docs/TESTING_ON_MAC.md). See the [migration plan](docs/MIGRATION_PLAN.md) for the roadmap and the [legacy tool inventory](docs/legacy-tool-inventory.md) for what is being ported.

**Platforms:** macOS first (Apple Silicon and Intel). Windows is planned; the code is structured so it can be added without a rewrite.

## Stack

- **Tauri v2**: native shell using the system WebView (WKWebView on macOS, WebView2 on Windows).
- **Rust**: backend services and all operating-system access.
- **TypeScript + Vite**: UI, Gemini Live voice session and tools that do not need the OS.

## What works today

- Floating holographic orb window, menu bar icon, single instance.
- Voice conversation with Gemini Live in three modes: **"Hey JARVIS"** (local wake word, nothing is sent before it), **push to talk** (hold ⌥ Space) and **always listening**.
- Tools: open apps, current weather, current time.
- Gemini API key stored in the macOS Keychain.

## Prerequisites (macOS)

1. Xcode Command Line Tools: `xcode-select --install`
2. Rust (stable): https://rustup.rs
3. Node.js 22 or later
4. pnpm 10: `corepack enable`

Windows and Linux prerequisites: https://v2.tauri.app/start/prerequisites/

## Getting started

```bash
pnpm install
pnpm tauri dev
```

## Scripts

| Command                                                       | What it does                                     |
| ------------------------------------------------------------- | ------------------------------------------------ |
| `pnpm tauri dev`                                              | Run the app with hot reload                      |
| `pnpm tauri build`                                            | Build the installer (`.dmg` on macOS)            |
| `pnpm check`                                                  | Typecheck, lint, format check and frontend tests |
| `pnpm test`                                                   | Frontend unit tests (Vitest)                     |
| `cargo test` (in `src-tauri/`)                                | Rust unit tests                                  |
| `cargo clippy --all-targets -- -D warnings` (in `src-tauri/`) | Rust lints                                       |

## Project layout

```
src/                 Frontend (TypeScript)
  platform.ts        Typed access to the Rust platform layer
  tools/             Tool registry and tools implemented in TypeScript
src-tauri/           Rust backend
  src/platform/      The only place with OS-specific code
  capabilities/      Tauri permissions
docs/                Plan, inventory and legacy reference data
```

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md). All code, comments and documentation are written in English.

## Licensing note

The bundled "hey jarvis" wake-word model is licensed for **non-commercial use only**. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Security

API keys must never be committed. They will be stored in the macOS Keychain (Windows Credential Manager on Windows).
