# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Rules

- **Write everything in English**: code, comments, docs, commit messages and PR text, even when the user writes in another language.
- Read `CONTRIBUTING.md` before changing code; its rules apply to agents too.
- OS-specific code only in `src-tauri/src/platform/`: no `#[cfg(target_os = ...)]` elsewhere, and the frontend only reads `PlatformInfo`.
- Tools must never report success for work that did not happen.
- Anything that runs shell commands, edits files on the user's behalf or executes generated code must ask the user first.
- Do not loosen the CSP (`src-tauri/tauri.conf.json`) or `src-tauri/capabilities/` beyond what a feature needs.
- Commit subjects are short and imperative.

Roadmap and phase notes: `docs/MIGRATION_PLAN.md`. Legacy tool decisions: `docs/legacy-tool-inventory.md` (update a tool's row when porting it). Legacy source: `paveltocto/jarvis-ai`. Manual checks that need a real Mac: `docs/TESTING_ON_MAC.md`.

## Commands

```bash
pnpm install
pnpm tauri dev          # run the app with hot reload
pnpm tauri build        # build the installer
pnpm check              # typecheck, lint, format check, Vitest
pnpm format             # apply Prettier

pnpm test src/rules/model.test.ts       # one frontend test file
pnpm test -t "part of the test name"    # frontend tests by name

pnpm build              # required before any cargo build: generate_context! embeds dist/

# in src-tauri/
cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
cargo test rules::                      # one module's tests (or pass part of a test name)
```

- The Rust toolchain is pinned in `rust-toolchain.toml`. TypeScript stays on 6.x because typescript-eslint does not support 7.
- CI runs the frontend checks and `pnpm build` on Ubuntu, and the Rust checks on macOS and Windows.
- `cargo test` runs the wake-word audio pipeline from the WAV files in `src-tauri/tests/fixtures/`, without a microphone.
- Linux needs the WebKitGTK packages from https://v2.tauri.app/start/prerequisites/#linux to compile.

## Architecture

A Tauri v2 app. **Rust** owns whatever must keep running while the window is hidden (microphone, wake word, global shortcut, tray, schedulers) and every OS call, because macOS throttles JavaScript timers in hidden windows. The **webview** (plain TypeScript, no UI framework) owns the UI, the Gemini Live session, audio playback and most tools. `src/main.ts` (`App`) wires the pieces together. Closing the window only hides it.

### Rust ↔ webview boundary

- `src/backend.ts` wraps the Tauri commands and events (`platform_info` is wrapped in `src/platform.ts`). Names and types are mirrored by hand.
- A new command goes in `commands.rs` (kept thin), in `generate_handler!` in `lib.rs`, and in `backend.ts`.
- The webview gets no arbitrary access: `data.rs` only reads and writes allowlisted document names (`DocumentName` in TypeScript must match), `secrets.rs` allowlists secret names, and file pickers are opened by Rust so the webview never chooses a path.

### Voice

Audio flows from `cpal` through resampling to 16 kHz (`src-tauri/src/audio/`) into either the local wake-word detector or, only while a session is open, a Tauri `Channel` to the webview, then to Gemini Live and Web Audio playback. In wake-word mode nothing leaves the machine before detection.

`src/voice/controller.ts` is a state machine with no I/O of its own (audio, session and speaker are injected, so tests use fakes). The microphone is not streamed while JARVIS speaks. `gemini-live.ts` pins API version `v1beta` because the Live WebSocket returns 404 on the SDK's default.

The system instruction is rebuilt for each session and includes stored memory, profile, goals and protocol names.

### Tools

One `ToolDefinition` per file in `src/tools/builtin/`, registered in `src/tools/index.ts`. Names are `snake_case`; descriptions are English text for the model. `ToolRegistry` only offers a tool when the current OS is in `platforms` and every capability in `requires` is reported by Rust. Tools return `ok()` or `fail()` and reach the outside world only through `ToolContext`; tests use `testContext()` from `src/tools/testing/context.ts` with overrides. A new `ToolContext` service must be added there and in `App.#toolContext()`.

Quitting and rule creation only show a confirmation in the window, so the tool result must not claim the action already happened.

### Platform layer

To add an OS feature: add a method to the `Platform` trait with an `Unsupported` default, add a `Capability` (mirrored in `src/platform.ts`), then override the method in `macos.rs` and list the capability there. `windows.rs` keeps the defaults until phase 8.

`tauri.macos.conf.json` is merged over `tauri.conf.json` on macOS. Arrays are replaced rather than merged, so a change to the window definition must be made in both files.

### Storage and scheduling

- Each JSON document in the app data folder has a single writer.
- The webview writes memory, profile, goals, protocols, settings and rules. Make changes through `DocumentStore.update`, which serializes read-modify-write per document so concurrent tool calls cannot overwrite each other.
- Rust alone writes reminders (`reminders.rs`).
- The scheduler thread in `reminders.rs` ticks every 15 s. It fires reminders and, through `rules.rs`, reads the rules document and emits `rule:due`. The webview runs the action and advances `nextRunAtMs`. Runs more than two minutes late are skipped.
- Phrase rules are matched in the webview against Gemini's input transcription. Rules cannot run the tools in `RULE_EXCLUDED_TOOLS`.
- API keys live only in the OS credential store.

Text from stored data is rendered with DOM calls, never as HTML.
