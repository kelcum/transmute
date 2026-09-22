import { h, picker, statusBar, card, iconButton, ICONS, isPdf, isImage, openPdfjs, openPdfLib, renderPage, getPdfLib, getSortable, pdfBlob, addImagePage } from "./common.js";
import { downloadBlob, formatBytes } from "../util.js";

export default {
  id: "merge",
  title: "Merge PDFs",
  desc: "Combine several PDFs and images into one file, in any order.",
  icon: '<path d="M8 3H5a2 2 0 00-2 2v14a2 2 0 002 2h3M16 3h3a2 2 0 012 2v14a2 2 0 01-2 2h-3M12 8v8M8 12h8"/>',
  mount(root) {
    const list = h("div", { class: "card-grid" });
    const status = statusBar();
    const go = h("button", { class: "btn primary", disabled: true, onclick: run }, "Merge PDFs");
    const hint = h("p", { class: "tool-hint", hidden: true }, "Drag the cards to change the order.");
    const pick = picker({
      multiple: true,
      accept: ".pdf,application/pdf,image/png,image/jpeg,image/webp,image/gif,image/bmp",
      label: "Add PDFs or images",
      onFiles: addFiles,
    });
    root.append(pick.el, hint, list, h("div", { class: "tool-actions" }, status.el, go));
    getSortable().then((Sortable) => Sortable.create(list, { animation: 150, ghostClass: "ghost", filter: ".icon-btn", preventOnFilter: false, delay: 180, delayOnTouchOnly: true }));

    const ready = () => [...list.children].map((el) => el._item).filter((i) => i?.pages && !i.error);
    const update = () => {
      const n = ready().length;
      go.disabled = n < 1;
      go.textContent = n > 1 ? `Merge ${n} files` : "Merge PDFs";
      hint.hidden = list.children.length < 2;
    };

    async function addFiles(files) {
      for (const file of files) {
        if (!isPdf(file) && !isImage(file)) { status.set(`${file.name} isn't a PDF or image.`, "error"); continue; }
        const item = { file, kind: isPdf(file) ? "pdf" : "image" };
        const c = card({ label: file.name, actions: [iconButton("Remove", ICONS.x, () => { c.el.remove(); update(); })] });
        c.el._item = item;
        list.append(c.el);
        try {
          if (item.kind === "pdf") {
            item.bytes = new Uint8Array(await file.arrayBuffer());
            const { pdf, close } = await openPdfjs(item.bytes);
            try {
              item.pages = pdf.numPages;
              c.setThumb((await renderPage(pdf, 1, 200)).url);
            } finally { close(); }
            c.setMeta(`${item.pages} page${item.pages === 1 ? "" : "s"} · ${formatBytes(file.size)}`);
          } else {
            await createImageBitmap(file);
            item.pages = 1;
            c.setThumb(URL.createObjectURL(file));
            c.setMeta(`Image · ${formatBytes(file.size)}`);
          }
        } catch (e) {
          item.error = true;
          c.setError(e.message);
        }
        update();
      }
    }

    async function run() {
      const items = ready();
      go.disabled = true;
      try {
        const { PDFDocument } = await getPdfLib();
        const out = await PDFDocument.create();
        for (const [i, item] of items.entries()) {
          status.set(`Adding ${i + 1} of ${items.length}: ${item.file.name}…`);
          if (item.kind === "pdf") {
            const src = await openPdfLib(item.bytes);
            for (const p of await out.copyPages(src, src.getPageIndices())) out.addPage(p);
          } else {
            await addImagePage(out, item.file);
          }
        }
        const bytes = await out.save({ useObjectStreams: true });
        downloadBlob(pdfBlob(bytes), "merged.pdf");
        status.set(`Done · ${out.getPageCount()} pages · ${formatBytes(bytes.length)} · downloaded merged.pdf`, "ok");
      } catch (e) {
        status.fail(e);
      }
      update();
    }

    return { addFiles };
  },
};
