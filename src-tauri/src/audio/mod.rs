//! Microphone capture, wake-word detection and audio streaming.
//!
//! Pipeline: microphone (any rate, any channel count) → mono → 16 kHz →
//! either the wake-word detector (while idle) or the frontend stream (while
//! a voice session is open). Audio never leaves the process unless the
//! frontend has opened a stream with [`AudioService::start_stream`].
//!
//! Threads:
//! - the capture thread owns the `cpal` stream (it is not `Send` on every
//!   platform) and forwards mono blocks without blocking the audio callback;
//! - the processing thread resamples, measures the input level, runs the
//!   detector and writes to the stream.

pub mod resample;
pub mod wake_word;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use resample::Resampler;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread::JoinHandle;
use tauri::ipc::{Channel, InvokeResponseBody};
use wake_word::WakeWordDetector;

/// Sample rate expected by the wake-word models and Gemini Live input.
pub const TARGET_SAMPLE_RATE: u32 = 16_000;
/// Samples per message sent to the frontend stream (32 ms).
const STREAM_BLOCK: usize = 512;
/// Samples per input-level measurement (50 ms).
const LEVEL_BLOCK: usize = 800;
/// Chunks (80 ms each) ignored after a detection, so one utterance fires once.
const WAKE_WORD_COOLDOWN_CHUNKS: usize = 25;
/// Blocks buffered between the audio callback and the processing thread.
const CAPTURE_QUEUE: usize = 64;
pub const DEFAULT_WAKE_WORD_THRESHOLD: f32 = 0.5;

/// Receives everything the processing thread reports.
pub trait AudioEvents: Send + Sync + 'static {
    /// RMS input level, `0.0..=1.0`, every 50 ms.
    fn level(&self, rms: f32);
    fn wake_word(&self, score: f32);
    fn error(&self, message: String);
}

#[derive(Debug, thiserror::Error)]
pub enum AudioError {
    #[error("no microphone was found")]
    NoInputDevice,
    #[error("the microphone could not be opened: {0}")]
    Device(String),
    #[error("unsupported microphone sample format: {0}")]
    UnsupportedFormat(String),
}

impl Serialize for AudioError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InputDeviceInfo {
    pub name: String,
    pub sample_rate: u32,
    pub channels: u16,
}

/// Settings shared between commands and the processing thread.
struct Shared {
    stream: Mutex<Option<Channel<InvokeResponseBody>>>,
    wake_word_enabled: AtomicBool,
    wake_word_threshold: AtomicU32,
    reset_detector: AtomicBool,
}

impl Shared {
    fn threshold(&self) -> f32 {
        f32::from_bits(self.wake_word_threshold.load(Ordering::Relaxed))
    }

    fn stream(&self) -> Option<Channel<InvokeResponseBody>> {
        self.stream
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }
}

struct Running {
    stop: mpsc::Sender<()>,
    capture: JoinHandle<()>,
    processing: JoinHandle<()>,
}

/// Owns the microphone. Managed as Tauri state.
pub struct AudioService {
    shared: Arc<Shared>,
    running: Mutex<Option<Running>>,
}

impl Default for AudioService {
    fn default() -> Self {
        Self::new()
    }
}

impl AudioService {
    pub fn new() -> Self {
        Self {
            shared: Arc::new(Shared {
                stream: Mutex::new(None),
                wake_word_enabled: AtomicBool::new(true),
                wake_word_threshold: AtomicU32::new(DEFAULT_WAKE_WORD_THRESHOLD.to_bits()),
                reset_detector: AtomicBool::new(false),
            }),
            running: Mutex::new(None),
        }
    }

