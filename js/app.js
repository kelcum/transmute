import { FORMATS, CATEGORIES, DEFAULT_OUT, detectExt, baseName } from "./formats.js";
import { formatBytes, zipFiles, downloadBlob, UserError } from "./util.js";
import imageEngine from "./engines/image.js";
import mediaEngine from "./engines/media.js";
import documentEngine from "./engines/document.js";
import spreadsheetEngine from "./engines/spreadsheet.js";
import dataEngine from "./engines/data.js";
import archiveEngine from "./engines/archive.js";
import { routePdf, pdfFiles } from "./pdf/tools.js";
import mountScreenshots from "./screenshots.js";

const ENGINES = [imageEngine, mediaEngine, documentEngine, spreadsheetEngine, dataEngine, archiveEngine];
const $ = (sel, root = document) => root.querySelector(sel);

function routesFor(inExt) {
  const routes = new Map();
  if (!inExt) return routes;
  for (const engine of ENGINES) for (const out of engine.outputs(inExt)) if (!routes.has(out)) routes.set(out, engine);
  return routes;
}

// ---------- settings ----------
const DEFAULT_SETTINGS = {
  image: { quality: 0.9, width: "", height: "", background: "#ffffff" },
  video: { quality: "original", maxHeight: 0 },
  audio: { bitrate: 0 },
  pdf: { scale: 2 },
};
function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem("transmute.settings") || "{}");
    return Object.fromEntries(Object.entries(DEFAULT_SETTINGS).map(([k, v]) => [k, { ...v, ...(saved[k] || {}) }]));
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}
const settings = loadSettings();
function saveSettings() {
  try { localStorage.setItem("transmute.settings", JSON.stringify(settings)); } catch {}
}
for (const input of document.querySelectorAll("[data-setting]")) {
  const [group, key] = input.dataset.setting.split(".");
  input.value = settings[group][key];
  const out = document.querySelector(`[data-setting-out="${input.dataset.setting}"]`);
  const show = () => { if (out) out.textContent = Math.round(input.value * 100) + "%"; };
  show();
  input.addEventListener("input", () => {
    const numeric = input.type === "number" || input.type === "range" || /^\d+(\.\d+)?$/.test(input.value);
    settings[group][key] = numeric && input.value !== "" ? +input.value : input.value;
    show();
    saveSettings();
  });
}
$("#resetSettings").addEventListener("click", () => {
  Object.assign(settings, structuredClone(DEFAULT_SETTINGS));
  saveSettings();
  for (const input of document.querySelectorAll("[data-setting]")) {
    const [g, k] = input.dataset.setting.split(".");
    input.value = settings[g][k];
    input.dispatchEvent(new Event("input"));
  }
});
$("#settingsToggle").addEventListener("click", () => {
  const panel = $("#settings");
  panel.hidden = !panel.hidden;
  $("#settingsToggle").setAttribute("aria-expanded", String(!panel.hidden));
});

// ---------- queue ----------
const jobs = [];
let nextId = 1;
const rowsEl = $("#rows");
const rowTpl = $("#rowTpl");

function buildSelect(select, routes, current) {
  select.innerHTML = "";
  const byCat = {};
  for (const out of routes.keys()) (byCat[FORMATS[out].cat] ||= []).push(out);
  for (const [cat, outs] of Object.entries(byCat)) {
    const group = document.createElement("optgroup");
    group.label = CATEGORIES[cat].label;
    for (const o of outs) group.append(new Option(FORMATS[o].label, o, false, o === current));
    select.append(group);
  }
}

function addFiles(files) {
  for (const file of files) {
    const inExt = detectExt(file);
    const routes = routesFor(inExt);
    const preferred = DEFAULT_OUT[inExt];
    const job = {
      id: nextId++,
      file,
      inExt,
      routes,
      outExt: routes.has(preferred) ? preferred : routes.keys().next().value ?? null,
      state: routes.size ? "ready" : "unsupported",
      progress: 0,
      results: null,
      error: null,
      controller: null,
    };
    job.el = rowTpl.content.firstElementChild.cloneNode(true);
    const badge = $(".badge", job.el);
    badge.textContent = inExt === "tar.gz" ? "TGZ" : inExt ? inExt.toUpperCase() : "?";
    badge.dataset.cat = inExt ? FORMATS[inExt].cat : "none";
    $(".name", job.el).textContent = file.name;
    $(".name", job.el).title = file.name;
    $(".size", job.el).textContent = formatBytes(file.size);
    const select = $(".fmt", job.el);
    if (routes.size) {
      buildSelect(select, routes, job.outExt);
      select.addEventListener("change", () => {
        job.outExt = select.value;
        if (job.state === "done" || job.state === "error") { job.state = "ready"; job.results = null; }
        render(job);
      });
    } else {
      select.replaceWith(Object.assign(document.createElement("span"), { className: "nosupport", textContent: "Not supported yet" }));
    }
    $(".rm", job.el).addEventListener("click", () => removeJob(job));
    $(".dl", job.el).addEventListener("click", () => downloadJob(job));
    rowsEl.append(job.el);
    jobs.push(job);
    render(job);
  }
  refreshQueue();
}

