// ════════════════════════════════════════════════════
//  WEBCODECS VIDEO EXPORT
// ════════════════════════════════════════════════════
let cancelExport = false;

// iPadOS Safari reports a desktop "Macintosh" user agent, so a plain UA test
// misses iPads entirely. The maxTouchPoints check catches them — real Macs
// report 0 touch points.
function wcIsApplePlatform() {
  return /iPhone|iPad|iPod/.test(navigator.userAgent)
    || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
}

async function doWebCodecsExport() {
  // WebCodecs is a low-level browser API for encoding/decoding video and audio.
  // It gives direct access to the hardware codec (GPU) rather than going through
  // the browser's high-level video element.
  if (!('VideoEncoder' in window) || !('VideoDecoder' in window)) {
    // Every browser on iOS is WebKit under the hood, so "use Chrome" is wrong
    // advice there — WebCodecs arrived with iOS/iPadOS 16.4.
    const msg = wcIsApplePlatform()
      ? 'Video export needs iOS 16.4 or later — update your device'
      : 'WebCodecs not supported — use Chrome or Edge';
    toast(msg);
    trackEvent('browser_unsupported', { message: msg });
    return;
  }
  // Combined export uses two passes: highlighted clips with no scoreboard, then
  // all clips with scoreboard. Normal export uses the existing option flags.
  const highlightClips = exportCombined
    ? clips.filter(c => c.end !== null && c.highlight).sort((a, b) => a.start - b.start)
    : null;
  const exportClips = exportCombined
    ? clips.filter(c => c.end !== null).sort((a, b) => a.start - b.start)
    : clips.filter(c => c.end !== null && (!exportHighlightsOnly || c.highlight))
           .sort((a, b) => a.start - b.start);

  if (exportCombined) {
    if (!highlightClips.length) { toast('No highlighted clips to export'); return; }
    if (!exportClips.length)    { toast('No complete clips to export'); return; }
  } else if (!exportClips.length) {
    toast(exportHighlightsOnly ? 'No highlighted clips to export' : 'No complete clips to export');
    return;
  }
  if (!videoFile) { toast('No video loaded'); return; }

  const scoreboardStyle    = exportScoreboardStyle;
  const scoreboardPosition = { ...exportScoreboardPosition };
  const disableScoreboard  = exportCombined ? false : exportDisableScoreboard;
  const disableWatermark   = exportDisableWatermark;
  if (!disableWatermark && !_watermarkImg.complete) {
    await new Promise(r => { _watermarkImg.onload = r; _watermarkImg.onerror = r; });
  }
  const watermarkLogo = (!disableWatermark && _watermarkImg.naturalWidth) ? _watermarkImg : null;
  cancelExport = false;

  $('export-body').innerHTML = `<div class="export-body">
    <div class="exp-progress">
      <div class="exp-status" id="exp-status">Initializing…</div>
      <div class="exp-bar-wrap"><div class="exp-bar" id="exp-bar"></div></div>
      <div class="exp-meta-txt" id="exp-meta"></div>
      <div class="exp-debug-txt" id="exp-debug"></div>
      <button class="exp-cancel" id="exp-cancel-btn" onclick="cancelExportFn()">Cancel</button>
    </div>
  </div>`;

  const setProgress = (pct, status, meta = '') => {
    const bar = $('exp-bar'), lbl = $('exp-status'), met = $('exp-meta');
    if (bar) bar.style.width = Math.max(0, pct) + '%';
    if (lbl) lbl.textContent = status;
    if (met) met.textContent = meta;
  };

  const homeLabel = $('inp-home').value || 'Home';
  const awayLabel = $('inp-away').value || 'Away';

  try {
    setProgress(2, 'Loading muxer…');
    // A muxer (multiplexer) combines multiple media streams into one container file.
    // Think of MP4 as a ZIP file: the muxer is the tool that packs the encoded video
    // chunks and encoded audio chunks together, writing the MP4 file structure
    // (track headers, timing tables, codec metadata, etc.) around them.
    // mp4-muxer is a pure-JS library that does this entirely in the browser.
    let Muxer, StreamTarget, ArrayBufferTarget;
    try {
      ({ Muxer, StreamTarget, ArrayBufferTarget } = await import('./lib/mp4-muxer.js'));
    } catch {
      throw new Error('Could not load mp4-muxer.');
    }
    if (cancelExport) return;

    // Stream the file to MP4Box in chunks — never load the full file into a single
    // ArrayBuffer.  A 1.6 GB arrayBuffer() call can exhaust the V8 JS heap and crash
    // the tab before parsing even starts.  Streaming keeps peak memory to one small
    // chunk at a time while the parser accumulates the extracted sample data.
    // Verify file is still readable before starting the parse.
    // On Android, file-picker permissions can expire if the user backgrounded Chrome
    // between picking the file and tapping Export.
    try { await videoFile.slice(0, 4).arrayBuffer(); }
    catch { throw new Error('Video file is no longer accessible — re-select it and try again'); }

    setProgress(5, 'Parsing video file…', wcFmtSize(videoFile.size));
    const { videoTrack, audioTrack, videoSamples, audioSamples, mp4file, moovBuf } =
      await wcParseMp4(videoSrc, videoFile);
    if (cancelExport) return;
    if (!videoTrack) throw new Error('No video track found in file');

    // ── Sample extraction audit ──────────────────────────────────────────────
    // If MP4Box misaligns while parsing (see any [BoxParser] warnings above),
    // videoSamples can come back empty or with zero-length data arrays.
    // Either way the decoder receives nothing and decoded=0.
    console.log(`[WC] parsed: videoSamples=${videoSamples.length}, audioSamples=${audioSamples.length}`);
    if (videoSamples.length === 0) {
      console.warn('[WC] ⚠ 0 video samples — MP4Box failed to extract samples; likely caused by the BoxParser size warning above');
    } else {
      const s0 = videoSamples[0], sN = videoSamples[videoSamples.length - 1];
      const ts0 = s0.timescale || 1;
      console.log(`[WC] sample[0]:  is_sync=${s0.is_sync}, dts=${(s0.dts/ts0).toFixed(3)}s, dataLen=${s0.data?.byteLength ?? '⚠MISSING'}`);
      console.log(`[WC] sample[${videoSamples.length-1}]: is_sync=${sN.is_sync}, dts=${(sN.dts/ts0).toFixed(3)}s, dataLen=${sN.data?.byteLength ?? '⚠MISSING'}`);
      const emptyCount = videoSamples.filter(s => !s.data?.byteLength).length;
      if (emptyCount) console.warn(`[WC] ⚠ ${emptyCount} of ${videoSamples.length} samples have empty/missing data`);
    }
    // ────────────────────────────────────────────────────────────────────────

    const { width, height } = videoTrack.video;
    // Timescale: the number of "ticks" per second used to express timestamps in the file.
    // Example: timescale=90000 means a frame at t=1s has timestamp=90000.
    // To convert any MP4 timestamp to seconds: seconds = timestamp / timescale.
    const timescale = videoTrack.timescale;
    // Estimate frame rate: total frames ÷ total duration (converted to seconds).
    // nb_samples = total frame count in the video track.
    // ⚠ WARNING: Math.round turns 29.97 fps into 30 fps. This ~0.1% mismatch
    // between the encoder's declared fps and the real frame spacing causes
    // slight A/V sync drift on long exports.
    const fps = Math.round(videoTrack.nb_samples / (videoTrack.duration / timescale));

    // MP4 tkhd box contains a 3×3 affine matrix (stored as 9 16.16 fixed-point values)
    // that tells the player how to rotate the frame for display. iPhones in particular
    // record in rotated orientations and rely on this matrix — without it the raw encoded
    // frame appears upside-down or sideways. We apply the rotation directly onto the canvas
    // so the re-encoded output is already correctly oriented without needing any metadata.
    // Matrix layout: [a, b, u,  c, d, v,  tx, ty, w]. Rotation lives in a (m[0]) and b (m[1]).
    //   a>0, b=0  → 0°   a=0, b>0 → 90° CW
    //   a<0, b=0  → 180° a=0, b<0 → 270° CW
    const m = videoTrack.matrix;
    const trackRotation = m
      ? (m[0] < 0 ? 180 : m[1] > 0 ? 90 : m[1] < 0 ? 270 : 0)
      : 0;
    // For 90°/270° the output canvas is transposed relative to the encoded frame dimensions.
    const outW = (trackRotation === 90 || trackRotation === 270) ? height : width;
    const outH = (trackRotation === 90 || trackRotation === 270) ? width : height;
    console.log(`[WC] track rotation: ${trackRotation}° — encoded: ${width}×${height} → output: ${outW}×${outH}`);

    const clipCountLabel = exportCombined
      ? `${highlightClips.length}+${exportClips.length}`
      : String(exportClips.length);
    setProgress(6, 'Preparing…', `${outW}×${outH} · ${fps} fps · ${clipCountLabel} clips`);
    await wcYield();

    // For each clip, collect the set of compressed video samples that cover it.
    // This includes some samples BEFORE clip.start as "pre-roll" — because
    // H.264 frames often reference earlier frames (they are not self-contained),
    // so the decoder needs to process those earlier frames first to reconstruct
    // the ones we actually want. wcGetSamplesForClip finds the last keyframe
    // before clip.start and starts there, giving the decoder its necessary context.
    const clipGroups = exportClips.map(c => wcGetSamplesForClip(videoSamples, c, timescale));
    const hlGroups   = exportCombined
      ? highlightClips.map(c => wcGetSamplesForClip(videoSamples, c, timescale))
      : null;
    // frameSamples = samples within the clip's display window (used for progress only).
    // ⚠ WARNING: frameSamples has no upper-bound check in wcGetSamplesForClip,
    // so totalFrames is slightly overestimated — the progress bar won't reach 91%.
    const totalFrames = clipGroups.reduce((n, g) => n + g.frameSamples.length, 0)
      + (hlGroups ? hlGroups.reduce((n, g) => n + g.frameSamples.length, 0) : 0);
    if (!totalFrames) throw new Error('No frames found in the selected clip ranges');

    const isIOS = wcIsApplePlatform();
    const isMobile = isIOS || /Android/i.test(navigator.userAgent);

    const audioDataMap = new Map(); // offset → Uint8Array (audio sample bytes, all clips)
    const aTs = audioTrack?.timescale;

    // Fetch the compressed bytes for one clip. One contiguous File.slice() per
    // clip (a single range spanning all samples for that clip) avoids per-sample
    // IPC overhead. The returned map's Uint8Array views hold the range buffer
    // alive only until clipDataMap.clear() runs after the clip encodes.
    // includeAudio: also copy this clip's audio bytes into audioDataMap (copied,
    // not viewed, so the range buffer can still be freed after the video decode).
    const fetchClipData = async (group, label, ci, includeAudio) => {
      const { clip, allSamples } = group;
      const clipDataMap = new Map();

      // Audio samples for this clip (filtered by time window, same as the muxing loop).
      const clipAudio = (includeAudio && audioTrack && audioSamples.length)
        ? audioSamples.filter(s => {
            const t = s.cts / (s.timescale || aTs);
            return t >= clip.start - 0.002 && t <= clip.end + 0.002;
          })
        : [];

      // One range read covering both video and audio samples for this clip.
      const allForRange = allSamples.length ? [...allSamples, ...clipAudio] : clipAudio;
      if (allForRange.length > 0) {
        let minOff = allForRange[0].offset, maxEnd = allForRange[0].offset + allForRange[0].size;
        for (const s of allForRange) {
          if (s.offset < minOff) minOff = s.offset;
          if (s.offset + s.size > maxEnd) maxEnd = s.offset + s.size;
        }
        console.log(`[WC] ${label} ${ci} fetch: ${((maxEnd-minOff)/1048576).toFixed(0)} MB range, video=${allSamples.length} audio=${clipAudio.length}`);
        const rangeBuffer = await videoFile.slice(minOff, maxEnd).arrayBuffer();
        for (const s of allSamples) {
          if (!clipDataMap.has(s.offset))
            clipDataMap.set(s.offset, new Uint8Array(rangeBuffer, s.offset - minOff, s.size));
        }
        for (const s of clipAudio) {
          if (!audioDataMap.has(s.offset))
            audioDataMap.set(s.offset,
              new Uint8Array(rangeBuffer, s.offset - minOff, s.size).slice());
        }
      }
      return clipDataMap;
    };

    // When each clip's bytes are fetched differs by platform:
    //  • Android/desktop: fetch every clip RIGHT NOW, before any long async work
    //    (encoder setup, per-clip decoding) can create a gap during which Android
    //    may revoke file-picker access. Costs memory: every clip's range stays
    //    alive until that clip finishes encoding.
    //  • iOS: fetch each clip just-in-time inside the encode loop instead. iOS
    //    Safari caps a tab's memory far below desktop (~1–1.5 GB, and the tab is
    //    killed without any error message), so holding all clips at once crashes
    //    on real match footage — and iOS file handles stay readable for the whole
    //    session, so Android's revocation problem doesn't exist there.
    // getClipData/getHlData resolve to the data map for clip index ci; on the
    // prefetch platforms they just return the already-loaded map.
    let getClipData, getHlData = null;
    if (isIOS) {
      getClipData = ci => fetchClipData(clipGroups[ci], 'clip', ci, true);
      if (exportCombined) getHlData = ci => fetchClipData(hlGroups[ci], 'hl clip', ci, false);
    } else {
      setProgress(8, 'Loading clip data…');
      const allClipDataMaps = [];
      for (let ci = 0; ci < clipGroups.length; ci++) {
        if (cancelExport) break;
        allClipDataMaps.push(await fetchClipData(clipGroups[ci], 'clip', ci, true));
        setProgress(8 + Math.round(3 * (ci + 1) / clipGroups.length), 'Loading clip data…',
          `Clip ${ci + 1} / ${clipGroups.length}`);
      }
      if (cancelExport) return;
      getClipData = ci => allClipDataMaps[ci];

      // For combined export, also pre-fetch video data for the highlight clips (pass 1).
      // Audio is already captured in audioDataMap above since highlights ⊂ allClips.
      if (exportCombined) {
        const hlDataMaps = [];
        for (let ci = 0; ci < hlGroups.length; ci++) {
          if (cancelExport) break;
          hlDataMaps.push(await fetchClipData(hlGroups[ci], 'hl clip', ci, false));
        }
        if (cancelExport) return;
        getHlData = ci => hlDataMaps[ci];
      }
    }

    // OffscreenCanvas: a canvas element that lives only in memory, not on the page.
    // We use it to composite each decoded video frame with the scoreboard overlay
    // before passing the combined image to the encoder.
    const canvas = new OffscreenCanvas(outW, outH);
    const ctx = canvas.getContext('2d');
    console.log('[WC] OffscreenCanvas ctx:', ctx ? 'ok' : '⚠ NULL — all canvas ops will silently no-op');

    // Converts a decoded VideoFrame into an ImageBitmap that survives the frame
    // being closed (frames must be closed promptly to free the hardware
    // decoder's output buffer pool). createImageBitmap(VideoFrame) is the fast
    // path everywhere, but WebKit's support for VideoFrame sources has gaps —
    // if it rejects, permanently switch to bouncing the frame through a scratch
    // canvas, since drawImage accepts a VideoFrame in every WebCodecs browser.
    let scratchCanvas = null, scratchCtx = null;
    const bitmapViaScratch = (frame) => {
      if (!scratchCanvas) {
        scratchCanvas = new OffscreenCanvas(width, height);
        scratchCtx = scratchCanvas.getContext('2d');
      }
      scratchCtx.drawImage(frame, 0, 0, width, height);
      // transferToImageBitmap detaches the canvas's current bitmap (no copy) and
      // resets the canvas to blank, ready for the next frame.
      return scratchCanvas.transferToImageBitmap();
    };
    let frameToBitmap = async (frame) => {
      try {
        return await createImageBitmap(frame);
      } catch (e) {
        console.warn('[WC] createImageBitmap(VideoFrame) failed — using scratch canvas fallback:', e.message);
        frameToBitmap = async f => bitmapViaScratch(f);
        return bitmapViaScratch(frame);
      }
    };

    // On mobile (Android/iOS), the JS heap is capped well below desktop limits. ArrayBufferTarget accumulates
    // the entire output as one contiguous ArrayBuffer, which crashes the tab on
    // large exports. StreamTarget instead calls onData with small sequential chunks
    // as they are produced. fastStart:'fragmented' writes ftyp+moov first then
    // moof+mdat pairs — inherently sequential (no seek-backs needed), so ignoring
    // the position argument is safe, and Android's MediaExtractor can parse it.
    // Desktop uses 'in-memory' (moov at front, WMP compatible).
    //
    // The chunks are moved out of the JS heap as they arrive: every ~64 MB the
    // accumulated Uint8Arrays are consolidated into a Blob. Blob storage is
    // browser-managed and may be disk-backed, so the JS heap never holds more
    // than one consolidation window — without this, chunks + the final Blob
    // briefly hold the entire output in memory twice. Building the final Blob
    // from Blob parts is cheap: Blob-of-Blobs references, it doesn't copy.
    //
    // firstTimestampBehavior 'offset': subtracts the first frame's timestamp from
    // all subsequent timestamps, ensuring the output video always starts at t=0.
    const dbg = $('exp-debug');
    if (dbg) dbg.textContent = `fastStart: ${isMobile ? 'fragmented' : 'in-memory'}`;
    const outputChunks = [];    // pending Uint8Arrays (JS heap)
    const outputBlobParts = []; // consolidated Blobs (browser-managed storage)
    let outputPendingBytes = 0;
    const OUTPUT_CONSOLIDATE_BYTES = 64 * 1024 * 1024;
    const onMuxData = (data, _position) => {
      outputChunks.push(data.slice()); // copy — the muxer may reuse its buffer
      outputPendingBytes += data.byteLength;
      if (outputPendingBytes >= OUTPUT_CONSOLIDATE_BYTES) {
        outputBlobParts.push(new Blob(outputChunks));
        outputChunks.length = 0;
        outputPendingBytes = 0;
      }
    };
    const muxer = new Muxer({
      target: isMobile
        ? new StreamTarget({ onData: onMuxData })
        : new ArrayBufferTarget(),
      // 'avc' = H.264/AVC (Advanced Video Coding) — the most widely supported
      // video codec. Each compressed frame is a fragment of H.264 bitstream.
      video: { codec: 'avc', width: outW, height: outH },
      // AAC = Advanced Audio Coding — the standard audio codec inside MP4 files.
      ...(audioTrack ? { audio: {
        codec: 'aac',
        sampleRate: audioTrack.audio.sample_rate,
        numberOfChannels: audioTrack.audio.channel_count,
      }} : {}),
      fastStart: isMobile ? 'fragmented' : 'in-memory',
      firstTimestampBehavior: 'offset',
    });

    // State shared across both encode passes (combined) or the single pass (normal).
    let encErr = null;
    let encErrClip = -1;
    let chunksFromEncoder = 0;
    let lastMuxTs     = -1; // last chunk.timestamp seen by the encoder output callback
    // Safari's encoder (especially in 'realtime' latency mode) may never attach
    // decoderConfig metadata to its output chunks. mp4-muxer silently omits the
    // avcC box without it and the exported file is unplayable — so the first
    // chunk of each encoder instance is validated, and if the description is
    // missing it is synthesized from the SPS/PPS carried in-band in that first
    // keyframe. If the encoder also ignored avc:{format:'avc'} and produced
    // Annex B framing, every chunk is re-framed to AVCC before muxing.
    let firstChunkOfEncoder = true;
    let annexBDetected      = false;
    let synthesizedDesc     = null;

    // VideoEncoder compresses raw image frames (VideoFrame objects) into
    // H.264 bitstream chunks. Each output chunk is handed to the muxer immediately.
    // For combined export the encoder is recreated between passes (same config, new
    // instance) to force an IDR (keyframe) at the start of the second pass, ensuring
    // the full-match section is independently seekable in the output file.
    let encoder;
    const makeEncoder = () => {
      firstChunkOfEncoder = true; // each instance re-validates its first chunk
      encoder = new VideoEncoder({
        output: (chunk, meta) => {
          if (!cancelExport) {
            if (lastMuxTs !== -1 && chunk.timestamp < lastMuxTs) {
              console.warn(`[WC] muxer chunk non-monotonic: prev=${lastMuxTs} cur=${chunk.timestamp} type=${chunk.type}`);
            }
            lastMuxTs = chunk.timestamp;
            chunksFromEncoder++;
            const chunkData = new Uint8Array(chunk.byteLength);
            chunk.copyTo(chunkData);
            if (chunksFromEncoder === 1) {
              console.log(`[WC] encoder output callback fired for first time — type=${chunk.type} ts=${chunk.timestamp} byteLength=${chunk.byteLength} copied=${chunkData[0]},${chunkData[1]},${chunkData[2]},${chunkData[3]}`);
              console.log(`[WC] first chunk meta — decoderConfig present: ${!!(meta && meta.decoderConfig)}, description byteLength: ${meta?.decoderConfig?.description?.byteLength ?? 'none'}`);
            } else if (chunksFromEncoder % 20 === 0) {
              console.log(`[WC] encoder output chunks so far: ${chunksFromEncoder}`);
            }

            let muxMeta = meta;
            let muxData = chunkData;
            if (firstChunkOfEncoder) {
              firstChunkOfEncoder = false;
              if (!meta?.decoderConfig?.description) {
                const fixed = wcExtractAvcCFromChunk(chunkData);
                if (fixed) {
                  annexBDetected  = fixed.format === 'annexb';
                  synthesizedDesc = fixed.description;
                  console.warn(`[WC] encoder provided no decoderConfig.description — synthesized avcC from in-band SPS/PPS (framing: ${fixed.format})`);
                } else {
                  // No description and no in-band parameter sets: the output
                  // genuinely cannot be made playable. Fail loudly instead of
                  // producing a silent broken file.
                  encErr = new Error('Encoder produced no codec configuration — this device cannot export a playable MP4');
                  return;
                }
              }
            }
            if (synthesizedDesc && !meta?.decoderConfig?.description) {
              muxMeta = { decoderConfig: { codec: encoderConfig.codec, description: synthesizedDesc } };
            }
            if (annexBDetected) {
              muxData = wcAnnexBToAvcc(chunkData) || chunkData;
            }

            const chunkDuration = chunk.duration ?? Math.round(1_000_000 / fps);
            muxer.addVideoChunkRaw(muxData, chunk.type, chunk.timestamp, chunkDuration, muxMeta);
          }
        },
        error: e => {
          encErr = e;
          console.error('[WC] ENCODER ERROR at clip', encErrClip, '—', e.name, e.message, e);
        },
      });
      encoder.configure(encoderConfig);
    };
    // wcPickH264Codec (defined below) selects the minimum H.264 level that can
    // handle this video's resolution and frame rate. H.264 levels cap the maximum
    // macroblocks-per-second (MBs/sec) a decoder or encoder must handle, where each
    // macroblock covers 16×16 pixels. Choosing too low a level makes the encoder
    // reject or corrupt frames:
    //   Level 4.0 (avc1.640028) — up to ~245 760 MBs/sec → 1080p @ 30 fps
    //   Level 5.0 (avc1.640032) — up to ~589 824 MBs/sec → ~1440p @ 30 fps
    //   Level 5.1 (avc1.640033) — up to ~983 040 MBs/sec → 4K @ 30 fps
    //   Level 5.2 (avc1.640034) — up to ~2 073 600 MBs/sec → 4K @ 60 fps
    //   Level 6.0 (avc1.64003c) — up to ~4 177 920 MBs/sec → 8K @ 30 fps
    const encoderConfig = {
      codec: wcPickH264Codec(outW, outH, fps),
      width: outW, height: outH,
      bitrate: getExportBitrate(outW, outH, fps),
      framerate: fps,
      // 'prefer-hardware' uses the GPU for encoding, which is 10–100x faster than
      // the CPU. If hardware acceleration isn't available, it falls back to software.
      hardwareAcceleration: 'prefer-hardware',
      // 'realtime' outputs each encoded chunk immediately instead of buffering
      // many frames for look-ahead analysis ('quality' mode). This keeps the
      // encode queue small and prevents GPU memory exhaustion across clips.
      latencyMode: 'realtime',
      // Explicitly request AVCC (length-prefixed) output format for H.264.
      // Without this, Chrome may produce Annex B (start-code prefixed) output
      // depending on which encoder implementation it selects (hardware vs software).
      // mp4-muxer expects AVCC — Annex B data stored in an MP4 container produces
      // an unreadable bitstream ("missing picture in access unit" in ffprobe).
      avc: { format: 'avc' },
    };
    // Verify the config is actually encodable before committing. If the device
    // rejects it (e.g. older hardware that can't encode 4K60 at any level),
    // configure() would only fail asynchronously with a cryptic error — surface
    // a clear one now instead. Some WebKit builds reject the hardwareAcceleration
    // hint itself rather than the codec, so retry without it before giving up.
    let encSupported = null;
    try {
      let encSupport = await VideoEncoder.isConfigSupported(encoderConfig);
      console.log('[WC] encoder isConfigSupported:', encSupport.supported,
        '| hw:', encSupport.config?.hardwareAcceleration,
        '| codec:', encSupport.config?.codec);
      if (encSupport.supported === false) {
        const { hardwareAcceleration, ...noHint } = encoderConfig;
        encSupport = await VideoEncoder.isConfigSupported(noHint);
        console.log('[WC] encoder isConfigSupported (no hw hint):', encSupport.supported);
        if (encSupport.supported) delete encoderConfig.hardwareAcceleration;
      }
      encSupported = encSupport.supported;
    } catch (e) {
      // A probe that throws is not proof the config is bad (older implementations
      // throw on unrecognised keys) — log and let configure() decide.
      console.warn('[WC] encoder isConfigSupported() threw:', e.message);
    }
    if (encSupported === false) {
      throw new Error(`This device cannot encode ${outW}×${outH} @ ${fps} fps H.264 video (${encoderConfig.codec})`);
    }
    makeEncoder();

    // Why we must decode then re-encode even though the source is already H.264:
    // We need to draw the scoreboard overlay onto every frame. There is no way to
    // "insert pixels" into a compressed video stream — compressed frames store only
    // differences and mathematical coefficients, not raw pixels. The only path is:
    // decompress → draw on canvas → compress again. This is why the export is slow
    // compared to copying audio, which has no visual modification at all.
    //
    // Build the VideoDecoder configuration from codec metadata stored in the MP4.
    // H.264 streams require SPS (Sequence Parameter Set) and PPS (Picture Parameter
    // Set) NAL units to be provided up-front. These describe the stream's profile,
    // resolution, and encoding settings. Without them the decoder cannot start.
    // wcBuildDecoderConfig reads them from the avcC box in the MP4 container.
    const decoderConfig = wcBuildDecoderConfig(videoTrack, mp4file);
    if (!decoderConfig.description) {
      // description is the raw AVCDecoderConfigurationRecord or
      // HEVCDecoderConfigurationRecord bytes that tell the decoder about the
      // stream's profile, resolution, and parameter sets (SPS/PPS/VPS).
      // If it's missing here, wcBuildDecoderConfig could not find a recognised
      // codec config box — either the file uses AV1, VP9, or a codec whose
      // container structure we don't yet handle.
      const codec = videoTrack.codec || '';
      if (codec.startsWith('av01')) {
        throw new Error('AV1 video is not supported by the WebCodecs export engine — convert the file to H.264 or H.265 first.');
      }
      throw new Error('Could not read codec config from video. H.264 (AVC) and H.265 (HEVC) files are supported — convert the file to one of those and try again.');
    }

    // MP4Box can produce a structurally valid description record that has ZERO
    // parameter sets (numOfArrays=0 for HEVC, numSPS=0 for AVC). This happens when
    // a malformed box in stsd causes the BoxParser to skip the NAL array section of
    // the avcC/hvcC box. The decoder silently accepts every decode() call but
    // produces no frames because it has no VPS/SPS/PPS to reference.
    //
    // Detect this and fall back to scanning the raw file bytes directly for the
    // codec config box. The bytes in the file are correct — MP4Box just failed to
    // read them into its object model.
    {
      const desc   = decoderConfig.description;
      const codec  = (videoTrack.codec || '').toLowerCase();
      const isHEVC = codec.startsWith('hvc') || codec.startsWith('hev');
      // HEVC: byte[22] = numOfArrays.  AVC: byte[5] bits[4:0] = numSPS.
      const numParamSets = isHEVC ? desc[22] : (desc[5] & 0x1f);
      if (numParamSets === 0) {
        const boxType = isHEVC ? 'hvcC' : 'avcC';
        console.warn(`[WC] description has 0 parameter sets — MP4Box failed to parse ${boxType}; scanning moov bytes`);
        // hvcC/avcC is always nested inside moov; we already have moovBuf in memory
        // so we can scan it directly — no file re-read needed, no permission issues.
        const rawDesc = moovBuf ? wcExtractRawBox(moovBuf, boxType) : null;
        if (rawDesc) {
          const hex8 = Array.from(rawDesc.slice(0, 8)).map(b => b.toString(16).padStart(2,'0')).join(' ');
          console.log(`[WC] raw ${boxType} found: ${rawDesc.byteLength} bytes | first 8: ${hex8}`);
          decoderConfig.description = rawDesc;
        } else {
          console.warn(`[WC] ⚠ raw ${boxType} not found in moov bytes — export will likely fail`);
        }
      }
    }

    console.log('[WC] source codec:', videoTrack.codec, `${width}×${height}`, fps + 'fps',
      videoSamples.length + ' samples');
    // Dump the description bytes as hex. For a valid record, byte[0] MUST be 0x01
    // (configurationVersion). If it is anything else, wcBuildDecoderConfig read
    // garbage — the stsd/avcC/hvcC box was corrupted by the BoxParser misalignment.
    if (decoderConfig.description) {
      const hex = Array.from(decoderConfig.description.slice(0, 24))
        .map(b => b.toString(16).padStart(2, '0')).join(' ');
      const valid = decoderConfig.description[0] === 1;
      console.log(`[WC] description[0..23]: ${hex}`);
      console.log(`[WC] description valid (byte[0]==0x01): ${valid}${valid ? ' ✓' : ' ⚠ GARBAGE — this is why the decoder produces no frames'}`);
    }
    try {
      let decSupport = await VideoDecoder.isConfigSupported(decoderConfig);
      console.log('[WC] decoder isConfigSupported:', decSupport.supported,
        '| hw:', decSupport.config?.hardwareAcceleration,
        '| codec:', decSupport.config?.codec,
        '| has description:', !!(decSupport.config?.description));
      if (decSupport.supported === false) {
        // 'prefer-hardware' is rejected outright on machines with no hardware
        // decoder (and by some WebKit builds) — configure() would then throw
        // "Unsupported configuration". The software decoder works fine, so
        // drop the hint and re-probe before giving up.
        const { hardwareAcceleration, ...noHint } = decoderConfig;
        decSupport = await VideoDecoder.isConfigSupported(noHint);
        console.log('[WC] decoder isConfigSupported (no hw hint):', decSupport.supported);
        if (decSupport.supported) delete decoderConfig.hardwareAcceleration;
      }
    } catch (e) {
      console.warn('[WC] decoder isConfigSupported() threw:', e.message);
    }

    let framesEncoded = 0;
    // Tracks the total output duration placed so far so each new clip is appended
    // immediately after the previous one with no gap.
    let cumulativeDuration = 0;
    // Tracks the last timestamp sent to the encoder across all clips.
    // Encoder/muxer require strictly increasing DTS. Source videos with B-frames
    // emit frames from the decoder in DTS order, but CTS (display time) can
    // be non-monotonic relative to that order — a B-frame decoded third may have
    // a CTS earlier than the P-frame decoded second. We clamp outTs to always
    // be at least lastEncodedTs + 1 to keep DTS monotonically increasing.
    let lastEncodedTs = -1;

    // Encode all clips in groupGroups into the shared muxer/encoder.
    // getGroupData(ci): resolves to the clip's compressed bytes — already in
    //   memory on prefetch platforms, fetched just-in-time on iOS.
    // showScoreboard: whether to draw the score overlay on each frame.
    // progressBase / progressRange: this group's slice of the 0–100 progress bar.
    // passLabel: prefix shown in progress meta text, e.g. "Highlights" or "Match".
    // Mutates outer: framesEncoded, cumulativeDuration, lastEncodedTs, encErr, encErrClip.
    const encodeGroup = async (groupGroups, getGroupData, showScoreboard, progressBase, progressRange, passLabel) => {
      const groupTotalFrames = groupGroups.reduce((n, g) => n + g.frameSamples.length, 0);
      const framesAtGroupStart = framesEncoded;

      for (let ci = 0; ci < groupGroups.length; ci++) {
        if (cancelExport) break;
        encErrClip = ci;
        const { clip, allSamples, frameSamples } = groupGroups[ci];
        console.log(`[WC] ${passLabel} clip ${ci}: ${clip.start.toFixed(3)}–${clip.end.toFixed(3)}s | allSamples=${allSamples.length}, frameSamples=${frameSamples.length}`);
        if (allSamples.length === 0) {
          console.warn(`[WC] ${passLabel} clip ${ci} ⚠ allSamples is empty — clip window outside video timeline, or videoSamples was empty`);
        } else {
          const s0 = allSamples[0], ts0 = s0.timescale || timescale;
          console.log(`[WC] ${passLabel} clip ${ci} preroll: is_sync=${s0.is_sync}, dts=${(s0.dts/ts0).toFixed(3)}s, offset=${s0.offset}, size=${s0.size}`);
        }

        const clipDataMap = await getGroupData(ci);

        // DTS (Decode Time Stamp): the order in which the decoder must process frames.
        // CTS (Composition Time Stamp): the order in which frames should be displayed.
        // These differ when the video uses B-frames (Bidirectional frames).
        //
        // B-frames compress a frame by storing only its difference from BOTH a past
        // and a future frame. This means frame display order ≠ decode order.
        // Example stream (I=keyframe, P=predicted from past, B=bidirectional):
        //   Display order:  I  B  B  P  B  B  P
        //   Decode order:   I  P  B  B  P  B  B   ← B-frames decoded after their references
        //
        // The decoder's output callback gives us the DTS. We need CTS to know when
        // each frame is actually displayed, which is what clip.start/end refers to.
        const dtsToCts = new Map();
        for (const s of allSamples) {
          const ts = s.timescale || timescale;
          dtsToCts.set(Math.round(s.dts * 1_000_000 / ts),
                       Math.round(s.cts * 1_000_000 / ts));
        }
        // The WebCodecs spec requires decoders to echo back the exact timestamp
        // passed in, but some implementations round differently. The ±2 µs loop
        // handles that drift without falling back to the wrong DTS value.
        const lookupCts = dts => {
          for (const d of [0, 1, -1, 2, -2]) {
            const v = dtsToCts.get(dts + d);
            if (v !== undefined) return v;
          }
          return dts; // last resort: treat DTS as CTS (no B-frame offset)
        };

        // firstOfClip forces the first encoded frame of each clip to be a keyframe
        // (also called an I-frame — Intra-coded frame).
        // A keyframe is a complete, fully self-contained image. All other frame types
        // (P-frames, B-frames) store only differences from other frames and CANNOT
        // be decoded without prior context. At each clip boundary the concatenated
        // video must start fresh, so a keyframe is mandatory here.
        let firstOfClip = true;
        let framesDecodedThisClip = 0;

        // Queue for sequentially processing decoded frames one at a time.
        // The Android hardware decoder (MediaCodec) buffers all input and emits all
        // frames in a burst during flush(). An async output callback would spawn
        // hundreds of concurrent coroutines, each holding an ~8 MB decoded 1080p
        // frame — enough to OOM the tab on a 1+ GB video with many clips.
        // Instead, the synchronous output callback enqueues each frame, and
        // drainFrames() processes them one at a time so only one live frame exists.
        const pendingFrames = [];
        const reorderBuffer = []; // { ctsMicros, bitmap }, kept CTS-sorted, bounded to ≤ REORDER_DEPTH entries
        let drainingFrames  = false;

        // Encodes frames from the front of reorderBuffer.
        // force=false: keeps REORDER_DEPTH frames buffered for B-frame reordering.
        // force=true: drains everything (called after decoder.flush() completes).
        //
        // Using a bounded buffer rather than sorting all frames at once fixes three
        // problems simultaneously:
        //   1. OOM: never holds more than REORDER_DEPTH ImageBitmaps (~64 MB at 1080p).
        //   2. Decoder stall: VideoFrames are closed in drainFrames before this runs,
        //      so Android's MediaCodec output buffer pool is always freed promptly.
        //   3. iOS choppiness: frames are encoded in CTS (display) order, giving the
        //      encoder monotonically increasing timestamps with no clamping.
        const REORDER_DEPTH = 8; // covers H.264 B-frame reorder depths of up to ~8 frames
        const encodeFromReorderBuffer = async (force) => {
          const threshold = force ? 0 : REORDER_DEPTH;
          while (reorderBuffer.length > threshold && !encErr && !cancelExport) {
            const { ctsMicros, bitmap } = reorderBuffer.shift();
            const ctsSec   = ctsMicros / 1_000_000;
            const keyFrame = firstOfClip;
            firstOfClip    = false;

            const rawOutTs = Math.round(((ctsSec - clip.start) + cumulativeDuration) * 1_000_000);
            // Two guards in one:
            //   1. Monotonicity: if rawOutTs didn't advance past the previous frame, clamp up.
            //   2. Non-negative: muxer rejects negative timestamps; a frame whose CTS lands
            //      within the ±2 ms clip-start tolerance can produce rawOutTs slightly < 0.
            //      Clamping to 0 is correct — the frame belongs at the very start of the clip.
            const outTs = Math.max(0,
              lastEncodedTs >= 0 && rawOutTs <= lastEncodedTs
                ? lastEncodedTs + 1
                : rawOutTs
            );
            if (outTs !== rawOutTs) {
              console.log(`[WC] ${passLabel} clip ${ci} outTs adjusted: raw=${rawOutTs} → ${outTs} (lastEncodedTs=${lastEncodedTs}, ctsSec=${ctsSec.toFixed(6)})`);
            }
            lastEncodedTs = outTs;

            if (framesEncoded === framesAtGroupStart) {
              console.log(`[WC] ${passLabel} clip ${ci} — first ImageBitmap: ${bitmap.width}×${bitmap.height}`);
            }
            if (trackRotation === 0) {
              ctx.drawImage(bitmap, 0, 0, width, height);
            } else {
              ctx.save();
              if (trackRotation === 90) {
                ctx.translate(outW, 0);
                ctx.rotate(Math.PI / 2);
              } else if (trackRotation === 180) {
                ctx.translate(outW, outH);
                ctx.rotate(Math.PI);
              } else { // 270
                ctx.translate(0, outH);
                ctx.rotate(-Math.PI / 2);
              }
              ctx.drawImage(bitmap, 0, 0, width, height);
              ctx.restore();
            }
            bitmap.close();
            if (framesEncoded === framesAtGroupStart) {
              // Sample a 4×4 block in the centre of the frame.
              // If all values are 0, createImageBitmap returned black or drawImage failed.
              const cx = Math.floor(outW / 2), cy = Math.floor(outH / 2);
              const px = ctx.getImageData(cx, cy, 4, 4);
              const nonZero = Array.from(px.data).some(v => v > 0);
              console.log(`[WC] ${passLabel} clip ${ci} — canvas pixels at centre after drawImage: `
                + (nonZero ? 'NON-BLACK ✓' : '⚠ ALL BLACK')
                + ' | first 8 bytes: [' + Array.from(px.data.slice(0, 8)).join(', ') + ']');
            }

            if (showScoreboard) {
              const { h, a } = wcScoreAt(ctsSec);
              wcDrawActiveScoreboard(ctx, outW, outH, homeLabel, awayLabel, h, a, scoreboardStyle, scoreboardPosition.v, scoreboardPosition.h, watermarkLogo);
            } else if (watermarkLogo) {
              wcDrawWatermark(ctx, outW, outH, watermarkLogo);
            }

            // Wrap the canvas pixels in a VideoFrame for the encoder.
            // VideoFrame is the uncompressed image representation (raw pixel data).
            // We use getImageData → raw buffer rather than VideoFrame(OffscreenCanvas)
            // because iOS Safari silently discards frames constructed directly from an
            // OffscreenCanvas, producing no encoder output and no error.
            const imageData = ctx.getImageData(0, 0, outW, outH);
            const vf = new VideoFrame(imageData.data.buffer, {
                format: 'RGBA',
                codedWidth: outW,
                codedHeight: outH,
                timestamp: outTs,
            });
            if (framesEncoded === framesAtGroupStart) {
              console.log(`[WC] ${passLabel} clip ${ci} — VideoFrame from canvas: `
                + `${vf.codedWidth}×${vf.codedHeight}, format: ${vf.format}, ts: ${vf.timestamp}`);
            }
            try {
              encoder.encode(vf, { keyFrame });
            } catch (syncErr) {
              console.error('[WC] encoder.encode() threw synchronously:', syncErr.name, syncErr.message, 'outTs:', outTs, 'keyFrame:', keyFrame);
              encErr = syncErr;
            }
            vf.close(); // Release GPU/memory immediately; encoder has its own copy.
            framesEncoded++;
            {
              const pct = progressBase + Math.round(((framesEncoded - framesAtGroupStart) / groupTotalFrames) * progressRange);
              setProgress(pct,
                `Encoding frame ${framesEncoded - framesAtGroupStart} / ${groupTotalFrames}`,
                `${passLabel} ${ci + 1} / ${groupGroups.length}`);
            }
            // Encoder backpressure: on Android the hardware encoder (MediaCodec)
            // and decoder share the same resource pool. If we let the encoder queue
            // grow unbounded (~132 frames), the decoder cannot complete flush() and
            // hangs indefinitely waiting for those MediaCodec resources to free up.
            // Yielding here until encodeQueueSize drops to a small number keeps the
            // encoder draining continuously and leaves decoder resources available.
            let backpressureYields = 0;
            while (encoder.encodeQueueSize > 5 && !encErr && !cancelExport) {
              await wcYield();
              backpressureYields++;
            }
            if (framesEncoded === framesAtGroupStart + 1) {
              console.log(`[WC] ${passLabel} clip ${ci} — after first encode: encodeQ=${encoder.encodeQueueSize} chunksOut=${chunksFromEncoder} state=${encoder.state}`);
            }
            if (framesEncoded % 20 === 0) {
              console.log(`[WC] ${passLabel} clip ${ci} encode progress — encoded=${framesEncoded}, encodeQ=${encoder.encodeQueueSize}, chunksOut=${chunksFromEncoder}, bpYields=${backpressureYields}`);
            }
          }
        };

        // Converts VideoFrames to ImageBitmaps (closing the VideoFrame immediately to
        // free the decoder's output buffer), inserts each into reorderBuffer in CTS
        // order, and calls encodeFromReorderBuffer to encode from the front of the
        // buffer whenever it exceeds REORDER_DEPTH entries.
        const drainFrames = async () => {
          if (drainingFrames) return;
          drainingFrames = true;
          console.log(`[WC] ${passLabel} clip ${ci} drainFrames — queue depth on entry: ${pendingFrames.length}`);
          while (pendingFrames.length > 0 && !cancelExport && !encErr) {
            const frame = pendingFrames.shift();
            try {
              framesDecodedThisClip++;
              // Translate the decoder's DTS-based timestamp to display time (CTS).
              const rawCtsMicros = lookupCts(frame.timestamp);
              // Guard: CTS must be within 1 s of DTS. B-frame reorder depths are
              // typically < 200 ms; anything larger indicates a corrupt/missing CTTS
              // entry that would produce a garbage output timestamp.
              const ctsMicros = (Number.isFinite(rawCtsMicros)
                && Math.abs(rawCtsMicros - frame.timestamp) <= 1_000_000)
                ? rawCtsMicros : frame.timestamp;
              if (rawCtsMicros !== ctsMicros)
                console.warn(`[WC] ${passLabel} clip ${ci} bad CTS: dts=${frame.timestamp} rawCts=${rawCtsMicros} → using dts`);
              const ctsSec    = ctsMicros / 1_000_000;
              if (framesDecodedThisClip === 1) {
                console.log(`[WC] ${passLabel} clip ${ci} — first decoded frame | format: ${frame.format}`
                  + ` | coded: ${frame.codedWidth}×${frame.codedHeight}`
                  + ` | display: ${frame.displayWidth}×${frame.displayHeight}`
                  + ` | ts: ${frame.timestamp} → ctsSec: ${ctsSec.toFixed(3)}`
                  + ` | colorSpace: ${JSON.stringify(frame.colorSpace)}`
                  + ` | in clip window: ${ctsSec >= clip.start - 0.002 && ctsSec <= clip.end + 0.002}`);
              }

              // Only process frames within the clip's display window.
              // Frames before clip.start are pre-roll: the decoder needed them to
              // build up its reference frame buffer, but we don't want them in output.
              //
              // Why ±0.002 s (2 ms) tolerance?
              // The clip boundaries (clip.start, clip.end) are floating-point seconds.
              // The frame's CTS is computed by dividing an integer timestamp by a
              // timescale integer, which introduces small rounding errors. A frame
              // intended to land exactly at clip.start might come out as
              // clip.start + 0.00011 s and get excluded without this tolerance.
              // 2 ms is much less than one frame (≈33 ms at 30fps), so it can't
              // accidentally pull in frames from outside the intended range.
              if (ctsSec >= clip.start - 0.002 && ctsSec <= clip.end + 0.002
                  && !cancelExport && !encErr) {
                // Hardware-decoded VideoFrames on Android are stored in a GPU-resident
                // YUV texture (produced by MediaCodec, the Android hardware codec).
                // createImageBitmap routes through the browser's compositing pipeline,
                // correctly handling GPU textures on every platform. The result is a
                // CPU-accessible RGBA ImageBitmap that can be held after the frame closes.
                const bitmap = await frameToBitmap(frame);
                // Insert into reorderBuffer maintaining CTS sorted order.
                // For B-frame sources the decoder emits in DTS order, which may differ
                // from CTS order by up to a few frames. Sorted insertion keeps the buffer
                // in display order so encodeFromReorderBuffer always encodes the earliest
                // displayable frame first.
                const insertIdx = reorderBuffer.findIndex(e => e.ctsMicros > ctsMicros);
                if (insertIdx === -1) reorderBuffer.push({ ctsMicros, bitmap });
                else reorderBuffer.splice(insertIdx, 0, { ctsMicros, bitmap });
                // Encode from the front of the buffer while we have enough lookahead.
                // frame.close() in the finally below frees the MediaCodec output buffer
                // before this encode step, so the decoder is never blocked waiting for room.
                await encodeFromReorderBuffer(false);
              }
            } catch (e) {
              if (!encErr) { encErr = e; console.error('[WC] frame processing error:', e.name, e.message); }
            } finally {
              // ALWAYS close the decoded frame, even pre-roll frames we don't use.
              // Decoded frames hold GPU-allocated memory. Forgetting to close them
              // will exhaust GPU memory and cause the decoder pipeline to stall.
              frame.close();
            }
          }
          // Drop any frames left in the queue (cancel or error path).
          while (pendingFrames.length > 0) pendingFrames.shift().close();
          console.log(`[WC] ${passLabel} clip ${ci} drainFrames done — totalDecoded=${framesDecodedThisClip}, reorderBuffer=${reorderBuffer.length}, encErr=${!!encErr}`);
          drainingFrames = false;
        };

        // Each clip gets its own fresh VideoDecoder so there is no leftover state
        // (reference frames, B-frame buffers) carried over from the previous clip.
        const decoder = new VideoDecoder({
          output: (frame) => {
            // Synchronous: just enqueue. drainFrames() does the async work.
            // This prevents Android's burst-output from spawning hundreds of
            // concurrent coroutines, each holding an ~8 MB decoded frame in memory.
            pendingFrames.push(frame);
            drainFrames(); // intentionally not awaited
          },
          error: e => {
            encErr = e;
            console.error('[WC] DECODER ERROR at clip', ci, '—', e.name, e.message, e);
          },
        });
        decoder.configure(decoderConfig);
        console.log(`[WC] ${passLabel} clip ${ci} decoder state after configure: ${decoder.state}`);

        let samplesSent = 0;
        for (let si = 0; si < allSamples.length; si++) {
          if (encErr || decoder.state === 'closed') {
            console.warn(`[WC] ${passLabel} clip ${ci} decode loop exited early at si=${si}: encErr=${!!encErr}, decoderState=${decoder.state}`);
            break;
          }
          const s  = allSamples[si];
          const ts = s.timescale || timescale;
          const sampleData = clipDataMap.get(s.offset);
          if (si === 0) {
            console.log(`[WC] ${passLabel} clip ${ci} first decode() call: type=${s.is_sync?'key':'delta'}, ts=${Math.round(s.dts*1e6/ts)}, dataLen=${sampleData.byteLength}`);
          }
          // Feed a single compressed frame ("sample") to the decoder.
          // is_sync = true → keyframe (I-frame); false → P-frame or B-frame ("delta").
          // Timestamps are in microseconds; dts = decode order, duration = frame length.
          // The decoder queues this and calls output() asynchronously when ready.
          decoder.decode(new EncodedVideoChunk({
            type:      s.is_sync ? 'key' : 'delta',
            timestamp: Math.round(s.dts * 1_000_000 / ts),
            duration:  Math.round(s.duration * 1_000_000 / ts),
            data:      sampleData,
          }));
          samplesSent++;
          // JavaScript is single-threaded. While we're in this synchronous loop,
          // no callbacks (including the decoder's output()) can fire. Yielding every
          // 50 samples hands control back to the browser for one tick, letting the
          // decoder drain its output queue and free GPU memory incrementally.
          // 50 samples ≈ 1.7 s of video at 30fps — frequent enough to keep memory
          // low without thrashing the event loop with constant yields.
          if ((si + 1) % 50 === 0) {
            await wcYield();
            console.log(`[WC] ${passLabel} clip ${ci} sample ${si}: framesDecoded=${framesDecodedThisClip} framesEncoded=${framesEncoded} decoderState=${decoder.state} decodeQ=${decoder.decodeQueueSize} encodeQ=${encoder.encodeQueueSize}`);
          }
        }
        console.log(`[WC] ${passLabel} clip ${ci} decode loop done: samplesSent=${samplesSent}, decoderState=${decoder.state}`);

        if (encErr) throw encErr;
        console.log(`[WC] ${passLabel} clip ${ci} pre-flush — decoded=${framesDecodedThisClip}, encoded=${framesEncoded}, pendingFrames=${pendingFrames.length}, drainingFrames=${drainingFrames}`);
        // flush() signals "no more input" to the decoder and waits until it has
        // emitted all remaining output frames (including buffered B-frames).
        // Three-way race: normal completion, 20 s stall timeout, or user cancel.
        // The cancel leg polls every 50 ms — frequent enough that cancel feels instant
        // to the user, but not so frequent (e.g. 1 ms) that it burns CPU in the loop.
        // It resolves (not rejects) so the try block falls through to decoder.close()
        // cleanly rather than jumping to the catch block.
        if (decoder.state !== 'closed') {
          let stallTimer, cancelPoll;
          try {
            // Progress-based stall detection: reset the 20 s window every time a new
          // frame is decoded. A fixed wall-clock timeout fires on long clips even when
          // the decoder is making steady progress — MediaCodec output buffers fill up
          // and are freed one-at-a-time by drainFrames, so flush() takes O(frames).
          let lastDecodedCount = framesDecodedThisClip;
          await Promise.race([
              decoder.flush(),
              new Promise((_, rej) => {
              stallTimer = setInterval(() => {
                if (framesDecodedThisClip > lastDecodedCount) {
                  lastDecodedCount = framesDecodedThisClip;
                } else {
                  clearInterval(stallTimer);
                    rej(new Error('Decoder stalled — try a different video file'));
                }
              }, 20_000);
            }),
              new Promise(res => { cancelPoll = setInterval(() => {
                if (cancelExport) { clearInterval(cancelPoll); res(); }
              }, 50); }),
            ]);
          } finally {
            clearInterval(stallTimer);
            clearInterval(cancelPoll);
          }
        }
        console.log(`[WC] ${passLabel} clip ${ci} post-flush decoder state: ${decoder.state}`);
        // decoder.close() is deferred until after the drain wait below.
        // Closing it here (while drainFrames may still be processing a frame) can
        // invalidate the GPU texture backing the outstanding VideoFrame on Android,
        // causing createImageBitmap to hang indefinitely.

        // Wait for the frame queue to finish draining before continuing.
        // On Android the hardware decoder emits all frames in a burst during flush(),
        // so drainFrames() is still running asynchronously when flush() resolves.
        let drainWaitTicks = 0;
        while ((drainingFrames || pendingFrames.length > 0) && !encErr && !cancelExport) {
          await wcYield();
          if (++drainWaitTicks % 200 === 0) {
            console.log(`[WC] ${passLabel} clip ${ci} drain wait spinning — drainingFrames=${drainingFrames}, pendingFrames=${pendingFrames.length}, tick=${drainWaitTicks}`);
          }
        }
        // Drop any leftover frames on the cancel/error path.
        while (pendingFrames.length > 0) pendingFrames.shift().close();
        // All outstanding VideoFrames are now closed — safe to close the decoder.
        if (decoder.state !== 'closed') decoder.close();
        console.log(`[WC] ${passLabel} clip ${ci} post-flush drain complete — decoded=${framesDecodedThisClip}, reorderBuffer=${reorderBuffer.length}, encoded=${framesEncoded}`);

        // Drain the final frames still buffered in the reorder window.
        // During decoding, encodeFromReorderBuffer(false) kept REORDER_DEPTH frames
        // back as lookahead. Now that all frames have been decoded and the VideoDecoder
        // is closed, we flush the remainder in CTS order.
        await encodeFromReorderBuffer(true);
        // Drop any remaining bitmaps on cancel/error path.
        while (reorderBuffer.length > 0) reorderBuffer.shift().bitmap.close();

        clipDataMap.clear(); // release compressed frame bytes; no longer needed after decode
        console.log(`[WC] ${passLabel} clip ${ci} summary: decoded=${framesDecodedThisClip}, encoded=${framesEncoded} total so far`);

        // Flush the encoder after each clip so all buffered frames are compressed
        // and released from GPU memory before the next clip's decoder starts.
        // Without this, frames pile up across clips and exhaust GPU memory.
        // Skip on the last clip — the flush after the group handles that.
        if (ci < groupGroups.length - 1 && !cancelExport && !encErr) {
          console.log(`[WC] flushing encoder after ${passLabel} clip ${ci}, queue was:`, encoder.encodeQueueSize);
          await encoder.flush();
          console.log(`[WC] encoder flushed, queue now:`, encoder.encodeQueueSize);
        }

        cumulativeDuration += clip.end - clip.start;
      }
    }; // end encodeGroup

    if (exportCombined) {
      // Pass 1: highlighted clips, no scoreboard.
      setProgress(21, 'Part 1/2 — Highlights…');
      await encodeGroup(hlGroups, getHlData, false, 21, 34, 'Highlights');
      if (cancelExport) return;
      if (encErr) throw encErr;
      // Flush the highlights encoder pass and create a fresh encoder for the full match.
      // A new VideoEncoder instance forces an IDR (keyframe) at the very first frame of
      // pass 2, making the full-match section independently seekable in the output file.
      console.log('[WC] combined: flushing encoder between passes');
      setProgress(55, 'Starting full match…');
      await encoder.flush();
      encoder.close();
      makeEncoder();
      // Pass 2: all clips, with scoreboard.
      setProgress(55, 'Part 2/2 — Full match…');
      await encodeGroup(clipGroups, getClipData, true, 55, 38, 'Match');
    } else {
      await encodeGroup(clipGroups, getClipData, !disableScoreboard, 11, 82, 'Clip');
    }

    if (cancelExport) return;
    if (encErr) throw encErr;

    // Tell the encoder there are no more frames. It drains any internally buffered
    // frames, calling output() for each, before the promise resolves.
    setProgress(93, 'Flushing encoder…');
    console.log(`[WC] pre-flush — framesEncoded=${framesEncoded}, chunksFromEncoder=${chunksFromEncoder}, encodeQ=${encoder.encodeQueueSize}`);
    await encoder.flush();
    console.log(`[WC] post-flush — chunksFromEncoder=${chunksFromEncoder}, encodeQ=${encoder.encodeQueueSize}`);
    encoder.close();

    // Audio: direct copy — AAC frames from the source are muxed as-is.
    // We don't need to decode and re-encode audio because we're not changing it
    // (no overlay, no pitch shift, nothing). Unlike video frames, which store
    // differences between frames and need full decompression to modify, AAC audio
    // frames are completely self-contained — each one holds a full 21 ms snapshot
    // of audio that can be read and written independently of any other frame.
    // This is why every frame is marked type: 'key': there is no such thing as
    // an audio "P-frame" or "B-frame." Copying them directly costs almost no time.
    // ⚠ NOTE: Because AAC frames are ~21 ms wide, the nearest frame boundary may
    // not align exactly to clip.start/end, causing a small click or gap at each cut.
    if (audioTrack && audioSamples.length) {
      setProgress(95, 'Muxing audio…');
      const aTs = audioTrack.timescale;
      let audioCumulative = 0;
      // Same monotonicity requirement as video: samples slightly past clip.end
      // (within the ±0.002 s filter) get outTs values that overshoot the base for
      // the next clip, causing the muxer to see a backward DTS at the boundary.
      let lastAudioTs = -1;
      const muxClipAudio = (clipsToMux) => {
        for (const clip of clipsToMux) {
          const clipAudio = audioSamples.filter(s => {
            const t = s.cts / (s.timescale || aTs);
            return t >= clip.start - 0.002 && t <= clip.end + 0.002;
          });
          for (const s of clipAudio) {
            const t = s.cts / (s.timescale || aTs);
            const rawOutTs = Math.max(0, Math.round(((t - clip.start) + audioCumulative) * 1_000_000));
            const outTs = lastAudioTs >= 0 && rawOutTs <= lastAudioTs
              ? lastAudioTs + 1
              : rawOutTs;
            if (outTs !== rawOutTs) {
              console.log(`[WC] audio outTs clamped at clip boundary: raw=${rawOutTs} → ${outTs}`);
            }
            lastAudioTs = outTs;
            // duration: how long this audio frame lasts, in microseconds.
            const outDur = Math.max(1, Math.round(s.duration * 1_000_000 / (s.timescale || aTs)));
            muxer.addAudioChunkRaw(audioDataMap.get(s.offset), 'key', outTs, outDur, null);
          }
          audioCumulative += clip.end - clip.start;
        }
      };
      if (exportCombined) {
        muxClipAudio(highlightClips); // pass 1 audio (highlights only)
        muxClipAudio(exportClips);    // pass 2 audio (all clips, timestamps continue)
      } else {
        muxClipAudio(exportClips);
      }
    }

    // finalize() instructs the muxer to write all MP4 structural metadata
    // (moov box, track headers, sample tables, stts/ctts timing tables, etc.)
    // and produce the final byte sequence in muxer.target.buffer.
    // finalize() is synchronous and can block the thread for a moment on large files.
    // The wcYield() before it gives the browser one tick to render the "Finalizing"
    // progress message before that block happens, so the UI doesn't appear frozen.
    setProgress(98, 'Finalizing MP4…');
    await wcYield();
    muxer.finalize();

    if (outputChunks.length) {
      outputBlobParts.push(new Blob(outputChunks));
      outputChunks.length = 0;
    }
    const blob = isMobile
      ? new Blob(outputBlobParts, { type: 'video/mp4' })
      : new Blob([muxer.target.buffer], { type: 'video/mp4' });
    console.log(`[WC] blob size: ${blob.size} bytes (${(blob.size / 1024).toFixed(1)} KB)${isMobile ? `, parts: ${outputBlobParts.length}` : ''}`);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const date = new Date().toISOString().slice(0, 10);
    a.download = `gamepointla_${homeLabel}_${awayLabel}_${date}${exportCombined ? '_combined' : ''}.mp4`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Revoke after 30 s, not immediately. a.click() triggers the download
    // but the browser's download manager picks up the URL asynchronously.
    // Revoking too early (before the download starts reading the blob) would
    // make the download fail. 30 s is generous enough for any browser to start.
    setTimeout(() => URL.revokeObjectURL(url), 30_000);

    const totalClipCount = exportCombined
      ? highlightClips.length + exportClips.length
      : exportClips.length;
    setProgress(100, `✓ Exported — ${wcFmtSize(blob.size)}`,
      `${framesEncoded} frames · ${totalClipCount} clip${totalClipCount !== 1 ? 's' : ''}`);
    const cancelBtn = $('exp-cancel-btn');
    if (cancelBtn) { cancelBtn.textContent = 'Done'; cancelBtn.onclick = () => openExport(); }
    $('exp-bar').style.background = 'var(--serve)';
    toast(exportCombined ? 'Combined export complete ✓' : 'Export complete ✓');

  } catch (err) {
    trackEvent('webcodecs_error', { message: err.message });
    console.error('[WC] export failed —', err.name, err.message);
    console.error('[WC] stack:', err.stack);
    const lbl = $('exp-status');
    if (lbl) { lbl.style.color = 'var(--danger)'; lbl.textContent = '⚠ ' + err.message; }
    const cancelBtn = $('exp-cancel-btn');
    if (cancelBtn) { cancelBtn.textContent = 'Back'; cancelBtn.onclick = () => openExport(); }
    if (isFileAccessError(err)) showReopenVideoButton();
  }
}

