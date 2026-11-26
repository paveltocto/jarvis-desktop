# Instructions for AI agents

- **Write everything in English**: code, comments, docs, commit messages and PR text, even when the user writes in another language.
- Read `CONTRIBUTING.md` before changing code; its rules apply to agents too.
- Roadmap: `docs/MIGRATION_PLAN.md`. Legacy tool decisions: `docs/legacy-tool-inventory.md`. Legacy source: `paveltocto/jarvis-ai`.
- OS-specific code only in `src-tauri/src/platform/`.
- Tools must never report success for work that did not happen.

## Commands

- Install: `pnpm install`
- Frontend checks: `pnpm check`
- Rust checks (in `src-tauri/`): `cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test`
- Rust compiles `tauri::generate_context!`, which needs `dist/` to exist: run `pnpm build` first.
- Linux needs the WebKitGTK packages from https://v2.tauri.app/start/prerequisites/#linux to compile.
