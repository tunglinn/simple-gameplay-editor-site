# GamePointLa

A zero-install, single-page web app for marking and exporting rally clips from volleyball match footage. Load a video file, tap **Serve** at the start of each rally and a point button at the end, then export all marked rallies stitched into one MP4 with a live scoreboard burned in.

Works on desktop Chrome and Android Chrome. No server, no account, no build step.

---

## Branches

- **`main`** — stable releases
- **`beta`** — active development; may include fixes and features not yet merged to main

---

## Features

- Load any local MP4/MOV video file (H.264 or HEVC/H.265)
- Mark rallies with serve → home point / away point / no point
- Undo/redo, highlight toggle, clip type editing
- Marks list panel with seek-to-clip and delete
- Review panel — plays each clip in sequence with scoreboard overlay
- Export pipeline — two engines:
  - **WebCodecs** (default): frame-accurate, fast, produces MP4 via mp4-muxer; burns live scoreboard onto each frame
  - **MediaRecorder** fallback: real-time playback capture into WebM; lower accuracy but broader compatibility
- Export quality selector (low / medium / high bitrate)
- Cancel mid-export; progress-based stall detection
- PWA manifest + service worker (installable, works offline once cached)
- Android-specific fixes:
  - Lazy `editorVideo` loading prevents hardware decoder pool exhaustion
  - HEVC (`hvcC`) decoder config support alongside H.264 (`avcC`)
  - `createImageBitmap` for GPU-resident VideoFrames — fixes black-screen export on Android
  - Blob URL file read at export time — avoids Android file permission expiry after tab backgrounding

---

## What still needs work

- **Audio in WebCodecs export**: the WebCodecs path currently drops audio. Adding audio requires `AudioDecoder` + mp4-muxer audio track.
- **Cross-browser**: WebCodecs is Chrome/Edge only. Safari does not support `VideoEncoder`. The MediaRecorder fallback covers Firefox/Safari but produces WebM and runs real-time.
- **Session persistence**: clips are held in memory only. Closing the tab loses all marks.
- **Marks import/export**: UI scaffolding exists (Import Confirm modal) but the file round-trip logic is incomplete.
- **Mobile scrubbing UX**: fine-grained scrubbing on a touch screen is awkward.

---

## Project structure

```
index.html          Landing page
landing/            Landing page styles and scripts
app.html            App entry point
app/
  app.js            Main app logic
  app.css           App styles
  export-engine.js  WebCodecs + MediaRecorder export pipeline
  export-utils.js   Pure utility functions (also used by tests)
sw.js               Service worker
tests/
  unit/             Vitest unit tests
  e2e/              Playwright E2E tests
```

---

## Running locally

No build step required. Serve the directory over HTTP (browsers block some APIs on `file://`):

```bash
python -m http.server 8080
```

Then open `http://localhost:8080` in Chrome.

---

## Tests

Install dev dependencies first (only needed for tests):

```bash
npm install
npx playwright install   # downloads the Chromium binary for E2E tests
```

### Unit tests (fast, no browser)

Tests for pure utility functions in `app/export-utils.js`. Runs in Node.js in ~300 ms.

```bash
npm test              # run once
npm run test:watch    # re-run on file change
```

### E2E tests (real Chromium, ~30–60 s)

Tests the full export pipeline in a real browser, including WebCodecs encode/decode and pixel-level verification that exported frames are not black.

```bash
npm run test:e2e          # headless
npm run test:e2e:ui       # Playwright interactive UI
```

The E2E suite starts a local `serve` server automatically on port 5500. Test videos are generated synthetically inside the browser — no binary fixture files needed.

| Layer | Tool | What it verifies |
|---|---|---|
| Unit | Vitest | Timestamp formatting, H.264 level selection, AVC/HEVC binary serialization, sample-window slicing |
| E2E | Playwright | Page load, video ingestion, WebCodecs export produces valid MP4, progress reaches 100%, cancellation, non-black pixel output |