function cancelExportFn() {
  cancelExport = true;
  openExport();
  toast('Export cancelled');
}

function isFileAccessError(err) {
  return err.message.includes('no longer accessible') || err.message.includes('Failed to load video');
}

function showReopenVideoButton() {
  const body = $('export-body');
  if (!body) return;
  const btn = document.createElement('button');
  btn.className = 'btn-primary';
  btn.style.cssText = 'margin-top:12px;width:100%';
  btn.textContent = 'Open Video';
  btn.onclick = () => { retryExportAfterReopen = true; triggerOpen(); };
  body.appendChild(btn);
}

// ── Helpers ──────────────────────────────────────────

function wcClampBitrate(w, h, fps) {
  return Math.min(20_000_000, Math.max(2_000_000, Math.round(w * h * fps * 0.05)));
}

function wcScoreAt(tSec) {
  const h = clips.filter(c => c.end !== null && c.end <= tSec && c.type === 'home_point').length;
  const a = clips.filter(c => c.end !== null && c.end <= tSec && c.type === 'away_point').length;
  return { h, a };
}

function wcDrawWatermark(ctx, w, h, logoImg) {
  if (!logoImg || !logoImg.naturalWidth) return;
  const iconH   = Math.max(32, Math.round(h * 0.08));
  const marginX = Math.round(w * 0.022);
  const marginY = Math.round(h * 0.022);

  ctx.save();
  ctx.shadowColor   = 'rgba(0,0,0,0.45)';
  ctx.shadowBlur    = Math.round(iconH * 0.3);
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
  ctx.drawImage(logoImg, w - marginX - iconH, marginY, iconH, iconH);
  ctx.shadowColor = 'transparent';
  ctx.restore();
}

