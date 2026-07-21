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
  //   Level 5.1 (0x33): ≤ 983 040 MBs/sec — 3840×2160 @ 30 fps (4K30)
  //   Level 5.2 (0x34): ≤ 2 073 600 MBs/sec — 3840×2160 @ 60 fps (4K60, iPhone default)
  //   Level 6.0 (0x3c): ≤ 4 177 920 MBs/sec — 8K @ 30 fps
  const mbsPerSec = Math.ceil(width / 16) * Math.ceil(height / 16) * fps;
  if (mbsPerSec > 2_073_600) return 'avc1.64003c'; // Level 6.0 — 8K30
  if (mbsPerSec > 983_040)   return 'avc1.640034'; // Level 5.2 — 4K60
  if (mbsPerSec > 589_824)   return 'avc1.640033'; // Level 5.1 — 4K30
  if (mbsPerSec > 245_760)   return 'avc1.640032'; // Level 5.0 — 1440p or 1080p60
  return 'avc1.640028';                             // Level 4.0 — 1080p30 and below
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

// Scan a raw MP4 ArrayBuffer for a box by 4-char type code and return its content
// bytes (everything after the 8-byte size+type header), or null if not found.
//
// Why this exists: MP4Box.js parses the MP4 box tree into JavaScript objects. When
// it encounters a malformed sibling box (e.g. a box claiming a size of 1.75 GB
// inside a 232-byte container), it logs a warning and can fail to populate the NAL
// array fields of the avcC/hvcC object — leaving NaluArrays/SPS/PPS empty. The raw
// bytes in the file are correct; MP4Box just didn't read them. By searching the
// ArrayBuffer directly we bypass the parser entirely and get the real bytes.
function wcExtractRawBox(fileBuffer, typeFourCC) {
  const needle = typeFourCC.split('').map(c => c.charCodeAt(0));
  const bytes  = new Uint8Array(fileBuffer);
  for (let i = 4; i <= bytes.length - 8; i++) {
    if (bytes[i]   === needle[0] && bytes[i+1] === needle[1] &&
        bytes[i+2] === needle[2] && bytes[i+3] === needle[3]) {
      const boxSize = ((bytes[i-4] << 24) | (bytes[i-3] << 16) |
                       (bytes[i-2] << 8)  |  bytes[i-1]) >>> 0;
      const contentStart = i + 4;            // skip 4-byte type field
      const contentEnd   = (i - 4) + boxSize; // box start + total box size
      // Sanity-check: codec config boxes are always small and start with version=1.
      if (boxSize >= 20 && boxSize <= 65536 &&
          contentEnd <= bytes.length &&
          bytes[contentStart] === 1) {
        return bytes.slice(contentStart, contentEnd); // slice = independent copy
      }
    }
  }
  return null;
}