    /// Opens the default microphone. Calling it while running is a no-op that
    /// returns the current device.
    pub fn start(&self, events: Arc<dyn AudioEvents>) -> Result<InputDeviceInfo, AudioError> {
        let mut running = self.running.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(current) = running.as_ref()
            && !current.capture.is_finished()
        {
            return input_device_info(&default_input_device()?);
        }
        if let Some(stale) = running.take() {
            stop_threads(stale);
        }

        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        let (ready_tx, ready_rx) =
            mpsc::channel::<Result<(InputDeviceInfo, Receiver<Vec<f32>>), AudioError>>();
        let capture_events = Arc::clone(&events);
        let capture = std::thread::Builder::new()
            .name("audio-capture".into())
            .spawn(move || capture_thread(stop_rx, ready_tx, capture_events))
            .map_err(|error| AudioError::Device(error.to_string()))?;

        let (info, blocks) = match ready_rx.recv() {
            Ok(Ok(ready)) => ready,
            Ok(Err(error)) => return Err(error),
            Err(_) => return Err(AudioError::Device("capture thread exited".into())),
        };

        let shared = Arc::clone(&self.shared);
        let input_rate = info.sample_rate;
        let processing = std::thread::Builder::new()
            .name("audio-processing".into())
            .spawn(move || {
                let mut processor = Processor::new(input_rate, shared, events);
                for block in blocks {
                    processor.process(&block);
                }
            })
            .map_err(|error| AudioError::Device(error.to_string()))?;

        *running = Some(Running {
            stop: stop_tx,
            capture,
            processing,
        });
        Ok(info)
    }

    /// Closes the microphone.
    pub fn stop(&self) {
        let running = self
            .running
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        if let Some(running) = running {
            stop_threads(running);
        }
        self.stop_stream();
    }

    /// Sends 16 kHz mono PCM (little-endian `i16`) to `channel` until
    /// [`AudioService::stop_stream`]. Wake-word detection pauses meanwhile.
    pub fn start_stream(&self, channel: Channel<InvokeResponseBody>) {
        *self
            .shared
            .stream
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some(channel);
    }

    pub fn stop_stream(&self) {
        let previous = self
            .shared
            .stream
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        if previous.is_some() {
            // Forget audio heard during the session so it cannot trigger a detection.
            self.shared.reset_detector.store(true, Ordering::Relaxed);
        }
    }

    pub fn configure_wake_word(&self, enabled: bool, threshold: f32) {
        self.shared
            .wake_word_enabled
            .store(enabled, Ordering::Relaxed);
        self.shared
            .wake_word_threshold
            .store(threshold.clamp(0.05, 0.99).to_bits(), Ordering::Relaxed);
    }
}

impl Drop for AudioService {
    fn drop(&mut self) {
        self.stop();
    }
}

fn stop_threads(running: Running) {
    // Dropping the stop sender also wakes the capture thread.
    let _ = running.stop.send(());
    let _ = running.capture.join();
    let _ = running.processing.join();
}

fn default_input_device() -> Result<cpal::Device, AudioError> {
    cpal::default_host()
        .default_input_device()
        .ok_or(AudioError::NoInputDevice)
}

fn input_device_info(device: &cpal::Device) -> Result<InputDeviceInfo, AudioError> {
    let config = device
        .default_input_config()
        .map_err(|error| AudioError::Device(error.to_string()))?;
    Ok(InputDeviceInfo {
        name: device
            .id()
            .map(|id| id.to_string())
            .unwrap_or_else(|_| "default microphone".into()),
        sample_rate: config.sample_rate(),
        channels: config.channels(),
    })
}

type Ready = Result<(InputDeviceInfo, Receiver<Vec<f32>>), AudioError>;

fn capture_thread(stop: Receiver<()>, ready: mpsc::Sender<Ready>, events: Arc<dyn AudioEvents>) {
    let (blocks_tx, blocks_rx) = mpsc::sync_channel::<Vec<f32>>(CAPTURE_QUEUE);
    let stream = match open_stream(blocks_tx, events) {
        Ok((stream, info)) => {
            let _ = ready.send(Ok((info, blocks_rx)));
            stream
        }
        Err(error) => {
            let _ = ready.send(Err(error));
            return;
        }
    };
    // Block until asked to stop (or the service is dropped).
    let _ = stop.recv();
    drop(stream);
}