function wcDrawScoreboard(ctx, w, h, homeTeam, awayTeam, homeScore, awayScore) {
  const barH = Math.max(30, Math.round(h * 0.065));
  const y = h - barH;
  const pad = Math.round(w * 0.022);
  const fontSize = Math.round(barH * 0.56);

  ctx.fillStyle = 'rgba(0,0,0,0.72)';
  ctx.fillRect(0, y, w, barH);

  ctx.font = `800 ${fontSize}px "Arial Narrow", Arial, sans-serif`;
  ctx.textBaseline = 'middle';
  const midY = y + barH / 2;
  const maxSideW = Math.round(w / 2 - pad - pad);

  ctx.fillStyle = '#7eb3ff';
  ctx.textAlign = 'left';
  ctx.fillText(`${homeTeam.toUpperCase()}  ${homeScore}`, pad, midY, maxSideW);

  ctx.fillStyle = 'rgba(255,255,255,0.3)';
  ctx.textAlign = 'center';
  ctx.fillText('·', w / 2, midY);

  ctx.fillStyle = '#ff8a80';
  ctx.textAlign = 'right';
  ctx.fillText(`${awayScore}  ${awayTeam.toUpperCase()}`, w - pad, midY, maxSideW);
}

function wcDrawScoreboardbox(ctx, w, h, homeTeam, awayTeam, homeScore, awayScore, vPos = 'top', hPos = 'left', logoImg = null) {
  const rowH     = Math.max(22, Math.round(h * 0.052));
  const margin   = Math.round(w * 0.022);
  const accentW  = Math.round(rowH * 0.22);
  const pad      = Math.round(rowH * 0.28);
  const fontSize = Math.round(rowH * 0.54);

  ctx.font = `700 ${fontSize}px "Arial Narrow", Arial, sans-serif`;

  const homeText  = homeTeam.toUpperCase();
  const awayText  = awayTeam.toUpperCase();
  const maxNameW  = Math.max(ctx.measureText(homeText).width, ctx.measureText(awayText).width);
  const maxScoreW = Math.max(ctx.measureText(String(homeScore)).width, ctx.measureText(String(awayScore)).width);

  const minBoxW  = Math.round(w * 0.24);
  const boxW     = Math.max(minBoxW, Math.ceil(accentW + pad + maxNameW + pad + maxScoreW + pad));
  const boxH     = rowH * 2;
  const iconSize = (logoImg && logoImg.naturalWidth) ? boxH : 0;

  // Watermark sits between the scoreboard and the nearest screen edge, touching it.
  // [icon][box] for left, [box][icon] for right, so the icon is always outermost.
  const bx = hPos === 'right'  ? w - margin - iconSize - boxW
           : hPos === 'center' ? Math.round((w - boxW - iconSize) / 2)
           :                     margin + iconSize;
  const by = vPos === 'bottom' ? Math.round(h - margin * 0.8 - boxH)
           :                     Math.round(h * 0.03);
  const iconX = hPos === 'left' ? bx - iconSize : bx + boxW;

  ctx.shadowColor   = 'rgba(0,0,0,0.6)';
  ctx.shadowBlur    = Math.round(rowH * 0.4);
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;

  ctx.fillStyle = 'rgba(10,10,10,0.88)';
  ctx.fillRect(bx, by, boxW, boxH);
  ctx.shadowBlur = 0;

  ctx.fillStyle = '#1A73E8';
  ctx.fillRect(bx, by, accentW, rowH);
  ctx.fillStyle = '#D32F2F';
  ctx.fillRect(bx, by + rowH, accentW, rowH);
  ctx.fillStyle = 'rgba(255,255,255,0.10)';
  ctx.fillRect(bx, by + rowH, boxW, 1);

  ctx.textBaseline = 'middle';
  const textX  = bx + accentW + pad;
  const scoreX = bx + boxW - pad;

  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'left';
  ctx.fillText(homeText, textX, by + rowH / 2);
  ctx.fillStyle = '#7eb3ff';
  ctx.textAlign = 'right';
  ctx.fillText(homeScore, scoreX, by + rowH / 2);

  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'left';
  ctx.fillText(awayText, textX, by + rowH + rowH / 2);
  ctx.fillStyle = '#ff8a80';
  ctx.textAlign = 'right';
  ctx.fillText(awayScore, scoreX, by + rowH + rowH / 2);

  ctx.shadowColor = 'transparent';

  if (iconSize) {
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur  = Math.round(iconSize * 0.3);
    ctx.drawImage(logoImg, iconX, by, iconSize, iconSize);
    ctx.restore();
  }
}

