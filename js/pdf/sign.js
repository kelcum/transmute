import { h, picker, statusBar, segmented, isPdf, openPdfjs, openPdfLib, pageViewer, getPdfLib, pdfBlob, stem } from "./common.js";
import { embedUnicodeFont } from "../pdfwriter.js";
import { CDN, lazy, downloadBlob, formatBytes } from "../util.js";

const SCRIPT_FONTS = [["Dancing Script", 600], ["Caveat", 600], ["Great Vibes", 400]];
const INKS = { black: "#111827", blue: "#1d3fb0" };
// Matches the font embedded in the PDF, so text lands exactly where it's shown.
const TEXT_FONT = "TransmuteText";
// DejaVu Sans: (ascender − half the leading at line-height 1.25) / em.
const BASELINE = 0.971;
const LINE = 1.25;
const PAD = 3;

const loadScriptFonts = lazy(async () => {
  await new Promise((resolve) => {
    const link = h("link", { rel: "stylesheet", href: "https://fonts.googleapis.com/css2?family=Caveat:wght@600&family=Dancing+Script:wght@600&family=Great+Vibes&display=swap" });
    link.onload = link.onerror = resolve;
    document.head.append(link);
  });
  await Promise.all(SCRIPT_FONTS.map(([f, w]) => document.fonts.load(`${w} 60px "${f}"`)));
});
const loadTextFont = lazy(async () => {
  const face = new FontFace(TEXT_FONT, `url(${CDN}dejavu-fonts-ttf@2.37.3/ttf/DejaVuSans.ttf)`);
  document.fonts.add(await face.load());
});

function trim(canvas) {
  const { width: w, height: ht } = canvas;
  const d = canvas.getContext("2d").getImageData(0, 0, w, ht).data;
  let x0 = w, y0 = ht, x1 = -1, y1 = -1;
  for (let y = 0; y < ht; y++) {
    for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3] > 10) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  const pad = 4;
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
  x1 = Math.min(w - 1, x1 + pad); y1 = Math.min(ht - 1, y1 + pad);
  const out = document.createElement("canvas");
  out.width = x1 - x0 + 1;
  out.height = y1 - y0 + 1;
  out.getContext("2d").drawImage(canvas, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return { url: out.toDataURL("image/png"), w: out.width, h: out.height };
}

