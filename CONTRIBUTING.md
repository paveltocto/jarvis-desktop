# Contributing

## Language

**Everything in this repository is written in English**: code, identifiers, comments, commit messages, pull requests, issues and documentation. Text shown to end users is the only exception, and it will go through translation files once i18n is added.

## Workflow

1. Create a branch from `main`.
2. Make the change with tests.
3. Run the checks below; all must pass.
4. Open a pull request with a short description of what changed and why.

## Checks

```bash
pnpm check                                         # typecheck, lint, format, frontend tests
cd src-tauri
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

CI runs the frontend checks on Ubuntu and the Rust checks on macOS and Windows.

## Rules

### Platform code

- OS-specific code lives only in `src-tauri/src/platform/`. No `#[cfg(target_os = ...)]` anywhere else, and no OS checks in the frontend beyond reading `PlatformInfo`.
- To add an OS feature: add a method with an `Unsupported` default to the `Platform` trait, add a `Capability`, implement it in `macos.rs` and list the capability there. `windows.rs` keeps the default until phase 8.

### Tools

- One tool per file under `src/tools/` (or a Rust command when it needs the backend).
- Declare `platforms` and `requires` honestly. The registry hides tools that cannot run on the current machine.
- Return `fail(...)` when the work did not happen. Never return a success message for something that was not done.
- Tool names are `snake_case`. Descriptions are written in English for the model.
- When porting a legacy tool, update its row in `docs/legacy-tool-inventory.md`.

### Security

- Never commit API keys or personal data.
- Do not loosen the Content Security Policy or Tauri capabilities beyond what a feature needs.
- Anything that runs shell commands, edits files on the user's behalf or executes generated code must ask the user first.

## Commit messages

Imperative mood, short subject line (for example `Add volume control on macOS`), with a body when the reason is not obvious.
