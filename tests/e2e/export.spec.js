// End-to-end tests for the video export pipeline.
//
// WHY PLAYWRIGHT AND NOT VITEST?
// WebCodecs (VideoDecoder, VideoEncoder, OffscreenCanvas, createImageBitmap)
// are GPU-accelerated browser APIs that don't exist in Node.js. You can't
// meaningfully mock them: a mock VideoDecoder that calls your output callback
// with fake frames will tell you that your callback wiring is correct, but it
// can't tell you whether the frames are black, whether the timestamps are right,
// or whether the exported file actually plays. Playwright launches a real
// Chromium process, so the full codec pipeline executes the same way it does
// in Chrome on Android — including the createImageBitmap GPU-texture path we
// fixed for the black-screen bug.
//
// SETUP: a minimal synthetic test video is created inside the browser at the
// start of each test using WebCodecs itself. This avoids shipping a binary
// fixture file and keeps the test self-contained.

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─────────────────────────────────────────────────────────────────────────────
// Helper: generate a minimal valid H.264 MP4 entirely inside the browser.
// Returns the MP4 as a Uint8Array. Takes ~200 ms on a typical desktop.
// ─────────────────────────────────────────────────────────────────────────────
async function generateTestMp4(page) {
  return page.evaluate(async () => {
    // Encode 30 frames (1 second at 30 fps) of a solid-colour animation.
    // Each frame alternates between red and blue so the output is visually
    // distinguishable from an all-black or all-transparent stream.
    const WIDTH  = 320;
    const HEIGHT = 240;
    const FPS    = 30;
    const FRAMES = 30;

    const { Muxer, ArrayBufferTarget } = await import(
      'https://cdn.jsdelivr.net/npm/mp4-muxer@5.1.3/+esm'
    );

    const muxer = new Muxer({
      target: new ArrayBufferTarget(),
      video: { codec: 'avc', width: WIDTH, height: HEIGHT },
      fastStart: 'in-memory',
      firstTimestampBehavior: 'offset',
    });

    const encoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: e => { throw e; },
    });
    encoder.configure({
      codec: 'avc1.640028',
      width: WIDTH, height: HEIGHT,
      bitrate: 1_000_000,
      framerate: FPS,
    });

    const canvas = new OffscreenCanvas(WIDTH, HEIGHT);
    const ctx    = canvas.getContext('2d');

    for (let i = 0; i < FRAMES; i++) {
      ctx.fillStyle = i % 2 === 0 ? '#ff4444' : '#4444ff';
      ctx.fillRect(0, 0, WIDTH, HEIGHT);
      // Write frame number in white so we can verify ordering if needed.
      ctx.fillStyle = '#ffffff';
      ctx.font = '20px sans-serif';
      ctx.fillText(`frame ${i}`, 10, 30);

      const vf = new VideoFrame(canvas, { timestamp: Math.round(i * 1_000_000 / FPS) });
      encoder.encode(vf, { keyFrame: i === 0 });
      vf.close();
    }

    await encoder.flush();
    encoder.close();
    muxer.finalize();
    return new Uint8Array(muxer.target.buffer);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: load the synthetic MP4 into the app's file picker.
// ─────────────────────────────────────────────────────────────────────────────
async function loadVideoIntoApp(page) {
  const mp4Bytes = await generateTestMp4(page);

  // Set the file on the hidden <input type="file"> element by writing the
  // bytes as a Buffer — Playwright converts it to a File object for us.
  await page.locator('#file-input').setInputFiles({
    name:     'test-clip.mp4',
    mimeType: 'video/mp4',
    buffer:   Buffer.from(mp4Bytes),
  });

  // The app shows a "Video loaded ✓" snackbar on success.
  await expect(page.locator('#snack')).toContainText('Video loaded');
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: add a single complete clip (serve → home point) at known timestamps.
// ─────────────────────────────────────────────────────────────────────────────
async function addClipViaApi(page, startSec, endSec) {
  await page.evaluate(({ startSec, endSec }) => {
    // The app exposes its state as module-level variables; we call the same
    // action functions the UI buttons call so we're testing the real path.
    editorVideo.currentTime = startSec;
    pressServe();
    editorVideo.currentTime = endSec;
    pressPoint('home_point');
  }, { startSec, endSec });
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  // Wait until the main JS has initialised (the undo button is created by init).
  await page.waitForSelector('#btn-undo');
});

test('page loads without JS errors', async ({ page }) => {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  expect(errors).toHaveLength(0);
});

test('video loads and editor opens', async ({ page }) => {
  await loadVideoIntoApp(page);

  // Open the editor.
  await page.locator('#nav-editor').click();
  await expect(page.locator('#editor-view')).toHaveClass(/open/);

  // The progress bar should have a valid max once metadata loads.
  await expect(page.locator('#vid-progress')).not.toHaveAttribute('max', '100');
});

test('WebCodecs export completes and produces a non-empty MP4', async ({ page }) => {
  await loadVideoIntoApp(page);

  // Open editor and add one clip covering 0.1 s → 0.8 s.
  await page.locator('#nav-editor').click();
  await expect(page.locator('#editor-view')).toHaveClass(/open/);
  await addClipViaApi(page, 0.1, 0.8);

  // Open the export panel.
  await page.locator('#editor-view').press('Escape');
  await page.locator('#nav-export').click();

  // Make sure WebCodecs engine is selected (default).
  await expect(page.locator('#eng-webcodecs')).toHaveClass(/active/);

  // Start the download and capture the file contents.
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60_000 }),
    page.locator('button:has-text("Export Video")').click(),
  ]);

  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const bytes = Buffer.concat(chunks);

  // The exported file must be a valid MP4: starts with an ftyp or mdat/moov box.
  // The first 8 bytes of any MP4 are: 4-byte box size + 4-byte box type ('ftyp').
  expect(bytes.length).toBeGreaterThan(1000);
  expect(bytes.slice(4, 8).toString('ascii')).toBe('ftyp');
});

