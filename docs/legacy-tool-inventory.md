# Legacy tool inventory

The Python app ([`paveltocto/jarvis-ai`](https://github.com/paveltocto/jarvis-ai), commit `027a357`) declares 66 tools to Gemini in `main.py` (`TOOL_DECLARATIONS`). This file records what each one actually does today and what happens to it in the migration.

Parameter schemas for all 66 tools are in [`legacy/tool-parameters.json`](legacy/tool-parameters.json), with the line number of each declaration in the legacy `main.py`.

## Legend

**Legacy status**

- **Working**: real implementation exists.
- **Partial**: implemented, but key behaviour is missing.
- **Stub**: the function returns a fixed success message without doing anything. The model then tells the user the task was done.
- **Missing**: declared to the model, but the module does not exist (the import fails silently and the handler is `None`).

**Decision**

- **Port**: rewrite with equivalent behaviour.
- **Merge**: fold into another tool.
- **Complete**: port and implement the missing behaviour.
- **Implement**: was a stub or missing; build it for real in v1.
- **Redesign**: the legacy approach does not fit a compiled app; rebuild with a new approach.
- **Defer**: not in v1. Not declared to the model until implemented.
- **Drop**: not planned.

**Phase** refers to [MIGRATION_PLAN.md](MIGRATION_PLAN.md#6-phases).

## Core, voice and UI

| Tool                | Legacy status | Decision | Phase | Notes                                                                                                                                                      |
| ------------------- | ------------- | -------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_current_time`  | Working       | Port     | 0     | **Done.** Pure TypeScript; first tool in the registry.                                                                                                     |
| `sleep_mode`        | Working       | Redesign | 1     | **Done.** Replaced by the `idle` voice state with local "Hey JARVIS" detection (openWakeWord). Legacy used Vosk and matched "jarvis" anywhere in the text. |
| `shutdown_jarvis`   | Working       | Port     | 2     |                                                                                                                                                            |
| `jarvis_ui_control` | Working       | Port     | 2     | Show and hide widgets.                                                                                                                                     |
| `show_hologram`     | Working       | Port     | 2     | Renders HTML or a URL in an overlay window. HTML must be sandboxed.                                                                                        |
| `activate_protocol` | Working       | Port     | 2     | Named instruction sets stored in `protocols.json`.                                                                                                         |
| `save_memory`       | Working       | Port     | 2     | Keep the legacy `memory/*.json` format and import it on first run.                                                                                         |
| `camera_bus`        | Working       | Port     | 5     |                                                                                                                                                            |

## System control

| Tool                 | Legacy status | Decision | Phase | Notes                                                                                                     |
| -------------------- | ------------- | -------- | ----- | --------------------------------------------------------------------------------------------------------- |
| `open_app`           | Working       | Port     | 1     | **Done.** macOS: `open -a`. Platform capability `open_app`.                                               |
| `weather_report`     | Working       | Port     | 1     | **Done.** wttr.in JSON API, no API key.                                                                   |
| `system_monitor`     | Working       | Port     | 3     | `sysinfo` crate, cross-platform.                                                                          |
| `window_control`     | Working       | Port     | 4     | Capability `windows`.                                                                                     |
| `computer_settings`  | Working       | Merge    | 4     | Merged with `contextual_control` into one settings tool (volume, brightness, Do Not Disturb, power mode). |
| `contextual_control` | Working       | Merge    | 4     | See `computer_settings`.                                                                                  |
| `computer_control`   | Working       | Port     | 4     | Mouse, keyboard, screenshots. `enigo` + `xcap`.                                                           |
| `app_macro`          | Working       | Port     | 4     |                                                                                                           |
| `native_ui`          | Working       | Redesign | 4     | Legacy uses `pywinauto` (Windows only). macOS: AppleScript/JXA through capability `ui_scripting`.         |
| `terminal_agent`     | Working       | Port     | 4     | macOS: `zsh`. Requires user confirmation before running. Legacy ran commands without confirmation.        |
| `windows_settings`   | Stub          | Defer    | 8     | Windows registry and display settings. Revisit with the Windows platform.                                 |
| `desktop_control`    | Stub          | Defer    | —     | Overlaps with `computer_control` and `file_controller`.                                                   |

## Vision

| Tool              | Legacy status | Decision | Phase | Notes                                                               |
| ----------------- | ------------- | -------- | ----- | ------------------------------------------------------------------- |
| `screen_vision`   | Working       | Port     | 5     |                                                                     |
| `screen_process`  | Working       | Merge    | 5     | Duplicate of `screen_vision` (same handler in legacy).              |
| `vision_guardian` | Working       | Port     | 5     | Background screen analysis. Must be opt-in and visible to the user. |
| `visual_click`    | Working       | Port     | 5     | OCR with `tesseract.js`.                                            |

## Files and documents

| Tool                   | Legacy status | Decision | Phase | Notes                                                             |
| ---------------------- | ------------- | -------- | ----- | ----------------------------------------------------------------- |
| `file_controller`      | Working       | Port     | 3     | 15 parameters; consider splitting into smaller tools.             |
| `smart_file_organizer` | Working       | Port     | 3     | Duplicate detection by hash (use SHA-256 instead of MD5).         |
| `document_creator`     | Working       | Port     | 3     | `pptxgenjs`, `docx`.                                              |
| `file_processor`       | Missing       | Defer    | —     | Image, audio, video and spreadsheet processing for dropped files. |

## Web and media

| Tool              | Legacy status | Decision  | Phase | Notes                  |
| ----------------- | ------------- | --------- | ----- | ---------------------- |
| `youtube_video`   | Working       | Port      | 3     |                        |
| `browser_control` | Working       | Port      | 3     | `chromiumoxide` (CDP). |
| `spotify_control` | Working       | Port      | 3     | Spotify Web API.       |
| `web_search`      | Stub          | Implement | 3     |                        |

## Communication

| Tool                     | Legacy status | Decision  | Phase | Notes                                               |
| ------------------------ | ------------- | --------- | ----- | --------------------------------------------------- |
| `unified_communications` | Working       | Port      | 3     | Email, Telegram, Discord, WhatsApp.                 |
| `send_message`           | Missing       | Merge     | 3     | Into `unified_communications`.                      |
| `whatsapp`               | Working       | Redesign  | 4     | macOS: `whatsapp://send` URL scheme plus key press. |
| `gmail_control`          | Stub          | Implement | 3     | Gmail REST API with OAuth.                          |
| `google_calendar`        | Stub          | Implement | 3     | Calendar REST API with OAuth.                       |
| `google_drive`           | Stub          | Defer     | —     |                                                     |
| `google_maps`            | Stub          | Defer     | —     |                                                     |
| `social_media`           | Stub          | Defer     | —     |                                                     |

The Telegram bot (`core/telegram_bot.py`) is not a tool, but it is ported as a backend service in phase 3.

## Productivity and automation

| Tool                   | Legacy status | Decision  | Phase | Notes                                                                                 |
| ---------------------- | ------------- | --------- | ----- | ------------------------------------------------------------------------------------- |
| `reminder`             | Working       | Port      | 2     |                                                                                       |
| `goals`                | Working       | Port      | 2     |                                                                                       |
| `user_profile`         | Working       | Port      | 2     |                                                                                       |
| `agent_task`           | Working       | Port      | 2     | Priority task queue.                                                                  |
| `rules_engine`         | Partial       | Complete  | 2     | Legacy matches trigger phrases but never runs the action (`_run_action` only prints). |
| `proactive_automation` | Working       | Merge     | 2     | Overlaps with `rules_engine`; one automation engine in Rust.                          |
| `scheduler`            | Stub          | Implement | 2     | Rust backend service so it runs while the window is hidden.                           |
| `morning_brief`        | Stub          | Implement | 3     | Weather, calendar, email summary.                                                     |

## AI and development

| Tool               | Legacy status | Decision | Phase | Notes                                                                                                                             |
| ------------------ | ------------- | -------- | ----- | --------------------------------------------------------------------------------------------------------------------------------- |
| `openrouter_agent` | Working       | Port     | 3     |                                                                                                                                   |
| `code_helper`      | Working       | Port     | 6     | Runs code; needs the sandbox.                                                                                                     |
| `tool_creator`     | Working       | Redesign | 6     | Generates JavaScript run in `rquickjs` instead of Python. Legacy declaration requires a `description` parameter it never defines. |
| `auto_programmer`  | Working       | Redesign | 6     | Same sandbox as `tool_creator`.                                                                                                   |
| `self_edit`        | Working       | Redesign | 6     | A compiled app cannot edit its own source. Scope it to user-created tool scripts and settings.                                    |
| `dev_agent`        | Missing       | Defer    | —     | Legacy declaration requires a `description` parameter it never defines.                                                           |

The legacy `deepseek_agent.py` exists but is not declared as a tool; it is called internally. Port it with `openrouter_agent` in phase 3.

## Deferred (stubs and missing modules)

None of these are declared to the model until they are really implemented.

| Tool                    | Legacy status | Notes                                                    |
| ----------------------- | ------------- | -------------------------------------------------------- |
| `flight_finder`         | Stub          |                                                          |
| `image_generation`      | Stub          |                                                          |
| `smart_home`            | Stub          |                                                          |
| `git_control`           | Stub          |                                                          |
| `codebase`              | Stub          |                                                          |
| `knowledge_base`        | Stub          |                                                          |
| `tiktok_analyzer`       | Stub          |                                                          |
| `arca_invoice`          | Stub          | Argentine tax invoicing (AFIP/ARCA).                     |
| `game_updater`          | Missing       |                                                          |
| `rgb_control`           | Missing       |                                                          |
| `accessibility`         | Missing       | Eye tracking, task simplification, routine gamification. |
| `accessibility_overlay` | Missing       |                                                          |

## Summary

| Decision  | Count  |
| --------- | ------ |
| Port      | 30     |
| Merge     | 5      |
| Complete  | 1      |
| Implement | 5      |
| Redesign  | 6      |
| Defer     | 19     |
| **Total** | **66** |