function removeJob(job) {
  job.controller?.abort();
  job.el.remove();
  jobs.splice(jobs.indexOf(job), 1);
  refreshQueue();
}

function render(job) {
  const el = job.el;
  el.dataset.state = job.state;
  const msg = $(".msg", el);
  const bar = $(".bar i", el);
  const dl = $(".dl", el);
  dl.hidden = job.state !== "done";
  const select = $(".fmt", el);
  if (select) select.disabled = job.state === "working" || job.state === "queued";
  bar.style.width = job.state === "done" ? "100%" : job.state === "working" ? `${Math.round(job.progress * 100)}%` : "0%";
  if (job.state === "ready") msg.textContent = "";
  else if (job.state === "queued") msg.textContent = "Waiting…";
  else if (job.state === "unsupported") msg.textContent = job.inExt ? "No conversions available" : "Unknown file type";
  else if (job.state === "error") msg.textContent = job.error;
  else if (job.state === "done") {
    const total = job.results.reduce((s, r) => s + r.blob.size, 0);
    const n = job.results.length;
    msg.textContent = `Done in ${(job.elapsed / 1000).toFixed(1)}s · ${formatBytes(total)}${n > 1 ? ` · ${n} files` : ""}`;
    dl.textContent = n > 1 ? "Download .zip" : "Download";
  }
}

function refreshQueue() {
  const any = jobs.length > 0;
  $("#queue").hidden = !any;
  $("#dropzone").classList.toggle("compact", any);
  const convertable = jobs.filter((j) => (j.state === "ready" || j.state === "error") && j.outExt);
  const done = jobs.filter((j) => j.state === "done");
  const busy = jobs.some((j) => j.state === "working" || j.state === "queued");
  const convertBtn = $("#convertAll");
  convertBtn.disabled = busy || (!convertable.length && !done.length);
  convertBtn.textContent = busy ? "Converting…" : !convertable.length && done.length ? "Convert again" : `Convert${convertable.length > 1 ? ` ${convertable.length} files` : ""}`;
  $("#downloadAll").disabled = done.length < 2;
  $("#summary").textContent = `${jobs.length} file${jobs.length === 1 ? "" : "s"}${done.length ? ` · ${done.length} done` : ""}`;

  const bulk = $("#bulkFormat");
  const union = new Map();
  for (const j of jobs) if (j.state !== "unsupported") for (const [o, e] of j.routes) union.set(o, e);
  const prev = bulk.value;
  bulk.innerHTML = '<option value="">Convert all to…</option>';
  const tmp = document.createElement("select");
  buildSelect(tmp, union, null);
  bulk.append(...tmp.childNodes);
  bulk.value = union.has(prev) ? prev : "";
  bulk.disabled = busy || !union.size;
}

$("#bulkFormat").addEventListener("change", (e) => {
  const out = e.target.value;
  if (!out) return;
  for (const j of jobs) {
    if (!j.routes.has(out) || j.state === "working" || j.state === "queued") continue;
    j.outExt = out;
    const select = $(".fmt", j.el);
    if (select) select.value = out;
    if (j.state === "done" || j.state === "error") { j.state = "ready"; j.results = null; }
    render(j);
  }
  refreshQueue();
});

$("#clearAll").addEventListener("click", () => { for (const j of [...jobs]) removeJob(j); });

// ---------- running ----------
const LIMITS = { heavy: 1, light: Math.max(2, Math.min(4, (navigator.hardwareConcurrency || 4) >> 1)) };
const running = { heavy: 0, light: 0 };

$("#convertAll").addEventListener("click", () => {
  let queued = 0;
  for (const j of jobs) {
    if ((j.state === "ready" || j.state === "error") && j.outExt) { j.state = "queued"; queued++; render(j); }
  }
  if (!queued) for (const j of jobs) if (j.state === "done") { j.state = "queued"; render(j); }
  pump();
});

function pump() {
  for (const job of jobs) {
    if (job.state !== "queued") continue;
    const engine = job.routes.get(job.outExt);
    const lane = engine.heavy ? "heavy" : "light";
    if (running[lane] >= LIMITS[lane]) continue;
    running[lane]++;
    runJob(job, engine).finally(() => { running[lane]--; pump(); });
  }
  refreshQueue();
}

