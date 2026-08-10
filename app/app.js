// ════════════════════════════════════════════════════
//  STATE
// ════════════════════════════════════════════════════
let clips = [];          // completed/in-progress saved clips
let activeClip = null;   // rally currently being marked
let history = [[]];      // undo/redo stack (arrays of clips)
let histIdx = 0;
let clipSeq = 0;         // unique ID counter
let videoSrc = '';       // object URL
let videoFile = null;    // File reference
let videoLoaded = false;
let retryExportAfterReopen = false;

// ════════════════════════════════════════════════════
//  DOM
// ════════════════════════════════════════════════════
const $ = id => document.getElementById(id);
const mainVideo   = $('main-video');
const editorVideo = $('editor-video');
const fileInput   = $('file-input');
const editorView  = $('editor-view');
const recBar      = $('rec-bar');
const vidProgress = $('vid-progress');
const playIcon    = $('play-icon');
const dpUp        = $('dp-up');
const dpPrev      = $('dp-prev');
const dpNext      = $('dp-next');
const marksModal  = $('marks-modal');
const marksScroll = $('marks-scroll');
const snack       = $('snack');

// ════════════════════════════════════════════════════
//  TYPE CONFIG
// ════════════════════════════════════════════════════
const TC = {
  serve:      { label: 'SERVE',   color: '#00BFA5', bg: '#E0F7FA' },
  home_point: { label: 'HOME',    color: '#1A73E8', bg: '#E8F0FE' },
  away_point: { label: 'AWAY',    color: '#E53935', bg: '#FDECEA' },
  no_point:   { label: 'NO PT',   color: '#757575', bg: '#F0F0F0' },
};

// ════════════════════════════════════════════════════
//  FILE / VIDEO
// ════════════════════════════════════════════════════
function triggerOpen() {
  fileInput.click();
}

fileInput.addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  if (videoSrc) URL.revokeObjectURL(videoSrc);
  videoSrc = URL.createObjectURL(file);
  videoFile = file;
  mainVideo.src = videoSrc;
  // Don't assign editorVideo.src here. On Android, pointing two <video> elements at
  // the same file at the same time forces the browser to open two hardware codec
  // pipelines simultaneously. Android devices expose only a small fixed pool of
  // hardware decoder instances; competing for that pool causes one element to stall
  // or freeze a few seconds into playback. Instead, editorVideo.src is assigned
  // lazily the first time the editor is opened (see openEditor below), so only one
  // decoder is ever active at a time.
  editorVideo.removeAttribute('src');
  editorVideo.load(); // resets readyState to HAVE_NOTHING, releasing any old decoder
  mainVideo.style.display = 'block';
  $('placeholder').style.display = 'none';
  videoLoaded = true;
  fileInput.value = '';
  toast('Video loaded ✓');
  if (retryExportAfterReopen) {
    retryExportAfterReopen = false;
    doVideoExport();
  }
});

$('video-area').addEventListener('click', () => {
  if (!videoLoaded) triggerOpen();
  else { mainVideo.paused ? mainVideo.play() : mainVideo.pause(); }
});

// ── Android auto-pause recovery ──────────────────────
// Chrome Android fires `waiting` then auto-pauses the video under memory
// pressure even when the full buffer is available (ready=2). `_autoStalled`
// distinguishes this from a deliberate user pause so we only auto-resume
// when Chrome caused the pause, not the user.
let _autoStalled = false;
mainVideo.addEventListener('waiting', () => {
  _autoStalled = true;
  console.warn(`[stall] waiting at ${mainVideo.currentTime.toFixed(2)}s ready=${mainVideo.readyState}`);
});
mainVideo.addEventListener('playing', () => { _autoStalled = false; });
mainVideo.addEventListener('pause', () => {
  if (_autoStalled) {
    _autoStalled = false;
    console.warn(`[stall] auto-paused at ${mainVideo.currentTime.toFixed(2)}s — recovering`);
    setTimeout(() => mainVideo.play().catch(e => console.error('[stall] recovery failed:', e)), 300);
  }
});
// ─────────────────────────────────────────────────────

// ════════════════════════════════════════════════════
//  EDITOR OPEN / CLOSE
// ════════════════════════════════════════════════════
function openEditor() {
  if (!videoLoaded) { toast('Open a video first'); return; }
  if (window._dbgZone) window._dbgZone.style.pointerEvents = 'none';
  editorView.classList.add('open');
  updateScore();
  updateActionBtns();
  updateUndoRedo();

  if (editorVideo.readyState < 1) {
    // editorVideo has no src yet (first open, or after loading a new file).
    // Assign the src now — only one decoder is running because mainVideo is
    // paused while the editor is visible. Once the browser has parsed the file
    // header (duration, dimensions, codec tables) it fires 'loadedmetadata',
    // at which point we sync the playhead to wherever mainVideo was.
    // { once: true } auto-removes the listener after it fires once.
    editorVideo.src = videoSrc;
    editorVideo.addEventListener('loadedmetadata', () => {
      editorVideo.currentTime = mainVideo.currentTime;
      vidProgress.max = editorVideo.duration || 100;
      syncProgress();
    }, { once: true });
  } else {
    // editorVideo already has the current video loaded — just sync the playhead.
    editorVideo.currentTime = mainVideo.currentTime;
    syncProgress();
  }
}