function wcDrawActiveScoreboard(ctx, w, h, homeTeam, awayTeam, homeScore, awayScore, style, vPos, hPos, logoImg = null) {
  const s  = style ?? exportScoreboardStyle;
  const vp = vPos  ?? exportScoreboardPosition.v;
  const hp = hPos  ?? exportScoreboardPosition.h;
  if (s === 'box') {
    wcDrawScoreboardbox(ctx, w, h, homeTeam, awayTeam, homeScore, awayScore, vp, hp, logoImg);
  } else {
    wcDrawScoreboard(ctx, w, h, homeTeam, awayTeam, homeScore, awayScore);
    wcDrawWatermark(ctx, w, h, logoImg);
  }
}

// Scan the file's top-level box headers (8 bytes each) to locate moov without
// reading any mdat content.  For a 1.6 GB file this reads ~48 bytes total.
async function wcFindMoov(file) {
  let offset = 0;
  while (offset + 8 <= file.size) {
    const hdr = new DataView(await file.slice(offset, Math.min(offset + 16, file.size)).arrayBuffer());
    let size = hdr.getUint32(0, false);
    const type = String.fromCharCode(hdr.getUint8(4), hdr.getUint8(5), hdr.getUint8(6), hdr.getUint8(7));
    if (size === 1) {
      // 64-bit extended size stored in the next 8 bytes
      size = hdr.getUint32(8, false) * 4294967296 + hdr.getUint32(12, false);
    } else if (size === 0) {
      size = file.size - offset; // box extends to EOF
    }
    if (type === 'moov') return { start: offset, size };
    if (size < 8) { console.warn('[WC] wcFindMoov: bad box size', size, 'at offset', offset); break; }
    offset += size;
  }
  return null;
}

