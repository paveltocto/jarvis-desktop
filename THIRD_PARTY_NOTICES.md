# Third-party notices

## openWakeWord models

Files: `src-tauri/resources/wake-word/melspectrogram.onnx`, `embedding_model.onnx`, `hey_jarvis_v0.1.onnx`

- Source: [openWakeWord](https://github.com/dscripka/openWakeWord) by David Scripka, release 0.4.0 (taken from the PyPI package).
- The openWakeWord **code** is licensed under the Apache License 2.0. The Rust detector in `src-tauri/src/audio/wake_word.rs` is a port of its streaming pipeline (`openwakeword/utils.py`).
- The **pre-trained models**, including `hey_jarvis_v0.1.onnx`, are licensed under [Creative Commons Attribution-NonCommercial-ShareAlike 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/). **They may not be used commercially.** Before any commercial distribution, replace them with a model you trained yourself or licensed for that use.
- `melspectrogram.onnx` and `embedding_model.onnx` are derived from Google's [speech_embedding](https://www.kaggle.com/models/google/speech-embedding) model (Apache License 2.0).

## Test fixtures

`src-tauri/tests/fixtures/*.wav` were synthesized with [eSpeak NG](https://github.com/espeak-ng/espeak-ng) and resampled to 16 kHz. They contain only the generated speech.

## Application icon

`assets/app-icon.png` is upscaled from the legacy app icon (`assets/jarvis_icono.ico` in `paveltocto/jarvis-ai`). A higher-resolution source (1024×1024) should replace it before release.