function closeEditor() {
  editorVideo.pause();
  mainVideo.currentTime = editorVideo.currentTime;
  if (window._dbgZone) window._dbgZone.style.pointerEvents = 'auto';
  editorView.classList.remove('open');
  updatePlayIcon();
}

// ════════════════════════════════════════════════════
//  PLAYBACK
// ════════════════════════════════════════════════════
function togglePlay() {
  editorVideo.paused ? editorVideo.play() : editorVideo.pause();
}

function updatePlayIcon() {
  const paused = editorVideo.paused;
  playIcon.innerHTML = paused
    ? '<polygon points="5 3 19 12 5 21 5 3"/>'
    : '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>';
}

editorVideo.addEventListener('play',  updatePlayIcon);
editorVideo.addEventListener('pause', updatePlayIcon);
editorVideo.addEventListener('ended', updatePlayIcon);
editorVideo.addEventListener('timeupdate', () => { updateScore(); syncProgress(); refreshRecBar(); syncNavBtns(); syncDpUpStyle(); });
editorVideo.addEventListener('loadedmetadata', () => {
  vidProgress.max = editorVideo.duration || 100;
  syncProgress();
});

vidProgress.addEventListener('input', () => {
  editorVideo.currentTime = parseFloat(vidProgress.value);
  syncProgress();
});

function syncProgress() {
  if (!isNaN(editorVideo.duration) && editorVideo.duration > 0) {
    vidProgress.max = editorVideo.duration;
    vidProgress.value = editorVideo.currentTime;
    const pct = (editorVideo.currentTime / editorVideo.duration) * 100;
    vidProgress.style.setProperty('--progress-pct', `${pct}%`);
  } else {
    vidProgress.value = 0;
    vidProgress.style.setProperty('--progress-pct', '0%');
  }
}

// ════════════════════════════════════════════════════
//  D-PAD
// ════════════════════════════════════════════════════
function dLeft()  { editorVideo.currentTime = Math.max(0, editorVideo.currentTime - 5); }
function dRight() { editorVideo.currentTime = Math.min(editorVideo.duration || 99999, editorVideo.currentTime + 5); }

function dUp() {
  // toggle highlight on activeClip or last completed clip
  if (activeClip) {
    activeClip.highlight = !activeClip.highlight;
    refreshRecBar();
    toast(activeClip.highlight ? '⭐ Highlight ON' : '☆ Highlight OFF');
  } else if (clips.length > 0) {
    const last = [...clips].sort((a,b) => a.start - b.start).pop();
    const c = clips.find(x => x.id === last.id);
    c.highlight = !c.highlight;
    saveHistory();
    toast(c.highlight ? '⭐ Highlight ON' : '☆ Highlight OFF');
  } else {
    toast('No clip to highlight');
  }
  syncDpUpStyle();
  if (marksModal.classList.contains('open')) renderMarks();
}

function dDown() { openMarks(); }

function prevMark() {
  const THRESHOLD = 2;
  const cur = editorVideo.currentTime;
  const times = clips.map(c => c.start).concat(activeClip ? [activeClip.start] : []).sort((a, b) => a - b);
  const desc = [...times].reverse();
  const clipStart = desc.find(t => t <= cur + 0.1);
  if (clipStart != null && cur - clipStart > THRESHOLD) {
    seekTo(clipStart);
  } else {
    const prev = desc.find(t => t < (clipStart ?? cur) - 0.1);
    if (prev != null) seekTo(prev);
    else if (clipStart != null) seekTo(clipStart);
  }
}

function nextMark() {
  const cur = editorVideo.currentTime;
  const times = clips.map(c => c.start).concat(activeClip ? [activeClip.start] : []).sort((a, b) => a - b);
  const t = times.find(t => t > cur + 0.1);
  if (t != null) seekTo(t);
}

function syncDpUpStyle() {
  const cur = editorVideo.currentTime;
  const hit = !activeClip && clips.find(c => c.end != null && POINT_TYPES.includes(c.type) && cur >= c.start && cur <= c.end);
  dpUp.disabled = !activeClip && !hit;
  const on = activeClip ? activeClip.highlight : (hit ? hit.highlight : false);
  dpUp.classList.toggle('star-on', !!on);
}

// ════════════════════════════════════════════════════
//  ACTION BUTTONS
// ════════════════════════════════════════════════════
function pressServe() {
  if (activeClip) {
    // Save the in-progress clip as-is (serve type, no end)
    finishActiveClip(null, 'serve');
  }
  activeClip = {
    id: 'c' + (++clipSeq),
    start: editorVideo.currentTime,
    end: null,
    type: 'serve',
    highlight: false,
    order: clipSeq,
  };
  saveHistory();
  refreshRecBar();
  updateActionBtns();
  syncDpUpStyle();
  // toast('🟢 Rally started @ ' + fmt(editorVideo.currentTime));
}