// Parses only the moov box to build a sample table (timestamps, offsets, sizes).
// No mdat is read, so sample.data is null for every entry — Part 2 will fetch
// sample bytes on demand per clip.
async function wcParseMp4(_url, file) {
  const wcMem = () => {
    if (!performance.memory) return '';
    const mb = v => (v / 1048576).toFixed(0) + 'MB';
    return ` heap=${mb(performance.memory.usedJSHeapSize)}/${mb(performance.memory.jsHeapSizeLimit)}`;
  };

  console.log(`[WC] wcParseMp4 start${wcMem()}`);
  const moovInfo = await wcFindMoov(file);
  if (!moovInfo) throw new Error('moov box not found — file may be corrupt or in an unsupported format');
  console.log(`[WC] moov offset=${(moovInfo.start/1048576).toFixed(0)}MB size=${(moovInfo.size/1048576).toFixed(1)}MB${wcMem()}`);

  return new Promise(async (resolve, reject) => {
    const mp4file = MP4Box.createFile();
    const result = { videoTrack: null, audioTrack: null, videoSamples: [], audioSamples: [], mp4file, moovBuf: null };

    mp4file.onReady = info => {
      result.videoTrack = info.videoTracks[0] || null;
      result.audioTrack = info.audioTracks[0] || null;
      console.log(`[WC] onReady — video=${!!result.videoTrack} (nb_samples=${info.videoTracks[0]?.nb_samples}) audio=${!!result.audioTrack}${wcMem()}`);

      // setExtractionOptions + start() causes MP4Box to call buildSampleLists internally,
      // populating trak.samples with per-sample dts/cts/is_sync/offset/size from the
      // stts/stss/stco/stsz boxes in moov.  No mdat is fed so data stays null.
      if (result.videoTrack)
        mp4file.setExtractionOptions(result.videoTrack.id, null, { nbSamples: Infinity });
      if (result.audioTrack)
        mp4file.setExtractionOptions(result.audioTrack.id, null, { nbSamples: Infinity });
      mp4file.start();

      if (result.videoTrack)
        result.videoSamples = mp4file.getTrackById(result.videoTrack.id)?.samples ?? [];
      if (result.audioTrack)
        result.audioSamples = mp4file.getTrackById(result.audioTrack.id)?.samples ?? [];
    };

    mp4file.onSamples = () => {}; // no mdat fed — should never fire
    mp4file.onError = reject;

    try {
      // MP4Box processes buffers in file order (by fileStart), not feeding order.
      // Feeding moov alone (at fileStart=moovInfo.start) just pre-loads it; the
      // sequential parser starts at offset 0 and won't reach moov until it advances.
      // Feeding the first 1 KB gives MP4Box the ftyp box + the 8-byte mdat box header.
      // The mdat header encodes the full mdat size, so the parser advances by that size
      // and lands exactly at moovInfo.start — no mdat content needed.
      if (moovInfo.start > 0) {
        const preamble = await file.slice(0, Math.min(1024, moovInfo.start)).arrayBuffer();
        preamble.fileStart = 0;
        mp4file.appendBuffer(preamble);
      }

      result.moovBuf = await file.slice(moovInfo.start, moovInfo.start + moovInfo.size).arrayBuffer();
      result.moovBuf.fileStart = moovInfo.start;
      mp4file.appendBuffer(result.moovBuf); // onReady fires synchronously here

      await new Promise(r => setTimeout(r, 0)); // let onReady + start() settle
      mp4file.flush();

      // Access sample table built from moov's stts/stss/stco/stsz boxes.
      // Each sample has dts/cts/is_sync/offset/size — data is null (no mdat fed).
      if (result.videoTrack)
        result.videoSamples = mp4file.getTrackById(result.videoTrack.id)?.samples ?? [];
      if (result.audioTrack)
        result.audioSamples = mp4file.getTrackById(result.audioTrack.id)?.samples ?? [];

      const vs = result.videoSamples;
      const ts = result.videoTrack?.timescale ?? 1;
      console.log(`[WC] sample table: ${vs.length} video, ${result.audioSamples.length} audio${wcMem()}`);
      if (vs.length > 0) {
        const s0 = vs[0], sN = vs[vs.length - 1];
        console.log(`[WC] sample[0]:    is_sync=${s0.is_sync} dts=${(s0.dts/ts).toFixed(3)}s offset=${s0.offset} size=${s0.size} data=${s0.data ?? 'null ✓'}`);
        console.log(`[WC] sample[last]: is_sync=${sN.is_sync} dts=${(sN.dts/ts).toFixed(3)}s offset=${sN.offset} size=${sN.size}`);
        const allValid  = vs.every(s => s.offset > 0 && s.size > 0);
        const anyLoaded = vs.some(s => s.data != null);
        console.log(`[WC] offsets/sizes valid: ${allValid} | data pre-loaded: ${anyLoaded} (want false)`);
        if (!allValid) console.warn('[WC] ⚠ some samples missing offset/size — Part 2 will fail');
      } else {
        console.warn('[WC] ⚠ videoSamples empty — trak.samples not populated; onReady may not have fired');
      }
      resolve(result);
    } catch (e) {
      reject(e);
    }
  });
}

