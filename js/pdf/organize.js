import { h, picker, statusBar, card, iconButton, ICONS, isPdf, openPdfjs, openPdfLib, renderPage, getPdfLib, getSortable, pdfBlob, stem } from "./common.js";
import { downloadBlob, formatBytes } from "../util.js";

export default {
  id: "organize",
  title: "Organize pages",
  desc: "Reorder, rotate and delete pages, or add pages from other PDFs.",
  icon: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  mount(root) {
    const docs = [];
    const grid = h("div", { class: "card-grid pages" });
    const status = statusBar();
    const go = h("button", { class: "btn primary", disabled: true, onclick: run }, "Save PDF");
    const hint = h("p", { class: "tool-hint", hidden: true }, "Drag pages to reorder them (press and hold on touchscreens). Use the buttons on each page to rotate or remove it.");
    const rotateAll = h("button", { class: "btn ghost small", onclick: () => pages().forEach((p) => rotate(p, 90)) }, "Rotate all");
    const toolbar = h("div", { class: "tool-row", hidden: true }, rotateAll);
    const pick = picker({ multiple: true, label: "Choose PDFs", onFiles: addFiles });
    root.append(pick.el, toolbar, hint, grid, h("div", { class: "tool-actions" }, status.el, go));
    getSortable().then((Sortable) => Sortable.create(grid, { animation: 150, ghostClass: "ghost", filter: ".icon-btn", preventOnFilter: false, delay: 180, delayOnTouchOnly: true }));

    const pages = () => [...grid.children].map((el) => el._page);
    const update = () => {
      const n = grid.children.length;
      go.disabled = !n;
      go.textContent = n ? `Save PDF (${n} page${n === 1 ? "" : "s"})` : "Save PDF";
      hint.hidden = toolbar.hidden = !n;
      pick.el.querySelector(".btn").textContent = n ? "Add more PDFs" : "Choose PDFs";
    };
    function rotate(p, by) {
      p.rot = (p.rot + by + 360) % 360;
      p.img.style.transform = `rotate(${p.rot}deg)`;
    }

    async function addFiles(files) {
      for (const file of files) {
        if (!isPdf(file)) { status.set(`${file.name} isn't a PDF.`, "error"); continue; }
        try {
          const bytes = new Uint8Array(await file.arrayBuffer());
          const { pdf, close } = await openPdfjs(bytes);
          const d = docs.push({ bytes, name: file.name }) - 1;
          const cards = [];
          for (let i = 0; i < pdf.numPages; i++) {
            const p = { doc: d, index: i, rot: 0 };
            const c = card({
              label: `Page ${i + 1}`,
              sub: "",
              actions: [
                iconButton("Rotate left", ICONS.rotL, () => rotate(p, -90)),
                iconButton("Rotate right", ICONS.rotR, () => rotate(p, 90)),
                iconButton("Delete page", ICONS.x, () => { c.el.remove(); update(); }),
              ],
            });
            p.img = c.img;
            p.nameEl = c.el.querySelector(".tc-name");
            c.el._page = p;
            grid.append(c.el);
            cards.push(c);
          }
          if (docs.length > 1) {
            for (const p of pages()) p.nameEl.textContent = p.nameEl.title = `${stem(docs[p.doc].name)} · ${p.index + 1}`;
          }
          update();
          try {
            for (const [i, c] of cards.entries()) c.setThumb((await renderPage(pdf, i + 1, 160)).url);
          } finally {
            close();
          }
        } catch (e) {
          status.fail(e);
        }
      }
    }

    async function run() {
      go.disabled = true;
      try {
        const { PDFDocument, degrees } = await getPdfLib();
        const out = await PDFDocument.create();
        const order = pages();
        // Copy each source's pages in one batch so shared fonts/images aren't duplicated.
        const copied = new Map();
        for (const d of new Set(order.map((p) => p.doc))) {
          status.set(`Reading ${docs[d].name}…`);
          const src = await openPdfLib(docs[d].bytes);
          const idx = order.filter((p) => p.doc === d).map((p) => p.index);
          const res = await out.copyPages(src, idx);
          idx.forEach((i, k) => copied.set(`${d}:${i}`, res[k]));
        }
        for (const p of order) {
          const page = copied.get(`${p.doc}:${p.index}`);
          if (p.rot) page.setRotation(degrees((page.getRotation().angle + p.rot) % 360));
          out.addPage(page);
        }
        const bytes = await out.save({ useObjectStreams: true });
        const name = `${stem(docs[0].name)}-organized.pdf`;
        downloadBlob(pdfBlob(bytes), name);
        status.set(`Done · ${order.length} pages · ${formatBytes(bytes.length)} · downloaded ${name}`, "ok");
      } catch (e) {
        status.fail(e);
      }
      update();
    }

    return { addFiles };
  },
};