function pressPoint(type) {
  if (!activeClip) return;
  finishActiveClip(editorVideo.currentTime, type);
  saveHistory();
  updateScore();
  const labels = { home_point: '🔵 Home Point', away_point: '🔴 Away Point', no_point: '⚫ No Point' };
  // toast(labels[type] || 'Saved');
}

function finishActiveClip(endTime, type) {
  activeClip.end  = endTime;
  activeClip.type = type;
  clips = clips.filter(c => c.id !== activeClip.id);
  clips.push({ ...activeClip });
  activeClip = null;
  refreshRecBar();
  updateActionBtns();
  syncDpUpStyle();
  if (marksModal.classList.contains('open')) renderMarks();
}

function updateActionBtns() {
  const on = !!activeClip;
  $('btn-home').disabled = !on;
  $('btn-nopt').disabled = !on;
  $('btn-away').disabled = !on;
  $('btn-serve').disabled = on;
  syncDpUpStyle();
  syncNavBtns();
}

function syncNavBtns() {
  const cur = editorVideo.currentTime;
  const allStarts = clips.map(c => c.start).concat(activeClip ? [activeClip.start] : []);
  dpPrev.disabled = allStarts.length === 0;
  dpNext.disabled = !allStarts.some(t => t > cur + 0.1);
}

function hexToRgba(hex, a) {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  return `rgba(${r},${g},${b},${a})`;
}

function pillStyle(color) {
  return `background:${hexToRgba(color, 0.18)};border-color:${hexToRgba(color, 0.45)};color:${color}`;
}

const POINT_TYPES = ['home_point', 'away_point', 'no_point'];

function refreshRecBar() {
  if (activeClip) {
    const col = TC.serve.color;
    recBar.innerHTML = `<div class="rec-pill" style="${pillStyle(col)}"><div class="rec-dot" style="background:${col}"></div><span>RALLY @ ${fmt(activeClip.start)}${activeClip.highlight ? ' ⭐' : ''}</span></div>`;
    return;
  }
  const cur = editorVideo.currentTime;
  const hit = clips.find(c => c.end != null && POINT_TYPES.includes(c.type) && cur >= c.start && cur <= c.end);
  if (hit) {
    const col = TC[hit.type].color;
    const star = hit.highlight ? ' ⭐' : '';
    const opts = POINT_TYPES.map(t => {
      const label = t === hit.type ? `${TC[t].label} @ ${fmt(hit.start)}${star}` : TC[t].label;
      return `<option value="${t}"${t === hit.type ? ' selected' : ''}>${label}</option>`;
    }).join('');
    recBar.innerHTML = `<div class="rec-pill" style="${pillStyle(col)}"><div class="rec-dot" style="background:${col}"></div><select class="rec-select" style="color:${col}" onchange="changeClipTypeFromBar('${hit.id}',this.value)">${opts}</select></div>`;
  } else {
    recBar.innerHTML = '';
  }
}

function changeClipTypeFromBar(id, newType) {
  const clip = clips.find(c => c.id === id);
  if (!clip || !TC[newType]) return;
  clip.type = newType;
  saveHistory();
  updateScore();
  if (marksModal.classList.contains('open')) renderMarks();
  refreshRecBar();
}

// ════════════════════════════════════════════════════
//  SCORE
// ════════════════════════════════════════════════════
function updateScore() {
  const t = editorVideo.currentTime;
  const done = clips.filter(c => c.end !== null && c.end <= t);
  const h = done.filter(c => c.type === 'home_point').length;
  const a = done.filter(c => c.type === 'away_point').length;
  const homeLabel = $('inp-home').value || 'HOME';
  const awayLabel = $('inp-away').value || 'AWAY';
  $('score-teams').textContent = homeLabel.toUpperCase() + ' vs ' + awayLabel.toUpperCase();
  $('sc-home').textContent = h;
  $('sc-away').textContent = a;
}

// ════════════════════════════════════════════════════
//  UNDO / REDO
// ════════════════════════════════════════════════════
function saveHistory() {
  history = history.slice(0, histIdx + 1);
  history.push(JSON.parse(JSON.stringify(clips)));
  histIdx = history.length - 1;
  updateUndoRedo();
}

function undo() {
  if (histIdx <= 0) { toast('Nothing to undo'); return; }
  histIdx--;
  clips = JSON.parse(JSON.stringify(history[histIdx]));
  // Cancel any activeClip
  if (activeClip) { activeClip = null; refreshRecBar(); updateActionBtns(); syncDpUpStyle(); }
  updateUndoRedo();
  updateScore();
  if (marksModal.classList.contains('open')) renderMarks();
  // toast('Undo ↩');
}

