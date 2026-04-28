// Pure utility functions for the export pipeline.
// No DOM references, no global state, no browser-API dependencies.
// Loaded as a plain <script> in the browser (functions become globals on window).
// Required as a CommonJS module in tests via:
//   const utils = require('./export-utils.js');

function fmt(s) {
  if (s === null || s === undefined || isNaN(s)) return '--:--';
  const m   = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  const f   = Math.floor((s % 1) * 10);
  return `${m}:${String(sec).padStart(2,'0')}.${f}`;
}

function fmtDur(s) {
  if (isNaN(s) || s < 0) return '';
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s/60)}m${String(Math.floor(s%60)).padStart(2,'0')}s`;
}

function wcYield() { return new Promise(r => setTimeout(r, 0)); }

function wcFmtSize(bytes) {
  return bytes > 1_073_741_824
    ? (bytes / 1_073_741_824).toFixed(1) + ' GB'
    : (bytes / 1_048_576).toFixed(0) + ' MB';
}

function wcPickH264Codec(width, height, fps) {
  // H.264 defines levels by the maximum macroblocks-per-second (MBs/sec) a
  // decoder/encoder must handle, where each macroblock covers 16×16 pixels.
  // Choosing a level lower than the video requires causes the encoder to
  // reject or corrupt frames silently.
  //   Level 4.0 (0x28): ≤ 245 760 MBs/sec — 1920×1080 @ 30 fps
  //   Level 5.0 (0x32): ≤ 589 824 MBs/sec — ~2560×1440 @ 30 fps
  //   Level 5.1 (0x33): ≤ 983 040 MBs/sec — 3840×2160 @ 30 fps (4K)
  const mbsPerSec = Math.ceil(width / 16) * Math.ceil(height / 16) * fps;
  if (mbsPerSec > 589_824) return 'avc1.640033'; // Level 5.1 — 4K
  if (mbsPerSec > 245_760) return 'avc1.640032'; // Level 5.0 — 1440p or 1080p60
  return 'avc1.640028';                           // Level 4.0 — 1080p30 and below
}

function wcSerializeAvcC(box) {
  const spsList = box.SPS || [];
  const ppsList = box.PPS || [];

  let size = 6 + 1; // 5 config bytes + 1 numSPS + 1 numPPS
  for (const s of spsList) size += 2 + s.nalu.byteLength;
  for (const p of ppsList) size += 2 + p.nalu.byteLength;

  const buf = new Uint8Array(size);
  const view = new DataView(buf.buffer);
  let o = 0;

  buf[o++] = box.configurationVersion || 1;
  buf[o++] = box.AVCProfileIndication;
  buf[o++] = box.profile_compatibility;
  buf[o++] = box.AVCLevelIndication;
  buf[o++] = (box.lengthSizeMinusOne & 0x3) | 0xfc; // upper 6 bits reserved = 1
  buf[o++] = (spsList.length & 0x1f) | 0xe0;         // upper 3 bits reserved = 1
  for (const s of spsList) {
    view.setUint16(o, s.nalu.byteLength, false); o += 2; // big-endian
    buf.set(s.nalu, o); o += s.nalu.byteLength;
  }
  buf[o++] = ppsList.length;
  for (const p of ppsList) {
    view.setUint16(o, p.nalu.byteLength, false); o += 2;
    buf.set(p.nalu, o); o += p.nalu.byteLength;
  }
  return buf;
}

function wcSerializeHvcC(box) {
  const naluArrays = box.NaluArrays || [];

  let size = 23 + 1;
  for (const arr of naluArrays) {
    size += 1 + 2;
    for (const unit of arr.units) {
      size += 2 + unit.data.byteLength;
    }
  }

  const buf  = new Uint8Array(size);
  const view = new DataView(buf.buffer);
  let o = 0;

  buf[o++] = box.configurationVersion || 1;
  buf[o++] = ((box.general_profile_space & 0x3) << 6) |
             ((box.general_tier_flag     & 0x1) << 5) |
              (box.general_profile_idc   & 0x1f);
  view.setUint32(o, box.general_profile_compatibility_flags || 0, false); o += 4;
  const gcif = box.general_constraint_indicator_flags;
  if (gcif && gcif.length === 6) buf.set(gcif, o);
  o += 6;
  buf[o++] = box.general_level_idc || 0;
  view.setUint16(o, 0xf000 | (box.min_spatial_segmentation_idc & 0x0fff), false); o += 2;
  buf[o++] = 0xfc | (box.parallelismType       & 0x3);
  buf[o++] = 0xfc | (box.chroma_format_idc     & 0x3);
  buf[o++] = 0xf8 | (box.bit_depth_luma_minus8   & 0x7);
  buf[o++] = 0xf8 | (box.bit_depth_chroma_minus8 & 0x7);
  view.setUint16(o, box.avgFrameRate || 0, false); o += 2;
  buf[o++] = ((box.constantFrameRate  & 0x3) << 6) |
             ((box.numTemporalLayers  & 0x7) << 3) |
             ((box.temporalIdNested   & 0x1) << 2) |
              (box.lengthSizeMinusOne & 0x3);
  buf[o++] = naluArrays.length;
  for (const arr of naluArrays) {
    buf[o++] = ((arr.completeness & 0x1) << 7) | (arr.nal_unit_type & 0x3f);
    view.setUint16(o, arr.units.length, false); o += 2;
    for (const unit of arr.units) {
      const data = unit.data instanceof Uint8Array
        ? unit.data
        : new Uint8Array(unit.data.buffer || unit.data);
      view.setUint16(o, data.byteLength, false); o += 2;
      buf.set(data, o); o += data.byteLength;
    }
  }
  return buf;
}

function wcGetSamplesForClip(allSamples, clip, timescale) {
  let prerollIdx = -1;
  for (let i = 0; i < allSamples.length; i++) {
    const t = allSamples[i].dts / (allSamples[i].timescale || timescale);
    if (t > clip.start) break;
    if (allSamples[i].is_sync) prerollIdx = i;
  }
  if (prerollIdx === -1) {
    prerollIdx = allSamples.findIndex(s => s.is_sync);
    if (prerollIdx === -1) throw new Error('No keyframes found in video track');
  }

  const allSamplesForClip = [];
  const frameSamples = [];
  for (let i = prerollIdx; i < allSamples.length; i++) {
    const s = allSamples[i];
    const ts = s.timescale || timescale;
    const dtsSec = s.dts / ts;
    const ctsSec = s.cts / ts;
    if (dtsSec > clip.end + 1.0) break;
    allSamplesForClip.push(s);
    if (ctsSec >= clip.start - 0.002 && ctsSec <= clip.end + 0.002) frameSamples.push(s);
  }

  return { clip, allSamples: allSamplesForClip, frameSamples };
}

// CommonJS export — used by Node.js / Vitest.
// The `if` guard makes this a no-op in the browser, where `module` is undefined.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    fmt, fmtDur, wcYield, wcFmtSize,
    wcPickH264Codec, wcSerializeAvcC, wcSerializeHvcC, wcGetSamplesForClip,
  };
}
