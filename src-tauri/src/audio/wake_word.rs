//! "Hey JARVIS" wake-word detection.
//!
//! A Rust port of the openWakeWord streaming pipeline
//! (https://github.com/dscripka/openWakeWord, `openwakeword/utils.py`):
//!
//! 1. Audio arrives as 16 kHz mono `i16` and is processed in 80 ms chunks
//!    (1280 samples).
//! 2. A melspectrogram model turns the latest chunk (plus 480 samples of
//!    context) into mel frames, transformed with `x / 10 + 2`.
//! 3. An embedding model turns the latest 76 mel frames into one
//!    96-dimensional feature vector per chunk.
//! 4. The wake-word classifier scores the latest 16 feature vectors.
//!
//! Inference uses `tract`, a pure-Rust ONNX runtime, so there is no native
//! library to download, bundle or sign.

use std::collections::VecDeque;
use tract_onnx::prelude::*;

/// Samples per processing chunk (80 ms at 16 kHz).
pub const CHUNK_SAMPLES: usize = 1280;
const CONTEXT_SAMPLES: usize = 160 * 3;
const MEL_BINS: usize = 32;
const MEL_WINDOW: usize = 76;
const MEL_BUFFER_MAX: usize = 10 * 97;
const EMBEDDING_DIM: usize = 96;
const FEATURE_BUFFER_MAX: usize = 120;
/// Predictions right after a reset are unreliable; openWakeWord zeroes the first five.
/// Feature vectors the `hey_jarvis` classifier looks at (input shape `[1, 16, 96]`).
const CLASSIFIER_FRAMES: usize = 16;
const WARMUP_PREDICTIONS: usize = 5;

const MELSPEC_MODEL: &[u8] = include_bytes!("../../resources/wake-word/melspectrogram.onnx");
const EMBEDDING_MODEL: &[u8] = include_bytes!("../../resources/wake-word/embedding_model.onnx");
const HEY_JARVIS_MODEL: &[u8] = include_bytes!("../../resources/wake-word/hey_jarvis_v0.1.onnx");

type Plan = Arc<TypedRunnableModel>;

#[derive(Debug, thiserror::Error)]
pub enum WakeWordError {
    #[error("wake-word model error: {0}")]
    Model(String),
}

impl From<TractError> for WakeWordError {
    fn from(error: TractError) -> Self {
        Self::Model(format!("{error:#}"))
    }
}

pub type Result<T> = std::result::Result<T, WakeWordError>;

fn load(bytes: &[u8], shape: &[usize]) -> Result<Plan> {
    Ok(tract_onnx::onnx()
        .model_for_read(&mut &bytes[..])?
        .with_input_fact(0, f32::fact(shape).into())?
        .into_optimized()?
        .into_runnable()?)
}

/// Streaming detector for the "hey jarvis" phrase.
pub struct WakeWordDetector {
    melspec: Plan,
    embedding: Plan,
    classifier: Plan,
    classifier_frames: usize,
    /// Latest raw samples (chunk + context) fed to the melspectrogram model.
    raw: VecDeque<i16>,
    /// Samples received but not yet forming a full chunk.
    pending: Vec<i16>,
    mel: VecDeque<[f32; MEL_BINS]>,
    features: VecDeque<[f32; EMBEDDING_DIM]>,
    predictions: usize,
}

impl WakeWordDetector {
    pub fn new() -> Result<Self> {
        let classifier_frames = CLASSIFIER_FRAMES;
        let mut detector = Self {
            melspec: load(MELSPEC_MODEL, &[1, CHUNK_SAMPLES + CONTEXT_SAMPLES])?,
            embedding: load(EMBEDDING_MODEL, &[1, MEL_WINDOW, MEL_BINS, 1])?,
            classifier: load(HEY_JARVIS_MODEL, &[1, classifier_frames, EMBEDDING_DIM])?,
            classifier_frames,
            raw: VecDeque::new(),
            pending: Vec::new(),
            mel: VecDeque::new(),
            features: VecDeque::new(),
            predictions: 0,
        };
        detector.reset()?;
        Ok(detector)
    }