function redo() {
  if (histIdx >= history.length - 1) { toast('Nothing to redo'); return; }
  histIdx++;
  clips = JSON.parse(JSON.stringify(history[histIdx]));
  updateUndoRedo();
  updateScore();
  if (marksModal.classList.contains('open')) renderMarks();
  // toast('Redo ↪');
}

function updateUndoRedo() {
  $('btn-undo').disabled = histIdx <= 0;
  $('btn-redo').disabled = histIdx >= history.length - 1;
}

// ════════════════════════════════════════════════════
//  MARKS MODAL
// ════════════════════════════════════════════════════
function openMarks() {
  renderMarks();
  marksModal.classList.add('open');
}

function closeMarks() {
  marksModal.classList.remove('open');
}

function renderMarks() {
  const all = [...clips];
  if (activeClip) all.push(activeClip);
  all.sort((a,b) => a.start - b.start);

  if (!all.length) {
    marksScroll.innerHTML = '<div class="marks-empty">No marks yet.<br>Press <strong>SERVE</strong> to start a rally.</div>';
    return;
  }

  marksScroll.innerHTML = all.map(c => {
    const cfg = TC[c.type] || TC.serve;
    const isAct = activeClip && c.id === activeClip.id;
    const endBtn = c.end !== null
      ? `<span class="mk-arrow">→</span><button class="ts-btn" onclick="seekTo(${c.end})">${fmt(c.end)}</button>`
      : `<span class="ts-btn no-end">in progress…</span>`;

    const typeOptions = Object.entries(TC)
      .map(([key, val]) =>
        `<option value="${key}" ${c.type === key ? 'selected' : ''}>${val.label}</option>`
      ).join('');

    return `<div class="mk-item${isAct ? ' is-active' : ''}" onclick="seekTo(${c.start})">
      <div class="mk-dot" style="background:${cfg.color}"></div>
      <div class="mk-times">
        <button class="ts-btn" onclick="seekTo(${c.start})">${fmt(c.start)}</button>
        ${endBtn}
      </div>
      <select class="mk-type" style="color:${cfg.color}"
              onchange="changeClipType('${c.id}', this.value)">
        ${typeOptions}
      </select>
      <button class="mk-star" onclick="toggleHighlight('${c.id}')" title="Toggle Highlight">${c.highlight ? '⭐' : '☆'}</button>
      ${!isAct ? `<button class="mk-del" onclick="delClip('${c.id}')" title="Delete">🗑</button>` : ''}
    </div>`;
  }).join('');
}

function changeClipType(id, newType) {
  const clip = clips.find(c => c.id === id); // adjust to however you store clips
  if (clip && TC[newType]) {
    clip.type = newType;
    renderMarks(); // or whatever re-renders the list
  }
}

function seekTo(t) {
  editorVideo.currentTime = t;
}

function toggleHighlight(id) {
  if (activeClip && activeClip.id === id) {
    activeClip.highlight = !activeClip.highlight;
    refreshRecBar();
    syncDpUpStyle();
  } else {
    const c = clips.find(x => x.id === id);
    if (c) { c.highlight = !c.highlight; saveHistory(); }
  }
  renderMarks();
}

function delClip(id) {
  clips = clips.filter(c => c.id !== id);
  saveHistory();
  updateScore();
  renderMarks();
  toast('Clip deleted');
}

// ════════════════════════════════════════════════════
//  REVIEW PANEL
// ════════════════════════════════════════════════════
function openReview() {
  const body = $('review-body');
  const sorted = [...clips].sort((a,b) => a.start - b.start);

  if (!sorted.length) {
    body.innerHTML = '<div style="padding:40px 20px;text-align:center;color:var(--text3);font-family:\'Barlow Condensed\',sans-serif;font-size:16px;font-weight:600;line-height:1.6">No marks yet.<br>Open the Editor to start marking.</div>';
  } else {
    body.innerHTML = sorted.map((c, i) => {
      const cfg = TC[c.type] || TC.serve;
      const dur = (c.end !== null) ? ` · ${fmtDur(c.end - c.start)}` : '';
      return `<div class="rv-item">
        <span class="rv-num">${i + 1}</span>
        <span class="rv-badge" style="background:${cfg.bg};color:${cfg.color}">${cfg.label}</span>
        <div class="rv-times">
          <span class="rv-chip">▶ ${fmt(c.start)}</span>
          ${c.end !== null ? `<span class="rv-chip">■ ${fmt(c.end)}</span>` : ''}
          ${dur ? `<span class="rv-chip">${dur}</span>` : ''}
        </div>
        ${c.highlight ? '<span class="rv-star">⭐</span>' : ''}
      </div>`;
    }).join('');
  }
  $('review-panel').classList.add('open');
}