async function runJob(job, engine) {
  job.state = "working";
  job.progress = 0;
  job.results = null;
  job.error = null;
  job.controller = new AbortController();
  const signal = job.controller.signal;
  render(job);
  $(".msg", job.el).textContent = "Starting…";
  const t0 = performance.now();
  try {
    const results = await engine.convert({
      file: job.file,
      inExt: job.inExt,
      outExt: job.outExt,
      base: baseName(job.file.name),
      opts: settings,
      signal,
      progress: (p) => {
        job.progress = p;
        $(".bar i", job.el).style.width = `${Math.round(p * 100)}%`;
      },
      status: (text) => { if (job.state === "working") $(".msg", job.el).textContent = text; },
    });
    if (signal.aborted) return;
    job.results = results;
    job.elapsed = performance.now() - t0;
    job.state = "done";
  } catch (e) {
    if (signal.aborted) return;
    if (!(e instanceof UserError)) console.error(e);
    job.state = "error";
    job.error = e instanceof UserError ? e.message : `Conversion failed: ${e?.message || e}`;
  }
  render(job);
  refreshQueue();
}

async function downloadJob(job) {
  const r = job.results;
  if (r.length === 1) return downloadBlob(r[0].blob, r[0].name);
  downloadBlob(await zipFiles(r), `${baseName(job.file.name)}-${job.outExt}.zip`);
}

$("#downloadAll").addEventListener("click", async () => {
  const btn = $("#downloadAll");
  btn.disabled = true;
  btn.textContent = "Zipping…";
  try {
    const files = jobs.filter((j) => j.state === "done").flatMap((j) => j.results);
    downloadBlob(await zipFiles(files), "transmute-converted.zip");
  } finally {
    btn.textContent = "Download all (.zip)";
    refreshQueue();
  }
});

// ---------- views ----------
const shots = mountScreenshots($("#shotsRoot"));
const VIEWS = {
  convert: { el: $("#convertView"), title: "Transmute — free file converter" },
  pdf: { el: $("#pdfView"), title: "PDF tools — Transmute", onEnter: (sub) => routePdf(sub), files: pdfFiles },
  shots: { el: $("#shotsView"), title: "Screenshots — Transmute", files: shots.addFiles },
};
let currentView = "convert";
function route() {
  const hash = location.hash.replace(/^#/, "");
  const [name, sub] = hash.split("/");
  const view = VIEWS[name] ? name : "convert";
  const changed = view !== currentView;
  currentView = view;
  for (const [k, v] of Object.entries(VIEWS)) v.el.hidden = k !== view;
  for (const a of document.querySelectorAll(".tabs a")) {
    if (a.dataset.view === view) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  document.title = VIEWS[view].title;
  VIEWS[view].onEnter?.(sub);
  if (changed) window.scrollTo(0, 0);
}
window.addEventListener("hashchange", route);
route();
const takeFiles = (files) => (VIEWS[currentView].files ? VIEWS[currentView].files(files) : addFiles(files));

// ---------- input ----------
const fileInput = $("#fileInput");
$("#pickFiles").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => { addFiles(fileInput.files); fileInput.value = ""; });

let dragDepth = 0;
const overlay = $("#dropOverlay");
window.addEventListener("dragenter", (e) => {
  if (![...e.dataTransfer.types].includes("Files")) return;
  e.preventDefault();
  dragDepth++;
  overlay.hidden = false;
});
window.addEventListener("dragover", (e) => { if ([...e.dataTransfer.types].includes("Files")) e.preventDefault(); });
window.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; overlay.hidden = true; } });
window.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  overlay.hidden = true;
  if (e.dataTransfer.files.length) takeFiles([...e.dataTransfer.files]);
});
window.addEventListener("paste", (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (!files.length) return;
  e.preventDefault();
  takeFiles(files.map((f, i) => (f.name && f.name !== "image.png") ? f : new File([f], `pasted-${Date.now()}-${i}.${detectExt(f) || "png"}`, { type: f.type })));
});

// ---------- formats directory ----------
(function renderFormats() {
  const byCat = {};
  let pairs = 0;
  for (const [ext, f] of Object.entries(FORMATS)) {
    const routes = routesFor(ext);
    if (!routes.size) continue;
    pairs += routes.size;
    const c = (byCat[f.cat] ||= { from: [], to: new Set() });
    c.from.push(ext);
    for (const o of routes.keys()) c.to.add(o);
  }
  const chip = (e) => `<span class="chip">${FORMATS[e].label}</span>`;
  $("#formatGrid").innerHTML = Object.entries(byCat).map(([cat, c]) => `
    <div class="fcard" data-cat="${cat}">
      <h3>${CATEGORIES[cat].label}</h3>
      <div class="frow"><span class="flabel">From</span><div class="chips">${c.from.map(chip).join("")}</div></div>
      <div class="frow"><span class="flabel">To</span><div class="chips">${[...c.to].map(chip).join("")}</div></div>
    </div>`).join("");
  const inputCount = Object.values(byCat).reduce((s, c) => s + c.from.length, 0);
  $("#statFormats").textContent = inputCount;
  $("#statPairs").textContent = pairs;
})();