function signatureDialog() {
  let ink = INKS.black;
  let font = SCRIPT_FONTS[0][0];
  let upload = null;
  const dlg = h("dialog", { class: "sig-dialog" });

  // Draw
  const pad = h("canvas", { class: "sig-pad", width: 1000, height: 320 });
  const pctx = pad.getContext("2d");
  let drawn = false;
  let last = null;
  const pt = (e) => {
    const r = pad.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * pad.width, y: ((e.clientY - r.top) / r.height) * pad.height };
  };
  pad.addEventListener("pointerdown", (e) => {
    try { pad.setPointerCapture(e.pointerId); } catch {}
    last = pt(e);
    pctx.beginPath();
    pctx.arc(last.x, last.y, 2.5, 0, Math.PI * 2);
    pctx.fillStyle = ink;
    pctx.fill();
    drawn = true;
  });
  pad.addEventListener("pointermove", (e) => {
    if (!last) return;
    const p = pt(e);
    const mid = { x: (last.x + p.x) / 2, y: (last.y + p.y) / 2 };
    pctx.strokeStyle = ink;
    pctx.lineWidth = 5;
    pctx.lineCap = pctx.lineJoin = "round";
    pctx.beginPath();
    pctx.moveTo(last.mid?.x ?? last.x, last.mid?.y ?? last.y);
    pctx.quadraticCurveTo(last.x, last.y, mid.x, mid.y);
    pctx.stroke();
    last = { ...p, mid };
  });
  const endStroke = () => { last = null; };
  pad.addEventListener("pointerup", endStroke);
  pad.addEventListener("pointercancel", endStroke);
  const clearPad = () => { pctx.clearRect(0, 0, pad.width, pad.height); drawn = false; };

  // Type
  const nameIn = h("input", { type: "text", class: "text-in", placeholder: "Type your name", maxlength: 60 });
  const fontList = h("div", { class: "font-list" });
  const renderFontList = () => {
    fontList.replaceChildren(...SCRIPT_FONTS.map(([f, w]) =>
      h("button", { type: "button", class: "font-opt", "aria-pressed": String(f === font), style: `font-family:"${f}";font-weight:${w};color:${ink}`, onclick: () => { font = f; renderFontList(); } },
        nameIn.value || "Your name")));
  };
  nameIn.addEventListener("input", renderFontList);

  // Upload
  const upIn = h("input", { type: "file", accept: "image/png,image/jpeg,image/webp" });
  const whiteOut = h("input", { type: "checkbox", checked: true });
  const upPreview = h("img", { class: "up-preview", alt: "" });
  upIn.addEventListener("change", () => { upload = upIn.files[0] || null; if (upload) upPreview.src = URL.createObjectURL(upload); });

  const panels = {
    draw: h("div", { class: "sig-panel" }, pad, h("div", { class: "tool-row" }, h("span", { class: "muted" }, "Sign with your mouse, finger or stylus"), h("button", { type: "button", class: "btn ghost small", onclick: clearPad }, "Clear"))),
    type: h("div", { class: "sig-panel", hidden: true }, nameIn, fontList),
    upload: h("div", { class: "sig-panel", hidden: true }, upIn, h("label", { class: "check" }, whiteOut, "Make white background transparent"), upPreview),
  };
  const tabs = segmented([["draw", "Draw"], ["type", "Type"], ["upload", "Upload"]], "draw", (v) => {
    for (const [k, p] of Object.entries(panels)) p.hidden = k !== v;
    if (v === "type") loadScriptFonts().then(renderFontList);
  });
  const inks = segmented([["black", "Black"], ["blue", "Blue"]], "black", (v) => { ink = INKS[v]; renderFontList(); });
  const err = h("p", { class: "tool-msg", "data-kind": "error" });
  const ok = h("button", { type: "button", class: "btn primary" }, "Add signature");
  const cancel = h("button", { type: "button", class: "btn ghost", onclick: () => dlg.close() }, "Cancel");
  dlg.append(h("h3", {}, "Create your signature"), tabs.el, ...Object.values(panels),
    h("div", { class: "tool-row" }, h("span", { class: "muted" }, "Ink"), inks.el),
    err, h("div", { class: "dlg-actions" }, cancel, ok));
  document.body.append(dlg);

  async function build() {
    const mode = tabs.value;
    if (mode === "draw") return drawn ? trim(pad) : null;
    if (mode === "type") {
      if (!nameIn.value.trim()) return null;
      await loadScriptFonts();
      const c = document.createElement("canvas");
      c.width = 1400; c.height = 360;
      const ctx = c.getContext("2d");
      const weight = SCRIPT_FONTS.find(([f]) => f === font)[1];
      ctx.font = `${weight} 150px "${font}"`;
      ctx.fillStyle = ink;
      ctx.textBaseline = "middle";
      ctx.fillText(nameIn.value.trim(), 40, 180, 1320);
      return trim(c);
    }
    if (!upload) return null;
    const bmp = await createImageBitmap(upload);
    const k = Math.min(1, 1200 / bmp.width);
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    const ctx = c.getContext("2d");
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    if (whiteOut.checked) {
      const id = ctx.getImageData(0, 0, c.width, c.height);
      const d = id.data;
      for (let i = 0; i < d.length; i += 4) {
        const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        if (lum > 215) d[i + 3] = 0;
        else if (lum > 170) d[i + 3] = Math.round(d[i + 3] * (215 - lum) / 45);
      }
      ctx.putImageData(id, 0, 0);
    }
    return trim(c);
  }

  return {
    open() {
      err.textContent = "";
      clearPad();
      dlg.showModal();
      return new Promise((resolve) => {
        ok.onclick = async () => {
          const sig = await build();
          if (!sig) { err.textContent = tabs.value === "draw" ? "Draw your signature first." : tabs.value === "type" ? "Type your name first." : "Choose an image first."; return; }
          resolve(sig);
          dlg.close();
        };
        dlg.onclose = () => resolve(null);
      });
    },
  };
}

