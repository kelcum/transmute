import { h, picker, statusBar, segmented, isPdf, openPdfjs, openPdfLib, getPdfLib, pdfBlob, stem, sizeChange } from "./common.js";
import { downloadBlob, zipFiles, formatBytes, UserError } from "../util.js";

const LEVELS = {
  recommended: { quality: 0.72, maxDim: 2000 },
  strong: { quality: 0.6, dpi: 110 },
};

// Re-encodes the JPEG photos inside a PDF at lower quality/resolution.
// Everything else (text, vector art) is left untouched, so text stays sharp.
async function shrinkImages(bytes, { quality, maxDim }, onStep) {
  const { PDFName, PDFRawStream, PDFNumber, PDFArray } = await getPdfLib();
  const doc = await openPdfLib(bytes);
  const N = (s) => PDFName.of(s);
  const images = [...doc.context.enumerateIndirectObjects()].filter(([, obj]) =>
    obj instanceof PDFRawStream && String(obj.dict.get(N("Subtype"))) === "/Image" && String(obj.dict.get(N("Filter"))) === "/DCTDecode");
  let done = 0;
  for (const [ref, obj] of images) {
    onStep(++done, images.length);
    const d = obj.dict;
    if (d.has(N("Decode")) || d.has(N("ImageMask"))) continue;
    let cs = d.lookup(N("ColorSpace"));
    if (cs instanceof PDFArray && String(cs.get(0)) === "/ICCBased") {
      const n = cs.lookup(1)?.dict?.get(N("N"));
      cs = n && +String(n) === 4 ? "cmyk" : "/DeviceRGB";
    }
    // CMYK JPEGs decode inconsistently in browsers; leave them alone.
    if (!["/DeviceRGB", "/DeviceGray"].includes(String(cs))) continue;
    let bmp;
    try { bmp = await createImageBitmap(new Blob([obj.contents], { type: "image/jpeg" })); } catch { continue; }
    const k = d.has(N("SMask")) ? 1 : Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * k));
    const ht = Math.max(1, Math.round(bmp.height * k));
    const c = new OffscreenCanvas(w, ht);
    c.getContext("2d").drawImage(bmp, 0, 0, w, ht);
    const next = new Uint8Array(await (await c.convertToBlob({ type: "image/jpeg", quality })).arrayBuffer());
    if (next.length > obj.contents.length * 0.9) continue;
    d.set(N("Width"), PDFNumber.of(w));
    d.set(N("Height"), PDFNumber.of(ht));
    d.set(N("ColorSpace"), N("DeviceRGB"));
    d.set(N("BitsPerComponent"), PDFNumber.of(8));
    d.delete(N("DecodeParms"));
    doc.context.assign(ref, PDFRawStream.of(d, next));
  }
  return doc.save({ useObjectStreams: true });
}

// Replaces every page with a JPEG snapshot of itself. Smallest output, but text is no longer selectable.
async function rasterize(bytes, { quality, dpi }, onStep) {
  const { PDFDocument } = await getPdfLib();
  const { pdf, close } = await openPdfjs(bytes);
  const out = await PDFDocument.create();
  try {
    for (let n = 1; n <= pdf.numPages; n++) {
      onStep(n, pdf.numPages);
      const page = await pdf.getPage(n);
      const size = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: dpi / 72 });
      const c = new OffscreenCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvas: c, canvasContext: ctx, viewport: vp, intent: "print" }).promise;
      const jpg = await out.embedJpg(new Uint8Array(await (await c.convertToBlob({ type: "image/jpeg", quality })).arrayBuffer()));
      out.addPage([size.width, size.height]).drawImage(jpg, { x: 0, y: 0, width: size.width, height: size.height });
      page.cleanup();
    }
  } finally {
    close();
  }
  return out.save({ useObjectStreams: true });
}

export default {
  id: "compress",
  title: "Compress PDF",
  desc: "Make PDFs smaller by shrinking the photos inside them.",
  icon: '<path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/>',
  mount(root) {
    const items = [];
    const list = h("div", { class: "result-list" });
    const status = statusBar();
    const HINTS = {
      recommended: "Shrinks photos and scans; text and drawings stay sharp and selectable.",
      strong: "Turns every page into an image. Smallest files, but text can't be selected or searched.",
    };
    const levelHint = h("p", { class: "tool-hint" }, HINTS.recommended);
    const level = segmented([["recommended", "Recommended"], ["strong", "Strong"]], "recommended", (v) => {
      levelHint.textContent = HINTS[v];
    });
    const go = h("button", { class: "btn primary", disabled: true, onclick: run }, "Compress");
    const all = h("button", { class: "btn ghost", hidden: true, onclick: downloadAll }, "Download all (.zip)");
    const opts = h("div", { class: "tool-work", hidden: true }, h("div", { class: "tool-row" }, h("span", { class: "muted" }, "Level"), level.el), levelHint);
    const pick = picker({ multiple: true, label: "Choose PDFs", onFiles: addFiles });
    root.append(pick.el, opts, list, h("div", { class: "tool-actions" }, status.el, all, go));

    function update() {
      const pending = items.filter((i) => !i.result);
      go.disabled = !pending.length;
      go.textContent = pending.length > 1 ? `Compress ${pending.length} PDFs` : "Compress";
      all.hidden = items.filter((i) => i.result).length < 2;
      opts.hidden = !items.length;
    }

    function addFiles(files) {
      for (const file of files) {
        if (!isPdf(file)) { status.set(`${file.name} isn't a PDF.`, "error"); continue; }
        const msg = h("span", { class: "muted" }, formatBytes(file.size));
        const dl = h("button", { class: "btn primary small", hidden: true }, "Download");
        const item = { file, msg, dl };
        dl.onclick = () => downloadBlob(item.result.blob, item.result.name);
        list.append(h("div", { class: "result-row" }, h("span", { class: "tc-name" }, file.name), msg, dl));
        items.push(item);
      }
      update();
    }

    async function run() {
      go.disabled = true;
      const cfgName = level.value;
      for (const item of items.filter((i) => !i.result)) {
        const before = item.file.size;
        try {
          const bytes = new Uint8Array(await item.file.arrayBuffer());
          const step = (i, n) => { item.msg.textContent = cfgName === "strong" ? `Page ${i} of ${n}…` : `Image ${i} of ${n}…`; };
          item.msg.textContent = "Working…";
          let out = cfgName === "strong" ? await rasterize(bytes, LEVELS.strong, step) : await shrinkImages(bytes, LEVELS.recommended, step);
          let note = "";
          if (out.length >= before) { out = bytes; note = " · already as small as it gets"; }
          item.result = { name: `${stem(item.file.name)}-compressed.pdf`, blob: pdfBlob(out) };
          item.msg.textContent = sizeChange(before, out.length) + note;
          item.msg.className = "ok";
          item.dl.hidden = false;
        } catch (e) {
          item.msg.textContent = e.message;
          item.msg.className = "err";
          if (!(e instanceof UserError)) console.error(e);
        }
      }
      status.set("");
      update();
    }

    async function downloadAll() {
      downloadBlob(await zipFiles(items.filter((i) => i.result).map((i) => i.result)), "compressed-pdfs.zip");
    }

    return { addFiles };
  },
};
