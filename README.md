# SportMark

A zero-install, single-page web app for marking and exporting rally clips from volleyball match footage. Load a video file, tap **Serve** at the start of each rally and a point button at the end, then export all marked rallies stitched into one MP4 with a live scoreboard burned in.

Works on desktop Chrome and Android Chrome. No server, no account, no build step.

---

## Current state

**Working**

- Load any local MP4/MOV video file (H.264 or HEVC/H.265)
- Mark rallies with serve → home point / away point / no point
- Undo/redo, highlight toggle, clip type editing
- Marks list panel with seek-to-clip and delete
- Review panel (plays each clip in sequence with scoreboard overlay)
- Export pipeline — two engines:
  - **WebCodecs** (default): frame-accurate, fast, produces MP4 via mp4-muxer; works at 1080p/4K; burns live scoreboard onto each frame
  - **MediaRecorder** fallback: real-time playback capture into WebM; lower accuracy but broader compatibility
- Export quality selector (low / medium / high bitrate)
- Cancel mid-export
- Scoreboard overlay — home/away labels drawn on every exported frame
- PWA manifest + service worker (installable, works offline once cached)
- Android-specific fixes:
  - Lazy `editorVideo` loading prevents hardware decoder pool exhaustion (the freeze-on-load bug)
  - HEVC (`hvcC`) decoder config support alongside H.264 (`avcC`) — phones often record HEVC
  - Dynamic H.264 level selection for the encoder (4.0 → 5.0 → 5.1 based on resolution × fps)
  - `createImageBitmap` for GPU-resident VideoFrames — fixes the black-screen export bug on Android
  - Blob URL file read at export time — avoids Android's file permission expiry after tab backgrounding

**Test coverage**

- Unit tests (Vitest, Node.js): `fmt`, `fmtDur`, `wcFmtSize`, `wcPickH264Codec`, `wcSerializeAvcC`, `wcSerializeHvcC`, `wcGetSamplesForClip`
- E2E tests (Playwright, real Chromium): page load, video load, WebCodecs export produces valid MP4, export shows 100% progress, error on empty clip list, cancel mid-export, exported frames are not all black

---

## What still needs work

- **Audio in WebCodecs export**: the WebCodecs path currently drops audio. The MediaRecorder path captures audio from the video element stream. Adding audio to WebCodecs requires decoding audio samples with `AudioDecoder` and muxing them alongside the video with mp4-muxer's audio track — non-trivial but the muxer supports it.
- **Cross-browser**: WebCodecs is Chrome/Edge only. Safari does not support `VideoEncoder` as of mid-2025. The MediaRecorder fallback covers Firefox and Safari but produces WebM, not MP4, and is real-time (slow for long files).
- **Session persistence**: clips are held in memory only. Closing the tab loses all marks. LocalStorage or IndexedDB could save/restore the clip list and team names.
- **Marks import/export**: there is UI scaffolding for importing/exporting marks as JSON (the Import Confirm modal exists) but the file round-trip logic is incomplete.
- **Service worker cache versioning**: `sw.js` hard-codes `sportmark-v1`. Deploying a new version requires manually bumping the cache name or users may serve stale files.
- **Mobile scrubbing UX**: the progress bar is the primary seek control on mobile; fine-grained scrubbing on a touch screen is awkward. A dedicated scrub wheel or frame-step gesture would help.

---

## Design decisions

### Single HTML file (mostly)

The whole app — HTML, CSS, and JS — lives in `index.html` plus a small `export-utils.js` sidecar. There is no bundler, no transpiler, no `node_modules` at runtime. This keeps the dev loop instant (`python -m http.server`, done) and the deployed artifact trivially simple. The tradeoff is that `index.html` is long; sections are separated by banner comments.

### `export-utils.js` as a dual-mode module

Pure utility functions (`fmt`, `wcSerializeAvcC`, `wcGetSamplesForClip`, etc.) are extracted to `export-utils.js`. The file uses plain `function` declarations (which become window globals when loaded as a `<script>`) and a `module.exports` guard at the bottom for Node.js. This lets Vitest `require()` the exact same file the browser loads — no duplicated logic, no mock.

### Two `<video>` elements, one lazy

`mainVideo` plays the full file on the main screen. `editorVideo` is a separate element for the editor overlay. Android Chrome's hardware decoder pool is small (often 1–2 instances per codec family). Assigning the same `src` to both elements simultaneously exhausts the pool and causes the main video to freeze. The fix: `editorVideo.src` is only assigned inside `openEditor()` when `readyState < 1`, and is cleared (`removeAttribute('src')`) whenever a new file is loaded.

### `createImageBitmap` for GPU VideoFrames

Hardware-decoded `VideoFrame` objects on Android (via MediaCodec) are GPU-resident NV12 textures. Calling `ctx.drawImage(frame)` on an `OffscreenCanvas` 2D context fails silently — the canvas stays black. `createImageBitmap(frame)` routes through the browser's compositing pipeline which correctly converts the GPU texture to a CPU-accessible RGBA ImageBitmap. This is the fix for the black-screen export bug.

### Blob URL instead of `File.arrayBuffer()`

Android grants temporary filesystem read permission at file-pick time. By export time, the user may have locked their phone or backgrounded the tab, expiring that permission. Reading the file again via `videoFile.arrayBuffer()` throws `NotReadableError`. The fix: `URL.createObjectURL(file)` is called immediately at load time, copying the bytes into the browser's internal blob store. At export time, `fetch(videoSrc).then(r => r.arrayBuffer())` reads from that blob URL, which has no filesystem permission dependency.

### WebCodecs `firstOfClip` race condition

The decoder `output` callback is `async` (it calls `await createImageBitmap`). If two frame callbacks are in flight simultaneously and both read `firstOfClip` before either resets it, both will encode with `keyFrame: true`, corrupting the stream. The fix: `const keyFrame = firstOfClip; firstOfClip = false;` is executed *synchronously* at the top of the callback, before the first `await`.

---

## Running locally

No build step required. Serve the directory over HTTP (browsers block some APIs on `file://`):

```bash
python -m http.server 8080
```

Then open `http://localhost:8080` in Chrome.

> Any static file server works. `npx serve .` (see below) is an alternative if Node.js is available.

---

## Tests

### Setup

Install dev dependencies (Vitest + Playwright + serve — only needed for tests, not for running the app):

```bash
npm install
npx playwright install   # downloads the Chromium binary used by E2E tests
```

### Unit tests (fast, no browser)

Tests for the pure utility functions in `export-utils.js`. Runs in Node.js in ~300 ms.

```bash
npm test              # run once
npm run test:watch    # re-run on file change
```

### E2E tests (real Chromium, ~30–60 s)

Tests the full export pipeline in a real browser, including WebCodecs encode/decode, file download, and pixel-level verification that exported frames are not black.

```bash
npm run test:e2e          # headless
npm run test:e2e:ui       # Playwright interactive UI — useful for debugging
```

The E2E suite starts a local `serve` server automatically on port 5500.

### What each layer tests

| Layer | Tool | What it verifies |
|---|---|---|
| Unit | Vitest | Timestamp formatting, H.264 level selection, AVC/HEVC binary serialization, sample-window slicing |
| E2E | Playwright | Page load, video ingestion, WebCodecs export produces a valid MP4 (`ftyp` box), export progress reaches 100%, cancellation, non-black pixel output |

The E2E tests generate a synthetic red/blue alternating H.264 test video entirely inside the browser using WebCodecs, so no binary fixture file is needed.
