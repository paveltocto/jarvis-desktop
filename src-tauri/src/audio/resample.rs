//! Streaming mono sample-rate converter.
//!
//! Microphones usually run at 44.1 or 48 kHz, while the wake-word models and
//! Gemini Live expect 16 kHz. When downsampling, a windowed-sinc low-pass FIR
//! removes content above the new Nyquist frequency, then samples are picked
//! by linear interpolation. That is plenty for speech: after filtering, the
//! signal is heavily oversampled relative to its bandwidth.

use std::collections::VecDeque;

const FILTER_TAPS: usize = 63;
/// Fraction of the output Nyquist frequency kept by the low-pass filter.
const PASSBAND: f64 = 0.9;

pub struct Resampler {
    /// Input samples advanced per output sample.
    step: f64,
    taps: Vec<f32>,
    history: VecDeque<f32>,
    /// Last filtered sample of the previous call (interpolation anchor).
    previous: f32,
    /// Position of the next output sample, in input samples, relative to `previous`.
    position: f64,
}

impl Resampler {
    pub fn new(input_rate: u32, output_rate: u32) -> Self {
        assert!(
            input_rate > 0 && output_rate > 0,
            "sample rates must be positive"
        );
        let taps = if output_rate < input_rate {
            low_pass(PASSBAND * f64::from(output_rate) / 2.0 / f64::from(input_rate))
        } else {
            Vec::new()
        };
        Self {
            step: f64::from(input_rate) / f64::from(output_rate),
            history: std::iter::repeat_n(0.0, taps.len()).collect(),
            taps,
            previous: 0.0,
            position: 1.0,
        }
    }

    pub fn is_passthrough(&self) -> bool {
        self.step == 1.0
    }

    /// Converts the next block of input. State carries over between calls, so
    /// blocks of any size can be fed.
    pub fn process(&mut self, input: &[f32]) -> Vec<f32> {
        if self.is_passthrough() {
            return input.to_vec();
        }
        let filtered: Vec<f32> = input.iter().map(|&sample| self.filter(sample)).collect();
        let len = filtered.len() as f64;
        let mut output = Vec::with_capacity((len / self.step) as usize + 1);
        let at = |index: usize| {
            if index == 0 {
                self.previous
            } else {
                filtered[index - 1]
            }
        };
        while self.position < len {
            let index = self.position.floor() as usize;
            let fraction = (self.position - index as f64) as f32;
            output.push(at(index) * (1.0 - fraction) + at(index + 1) * fraction);
            self.position += self.step;
        }
        self.position -= len;
        if let Some(&last) = filtered.last() {
            self.previous = last;
        }
        output
    }

    fn filter(&mut self, sample: f32) -> f32 {
        if self.taps.is_empty() {
            return sample;
        }
        self.history.pop_front();
        self.history.push_back(sample);
        self.history
            .iter()
            .zip(&self.taps)
            .map(|(x, h)| x * h)
            .sum()
    }
}

/// Hamming-windowed sinc low-pass. `cutoff` is in cycles per input sample.
fn low_pass(cutoff: f64) -> Vec<f32> {
    let middle = (FILTER_TAPS - 1) as f64 / 2.0;
    let taps: Vec<f64> = (0..FILTER_TAPS)
        .map(|i| {
            let t = i as f64 - middle;
            let sinc = if t == 0.0 {
                2.0 * cutoff
            } else {
                (2.0 * std::f64::consts::PI * cutoff * t).sin() / (std::f64::consts::PI * t)
            };
            let window = 0.54
                - 0.46 * (2.0 * std::f64::consts::PI * i as f64 / (FILTER_TAPS - 1) as f64).cos();
            sinc * window
        })
        .collect();
    let sum: f64 = taps.iter().sum();
    taps.iter().map(|tap| (tap / sum) as f32).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(frequency: f64, rate: u32, seconds: f64) -> Vec<f32> {
        let n = (f64::from(rate) * seconds) as usize;
        (0..n)
            .map(|i| {
                (2.0 * std::f64::consts::PI * frequency * i as f64 / f64::from(rate)).sin() as f32
            })
            .collect()
    }

    fn rms(samples: &[f32]) -> f32 {
        (samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32).sqrt()
    }

    #[test]
    fn same_rate_is_passthrough() {
        let mut resampler = Resampler::new(16_000, 16_000);
        assert_eq!(resampler.process(&[0.1, 0.2, 0.3]), vec![0.1, 0.2, 0.3]);
    }

    #[test]
    fn output_length_follows_the_ratio_across_blocks() {
        for rate in [44_100, 48_000] {
            let mut resampler = Resampler::new(rate, 16_000);
            let input = sine(440.0, rate, 1.0);
            let total: usize = input
                .chunks(441)
                .map(|block| resampler.process(block).len())
                .sum();
            assert!(
                (total as i64 - 16_000).abs() <= 1,
                "{rate} Hz produced {total} samples"
            );
        }
    }

    #[test]
    fn keeps_speech_frequencies() {
        let mut resampler = Resampler::new(48_000, 16_000);
        let output = resampler.process(&sine(1_000.0, 48_000, 0.5));
        let level = rms(&output[200..]);
        assert!(
            (level - std::f32::consts::FRAC_1_SQRT_2).abs() < 0.03,
            "rms {level}"
        );
    }

    #[test]
    fn removes_frequencies_above_the_new_nyquist() {
        let mut resampler = Resampler::new(48_000, 16_000);
        let output = resampler.process(&sine(12_000.0, 48_000, 0.5));
        let level = rms(&output[200..]);
        assert!(level < 0.01, "12 kHz should be filtered out, rms {level}");
    }

    #[test]
    fn upsampling_interpolates() {
        let mut resampler = Resampler::new(8_000, 16_000);
        let output = resampler.process(&[0.0, 1.0, 0.0, 1.0]);
        // One input sample of latency: positions 1.0, 1.5, ... 3.5.
        assert_eq!(output.len(), 6);
        assert!((output[1] - 0.5).abs() < 1e-6);
    }
}