// ════════════════════════════════════════════════════
//  EXPORT PANEL
// ════════════════════════════════════════════════════
// WebCodecs (VideoEncoder/VideoDecoder) isn't implemented by WebKit, so every
// iOS browser (Safari, and Chrome/Firefox on iOS, which are WebKit under the
// hood) needs to default to the MediaRecorder engine instead.
let exportEngine = ('VideoEncoder' in window && 'VideoDecoder' in window) ? 'webcodecs' : 'recorder';
let exportQuality         = 'medium';
let exportHighlightsOnly  = false;
let exportDisableScoreboard = false;
let exportDisableWatermark  = false;

const _watermarkImg = new Image();
_watermarkImg.src = 'img/icon.png';

function selectEngine(e) {
  exportEngine = e;
  const wb = $('eng-webcodecs'), mr = $('eng-recorder');
  if (wb) wb.classList.toggle('active', e === 'webcodecs');
  if (mr) mr.classList.toggle('active', e === 'recorder');
}

function calcExportDur() {
  return clips
    .filter(c => c.end !== null && c.end > c.start && (!exportHighlightsOnly || c.highlight))
    .reduce((sum, c) => sum + (c.end - c.start), 0);
}

function selectHighlightsOnly(on) {
  exportHighlightsOnly = on;
  if (on) {
    // Default scoreboard off for highlights exports; user can still override.
    exportDisableScoreboard = true;
    const cb = $('opt-no-scoreboard');
    if (cb) cb.checked = true;
  }
  // Update highlights count label visibility.
  const sub = $('opt-highlights-sub');
  if (sub) sub.style.display = on ? '' : 'none';
  // Update live export duration.
  const durEl = $('meta-export-dur');
  if (durEl) { const d = calcExportDur(); durEl.textContent = d > 0 ? fmtDur(d) : '—'; }
}

function toggleExportSection(which) {
  if (window.innerWidth >= 600) return;
  const info = document.querySelector('.export-info');
  const settings = document.querySelector('.export-settings');
  if (!info || !settings) return;
  info.classList.toggle('collapsed', which !== 'info');
  settings.classList.toggle('collapsed', which !== 'settings');
}

function selectDisableScoreboard(on) {
  exportDisableScoreboard = on;
  drawPreview();
}

function selectDisableWatermark(on) {
  exportDisableWatermark = on;
  drawPreview();
}

