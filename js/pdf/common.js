import { CDN, lazy, moduleWorkerURL, UserError, formatBytes } from "../util.js";

export const PDFJS = CDN + "pdfjs-dist@6.3.289/";

export const getPdfjs = lazy(() => import(PDFJS + "build/pdf.min.mjs"));
// An explicitly passed worker outlives each document. With pdf.js's implicit shared
// worker, closing one document tears it down under any other open document.
const getWorker = lazy(async () => {
  const pdfjs = await getPdfjs();
  return new pdfjs.PDFWorker({ port: new Worker(moduleWorkerURL(PDFJS + "build/pdf.worker.min.mjs"), { type: "module" }) });
});
export const getPdfLib = lazy(() => import(CDN + "pdf-lib@1.17.1/dist/pdf-lib.esm.min.js"));
export const getSortable = lazy(async () => (await import(CDN + "sortablejs@1.15.7/modular/sortable.esm.js")).Sortable);

// pdf.js transfers the buffer it's given to its worker, so always hand it a copy.
export async function openPdfjs(bytes) {
  const pdfjs = await getPdfjs();
  const task = pdfjs.getDocument({
    worker: await getWorker(),
    data: bytes.slice(),
    cMapUrl: PDFJS + "cmaps/",
    cMapPacked: true,
    standardFontDataUrl: PDFJS + "standard_fonts/",
    wasmUrl: PDFJS + "wasm/",
    iccUrl: PDFJS + "iccs/",
  });
  try {
    return { pdf: await task.promise, close: () => task.destroy() };
  } catch (e) {
    task.destroy();
    if (e?.name === "PasswordException") throw new UserError("This PDF is password-protected.");
    throw new UserError("Couldn't read this PDF. It may be damaged.");
  }
}

export async function openPdfLib(bytes) {
  const { PDFDocument } = await getPdfLib();
  let doc;
  try {
    doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  } catch {
    throw new UserError("Couldn't read this PDF. It may be damaged.");
  }
  if (doc.isEncrypted) throw new UserError("This PDF is encrypted, so it can't be edited. Remove its password first.");
  return doc;
}

// "print" intent renders without requestAnimationFrame, so it keeps working in background tabs.
export async function renderPage(pdf, pageNumber, width, { forms = true } = {}) {
  const pdfjs = await getPdfjs();
  const page = await pdf.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: width / base.width });
  const canvas = new OffscreenCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({
    canvas, canvasContext: ctx, viewport: vp, intent: "print",
    annotationMode: forms ? pdfjs.AnnotationMode.ENABLE : pdfjs.AnnotationMode.DISABLE,
  }).promise;
  const blob = await canvas.convertToBlob({ type: "image/webp", quality: 0.88 });
  page.cleanup();
  return { url: URL.createObjectURL(blob), viewport: vp, rotation: page.rotate };
}

export function parseRanges(text, max) {
  const groups = [];
  for (const part of text.split(/[,;]/).map((s) => s.trim()).filter(Boolean)) {
    const m = part.match(/^(\d*)\s*[-–]\s*(\d*)$/);
    let a, b;
    if (/^\d+$/.test(part)) a = b = +part;
    else if (m && (m[1] || m[2])) { a = m[1] ? +m[1] : 1; b = m[2] ? +m[2] : max; }
    else throw new UserError(`"${part}" isn't a page range. Use something like 1-3, 5, 8-10.`);
    if (a < 1 || b < 1 || a > max || b > max) throw new UserError(`"${part}" is outside this PDF's ${max} pages.`);
    const g = [];
    for (let i = a; a <= b ? i <= b : i >= b; i += a <= b ? 1 : -1) g.push(i);
    groups.push(g);
  }
  if (!groups.length) throw new UserError("Enter at least one page range.");
  return groups;
}

export const isPdf = (f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name);
export const isImage = (f) => /^image\/(png|jpeg|webp|gif|bmp)$/.test(f.type) || /\.(png|jpe?g|webp|gif|bmp)$/i.test(f.name);
export const stem = (name) => name.replace(/\.[^.]+$/, "");
export const pdfBlob = (bytes) => new Blob([bytes], { type: "application/pdf" });

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "html") el.innerHTML = v;
    else if (v !== false && v != null) el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c);
  return el;
}

