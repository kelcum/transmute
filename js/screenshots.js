import { lazy, downloadBlob, zipFiles, formatBytes, UserError } from "./util.js";
import { getFfmpeg, ffmpegWriteInput, ffmpegCleanupInput } from "./ffmpeg.js";
import { detectExt, FORMATS, baseName } from "./formats.js";
import { MB_READABLE_VIDEO } from "./engines/media.js";
import { h, picker, statusBar, segmented, card, iconButton, ICONS } from "./ui.js";

const getMediabunny = lazy(() => import("mediabunny"));

// Caps runaway screenshot counts (e.g. a long video with a tiny interval).
const MAX_SHOTS = 400;

const isVideo = (f) => FORMATS[detectExt(f)]?.cat === "video" || f.type.startsWith("video/");

function timeLabel(seconds) {
  const s = Math.round(seconds);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const pad = (n) => String(n).padStart(2, "0");
  return h ? `${h}h${pad(m % 60)}m${pad(s % 60)}s` : `${m}m${pad(s % 60)}s`;
}

function computeTimestamps(mode, { first, duration, count, interval }) {
  const span = Math.max(0, duration - first);
  if (mode === "interval") {
    const n = Math.min(MAX_SHOTS, Math.floor(span / interval) + 1);
    return Array.from({ length: Math.max(1, n) }, (_, i) => first + i * interval);
  }
  const k = Math.min(MAX_SHOTS, Math.max(1, count));
  if (k === 1) return [first + span / 2];
  return Array.from({ length: k }, (_, i) => first + (i / (k - 1)) * span);
}

// CanvasSink yields HTMLCanvasElement on the main thread; only OffscreenCanvas has convertToBlob.
function canvasToBlob(canvas, type, quality) {
  if (canvas.convertToBlob) return canvas.convertToBlob({ type, quality });
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), type, quality));
}