function drawPreview() {
  const canvas = $('preview-canvas');
  if (!canvas) return;
  if (!canvas.parentElement.clientWidth) return;

  const video = videoLoaded ? mainVideo : null;

  // Draw at the video's native resolution so wcDrawScoreboard proportions
  // match the actual export exactly. CSS scales the canvas down to fit.
  const cW = (video && video.videoWidth)  ? video.videoWidth  : 1280;
  const cH = (video && video.videoHeight) ? video.videoHeight : 720;
  canvas.width  = cW;
  canvas.height = cH;
  canvas.style.width  = '100%';
  canvas.style.height = 'auto';

  const ctx = canvas.getContext('2d');

  if (video && video.videoWidth) {
    ctx.drawImage(video, 0, 0, cW, cH);
  } else {
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, cW, cH);
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    ctx.font = `700 ${Math.round(cH * 0.06)}px 'Barlow Condensed', sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('NO VIDEO LOADED', cW / 2, cH / 2);
  }

  if (!exportDisableScoreboard) {
    const homeLabel = $('inp-home').value || 'Home';
    const awayLabel = $('inp-away').value || 'Away';
    const homeScore = clips.filter(c => c.type === 'home_point').length;
    const awayScore = clips.filter(c => c.type === 'away_point').length;
    wcDrawScoreboard(ctx, cW, cH, homeLabel, awayLabel, homeScore, awayScore);
  }
  if (!exportDisableWatermark) {
    wcDrawWatermark(ctx, cW, cH, _watermarkImg.complete && _watermarkImg.naturalWidth ? _watermarkImg : null);
  }
}

function selectQuality(q) {
  exportQuality = q;
  ['low', 'medium', 'high'].forEach(id => {
    const btn = $('q-' + id);
    if (btn) btn.classList.toggle('active', id === q);
  });
}

function getExportBitrate(w, h, fps) {
  const f = { low: 0.03, medium: 0.08, high: 0.20 }[exportQuality] ?? 0.08;
  const cap = { low: 4_000_000, medium: 10_000_000, high: 20_000_000 }[exportQuality] ?? 10_000_000;
  return Math.min(cap, Math.max(1_000_000, Math.round(w * h * fps * f)));
}

function doVideoExport() {
  if (exportEngine === 'recorder') doMediaRecorderExport();
  else doWebCodecsExport();
}

function openExport() {
  const homeLabel = $('inp-home').value || 'Home';
  const awayLabel = $('inp-away').value || 'Away';
  const homeScore = clips.filter(c => c.type === 'home_point').length;
  const awayScore = clips.filter(c => c.type === 'away_point').length;
  const highlights = clips.filter(c => c.highlight).length;
  const nopts    = clips.filter(c => c.type === 'no_point').length;
  const serves   = clips.filter(c => c.type === 'serve').length; // incomplete
  const dur = (mainVideo.duration) || 0;
  const exportDur = calcExportDur();

  const isMobile = window.innerWidth < 600;
  const previewHtml = `<div class="preview-wrap"><canvas id="preview-canvas"></canvas><div class="preview-label">Preview</div></div>`;

  $('export-body').innerHTML = `<div class="export-body">
  ${isMobile ? previewHtml : ''}
  <div class="export-sections">
  <div class="export-info${isMobile ? ' collapsed' : ''}">
    <div class="section-head" onclick="toggleExportSection('info')">Overview<svg class="section-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor"><polyline points="6 9 12 15 18 9"/></svg></div>
    ${!isMobile ? previewHtml : ''}
    <div class="scoreboard">
      <div class="sb-heads"><span>${homeLabel.toUpperCase()}</span><span>${awayLabel.toUpperCase()}</span></div>
      <div class="sb-score"><span class="sh">${homeScore}</span><span class="sep">:</span><span class="sa">${awayScore}</span></div>
    </div>

    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-n" style="color:var(--highlight)">${highlights}</div>
        <div class="stat-l">Highlights</div>
      </div>
      <div class="stat-card">
        <div class="stat-n">${clips.length}</div>
        <div class="stat-l">Total Clips</div>
      </div>
      <div class="stat-card">
        <div class="stat-n" style="color:var(--nopt)">${nopts}</div>
        <div class="stat-l">No Points</div>
      </div>
    </div>

    <div class="meta-card">
      <div class="meta-row"><span class="meta-l">Video</span><span class="meta-v">${videoFile ? videoFile.name : '—'}</span></div>
      <div class="meta-row"><span class="meta-l">Duration</span><span class="meta-v">${dur ? fmt(dur) : '—'}</span></div>
      <div class="meta-row"><span class="meta-l">Incomplete rallies</span><span class="meta-v">${serves}</span></div>
    </div>
  </div>

  <div class="export-settings">
    <div class="section-head" onclick="toggleExportSection('settings')">Export Options<svg class="section-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor"><polyline points="6 9 12 15 18 9"/></svg></div>
    <div class="export-settings-col">
      <div class="eng-label">Scoreboard Style</div>
      <div class="sb-style-wrap">
        <select class="sb-style-select" disabled>
          <option>Classic</option>
        </select>
        <span class="soon-tag">Soon</span>
      </div>
    </div>

    <div class="export-settings-row">
      <div class="export-settings-col">
        <div class="eng-label">Engine</div>
        <div class="engine-toggle">
          <button class="eng-btn ${exportEngine === 'webcodecs' ? 'active' : ''}" id="eng-webcodecs" onclick="selectEngine('webcodecs')">WebCodecs</button>
          <button class="eng-btn ${exportEngine === 'recorder' ? 'active' : ''}" id="eng-recorder" onclick="selectEngine('recorder')">Recorder</button>
        </div>
      </div>
      <div class="export-settings-col">
        <div class="eng-label">Quality</div>
        <div class="engine-toggle">
          <button class="eng-btn ${exportQuality === 'low'    ? 'active' : ''}" id="q-low"    onclick="selectQuality('low')">Low</button>
          <button class="eng-btn ${exportQuality === 'medium' ? 'active' : ''}" id="q-medium" onclick="selectQuality('medium')">Med</button>
          <button class="eng-btn ${exportQuality === 'high'   ? 'active' : ''}" id="q-high"   onclick="selectQuality('high')">High</button>
        </div>
      </div>
    </div>

    <label class="opt-row" onclick="selectHighlightsOnly(!$('opt-highlights').checked)">
      <input type="checkbox" id="opt-highlights" ${exportHighlightsOnly ? 'checked' : ''}
             onchange="selectHighlightsOnly(this.checked)" onclick="event.stopPropagation()">
      <span class="opt-row-label">Highlights only</span>
      <span class="opt-row-sub" id="opt-highlights-sub" style="${exportHighlightsOnly ? '' : 'display:none'}">${highlights} clip${highlights !== 1 ? 's' : ''}</span>
    </label>
    <label class="opt-row" onclick="selectDisableScoreboard(!$('opt-no-scoreboard').checked)">
      <input type="checkbox" id="opt-no-scoreboard" ${exportDisableScoreboard ? 'checked' : ''}
             onchange="selectDisableScoreboard(this.checked)" onclick="event.stopPropagation()">
      <span class="opt-row-label">No scoreboard overlay</span>
    </label>
    <label class="opt-row" onclick="selectDisableWatermark(!$('opt-no-watermark').checked)">
      <input type="checkbox" id="opt-no-watermark" ${exportDisableWatermark ? 'checked' : ''}
             onchange="selectDisableWatermark(this.checked)" onclick="event.stopPropagation()">
      <span class="opt-row-label">No watermark</span>
    </label>

    <div class="export-dur-note"><span id="meta-export-dur">${exportDur > 0 ? fmtDur(exportDur) : '—'}</span> to export</div>

    <button class="dl-btn-secondary" onclick="doExport()">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
      Save Markers
    </button>
    <button class="dl-btn" onclick="doVideoExport()" style="background:var(--serve)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/><polyline points="7 10 10 13 17 8"/></svg>
      Export Video
    </button>
  </div>
  </div>
  </div>`;

  $('export-panel').classList.add('open');
  requestAnimationFrame(() => requestAnimationFrame(() => drawPreview()));
}

function doExport() {
  const homeLabel = $('inp-home').value || 'Home';
  const awayLabel = $('inp-away').value || 'Away';
  const homeScore = clips.filter(c => c.type === 'home_point').length;
  const awayScore = clips.filter(c => c.type === 'away_point').length;

  const data = {
    exportedAt:    new Date().toISOString(),
    videoFileName: videoFile ? videoFile.name : null,
    videoDuration: editorVideo.duration || null,
    homeTeam:      homeLabel,
    awayTeam:      awayLabel,
    score:         { home: homeScore, away: awayScore },
    highlights:    clips.filter(c => c.highlight).length,
    clips: clips.map(c => ({
      id:             c.id,
      order:          c.order,
      start:          c.start,
      end:            c.end,
      startFormatted: fmt(c.start),
      endFormatted:   c.end !== null ? fmt(c.end) : null,
      duration:       c.end !== null ? +(c.end - c.start).toFixed(3) : null,
      type:           c.type,
      highlight:      c.highlight,
    })),
  };

  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  const date = new Date().toISOString().slice(0, 10);
  a.download = `gamepointla_${homeLabel}_${awayLabel}_${date}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast('Downloaded ✓');
}

