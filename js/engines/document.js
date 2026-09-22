import { CDN, lazy, loadScript, moduleWorkerURL, UserError } from "../util.js";
import { htmlToPdf } from "../pdfwriter.js";

const PDFJS = CDN + "pdfjs-dist@6.3.289/";
const pdfjsLib = lazy(async () => {
  const pdfjs = await import(PDFJS + "build/pdf.min.mjs");
  pdfjs.GlobalWorkerOptions.workerPort = new Worker(moduleWorkerURL(PDFJS + "build/pdf.worker.min.mjs"), { type: "module" });
  return pdfjs;
});
const mammothLib = lazy(async () => { await loadScript(CDN + "mammoth@1.12.3/mammoth.browser.min.js"); return window.mammoth; });
const markedLib = lazy(async () => (await import(CDN + "marked@18.0.14/+esm")).marked);
const turndownLib = lazy(async () => {
  const TurndownService = (await import(CDN + "turndown@7.2.4/+esm")).default;
  const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
  const cell = (c) => c.textContent.replace(/\s+/g, " ").trim().replace(/\|/g, "\\|");
  td.addRule("table", {
    filter: "table",
    replacement: (_, table) => {
      const rows = [...table.querySelectorAll("tr")].map((tr) => [...tr.cells].map(cell));
      if (!rows.length) return "";
      const cols = Math.max(...rows.map((r) => r.length));
      const line = (r) => `| ${Array.from({ length: cols }, (_, i) => r[i] ?? "").join(" | ")} |`;
      return `\n\n${line(rows[0])}\n| ${Array(cols).fill("---").join(" | ")} |\n${rows.slice(1).map(line).join("\n")}\n\n`;
    },
  });
  return td;
});

const OUT = {
  pdf: ["png", "jpg", "webp", "txt"],
  docx: ["pdf", "html", "md", "txt"],
  md: ["pdf", "html", "txt"],
  html: ["pdf", "md", "txt"],
  txt: ["pdf", "html", "md"],
};

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