async function probeMediabunny(file) {
  const MB = await getMediabunny();
  const input = new MB.Input({ source: new MB.BlobSource(file), formats: MB.ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  if (!track) return null;
  const duration = await input.computeDuration();
  const first = await track.getFirstTimestamp();
  const sink = new MB.CanvasSink(track, { poolSize: 1 });
  const test = await sink.getCanvas(first);
  if (!test) return null;
  return { sink, duration, first, width: test.canvas.width, height: test.canvas.height };
}

async function extractWithMediabunny(probe, timestamps, { format, quality, signal, progress }) {
  const mime = format === "png" ? "image/png" : "image/jpeg";
  const results = [];
  let i = 0;
  for await (const result of probe.sink.canvasesAtTimestamps(timestamps)) {
    if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
    if (result) results.push({ timestamp: result.timestamp, blob: await canvasToBlob(result.canvas, mime, quality) });
    progress(++i / timestamps.length);
  }
  return results;
}

async function ffmpegDuration(ff, path) {
  const logs = [];
  const onLog = ({ message }) => logs.push(message);
  ff.on("log", onLog);
  try { await ff.exec(["-i", path]); } catch {} finally { ff.off("log", onLog); }
  const m = logs.join("\n").match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
  return m ? (+m[1]) * 3600 + (+m[2]) * 60 + +m[3] : null;
}

async function extractWithFfmpeg(file, inExt, mode, { count, interval, format, quality, status, progress, signal }) {
  status("Loading video engine (≈30 MB, first time only)…");
  const ff = await getFfmpeg();
  if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
  const input = await ffmpegWriteInput(ff, file, `in.${inExt}`);

  let fps;
  let duration = null;
  if (mode === "interval") {
    fps = 1 / interval;
  } else {
    status("Reading the video…");
    duration = await ffmpegDuration(ff, input.path);
    if (!duration) { await ffmpegCleanupInput(ff, input); throw new UserError("Couldn't read this video."); }
    fps = count <= 1 ? 0.0001 : (count - 1) / duration;
  }

  status("Extracting frames…");
  const ext = format === "png" ? "png" : "jpg";
  const qArgs = format === "jpg" ? ["-q:v", String(Math.round(2 + (1 - quality) * 28))] : [];
  const onProgress = ({ progress: p }) => { if (p >= 0 && p <= 1) progress(p); };
  const onAbort = () => { ff.terminate(); getFfmpeg.reset(); };
  ff.on("progress", onProgress);
  signal.addEventListener("abort", onAbort);
  try {
    const cap = Math.min(MAX_SHOTS, mode === "count" ? count : MAX_SHOTS);
    const code = await ff.exec(["-i", input.path, "-vf", `fps=${fps}`, "-frames:v", String(cap), ...qArgs, "-y", `/shot_%04d.${ext}`]);
    if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
    if (code !== 0) throw new UserError("Couldn't extract screenshots from this video.");
    const entries = (await ff.listDir("/")).filter((e) => e.name.startsWith("shot_")).sort((a, b) => a.name.localeCompare(b.name));
    const results = [];
    for (const [i, entry] of entries.entries()) {
      const data = await ff.readFile("/" + entry.name);
      const timestamp = mode === "interval" ? i * interval : count <= 1 ? duration / 2 : (i / (count - 1)) * duration;
      results.push({ timestamp, blob: new Blob([data], { type: format === "png" ? "image/png" : "image/jpeg" }) });
      await ff.deleteFile("/" + entry.name).catch(() => {});
    }
    return results;
  } finally {
    ff.off("progress", onProgress);
    signal.removeEventListener("abort", onAbort);
    if (!signal.aborted) await ffmpegCleanupInput(ff, input);
  }
}

const DEFAULTS = { mode: "count", count: 12, interval: 2, format: "jpg", quality: 0.85 };

export default function mountScreenshots(root) {
  let state = null;
  let items = [];
  const status = statusBar();

  const info = h("p", { class: "tool-file", hidden: true });
  const mode = segmented([["count", "Evenly spaced"], ["interval", "Every N seconds"]], DEFAULTS.mode, () => syncModeUI());
  const countIn = h("input", { type: "number", class: "text-in", min: "1", max: String(MAX_SHOTS), value: String(DEFAULTS.count) });
  const intervalIn = h("input", { type: "number", class: "text-in", min: "0.1", step: "0.1", value: String(DEFAULTS.interval) });
  const countRow = h("label", { class: "field" }, "How many screenshots", countIn);
  const intervalRow = h("label", { class: "field", hidden: true }, "Seconds between screenshots", intervalIn);
  const formatSel = h("select", {}, new Option("JPG", "jpg", true, true), new Option("PNG", "png"));
  const qualityIn = h("input", { type: "range", min: "0.4", max: "1", step: "0.01", value: String(DEFAULTS.quality) });
  const qualityRow = h("label", { class: "field" }, h("span", { class: "lrow" }, "JPG quality ", h("span", { class: "val" }, Math.round(DEFAULTS.quality * 100) + "%")), qualityIn);
  formatSel.addEventListener("change", () => { qualityRow.hidden = formatSel.value !== "jpg"; });
  qualityIn.addEventListener("input", () => { qualityRow.querySelector(".val").textContent = Math.round(qualityIn.value * 100) + "%"; });

  const grid = h("div", { class: "card-grid" });
  const go = h("button", { class: "btn primary", disabled: true, onclick: run }, "Extract screenshots");
  const dlAll = h("button", { class: "btn ghost", hidden: true, onclick: downloadAll }, "Download all (.zip)");
  const work = h("div", { class: "tool-work", hidden: true },
    info,
    h("div", { class: "tool-row" }, mode.el),
    h("div", { class: "tool-row" }, countRow, intervalRow, h("label", { class: "field" }, "Format", formatSel), qualityRow),
  );
  const pick = picker({ multiple: false, accept: "video/*,.mkv,.ts,.3gp,.mov,.avi,.wmv,.flv", label: "Choose a video", onFiles: addFiles });
  root.append(pick.el, work, grid, h("div", { class: "tool-actions" }, status.el, dlAll, go));

  function syncModeUI() {
    countRow.hidden = mode.value !== "count";
    intervalRow.hidden = mode.value !== "interval";
  }
  syncModeUI();

  async function addFiles(files) {
    const file = files.find(isVideo);
    if (!file) return status.set("Please choose a video file.", "error");
    grid.replaceChildren();
    items = [];
    dlAll.hidden = true;
    status.set("Reading the video…");
    go.disabled = true;
    const inExt = detectExt(file) || "mp4";
    try {
      const probe = MB_READABLE_VIDEO.includes(inExt) ? await probeMediabunny(file).catch(() => null) : null;
      state = { file, inExt, probe };
      const durationLabel = probe ? `${timeLabel(probe.duration)} · ${probe.width}×${probe.height}` : "duration unknown until extracted";
      info.textContent = `${file.name} · ${durationLabel} · ${formatBytes(file.size)}`;
      info.hidden = false;
      work.hidden = false;
      go.disabled = false;
      status.set("");
    } catch (e) {
      status.fail(e);
    }
  }

  async function run() {
    go.disabled = true;
    grid.replaceChildren();
    items = [];
    dlAll.hidden = true;
    const controller = new AbortController();
    const opts = {
      count: Math.max(1, Math.min(MAX_SHOTS, Math.round(+countIn.value) || DEFAULTS.count)),
      interval: Math.max(0.1, +intervalIn.value || DEFAULTS.interval),
      format: formatSel.value,
      quality: +qualityIn.value,
    };
    try {
      let results;
      if (state.probe) {
        const timestamps = computeTimestamps(mode.value, { first: state.probe.first, duration: state.probe.duration, ...opts });
        results = await extractWithMediabunny(state.probe, timestamps, {
          ...opts, signal: controller.signal,
          progress: (p) => status.set(`Extracting… ${Math.round(p * 100)}%`),
        });
      } else {
        results = await extractWithFfmpeg(state.file, state.inExt, mode.value, {
          ...opts, signal: controller.signal,
          status: (t) => status.set(t),
          progress: (p) => status.set(`Extracting… ${Math.round(p * 100)}%`),
        });
      }
      if (!results.length) throw new UserError("No screenshots could be extracted from this video.");
      const base = baseName(state.file.name);
      const pad = String(results.length).length;
      results.forEach((r, i) => {
        const name = `${base}-${String(i + 1).padStart(pad, "0")}-${timeLabel(r.timestamp)}.${opts.format}`;
        const c = card({ label: name, sub: formatBytes(r.blob.size), actions: [iconButton("Remove", ICONS.x, () => { c.el.remove(); item.removed = true; updateDlAll(); })] });
        c.setThumb(URL.createObjectURL(r.blob));
        c.el.append(h("button", { class: "btn primary small", onclick: () => downloadBlob(r.blob, name) }, "Download"));
        const item = { name, blob: r.blob, removed: false };
        items.push(item);
        grid.append(c.el);
      });
      status.set(`Done · ${results.length} screenshot${results.length === 1 ? "" : "s"}`, "ok");
      updateDlAll();
    } catch (e) {
      status.fail(e);
    }
    go.disabled = false;
  }

  function updateDlAll() {
    dlAll.hidden = items.filter((i) => !i.removed).length < 2;
  }

  async function downloadAll() {
    dlAll.disabled = true;
    dlAll.textContent = "Zipping…";
    try {
      downloadBlob(await zipFiles(items.filter((i) => !i.removed)), `${baseName(state.file.name)}-screenshots.zip`);
    } finally {
      dlAll.disabled = false;
      dlAll.textContent = "Download all (.zip)";
    }
  }

  return { addFiles };
}
