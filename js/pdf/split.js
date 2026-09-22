import { h, picker, statusBar, card, segmented, isPdf, openPdfjs, openPdfLib, renderPage, getPdfLib, parseRanges, pdfBlob, stem } from "./common.js";
import { downloadBlob, zipFiles, formatBytes } from "../util.js";

export default {
  id: "split",
  title: "Split PDF",
  desc: "Break a PDF into single pages or page ranges, or pull out the pages you need.",
  icon: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4L8.12 15.88M14.47 14.48L20 20M8.12 8.12L12 12"/>',
  mount(root) {
    let doc = null;
    let token = 0;
    const status = statusBar();
    const info = h("p", { class: "tool-file" });
    const ranges = h("input", { type: "text", class: "text-in", placeholder: "e.g. 1-3, 5, 8-10", "aria-label": "Page ranges" });
    const rangesRow = h("label", { class: "field", hidden: true }, "Each range becomes its own PDF", ranges);
    const selHint = h("p", { class: "tool-hint", hidden: true }, "Click pages to select them. They'll be saved together as one PDF.");
    const grid = h("div", { class: "card-grid pages" });
    const mode = segmented([["pages", "Every page"], ["ranges", "Custom ranges"], ["select", "Pick pages"]], "pages", (v) => {
      rangesRow.hidden = v !== "ranges";
      selHint.hidden = v !== "select";
      grid.classList.toggle("selectable", v === "select");
      update();
    });
    const go = h("button", { class: "btn primary", disabled: true, onclick: run }, "Split PDF");
    const work = h("div", { class: "tool-work", hidden: true }, info, mode.el, rangesRow, selHint, grid);
    const pick = picker({ multiple: false, label: "Choose a PDF", onFiles: addFiles });
    root.append(pick.el, work, h("div", { class: "tool-actions" }, status.el, go));
    ranges.addEventListener("input", update);

    const selected = () => [...grid.querySelectorAll(".tcard.selected")].map((el) => +el.dataset.page);

    function update() {
      if (!doc) return;
      const m = mode.value;
      const n = selected().length;
      go.disabled = (m === "select" && !n) || (m === "ranges" && !ranges.value.trim());
      go.textContent = m === "pages" ? `Split into ${doc.numPages} files`
        : m === "select" ? (n ? `Extract ${n} page${n === 1 ? "" : "s"}` : "Extract pages")
        : "Split PDF";
    }

    async function addFiles(files) {
      const file = files.find(isPdf);
      if (!file) return status.set("Please choose a PDF file.", "error");
      const my = ++token;
      grid.replaceChildren();
      status.set("Opening…");
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const { pdf, close } = await openPdfjs(bytes);
        doc = { bytes, name: file.name, numPages: pdf.numPages };
        info.textContent = `${file.name} · ${pdf.numPages} pages · ${formatBytes(file.size)}`;
        work.hidden = false;
        status.set("");
        update();
        const cards = [];
        for (let n = 1; n <= pdf.numPages; n++) {
          const c = card({ label: `Page ${n}`, sub: "" });
          c.el.dataset.page = n;
          c.el.addEventListener("click", () => {
            if (mode.value !== "select") return;
            c.el.classList.toggle("selected");
            update();
          });
          grid.append(c.el);
          cards.push(c);
        }
        try {
          for (const [i, c] of cards.entries()) {
            if (my !== token) break;
            c.setThumb((await renderPage(pdf, i + 1, 160)).url);
          }
        } finally {
          close();
        }
      } catch (e) {
        status.fail(e);
      }
    }

    async function run() {
      go.disabled = true;
      try {
        const { PDFDocument } = await getPdfLib();
        const src = await openPdfLib(doc.bytes);
        const base = stem(doc.name);
        const pad = (n) => String(n).padStart(String(doc.numPages).length, "0");
        let groups;
        if (mode.value === "pages") groups = src.getPageIndices().map((i) => [i + 1]);
        else if (mode.value === "ranges") groups = parseRanges(ranges.value, doc.numPages);
        else groups = [selected()];
        const files = [];
        for (const [i, g] of groups.entries()) {
          status.set(`Creating file ${i + 1} of ${groups.length}…`);
          const out = await PDFDocument.create();
          for (const p of await out.copyPages(src, g.map((n) => n - 1))) out.addPage(p);
          const name = mode.value === "select" ? `${base}-extract.pdf`
            : g.length === 1 ? `${base}-page-${pad(g[0])}.pdf`
            : `${base}-pages-${g[0]}-${g[g.length - 1]}.pdf`;
          files.push({ name, blob: pdfBlob(await out.save({ useObjectStreams: true })) });
        }
        if (files.length === 1) downloadBlob(files[0].blob, files[0].name);
        else {
          status.set("Zipping…");
          downloadBlob(await zipFiles(files), `${base}-split.zip`);
        }
        status.set(`Done · ${files.length} file${files.length === 1 ? "" : "s"} downloaded`, "ok");
      } catch (e) {
        status.fail(e);
      }
      update();
    }

    return { addFiles };
  },
};