export function htmlPage(title, body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
body{font:16px/1.65 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;max-width:780px;margin:40px auto;padding:0 20px;color:#1b1b1f}
img{max-width:100%}pre{background:#f4f4f6;padding:12px 14px;border-radius:8px;overflow:auto}
code{font-family:ui-monospace,Consolas,monospace;font-size:.92em}table{border-collapse:collapse;margin:1em 0}
td,th{border:1px solid #ddd;padding:6px 10px;text-align:left}th{background:#f6f6f8}
blockquote{margin:1em 0;padding-left:16px;border-left:3px solid #ddd;color:#555}
</style>
</head>
<body>
${body}
</body>
</html>
`;
}

const textToHtml = (text) =>
  text.split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`).join("\n");

const htmlToText = (html) => {
  const d = new DOMParser().parseFromString(html, "text/html");
  d.querySelectorAll("script,style").forEach((n) => n.remove());
  d.querySelectorAll("br").forEach((n) => n.replaceWith("\n"));
  d.querySelectorAll("p,div,h1,h2,h3,h4,h5,h6,li,tr,pre,blockquote").forEach((n) => n.append("\n"));
  return (d.body.textContent || "").replace(/\n{3,}/g, "\n\n").trim() + "\n";
};

async function toHtml(file, inExt, status) {
  if (inExt === "html") return await file.text();
  if (inExt === "txt") return textToHtml(await file.text());
  if (inExt === "md") return (await markedLib()).parse(await file.text());
  if (inExt === "docx") {
    status("Reading Word document…");
    const mammoth = await mammothLib();
    try {
      return (await mammoth.convertToHtml({ arrayBuffer: await file.arrayBuffer() })).value;
    } catch {
      throw new UserError("Couldn't read this .docx file. Old .doc files aren't supported — save it as .docx first.");
    }
  }
}

async function openPdf(file) {
  const pdfjs = await pdfjsLib();
  let task;
  try {
    task = pdfjs.getDocument({
      data: new Uint8Array(await file.arrayBuffer()),
      cMapUrl: PDFJS + "cmaps/",
      cMapPacked: true,
      standardFontDataUrl: PDFJS + "standard_fonts/",
      wasmUrl: PDFJS + "wasm/",
      iccUrl: PDFJS + "iccs/",
    });
    return { pdf: await task.promise, close: () => task.destroy() };
  } catch (e) {
    task?.destroy();
    if (e?.name === "PasswordException") throw new UserError("This PDF is password-protected.");
    throw new UserError("Couldn't read this PDF. It may be damaged.");
  }
}

async function pdfToImages({ file, outExt, opts, base, progress, status, signal }) {
  status("Loading PDF engine…");
  const { pdf, close } = await openPdf(file);
  const scale = +opts.pdf.scale || 2;
  const type = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" }[outExt];
  const pad = String(pdf.numPages).length;
  const files = [];
  try {
    for (let i = 1; i <= pdf.numPages; i++) {
      if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
      status(`Rendering page ${i} of ${pdf.numPages}…`);
      const page = await pdf.getPage(i);
      const vp = page.getViewport({ scale });
      const canvas = new OffscreenCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      // "print" intent renders without requestAnimationFrame, so it doesn't stall in background tabs.
      await page.render({ canvas, canvasContext: ctx, viewport: vp, intent: "print" }).promise;
      const blob = await canvas.convertToBlob({ type, quality: +opts.image.quality });
      const suffix = pdf.numPages > 1 ? `-page-${String(i).padStart(pad, "0")}` : "";
      files.push({ name: `${base}${suffix}.${outExt}`, blob });
      page.cleanup();
      progress(i / pdf.numPages);
    }
  } finally {
    close();
  }
  return files;
}

async function pdfToText({ file, base, progress, status }) {
  status("Loading PDF engine…");
  const { pdf, close } = await openPdf(file);
  const pages = [];
  try {
    for (let i = 1; i <= pdf.numPages; i++) {
      status(`Reading page ${i} of ${pdf.numPages}…`);
      const content = await (await pdf.getPage(i)).getTextContent();
      pages.push(content.items.map((it) => it.str + (it.hasEOL ? "\n" : "")).join("").trim());
      progress(i / pdf.numPages);
    }
  } finally {
    close();
  }
  const text = pages.join("\n\n");
  if (!text.trim()) throw new UserError("No selectable text in this PDF (it's probably scanned images).");
  return [{ name: `${base}.txt`, blob: new Blob([text + "\n"], { type: "text/plain" }) }];
}

export default {
  id: "document",
  outputs(inExt) {
    return OUT[inExt] || [];
  },
  async convert(job) {
    const { file, inExt, outExt, base, status } = job;
    if (inExt === "pdf") return outExt === "txt" ? pdfToText(job) : pdfToImages(job);

    if (inExt === "docx" && outExt === "txt") {
      const mammoth = await mammothLib();
      const { value } = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
      return [{ name: `${base}.txt`, blob: new Blob([value], { type: "text/plain" }) }];
    }
    if (inExt === "txt" && outExt === "md") {
      return [{ name: `${base}.md`, blob: new Blob([await file.text()], { type: "text/markdown" }) }];
    }

    const html = await toHtml(file, inExt, status);
    let blob;
    if (outExt === "pdf") {
      status("Laying out PDF…");
      blob = await htmlToPdf(html, base);
    } else if (outExt === "html") {
      blob = new Blob([htmlPage(base, html)], { type: "text/html" });
    } else if (outExt === "md") {
      const td = await turndownLib();
      blob = new Blob([td.turndown(html) + "\n"], { type: "text/markdown" });
    } else if (outExt === "txt") {
      blob = new Blob([htmlToText(html)], { type: "text/plain" });
    }
    return [{ name: `${base}.${outExt}`, blob }];
  },
};
