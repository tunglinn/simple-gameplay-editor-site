// Unit tests for the pure utility functions in export-utils.js.
// These run in Node.js — no browser, no DOM, no GPU.
//
// Why test these separately from the full export pipeline?
// The codec and canvas APIs (VideoDecoder, OffscreenCanvas, createImageBitmap)
// can only be meaningfully tested in a real browser (see tests/e2e/export.spec.js).
// But the orchestration logic — which samples belong to a clip, how timestamps
// convert, what H.264 level a video needs, what bytes go into a decoder config —
// is pure arithmetic that we can verify exhaustively here, fast, with no GPU.

import { createRequire } from 'node:module';
import { describe, it, expect } from 'vitest';

// export-utils.js uses CommonJS `module.exports` at the bottom for exactly this
// purpose: allowing Node.js / Vitest to require the same file the browser loads
// as a <script> tag.  No duplication of function bodies required.
const require = createRequire(import.meta.url);
const {
  fmt, fmtDur, wcFmtSize,
  wcPickH264Codec,
  wcSerializeAvcC, wcSerializeHvcC,
  wcGetSamplesForClip,
} = require('../../export-utils.js');

// ─────────────────────────────────────────────────────────────────────────────
// fmt — timestamp display (e.g. "1:23.4")
// ─────────────────────────────────────────────────────────────────────────────
describe('fmt', () => {
  it('formats zero as 0:00.0', () => {
    expect(fmt(0)).toBe('0:00.0');
  });

  it('formats whole seconds', () => {
    expect(fmt(90)).toBe('1:30.0');
  });

  it('includes tenths of a second', () => {
    expect(fmt(1.75)).toBe('0:01.7'); // floor, not round
  });

  it('zero-pads seconds below 10', () => {
    expect(fmt(65)).toBe('1:05.0');
  });

  it('returns --:-- for null', () => {
    expect(fmt(null)).toBe('--:--');
  });

  it('returns --:-- for undefined', () => {
    expect(fmt(undefined)).toBe('--:--');
  });

  it('returns --:-- for NaN', () => {
    expect(fmt(NaN)).toBe('--:--');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// fmtDur — compact duration (e.g. "12.5s" or "2m05s")
// ─────────────────────────────────────────────────────────────────────────────
describe('fmtDur', () => {
  it('formats sub-minute durations with one decimal', () => {
    expect(fmtDur(12.5)).toBe('12.5s');
  });

  it('formats minute-plus durations with zero-padded seconds', () => {
    expect(fmtDur(125)).toBe('2m05s');
  });

  it('formats exactly 60 seconds as minutes', () => {
    expect(fmtDur(60)).toBe('1m00s');
  });

  it('returns empty string for negative input', () => {
    expect(fmtDur(-1)).toBe('');
  });

  it('returns empty string for NaN', () => {
    expect(fmtDur(NaN)).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// wcFmtSize — human-readable file size
// ─────────────────────────────────────────────────────────────────────────────
describe('wcFmtSize', () => {
  it('formats megabytes as whole number', () => {
    expect(wcFmtSize(50 * 1_048_576)).toBe('50 MB');
  });

  it('formats gigabytes with one decimal place', () => {
    expect(wcFmtSize(1.5 * 1_073_741_824)).toBe('1.5 GB');
  });

  it('formats exactly 1 MB', () => {
    expect(wcFmtSize(1_048_576)).toBe('1 MB');
  });

  it('formats sub-MB as 0 MB (rounds down)', () => {
    expect(wcFmtSize(500_000)).toBe('0 MB');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// wcPickH264Codec — select minimum H.264 level for the given resolution + fps
// ─────────────────────────────────────────────────────────────────────────────
describe('wcPickH264Codec', () => {
  // The function counts macroblocks per second (MBs/sec).
  // Each macroblock = 16×16 pixels.
  // Level thresholds:  > 589 824 → 5.1,  > 245 760 → 5.0,  else → 4.0

  it('720p @ 30fps uses Level 4.0', () => {
    // 80 × 45 × 30 = 108 000 MBs/sec — well under 245 760
    expect(wcPickH264Codec(1280, 720, 30)).toBe('avc1.640028');
  });

  it('1080p @ 30fps uses Level 4.0', () => {
    // 120 × 68 × 30 = 244 800 MBs/sec — just under 245 760
    expect(wcPickH264Codec(1920, 1080, 30)).toBe('avc1.640028');
  });

  it('1080p @ 60fps uses Level 5.0', () => {
    // 120 × 68 × 60 = 489 600 MBs/sec — between 245 760 and 589 824
    expect(wcPickH264Codec(1920, 1080, 60)).toBe('avc1.640032');
  });

  it('1440p @ 30fps uses Level 5.0', () => {
    // 160 × 90 × 30 = 432 000 MBs/sec
    expect(wcPickH264Codec(2560, 1440, 30)).toBe('avc1.640032');
  });

  it('4K @ 30fps uses Level 5.1', () => {
    // 240 × 135 × 30 = 972 000 MBs/sec — above 589 824
    expect(wcPickH264Codec(3840, 2160, 30)).toBe('avc1.640033');
  });

  it('4K @ 60fps uses Level 5.1', () => {
    expect(wcPickH264Codec(3840, 2160, 60)).toBe('avc1.640033');
  });

  it('rounds up to the next macroblock on non-multiples of 16', () => {
    // 1920×1088 (padded 1080p) — same level as 1920×1080
    expect(wcPickH264Codec(1920, 1088, 30)).toBe('avc1.640028');
    // 1916 wide → Math.ceil(1916/16) = 120, same as 1920
    expect(wcPickH264Codec(1916, 1080, 30)).toBe('avc1.640028');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// wcSerializeAvcC — build AVCDecoderConfigurationRecord bytes from MP4Box data
// ─────────────────────────────────────────────────────────────────────────────
describe('wcSerializeAvcC', () => {
  // Real SPS/PPS bytes for a 1920×1080 H.264 High Profile Level 4.0 stream.
  // These aren't decoded by the test — they're treated as opaque payloads and
  // we just verify they are placed at the right byte offsets.
  const spsNalu = new Uint8Array([0x67, 0x64, 0x00, 0x28, 0xac, 0xd9, 0x40]);
  const ppsNalu = new Uint8Array([0x68, 0xeb, 0xe3, 0xcb, 0x22, 0xc0]);

  const box = {
    configurationVersion: 1,
    AVCProfileIndication:  0x64, // High Profile
    profile_compatibility: 0x00,
    AVCLevelIndication:    0x28, // Level 4.0
    lengthSizeMinusOne:    3,
    SPS: [{ nalu: spsNalu }],
    PPS: [{ nalu: ppsNalu }],
  };

  it('produces a buffer of the correct total length', () => {
    const result = wcSerializeAvcC(box);
    // 5 fixed header bytes
    // + 1 byte (numSPS with reserved bits)
    // + 2 byte SPS length  + spsNalu.byteLength
    // + 1 byte (numPPS)
    // + 2 byte PPS length  + ppsNalu.byteLength
    const expected = 5 + 1 + (2 + spsNalu.byteLength) + 1 + (2 + ppsNalu.byteLength);
    expect(result.byteLength).toBe(expected);
  });

  it('sets configurationVersion = 1 at byte 0', () => {
    expect(wcSerializeAvcC(box)[0]).toBe(1);
  });

  it('sets AVCProfileIndication at byte 1', () => {
    expect(wcSerializeAvcC(box)[1]).toBe(0x64); // High Profile
  });

  it('sets AVCLevelIndication at byte 3', () => {
    expect(wcSerializeAvcC(box)[3]).toBe(0x28); // Level 4.0
  });

  it('packs lengthSizeMinusOne with 0xfc reserved bits at byte 4', () => {
    // lengthSizeMinusOne=3 → (3 & 0x3) | 0xfc = 0xff
    expect(wcSerializeAvcC(box)[4]).toBe(0xff);
  });

  it('packs numSPS with 0xe0 reserved bits at byte 5', () => {
    // 1 SPS → (1 & 0x1f) | 0xe0 = 0xe1
    expect(wcSerializeAvcC(box)[5]).toBe(0xe1);
  });

  it('writes SPS length as big-endian uint16 at bytes 6–7', () => {
    const result = wcSerializeAvcC(box);
    const len = (result[6] << 8) | result[7];
    expect(len).toBe(spsNalu.byteLength);
  });

  it('embeds SPS NALU bytes verbatim', () => {
    const result = wcSerializeAvcC(box);
    expect(Array.from(result.slice(8, 8 + spsNalu.byteLength))).toEqual(Array.from(spsNalu));
  });

  it('handles empty SPS and PPS (minimal 7-byte output)', () => {
    const result = wcSerializeAvcC({ ...box, SPS: [], PPS: [] });
    // 5 header + 1 numSPS (0xe0) + 1 numPPS (0) = 7 bytes
    expect(result.byteLength).toBe(7);
    expect(result[5]).toBe(0xe0); // 0 SPSs, reserved bits set
    expect(result[6]).toBe(0x00); // 0 PPSs
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// wcSerializeHvcC — build HEVCDecoderConfigurationRecord bytes from MP4Box data
// ─────────────────────────────────────────────────────────────────────────────
describe('wcSerializeHvcC', () => {
  // Synthetic NAL units — content is not decoded, just checked for placement.
  const vpsNalu = new Uint8Array([0x40, 0x01, 0x0c, 0x01, 0xff]);
  const spsNalu = new Uint8Array([0x42, 0x01, 0x01, 0x01, 0x60, 0x00]);
  const ppsNalu = new Uint8Array([0x44, 0x01, 0xc1, 0x72, 0xb4, 0x62, 0x40]);

  const box = {
    configurationVersion: 1,
    general_profile_space: 0,
    general_tier_flag: 0,
    general_profile_idc: 1,              // Main profile
    general_profile_compatibility_flags: 0x60000000,
    general_constraint_indicator_flags: new Uint8Array([0x90, 0x00, 0x00, 0x00, 0x00, 0x00]),
    general_level_idc: 93,               // Level 3.1
    min_spatial_segmentation_idc: 0,
    parallelismType: 0,
    chroma_format_idc: 1,                // 4:2:0
    bit_depth_luma_minus8: 0,
    bit_depth_chroma_minus8: 0,
    avgFrameRate: 0,
    constantFrameRate: 0,
    numTemporalLayers: 1,
    temporalIdNested: 1,
    lengthSizeMinusOne: 3,
    NaluArrays: [
      { completeness: 1, nal_unit_type: 32, units: [{ data: vpsNalu }] }, // VPS
      { completeness: 1, nal_unit_type: 33, units: [{ data: spsNalu }] }, // SPS
      { completeness: 1, nal_unit_type: 34, units: [{ data: ppsNalu }] }, // PPS
    ],
  };

  it('starts with configurationVersion = 1', () => {
    expect(wcSerializeHvcC(box)[0]).toBe(1);
  });

  it('packs profile_space, tier_flag, profile_idc into byte 1', () => {
    // space=0, tier=0, idc=1 → (0<<6)|(0<<5)|(1) = 0x01
    expect(wcSerializeHvcC(box)[1]).toBe(0x01);
  });

  it('writes general_profile_compatibility_flags as big-endian uint32 at bytes 2–5', () => {
    const result = wcSerializeHvcC(box);
    const view = new DataView(result.buffer);
    expect(view.getUint32(2, false)).toBe(0x60000000);
  });

  it('copies constraint_indicator_flags as 6 bytes at bytes 6–11', () => {
    const result = wcSerializeHvcC(box);
    expect(Array.from(result.slice(6, 12))).toEqual([0x90, 0x00, 0x00, 0x00, 0x00, 0x00]);
  });

  it('writes general_level_idc at byte 12', () => {
    expect(wcSerializeHvcC(box)[12]).toBe(93);
  });

  it('produces 24-byte buffer when NaluArrays is empty', () => {
    // 23-byte fixed header + 1-byte numArrays = 24
    const result = wcSerializeHvcC({ ...box, NaluArrays: [] });
    expect(result.byteLength).toBe(24);
  });

  it('produces the correct total length with 3 NAL arrays', () => {
    const result = wcSerializeHvcC(box);
    // 24 header + 3×(1 type byte + 2 numNalus) + per-nalu (2 len + data)
    const expected = 24
      + 3 * 3
      + (2 + vpsNalu.byteLength)
      + (2 + spsNalu.byteLength)
      + (2 + ppsNalu.byteLength);
    expect(result.byteLength).toBe(expected);
  });

  it('sets array_completeness bit for VPS array at byte 23', () => {
    // completeness=1, nal_unit_type=32 → (1<<7)|(32) = 0xa0
    // Fixed header ends at byte 22 (numArrays), so first array type byte is at 23.
    expect(wcSerializeHvcC(box)[23]).toBe(0xa0);
  });

  it('treats missing constraint_indicator_flags as zero bytes', () => {
    const result = wcSerializeHvcC({ ...box, general_constraint_indicator_flags: undefined });
    // Bytes 6–11 should all be 0x00 (the buffer was zero-initialised)
    expect(Array.from(result.slice(6, 12))).toEqual([0, 0, 0, 0, 0, 0]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// wcGetSamplesForClip — select samples covering a clip, starting from pre-roll keyframe
// ─────────────────────────────────────────────────────────────────────────────
describe('wcGetSamplesForClip', () => {
  const TS = 90_000; // typical MP4 timescale (90 000 ticks/sec)

  // 20 samples at 0.5 s intervals (0 s … 9.5 s).
  // Keyframes (I-frames) at 0 s (index 0) and 5 s (index 10).
  // All other samples are P-frames.
  const makeSample = (i) => ({
    dts:      i * 0.5 * TS,
    cts:      i * 0.5 * TS, // no B-frames in this fixture
    is_sync:  i === 0 || i === 10,
    timescale: TS,
    duration:  Math.round(TS / 30),
    data:      new Uint8Array(4),
  });
  const samples = Array.from({ length: 20 }, (_, i) => makeSample(i));

  it('starts from the keyframe immediately before clip.start', () => {
    // Clip starts at 6 s. Nearest preceding keyframe is at 5 s (index 10).
    const { allSamples } = wcGetSamplesForClip(samples, { start: 6, end: 8 }, TS);
    expect(allSamples[0].dts / TS).toBe(5);
  });

  it('includes all samples up to clip.end + 1 s (B-frame margin)', () => {
    const { allSamples } = wcGetSamplesForClip(samples, { start: 6, end: 8 }, TS);
    // Last sample whose dts ≤ 9 s (= 8 + 1): index 18, dts = 9 s
    expect(allSamples[allSamples.length - 1].dts / TS).toBeLessThanOrEqual(9);
    // The sample at 9.5 s is excluded (9.5 > 9)
    const maxDts = Math.max(...allSamples.map(s => s.dts / TS));
    expect(maxDts).toBeLessThanOrEqual(9);
  });

  it('frameSamples only includes samples at or after clip.start (±2 ms tolerance)', () => {
    const { frameSamples } = wcGetSamplesForClip(samples, { start: 6, end: 8 }, TS);
    // Every frameSample must have cts ≥ clip.start - 0.002
    frameSamples.forEach(s => {
      expect(s.cts / TS).toBeGreaterThanOrEqual(6 - 0.002);
    });
  });

  it('falls back to the first keyframe when clip.start precedes all keyframes', () => {
    // Clip starts at 0.1 s, before the first keyframe at 0 s would cover it,
    // but prerollIdx search finds no keyframe before 0.1 s → falls back to index 0.
    const { allSamples } = wcGetSamplesForClip(samples, { start: 0.1, end: 2 }, TS);
    expect(allSamples[0].dts / TS).toBe(0);
  });

  it('throws when no keyframes exist anywhere in the track', () => {
    const noKeyframes = samples.map(s => ({ ...s, is_sync: false }));
    expect(() => wcGetSamplesForClip(noKeyframes, { start: 1, end: 3 }, TS))
      .toThrow('No keyframes found in video track');
  });

  it('uses per-sample timescale when present', () => {
    // Some MP4s store timescale on the sample itself rather than only on the track.
    const altTS = 600;
    const altSamples = [
      { dts: 0,    cts: 0,    is_sync: true,  timescale: altTS, duration: 20, data: new Uint8Array(1) },
      { dts: 20,   cts: 20,   is_sync: false, timescale: altTS, duration: 20, data: new Uint8Array(1) },
      { dts: 40,   cts: 40,   is_sync: false, timescale: altTS, duration: 20, data: new Uint8Array(1) },
    ];
    // clip from 0 s to 0.05 s at altTS=600
    const { frameSamples } = wcGetSamplesForClip(altSamples, { start: 0, end: 0.05 }, TS);
    // cts=0/600=0, cts=20/600≈0.033, cts=40/600≈0.067 → two samples ≤ 0.05+0.002
    expect(frameSamples.length).toBe(2);
  });
});
