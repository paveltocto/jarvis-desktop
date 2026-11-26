import { describe, expect, it } from "vitest";
import { base64ToBytes, bytesToBase64, pcm16ToFloat32, rms } from "./pcm";

describe("pcm", () => {
  it("round-trips base64", () => {
    const bytes = new Uint8Array(100_000).map((_, i) => i % 256);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });

  it("decodes little-endian int16", () => {
    const bytes = new Uint8Array([0x00, 0x00, 0xff, 0x7f, 0x00, 0x80]);
    const samples = pcm16ToFloat32(bytes);
    expect(samples[0]).toBe(0);
    expect(samples[1]).toBeCloseTo(1, 3);
    expect(samples[2]).toBe(-1);
  });

  it("ignores a trailing odd byte", () => {
    expect(pcm16ToFloat32(new Uint8Array(5))).toHaveLength(2);
  });

  it("computes rms", () => {
    expect(rms([])).toBe(0);
    expect(rms([1, -1, 1, -1])).toBe(1);
  });
});