fn open_stream(
    blocks: SyncSender<Vec<f32>>,
    events: Arc<dyn AudioEvents>,
) -> Result<(cpal::Stream, InputDeviceInfo), AudioError> {
    let device = default_input_device()?;
    let info = input_device_info(&device)?;
    let config = device
        .default_input_config()
        .map_err(|error| AudioError::Device(error.to_string()))?;
    let channels = usize::from(config.channels()).max(1);
    let on_error = move |error: cpal::Error| events.error(format!("microphone error: {error}"));

    macro_rules! build {
        ($sample:ty) => {{
            let blocks = blocks.clone();
            device.build_input_stream(
                config.clone().into(),
                move |data: &[$sample], _: &cpal::InputCallbackInfo| {
                    let mono: Vec<f32> = data
                        .chunks(channels)
                        .map(|frame| {
                            frame
                                .iter()
                                .map(|&s| <f32 as cpal::FromSample<$sample>>::from_sample_(s))
                                .sum::<f32>()
                                / frame.len() as f32
                        })
                        .collect();
                    // Never block the real-time callback; drop audio if processing lags.
                    if let Err(TrySendError::Full(_)) = blocks.try_send(mono) {}
                },
                on_error,
                None,
            )
        }};
    }

    let stream = match config.sample_format() {
        cpal::SampleFormat::F32 => build!(f32),
        cpal::SampleFormat::I16 => build!(i16),
        cpal::SampleFormat::I32 => build!(i32),
        cpal::SampleFormat::U16 => build!(u16),
        other => return Err(AudioError::UnsupportedFormat(other.to_string())),
    }
    .map_err(|error| AudioError::Device(error.to_string()))?;
    stream
        .play()
        .map_err(|error| AudioError::Device(error.to_string()))?;
    Ok((stream, info))
}

/// Runs on the processing thread. Separate from the device so it can be
/// tested with recorded audio.
struct Processor {
    resampler: Resampler,
    shared: Arc<Shared>,
    events: Arc<dyn AudioEvents>,
    detector: Option<WakeWordDetector>,
    detector_failed: bool,
    cooldown: usize,
    level_sum: f32,
    level_count: usize,
    stream_buffer: Vec<i16>,
}

impl Processor {
    fn new(input_rate: u32, shared: Arc<Shared>, events: Arc<dyn AudioEvents>) -> Self {
        Self {
            resampler: Resampler::new(input_rate, TARGET_SAMPLE_RATE),
            shared,
            events,
            detector: None,
            detector_failed: false,
            cooldown: 0,
            level_sum: 0.0,
            level_count: 0,
            stream_buffer: Vec::with_capacity(STREAM_BLOCK * 2),
        }
    }

    fn process(&mut self, block: &[f32]) {
        let samples: Vec<i16> = self
            .resampler
            .process(block)
            .into_iter()
            .map(|s| (s.clamp(-1.0, 1.0) * f32::from(i16::MAX)) as i16)
            .collect();
        self.measure_level(&samples);

        if let Some(channel) = self.shared.stream() {
            self.stream(&channel, &samples);
        } else {
            self.stream_buffer.clear();
            if self.shared.wake_word_enabled.load(Ordering::Relaxed) {
                self.detect(&samples);
            }
        }
    }

    fn measure_level(&mut self, samples: &[i16]) {
        for &sample in samples {
            let value = f32::from(sample) / f32::from(i16::MAX);
            self.level_sum += value * value;
            self.level_count += 1;
            if self.level_count == LEVEL_BLOCK {
                self.events
                    .level((self.level_sum / LEVEL_BLOCK as f32).sqrt());
                self.level_sum = 0.0;
                self.level_count = 0;
            }
        }
    }

    fn stream(&mut self, channel: &Channel<InvokeResponseBody>, samples: &[i16]) {
        self.stream_buffer.extend_from_slice(samples);
        while self.stream_buffer.len() >= STREAM_BLOCK {
            let bytes: Vec<u8> = self
                .stream_buffer
                .drain(..STREAM_BLOCK)
                .flat_map(i16::to_le_bytes)
                .collect();
            if channel.send(InvokeResponseBody::Raw(bytes)).is_err() {
                // The webview went away; stop streaming.
                self.shared
                    .stream
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .take();
                return;
            }
        }
    }