// A drop/choose area scoped to one tool. Page-level drops are routed here too.
export function picker({ multiple, accept = ".pdf,application/pdf", label, hint, onFiles }) {
  const input = h("input", { type: "file", accept, hidden: true, multiple });
  input.addEventListener("change", () => { onFiles([...input.files]); input.value = ""; });
  const el = h("div", { class: "picker" },
    input,
    h("button", { class: "btn primary", onclick: () => input.click() }, label),
    h("span", { class: "muted" }, hint || "or drop files anywhere on the page"),
  );
  return { el, open: () => input.click() };
}

export function statusBar() {
  const msg = h("span", { class: "tool-msg", role: "status" });
  return {
    el: msg,
    set(text, kind = "") { msg.textContent = text; msg.dataset.kind = kind; },
    fail(e) {
      if (!(e instanceof UserError)) console.error(e);
      this.set(e instanceof UserError ? e.message : `Something went wrong: ${e.message}`, "error");
    },
  };
}

export const sizeChange = (before, after) => {
  const pct = Math.round((1 - after / before) * 100);
  return `${formatBytes(before)} → ${formatBytes(after)}${pct > 0 ? ` (−${pct}%)` : ""}`;
};

export function card({ label, sub = "Loading…", actions = [] }) {
  const img = h("img", { alt: "", draggable: "false" });
  const meta = h("span", { class: "tc-meta" }, sub);
  const el = h("div", { class: "tcard" },
    h("div", { class: "tc-thumb" }, img),
    h("div", { class: "tc-info" }, h("span", { class: "tc-name", title: label }, label), meta),
    actions.length ? h("div", { class: "tc-actions" }, ...actions) : null);
  return {
    el,
    img,
    setThumb(url) { img.src = url; },
    setMeta(text) { meta.textContent = text; },
    setError(text) { el.classList.add("err"); meta.textContent = text; },
  };
}

export function iconButton(label, paths, onclick) {
  return h("button", {
    class: "icon-btn", type: "button", title: label, "aria-label": label, onclick,
    html: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`,
  });
}
export const ICONS = {
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  rotL: '<path d="M3 12a9 9 0 109-9 9.7 9.7 0 00-6.7 2.7L3 8"/><path d="M3 3v5h5"/>',
  rotR: '<path d="M21 12a9 9 0 11-9-9 9.7 9.7 0 016.7 2.7L21 8"/><path d="M21 3v5h-5"/>',
};

export function segmented(options, value, onChange) {
  const el = h("div", { class: "seg", role: "radiogroup" });
  const set = (v) => {
    value = v;
    for (const b of el.children) b.setAttribute("aria-checked", String(b.dataset.v === v));
  };
  for (const [v, text] of options) {
    el.append(h("button", { type: "button", role: "radio", "data-v": v, onclick: () => { set(v); onChange(v); } }, text));
  }
  set(value);
  return { el, get value() { return value; }, set };
}

export async function addImagePage(doc, file) {
  const bmp = await createImageBitmap(file);
  const jpeg = file.type === "image/jpeg" || /\.jpe?g$/i.test(file.name);
  let bytes;
  if (jpeg) bytes = new Uint8Array(await file.arrayBuffer());
  else {
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    c.getContext("2d").drawImage(bmp, 0, 0);
    bytes = new Uint8Array(await (await c.convertToBlob({ type: "image/png" })).arrayBuffer());
  }
  const img = jpeg ? await doc.embedJpg(bytes) : await doc.embedPng(bytes);
  const w = bmp.width * 0.75;
  const ht = bmp.height * 0.75;
  doc.addPage([w, ht]).drawImage(img, { x: 0, y: 0, width: w, height: ht });
}

// Renders every page, in order, into a scrollable column. Overlays (signatures,
// form inputs) are positioned in each page's CSS-pixel space.
export async function pageViewer(container, pdf, { forms = true, onPage } = {}) {
  const width = Math.min(860, Math.max(260, container.clientWidth - 8));
  const pages = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const vp = page.getViewport({ scale: width / page.getViewport({ scale: 1 }).width });
    const el = h("div", { class: "pv-page", "data-page": n, style: `width:${vp.width}px;height:${vp.height}px` },
      h("span", { class: "pv-num" }, String(n)));
    container.append(el);
    pages.push({ n, el, viewport: vp, rotation: page.rotate });
  }
  for (const p of pages) {
    const { url } = await renderPage(pdf, p.n, p.viewport.width, { forms });
    p.el.prepend(h("img", { src: url, alt: `Page ${p.n}`, draggable: "false" }));
    onPage?.(p);
  }
  return pages;
}