// ════════════════════════════════════════════════════
//  PANELS
// ════════════════════════════════════════════════════
function closePanel(id) { $(id).classList.remove('open'); }

// ════════════════════════════════════════════════════
//  UTILS  (fmt, fmtDur, wcYield, wcFmtSize, wcPickH264Codec,
//           wcSerializeAvcC, wcSerializeHvcC, wcGetSamplesForClip
//           are loaded from export-utils.js)
// ════════════════════════════════════════════════════

let snackTimer;
function toast(msg) {
  snack.textContent = msg;
  snack.classList.add('show');
  clearTimeout(snackTimer);
  snackTimer = setTimeout(() => snack.classList.remove('show'), 2200);
}

// ════════════════════════════════════════════════════
//  KEYBOARD SHORTCUTS
// ════════════════════════════════════════════════════
document.addEventListener('keydown', e => {
  if (!editorView.classList.contains('open')) return;
  if (e.target.tagName === 'INPUT') return;
  const key = e.key;
  switch (key) {
    case 'ArrowLeft':  e.preventDefault(); dLeft();  break;
    case 'ArrowRight': e.preventDefault(); dRight(); break;
    case 'ArrowUp':    e.preventDefault(); if (!dpUp.disabled) dUp(); break;
    case 'ArrowDown':  e.preventDefault(); dDown();  break;
    case ' ':          e.preventDefault(); togglePlay(); break;
    case 's': case 'S': pressServe(); break;
    case 'h': case 'H': if (!$('btn-home').disabled) pressPoint('home_point'); break;
    case 'a': case 'A': if (!$('btn-away').disabled) pressPoint('away_point'); break;
    case 'n': case 'N': if (!$('btn-nopt').disabled) pressPoint('no_point');   break;
    case 'm': case 'M': marksModal.classList.contains('open') ? closeMarks() : openMarks(); break;
    case 'Escape': marksModal.classList.contains('open') ? closeMarks() : closeEditor(); break;
    case 'z':
      if (e.ctrlKey || e.metaKey) { e.preventDefault(); e.shiftKey ? redo() : undo(); }
      break;
    case 'y':
      if (e.ctrlKey || e.metaKey) { e.preventDefault(); redo(); }
      break;
  }
});

// ════════════════════════════════════════════════════
//  PWA SERVICE WORKER
// ════════════════════════════════════════════════════
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}

// ════════════════════════════════════════════════════
//  IMPORT
// ════════════════════════════════════════════════════
let pendingImport = null;

function triggerImport() {
  $('import-input').click();
}

$('import-input').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  $('import-input').value = '';

  const reader = new FileReader();
  reader.onload = evt => {
    let data;
    try { data = JSON.parse(evt.target.result); }
    catch { toast('Invalid JSON file'); return; }

    if (!Array.isArray(data.clips) || data.clips.length === 0) {
      toast('No markers found in file');
      return;
    }

    if (clips.length > 0 || activeClip) {
      pendingImport = data;
      const existingCount = clips.length + (activeClip ? 1 : 0);
      $('import-existing-count').textContent = existingCount;
      $('import-new-count').textContent = data.clips.length;
      $('import-filename').textContent = data.videoFileName || file.name;
      $('import-modal').classList.add('open');
    } else {
      applyImport(data);
    }
  };
  reader.readAsText(file);
});