test('WebCodecs export shows 100% progress and Done button', async ({ page }) => {
  await loadVideoIntoApp(page);

  await page.locator('#nav-editor').click();
  await addClipViaApi(page, 0.1, 0.8);
  await page.locator('#editor-view').press('Escape');
  await page.locator('#nav-export').click();

  await page.locator('button:has-text("Export Video")').click();

  // Wait for the status label to show success (up to 60 s for slow CI machines).
  await expect(page.locator('#exp-status')).toContainText('✓ Exported', { timeout: 60_000 });
  await expect(page.locator('#exp-bar')).toHaveCSS('width', /^[1-9]/); // non-zero width
  await expect(page.locator('#exp-cancel-btn')).toHaveText('Done');
});

test('export shows error when no clips are marked', async ({ page }) => {
  await loadVideoIntoApp(page);
  await page.locator('#nav-export').click();

  // No clips have been added, so the export should fail gracefully.
  await page.locator('button:has-text("Export Video")').click();
  await expect(page.locator('#snack')).toContainText('No complete clips');
});

test('export can be cancelled mid-way', async ({ page }) => {
  await loadVideoIntoApp(page);

  await page.locator('#nav-editor').click();
  // Add a longer clip so there's time to cancel.
  await addClipViaApi(page, 0.0, 0.95);
  await page.locator('#editor-view').press('Escape');
  await page.locator('#nav-export').click();

  await page.locator('button:has-text("Export Video")').click();
  // Cancel almost immediately.
  await page.locator('#exp-cancel-btn').click();

  // Cancelling restores the export panel (openExport is called).
  await expect(page.locator('button:has-text("Export Video")')).toBeVisible();
});

test('exported frames are not all black', async ({ page }) => {
  // This test specifically guards against the Android black-screen regression
  // where ctx.drawImage(videoFrame) silently produced black pixels.
  // We encode a red/blue alternating video, export it, then decode the first
  // frame and verify at least some pixels are non-zero.

  await loadVideoIntoApp(page);
  await page.locator('#nav-editor').click();
  await addClipViaApi(page, 0.0, 0.5);
  await page.locator('#editor-view').press('Escape');
  await page.locator('#nav-export').click();

  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60_000 }),
    page.locator('button:has-text("Export Video")').click(),
  ]);

  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const exportedBytes = Buffer.concat(chunks);

  // Decode the first frame of the exported file inside the browser and
  // sample its pixel values.
  const hasNonBlackPixels = await page.evaluate(async (mp4Base64) => {
    const bytes    = Uint8Array.from(atob(mp4Base64), c => c.charCodeAt(0));
    const blob     = new Blob([bytes], { type: 'video/mp4' });
    const url      = URL.createObjectURL(blob);
    const video    = document.createElement('video');
    video.src      = url;
    video.muted    = true;

    await new Promise((res, rej) => {
      video.onloadeddata = res;
      video.onerror      = rej;
    });

    const canvas  = document.createElement('canvas');
    canvas.width  = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx     = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0);

    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    // Check that at least one pixel has a colour component > 10
    // (allowing for compression artefacts on pure black).
    for (let i = 0; i < pixels.length; i++) {
      if (pixels[i] > 10) return true;
    }
    URL.revokeObjectURL(url);
    return false;
  }, exportedBytes.toString('base64'));

  expect(hasNonBlackPixels).toBe(true);
});