// Split an encoded H.264 chunk into its NAL units. Handles both framings an
// encoder may produce:
//   AVCC:    each NAL prefixed by a 4-byte big-endian length (what MP4 stores)
//   Annex B: NALs separated by 00 00 01 / 00 00 00 01 start codes
// Returns { format: 'avcc' | 'annexb', nals: Uint8Array[] } or null if the
// data parses cleanly as neither.
function wcSplitNals(data) {
  // Try AVCC first: walk the length-prefixed units. Valid only if the walk
  // lands exactly on the end of the buffer — random data essentially never
  // survives that check, so a false positive is not a practical concern.
  if (data.byteLength >= 5) {
    const nals = [];
    let pos = 0, ok = true;
    while (pos + 4 <= data.byteLength) {
      const len = ((data[pos] << 24) | (data[pos+1] << 16) | (data[pos+2] << 8) | data[pos+3]) >>> 0;
      if (len === 0 || pos + 4 + len > data.byteLength) { ok = false; break; }
      nals.push(data.subarray(pos + 4, pos + 4 + len));
      pos += 4 + len;
    }
    if (ok && pos === data.byteLength && nals.length) return { format: 'avcc', nals };
  }
  // Annex B: locate every 00 00 01 start code. NAL payloads cannot contain
  // 00 00 01 themselves (emulation prevention bytes guarantee it), so a plain
  // scan is safe. A 4-byte start code (00 00 00 01) is the same pattern with a
  // leading zero that we trim off the previous NAL's tail below.
  const starts = [];
  for (let i = 0; i + 2 < data.byteLength; i++) {
    if (data[i] === 0 && data[i+1] === 0 && data[i+2] === 1) { starts.push(i + 3); i += 2; }
  }
  if (!starts.length) return null;
  // Everything before the first start code must be zero padding, else this
  // isn't Annex B at all.
  for (let i = 0; i < starts[0] - 3; i++) if (data[i] !== 0) return null;
  const nals = [];
  for (let k = 0; k < starts.length; k++) {
    let end = k + 1 < starts.length ? starts[k+1] - 3 : data.byteLength;
    while (end > starts[k] && data[end-1] === 0) end--; // trim next start code's lead zeros / padding
    if (end > starts[k]) nals.push(data.subarray(starts[k], end));
  }
  return nals.length ? { format: 'annexb', nals } : null;
}

// Build an AVCDecoderConfigurationRecord ("description") from the SPS/PPS NAL
// units carried in-band inside an encoded keyframe chunk.
//
// Why this exists: some encoders (notably Safari's in 'realtime' latency mode)
// never attach decoderConfig metadata to their output chunks. Without a
// description, mp4-muxer silently omits the avcC box and the exported file is
// unplayable. The parameter sets are still present in the first keyframe's
// bytes, so we recover them from there. Profile/compat/level bytes are read
// straight from the SPS payload (bytes 1–3 by definition).
function wcExtractAvcCFromChunk(data) {
  const parsed = wcSplitNals(data);
  if (!parsed) return null;
  const sps = parsed.nals.filter(n => (n[0] & 0x1f) === 7);
  const pps = parsed.nals.filter(n => (n[0] & 0x1f) === 8);
  if (!sps.length || !pps.length) return null;
  const description = wcSerializeAvcC({
    configurationVersion: 1,
    AVCProfileIndication:  sps[0][1],
    profile_compatibility: sps[0][2],
    AVCLevelIndication:    sps[0][3],
    lengthSizeMinusOne:    3,
    SPS: sps.map(nalu => ({ nalu })),
    PPS: pps.map(nalu => ({ nalu })),
  });
  return { description, format: parsed.format };
}

// Re-frame an Annex B chunk (start-code separated) as AVCC (4-byte length
// prefixes) so it can be stored in an MP4 container. Already-AVCC data is
// returned as-is. Returns null if the data doesn't parse as either framing.
function wcAnnexBToAvcc(data) {
  const parsed = wcSplitNals(data);
  if (!parsed) return null;
  if (parsed.format === 'avcc') return data;
  let size = 0;
  for (const n of parsed.nals) size += 4 + n.byteLength;
  const out = new Uint8Array(size);
  let o = 0;
  for (const n of parsed.nals) {
    out[o++] =  n.byteLength >>> 24;
    out[o++] = (n.byteLength >>> 16) & 0xff;
    out[o++] = (n.byteLength >>>  8) & 0xff;
    out[o++] =  n.byteLength         & 0xff;
    out.set(n, o); o += n.byteLength;
  }
  return out;
}

// CommonJS export — used by Node.js / Vitest.
// The `if` guard makes this a no-op in the browser, where `module` is undefined.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    fmt, fmtDur, wcYield, wcFmtSize,
    wcPickH264Codec, wcSerializeAvcC, wcSerializeHvcC, wcGetSamplesForClip,
    wcExtractRawBox, wcSplitNals, wcExtractAvcCFromChunk, wcAnnexBToAvcc,
  };
}