function closeImportModal() {
  $('import-modal').classList.remove('open');
  pendingImport = null;
}

function confirmImport() {
  if (!pendingImport) return;
  const data = pendingImport;
  closeImportModal();
  applyImport(data);
}

function applyImport(data) {
  activeClip = null;

  clips = data.clips.map(c => ({
    id:        c.id,
    start:     c.start,
    end:       c.end,
    type:      c.type,
    highlight: !!c.highlight,
    order:     c.order,
  }));

  clipSeq = clips.reduce((m, c) => Math.max(m, c.order || 0), 0);

  if (data.homeTeam) $('inp-home').value = data.homeTeam;
  if (data.awayTeam) $('inp-away').value = data.awayTeam;

  history = [[]];
  histIdx = 0;
  saveHistory();

  refreshRecBar();
  updateActionBtns();
  updateUndoRedo();
  updateScore();
  syncDpUpStyle();
  if (marksModal.classList.contains('open')) renderMarks();

  toast(`Imported ${clips.length} marker${clips.length !== 1 ? 's' : ''} ✓`);
}

// ════════════════════════════════════════════════════
//  RESET
// ════════════════════════════════════════════════════
function openResetModal() {
  $('reset-modal').classList.add('open');
}

function closeResetModal() {
  $('reset-modal').classList.remove('open');
}

function doReset() {
  closeResetModal();

  // Close any open views first
  editorVideo.pause();
  mainVideo.pause();
  editorView.classList.remove('open');
  closeMarks();
  closePanel('review-panel');
  closePanel('export-panel');

  // Clear state
  activeClip = null;
  clips = [];
  history = [[]];
  histIdx = 0;
  clipSeq = 0;

  // Release video
  if (videoSrc) { URL.revokeObjectURL(videoSrc); videoSrc = ''; }
  videoFile = null;
  videoLoaded = false;

  mainVideo.removeAttribute('src');
  mainVideo.load();
  mainVideo.style.display = 'none';
  editorVideo.removeAttribute('src');
  editorVideo.load();
  $('placeholder').style.display = '';

  // Clear team names
  $('inp-home').value = '';
  $('inp-away').value = '';

  // Reset UI
  refreshRecBar();
  updateActionBtns();
  updateUndoRedo();
  updateScore();
  updatePlayIcon();
  syncProgress();

  toast('Reset complete');
}

// Init
updateUndoRedo();

// ── On-screen debug console ──────────────────────────
(function() {
  const panel = document.createElement('div');
  panel.id = 'dbg-panel';
  panel.style.cssText = 'position:fixed;bottom:0;left:0;right:0;height:38vh;background:rgba(0,0,0,0.85);color:#0f0;font:11px/1.4 monospace;overflow-y:auto;z-index:99999;padding:6px 6px 28px;pointer-events:auto;display:none;';
  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕ close';
  closeBtn.style.cssText = 'position:sticky;bottom:0;display:block;width:100%;background:#222;color:#aaa;border:none;padding:4px;font:bold 11px monospace;cursor:pointer;text-align:center;';
  closeBtn.onclick = toggleDbg;
  panel.appendChild(closeBtn);
  document.body.appendChild(panel);

  function toggleDbg() {
    panel.style.display = panel.style.display === 'none' ? '' : 'none';
  }

  // Invisible 44×44px zone — bottom-left corner, above all overlays.
  // Long-press 800ms to toggle the panel.
  const zone = document.createElement('div');
  zone.style.cssText = 'position:fixed;top:0;left:0;width:44px;height:44px;z-index:199;-webkit-touch-callout:none;user-select:none;touch-action:none;';
  zone.addEventListener('contextmenu', e => e.preventDefault());
  document.body.appendChild(zone);
  window._dbgZone = zone;
  let _zoneTimer = null, _zoneX = 0, _zoneY = 0;
  zone.addEventListener('pointerdown', e => {
    _zoneX = e.clientX; _zoneY = e.clientY;
    _zoneTimer = setTimeout(toggleDbg, 800);
  });
  zone.addEventListener('pointermove', e => {
    if (Math.abs(e.clientX - _zoneX) > 10 || Math.abs(e.clientY - _zoneY) > 10)
      clearTimeout(_zoneTimer);
  });
  ['pointerup', 'pointercancel'].forEach(e =>
    zone.addEventListener(e, () => clearTimeout(_zoneTimer))
  );

  ['log','warn','error'].forEach(level => {
    const orig = console[level].bind(console);
    console[level] = (...args) => {
      orig(...args);
      const line = document.createElement('div');
      line.style.color = level === 'error' ? '#f66' : level === 'warn' ? '#fa0' : '#0f0';
      line.textContent = args.join(' ');
      panel.insertBefore(line, closeBtn);
      panel.scrollTop = panel.scrollHeight;
    };
  });
})();
// ─────────────────────────────────────────────────────