function wcBuildDecoderConfig(videoTrack, mp4file) {
  const config = {
    codec: videoTrack.codec,
    codedWidth:  videoTrack.video.width,
    codedHeight: videoTrack.video.height,
    hardwareAcceleration: 'prefer-hardware',
  };
  try {
    const trak = mp4file.getTrackById(videoTrack.id);
    const entry = trak.mdia.minf.stbl.stsd.entries[0];
    if (entry.avcC) {
      // H.264/AVC: codec parameters live in the avcC box as SPS + PPS NAL units.
      // MP4Box.DataStream is not exposed in the browser UMD build, so we manually
      // serialize the AVCDecoderConfigurationRecord bytes ourselves.
      config.description = wcSerializeAvcC(entry.avcC);
    } else if (entry.hvcC) {
      // H.265/HEVC: codec parameters live in the hvcC box as VPS + SPS + PPS NAL
      // unit arrays. Android phones often record in HEVC (it's roughly 40% smaller
      // than H.264 at the same quality), so this path handles the common case of
      // phone footage that fails with avcC-only code.
      // The output of the overall pipeline is still H.264 (the VideoEncoder is
      // always configured with an avc1 codec), so we're decoding HEVC → re-encoding
      // as H.264, which Chrome/Android supports via hardware HEVC decode.
      config.description = wcSerializeHvcC(entry.hvcC);
    }
  } catch (e) {
    console.error('wcBuildDecoderConfig:', e);
  }
  return config;
}

// wcSerializeAvcC, wcSerializeHvcC, wcPickH264Codec are loaded from export-utils.js