    fn detect(&mut self, samples: &[i16]) {
        if self.detector.is_none() && !self.detector_failed {
            match WakeWordDetector::new() {
                Ok(detector) => self.detector = Some(detector),
                Err(error) => {
                    self.detector_failed = true;
                    self.events.error(format!("wake word unavailable: {error}"));
                }
            }
        }
        let Some(detector) = self.detector.as_mut() else {
            return;
        };
        if self.shared.reset_detector.swap(false, Ordering::Relaxed) {
            if let Err(error) = detector.reset() {
                self.events.error(error.to_string());
            }
            self.cooldown = 0;
        }
        let scores = match detector.push(samples) {
            Ok(scores) => scores,
            Err(error) => {
                self.events.error(error.to_string());
                return;
            }
        };
        let threshold = self.shared.threshold();
        for score in scores {
            if self.cooldown > 0 {
                self.cooldown -= 1;
            } else if score >= threshold {
                self.cooldown = WAKE_WORD_COOLDOWN_CHUNKS;
                self.events.wake_word(score);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct Recorder {
        wake_words: Mutex<Vec<f32>>,
        levels: Mutex<Vec<f32>>,
        errors: Mutex<Vec<String>>,
    }

    impl AudioEvents for Recorder {
        fn level(&self, rms: f32) {
            self.levels.lock().unwrap().push(rms);
        }
        fn wake_word(&self, score: f32) {
            self.wake_words.lock().unwrap().push(score);
        }
        fn error(&self, message: String) {
            self.errors.lock().unwrap().push(message);
        }
    }

    fn fixture(name: &str) -> Vec<f32> {
        let path = format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
        let mut reader = hound::WavReader::open(path).unwrap();
        assert_eq!(reader.spec().sample_rate, 16_000);
        let mut samples = vec![0.0; 16_000];
        samples.extend(
            reader
                .samples::<i16>()
                .map(|s| f32::from(s.unwrap()) / f32::from(i16::MAX)),
        );
        samples.extend(vec![0.0; 16_000]);
        samples
    }

    /// Simulates a 48 kHz microphone delivering 10 ms callbacks.
    fn run(samples_16k: &[f32], service: &AudioService) -> Arc<Recorder> {
        let microphone = Resampler::new(16_000, 48_000).process(samples_16k);
        let recorder = Arc::new(Recorder::default());
        let mut processor = Processor::new(48_000, Arc::clone(&service.shared), recorder.clone());
        for block in microphone.chunks(480) {
            processor.process(block);
        }
        recorder
    }

    #[test]
    fn detects_hey_jarvis_through_the_full_pipeline() {
        let service = AudioService::new();
        for clip in ["hey-jarvis-en-us.wav", "hey-jarvis-en-gb.wav"] {
            let recorder = run(&fixture(clip), &service);
            let detections = recorder.wake_words.lock().unwrap().clone();
            assert_eq!(detections.len(), 1, "{clip}: {detections:?}");
            assert!(recorder.errors.lock().unwrap().is_empty());
        }
    }

    #[test]
    fn ignores_other_speech() {
        let service = AudioService::new();
        for clip in ["negative-en.wav", "negative-es.wav"] {
            let recorder = run(&fixture(clip), &service);
            assert!(recorder.wake_words.lock().unwrap().is_empty(), "{clip}");
        }
    }

    #[test]
    fn disabled_wake_word_never_fires() {
        let service = AudioService::new();
        service.configure_wake_word(false, 0.5);
        let recorder = run(&fixture("hey-jarvis-en-us.wav"), &service);
        assert!(recorder.wake_words.lock().unwrap().is_empty());
    }

    #[test]
    fn streams_pcm_instead_of_detecting_while_a_session_is_open() {
        let service = AudioService::new();
        let received = Arc::new(Mutex::new(Vec::<u8>::new()));
        let sink = Arc::clone(&received);
        service.start_stream(Channel::new(move |body| {
            if let InvokeResponseBody::Raw(bytes) = body {
                sink.lock().unwrap().extend(bytes);
            }
            Ok(())
        }));
        let samples = fixture("hey-jarvis-en-us.wav");
        let recorder = run(&samples, &service);

        assert!(recorder.wake_words.lock().unwrap().is_empty());
        let bytes = received.lock().unwrap().len();
        // 16-bit samples, whole blocks only, within one block of the input length.
        assert_eq!(bytes % (STREAM_BLOCK * 2), 0);
        assert!(
            (bytes / 2).abs_diff(samples.len()) <= STREAM_BLOCK,
            "{bytes} bytes"
        );
    }

    #[test]
    fn reports_input_level() {
        let service = AudioService::new();
        let recorder = run(&fixture("hey-jarvis-en-us.wav"), &service);
        let levels = recorder.levels.lock().unwrap();
        assert!(levels.iter().any(|&level| level > 0.05));
        assert!(
            levels.first().is_some_and(|&level| level < 0.001),
            "leading silence"
        );
    }

    #[test]
    fn threshold_is_clamped() {
        let service = AudioService::new();
        service.configure_wake_word(true, 5.0);
        assert!((service.shared.threshold() - 0.99).abs() < f32::EPSILON);
    }
}