    /// Clears all buffers. Call after the microphone was paused so stale
    /// audio cannot trigger a detection.
    pub fn reset(&mut self) -> Result<()> {
        self.pending.clear();
        self.features.clear();
        self.reset_audio_buffers();
        // openWakeWord seeds the feature buffer with 4 s of low-level noise.
        let mut seed: u32 = 0x9E37_79B9;
        let noise: Vec<i16> = (0..16_000 * 4)
            .map(|_| {
                seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                ((seed >> 16) % 2000) as i16 - 1000
            })
            .collect();
        for chunk in noise.as_chunks::<CHUNK_SAMPLES>().0 {
            self.process_chunk(chunk)?;
        }
        self.reset_audio_buffers();
        self.predictions = 0;
        Ok(())
    }

    fn reset_audio_buffers(&mut self) {
        self.raw = std::iter::repeat_n(0, CONTEXT_SAMPLES).collect();
        self.mel = std::iter::repeat_n([1.0; MEL_BINS], MEL_WINDOW).collect();
    }

    /// Feeds 16 kHz mono samples. Returns one score in `0.0..=1.0` for each
    /// completed 80 ms chunk.
    pub fn push(&mut self, samples: &[i16]) -> Result<Vec<f32>> {
        self.pending.extend_from_slice(samples);
        let complete = self.pending.len() / CHUNK_SAMPLES * CHUNK_SAMPLES;
        let chunks: Vec<i16> = self.pending.drain(..complete).collect();
        let mut scores = Vec::with_capacity(chunks.len() / CHUNK_SAMPLES);
        for chunk in chunks.as_chunks::<CHUNK_SAMPLES>().0 {
            self.process_chunk(chunk)?;
            scores.push(self.score()?);
        }
        Ok(scores)
    }

    fn process_chunk(&mut self, chunk: &[i16]) -> Result<()> {
        self.raw.extend(chunk.iter().copied());
        while self.raw.len() > CHUNK_SAMPLES + CONTEXT_SAMPLES {
            self.raw.pop_front();
        }

        let input: Vec<f32> = self.raw.iter().map(|&s| f32::from(s)).collect();
        let input = Tensor::from_shape(&[1, input.len()], &input)?;
        let output = self.melspec.run(tvec!(input.into_tvalue()))?;
        let frames = output[0].to_plain_array_view::<f32>()?;
        for frame in frames
            .as_slice()
            .unwrap_or_default()
            .as_chunks::<MEL_BINS>()
            .0
        {
            let mut row = [0.0; MEL_BINS];
            for (dst, src) in row.iter_mut().zip(frame) {
                *dst = src / 10.0 + 2.0;
            }
            self.mel.push_back(row);
        }
        while self.mel.len() > MEL_BUFFER_MAX {
            self.mel.pop_front();
        }

        let window: Vec<f32> = self
            .mel
            .iter()
            .skip(self.mel.len() - MEL_WINDOW)
            .flatten()
            .copied()
            .collect();
        let input = Tensor::from_shape(&[1, MEL_WINDOW, MEL_BINS, 1], &window)?;
        let output = self.embedding.run(tvec!(input.into_tvalue()))?;
        let embedding = output[0].to_plain_array_view::<f32>()?;
        let mut row = [0.0; EMBEDDING_DIM];
        for (dst, src) in row.iter_mut().zip(embedding.iter()) {
            *dst = *src;
        }
        self.features.push_back(row);
        while self.features.len() > FEATURE_BUFFER_MAX {
            self.features.pop_front();
        }
        Ok(())
    }

    fn score(&mut self) -> Result<f32> {
        let window: Vec<f32> = self
            .features
            .iter()
            .skip(self.features.len().saturating_sub(self.classifier_frames))
            .flatten()
            .copied()
            .collect();
        let input = Tensor::from_shape(&[1, self.classifier_frames, EMBEDDING_DIM], &window)?;
        let output = self.classifier.run(tvec!(input.into_tvalue()))?;
        let score = output[0]
            .to_plain_array_view::<f32>()?
            .iter()
            .next()
            .copied()
            .unwrap_or(0.0);
        self.predictions += 1;
        Ok(if self.predictions <= WARMUP_PREDICTIONS {
            0.0
        } else {
            score
        })
    }
}