export default {
  id: "sign",
  title: "Sign & add text",
  desc: "Sign a PDF, or type text and dates anywhere on its pages.",
  icon: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4 12.5-12.5z"/>',
  mount(root) {
    let state = null;
    let items = [];
    const sigs = [];
    let dialog = null;
    const status = statusBar();
    const viewer = h("div", { class: "viewer" });
    const tray = h("div", { class: "sig-tray" });
    const bar = h("div", { class: "sign-bar", hidden: true },
      h("button", { class: "btn ghost", onclick: newSignature }, "✍︎ Signature"),
      h("button", { class: "btn ghost", onclick: () => addText("") }, "T  Text"),
      h("button", { class: "btn ghost", onclick: () => addText(new Date().toLocaleDateString()) }, "Date"),
      tray);
    const info = h("p", { class: "tool-file", hidden: true });
    const go = h("button", { class: "btn primary", disabled: true, onclick: save }, "Save signed PDF");
    const pick = picker({ multiple: false, label: "Choose a PDF", onFiles: addFiles });
    const hint = h("p", { class: "tool-hint", hidden: true }, "Drag to move · corner handle to resize · click text to edit");
    root.append(pick.el, info, bar, hint, viewer, h("div", { class: "tool-actions sticky" }, status.el, go));

    document.addEventListener("pointerdown", (e) => {
      if (!e.target.closest?.(".ov")) for (const it of items) it.el.classList.remove("sel");
    });

    const update = () => { go.disabled = !state || !items.length; };

    async function addFiles(files) {
      const file = files.find(isPdf);
      if (!file) return status.set("Please choose a PDF file.", "error");
      viewer.replaceChildren();
      items = [];
      state = null;
      update();
      status.set("Opening…");
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const { pdf, close } = await openPdfjs(bytes);
        info.textContent = `${file.name} · ${pdf.numPages} page${pdf.numPages === 1 ? "" : "s"} · ${formatBytes(file.size)}`;
        info.hidden = bar.hidden = hint.hidden = false;
        loadTextFont();
        try {
          const pages = await pageViewer(viewer, pdf);
          state = { bytes, name: file.name, pages };
        } finally {
          close();
        }
        status.set("");
      } catch (e) {
        status.fail(e);
      }
      update();
    }

    function visiblePage() {
      let best = state.pages[0];
      let bestVis = -Infinity;
      for (const p of state.pages) {
        const r = p.el.getBoundingClientRect();
        const vis = Math.min(r.bottom, innerHeight) - Math.max(r.top, 0);
        if (vis > bestVis) { bestVis = vis; best = p; }
      }
      return best;
    }

    function spot(page, w, ht) {
      const r = page.el.getBoundingClientRect();
      const vw = page.viewport.width;
      const vh = page.viewport.height;
      const y = Math.min(Math.max(innerHeight / 2 - r.top - ht / 2, 8), vh - ht - 8);
      return { x: (vw - w) / 2, y: Math.max(0, y) };
    }

    async function newSignature() {
      if (!state) return;
      dialog ??= signatureDialog();
      const sig = await dialog.open();
      if (!sig) return;
      sigs.push(sig);
      tray.append(h("button", { class: "sig-chip", title: "Place this signature", onclick: () => placeSig(sig) }, h("img", { src: sig.url, alt: "Saved signature" })));
      placeSig(sig);
    }

    function placeSig(sig) {
      const page = visiblePage();
      const w = Math.min(page.viewport.width * 0.32, 220);
      const ht = (w * sig.h) / sig.w;
      addItem({ type: "image", page, src: sig.url, w, h: ht, ...spot(page, w, ht) });
    }

    async function addText(text) {
      if (!state) return;
      await loadTextFont();
      const page = visiblePage();
      const it = addItem({ type: "text", page, text, fontSize: 16, ...spot(page, 160, 24) });
      if (!text) it.focusText();
    }

    function addItem(it) {
      const del = h("button", { class: "ov-del", type: "button", "aria-label": "Remove", onclick: () => remove(it) }, "×");
      const handle = h("span", { class: "ov-handle", "aria-hidden": "true" });
      let content;
      if (it.type === "image") content = h("img", { src: it.src, alt: "Signature", draggable: "false" });
      else {
        content = h("div", { class: "ov-text", contenteditable: "plaintext-only", spellcheck: "false", "data-placeholder": "Type here" });
        content.textContent = it.text;
        content.style.fontFamily = `"${TEXT_FONT}", sans-serif`;
        content.addEventListener("blur", () => { if (!content.textContent.trim()) remove(it); });
        content.addEventListener("input", () => clampInPage(it));
        it.textEl = content;
        it.focusText = () => {
          content.focus();
          const sel = getSelection();
          sel.selectAllChildren(content);
          sel.collapseToEnd();
        };
      }
      it.el = h("div", { class: `ov is-${it.type}`, tabindex: "0" }, content, del, handle);
      it.page.el.append(it.el);
      items.push(it);
      layout(it);
      select(it);
      bindDrag(it, handle);
      it.el.addEventListener("keydown", (e) => {
        if (e.target !== it.el) return;
        if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); remove(it); }
        const step = e.shiftKey ? 10 : 1;
        const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
        if (moves[e.key]) { e.preventDefault(); it.x += moves[e.key][0]; it.y += moves[e.key][1]; clampInPage(it); }
      });
      update();
      return it;
    }

    function layout(it) {
      Object.assign(it.el.style, { left: `${it.x}px`, top: `${it.y}px` });
      if (it.type === "image") Object.assign(it.el.style, { width: `${it.w}px`, height: `${it.h}px` });
      else it.textEl.style.fontSize = `${it.fontSize}px`;
    }

    function clampInPage(it) {
      const w = it.type === "image" ? it.w : it.el.offsetWidth;
      const ht = it.type === "image" ? it.h : it.el.offsetHeight;
      it.x = Math.min(Math.max(0, it.x), Math.max(0, it.page.viewport.width - w));
      it.y = Math.min(Math.max(0, it.y), Math.max(0, it.page.viewport.height - ht));
      layout(it);
    }

    function select(it) {
      for (const o of items) o.el.classList.toggle("sel", o === it);
    }

    function remove(it) {
      it.el.remove();
      items = items.filter((o) => o !== it);
      update();
    }

    function bindDrag(it, handle) {
      it.el.addEventListener("pointerdown", (e) => {
        if (e.target.closest(".ov-del")) return;
        const resizing = e.target === handle;
        if (!resizing && it.textEl && document.activeElement === it.textEl) return;
        e.preventDefault();
        select(it);
        try { it.el.setPointerCapture(e.pointerId); } catch {}
        const start = { x: e.clientX, y: e.clientY, ix: it.x, iy: it.y, iw: it.w, ih: it.h, fs: it.fontSize };
        let moved = false;
        const move = (ev) => {
          const dx = ev.clientX - start.x;
          const dy = ev.clientY - start.y;
          if (!moved && Math.hypot(dx, dy) < 3) return;
          moved = true;
          if (resizing && it.type === "image") {
            it.w = Math.max(24, Math.min(start.iw + dx, it.page.viewport.width - it.x));
            it.h = (it.w * start.ih) / start.iw;
          } else if (resizing) {
            it.fontSize = Math.max(6, Math.min(96, start.fs * (1 + dx / 120)));
          } else {
            it.x = start.ix + dx;
            it.y = start.iy + dy;
          }
          clampInPage(it);
        };
        const up = () => {
          it.el.removeEventListener("pointermove", move);
          it.el.removeEventListener("pointerup", up);
          it.el.removeEventListener("pointercancel", up);
          if (!moved && !resizing && it.textEl) it.focusText();
          else if (!moved) it.el.focus();
        };
        it.el.addEventListener("pointermove", move);
        it.el.addEventListener("pointerup", up);
        it.el.addEventListener("pointercancel", up);
      });
    }

    async function save() {
      go.disabled = true;
      status.set("Saving…");
      try {
        const { degrees, rgb } = await getPdfLib();
        const doc = await openPdfLib(state.bytes);
        const pages = doc.getPages();
        const images = new Map();
        let text = null;
        for (const it of items) {
          const vp = it.page.viewport;
          const s = vp.scale;
          const page = pages[it.page.n - 1];
          const rotate = degrees(it.page.rotation);
          if (it.type === "image") {
            if (!images.has(it.src)) images.set(it.src, await doc.embedPng(await (await fetch(it.src)).arrayBuffer()));
            // Anchor at the box's on-screen bottom-left; rotating by the page's /Rotate keeps it upright.
            const [x, y] = vp.convertToPdfPoint(it.x, it.y + it.h);
            page.drawImage(images.get(it.src), { x, y, width: it.w / s, height: it.h / s, rotate });
          } else {
            const value = it.textEl.innerText.replace(/\n$/, "");
            if (!value.trim()) continue;
            text ??= await embedUnicodeFont(doc);
            text.clean(value).split("\n").forEach((line, i) => {
              const [x, y] = vp.convertToPdfPoint(it.x + PAD, it.y + PAD + it.fontSize * (BASELINE + i * LINE));
              page.drawText(line, { x, y, size: it.fontSize / s, font: text.font, color: rgb(0.07, 0.09, 0.15), rotate });
            });
          }
        }
        const bytes = await doc.save({ useObjectStreams: true });
        const name = `${stem(state.name)}-signed.pdf`;
        downloadBlob(pdfBlob(bytes), name);
        status.set(`Done · downloaded ${name}`, "ok");
      } catch (e) {
        status.fail(e);
      }
      update();
    }

    return { addFiles };
  },
};
