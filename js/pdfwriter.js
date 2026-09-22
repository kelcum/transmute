import { CDN, lazy } from "./util.js";

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 56;
const CONTENT_W = PAGE_W - MARGIN * 2;
const FONT_URL = CDN + "dejavu-fonts-ttf@2.37.3/ttf/";

const libs = lazy(async () => {
  const [PDFLib, fontkit, ...fonts] = await Promise.all([
    import(CDN + "pdf-lib@1.17.1/dist/pdf-lib.esm.min.js"),
    import(CDN + "@pdf-lib/fontkit@1.1.1/+esm").then((m) => m.default),
    ...["DejaVuSans.ttf", "DejaVuSans-Bold.ttf", "DejaVuSans-Oblique.ttf", "DejaVuSans-BoldOblique.ttf", "DejaVuSansMono.ttf"].map((f) =>
      fetch(FONT_URL + f).then((r) => r.arrayBuffer())
    ),
  ]);
  return { PDFLib, fontkit, fonts };
});

const SKIP = new Set(["SCRIPT", "STYLE", "HEAD", "NOSCRIPT", "TEMPLATE", "TITLE", "META", "LINK", "SVG"]);
const BLOCK = new Set(["P", "DIV", "SECTION", "ARTICLE", "HEADER", "FOOTER", "MAIN", "NAV", "ASIDE", "FIGURE", "FIGCAPTION",
  "H1", "H2", "H3", "H4", "H5", "H6", "UL", "OL", "LI", "PRE", "BLOCKQUOTE", "TABLE", "HR", "IMG", "DL", "DT", "DD", "BODY", "CENTER", "ADDRESS"]);

function hasBlockChild(el) {
  for (const c of el.children) if (BLOCK.has(c.tagName) || hasBlockChild(c)) return true;
  return false;
}

function inlineRuns(node, style, out) {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent.replace(/\s+/g, " ");
    if (text) out.push({ text, ...style });
    return out;
  }
  if (node.nodeType !== Node.ELEMENT_NODE || SKIP.has(node.tagName)) return out;
  const t = node.tagName;
  if (t === "BR") { out.push({ text: "\n", ...style }); return out; }
  if (t === "IMG") return out;
  const s = { ...style };
  if (t === "B" || t === "STRONG" || t === "TH") s.bold = true;
  if (t === "I" || t === "EM" || t === "CITE") s.italic = true;
  if (t === "CODE" || t === "KBD" || t === "SAMP" || t === "TT") s.code = true;
  if (t === "A" && node.getAttribute("href")) s.link = true;
  for (const c of node.childNodes) inlineRuns(c, s, out);
  return out;
}

function collectBlocks(root) {
  const blocks = [];
  const walk = (container, ctx) => {
    let pending = [];
    const flush = () => {
      if (pending.some((r) => r.text.trim())) blocks.push({ type: "p", runs: pending, ...ctx });
      pending = [];
    };
    for (const node of container.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) { inlineRuns(node, {}, pending); continue; }
      if (node.nodeType !== Node.ELEMENT_NODE || SKIP.has(node.tagName)) continue;
      const t = node.tagName;
      if (/^H[1-6]$/.test(t)) { flush(); blocks.push({ type: "h", level: +t[1], runs: inlineRuns(node, { bold: true }, []), ...ctx }); }
      else if (t === "P" || t === "DT" || t === "FIGCAPTION" || ((t === "DIV" || t === "DD") && !hasBlockChild(node))) {
        flush();
        const runs = inlineRuns(node, t === "DT" ? { bold: true } : {}, []);
        if (runs.some((r) => r.text.trim())) blocks.push({ type: "p", runs, ...ctx });
        for (const img of node.querySelectorAll("img")) blocks.push({ type: "img", src: img.getAttribute("src"), ...ctx });
      }
      else if (t === "UL" || t === "OL") {
        flush();
        let n = +(node.getAttribute("start") || 1);
        for (const li of node.children) {
          if (li.tagName !== "LI") continue;
          const marker = t === "OL" ? `${n++}.` : "•";
          const runs = [];
          const nested = [];
          for (const c of li.childNodes) {
            if (c.nodeType === Node.ELEMENT_NODE && (c.tagName === "UL" || c.tagName === "OL" || c.tagName === "PRE" || c.tagName === "TABLE")) nested.push(c);
            else inlineRuns(c, {}, runs);
          }
          blocks.push({ type: "li", marker, runs, ...ctx, depth: (ctx.depth || 0) + 1 });
          for (const c of nested) {
            const wrapper = document.createElement("div");
            wrapper.appendChild(c.cloneNode(true));
            walk(wrapper, { ...ctx, depth: (ctx.depth || 0) + 1 });
          }
        }
      }
      else if (t === "PRE") { flush(); blocks.push({ type: "code", text: node.textContent.replace(/\n$/, ""), ...ctx }); }
      else if (t === "BLOCKQUOTE") { flush(); walk(node, { ...ctx, quote: (ctx.quote || 0) + 1 }); }
      else if (t === "TABLE") {
        flush();
        const rows = [...node.querySelectorAll("tr")].map((tr) => [...tr.cells].map((c) => c.textContent.replace(/\s+/g, " ").trim()));
        if (rows.length) blocks.push({ type: "table", rows, header: !!node.querySelector("tr th"), ...ctx });
      }
      else if (t === "HR") { flush(); blocks.push({ type: "hr", ...ctx }); }
      else if (t === "IMG") { flush(); blocks.push({ type: "img", src: node.getAttribute("src"), ...ctx }); }
      else if (BLOCK.has(t) || hasBlockChild(node)) { flush(); walk(node, ctx); }
      else inlineRuns(node, {}, pending);
    }
    flush();
  };
  walk(root, {});
  return blocks;
}

async function imageBytes(src) {
  if (!src) return null;
  try {
    const blob = await (await fetch(src)).blob();
    if (blob.type === "image/jpeg" || blob.type === "image/png") return { bytes: new Uint8Array(await blob.arrayBuffer()), type: blob.type };
    const bmp = await createImageBitmap(blob);
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    c.getContext("2d").drawImage(bmp, 0, 0);
    return { bytes: new Uint8Array(await (await c.convertToBlob({ type: "image/png" })).arrayBuffer()), type: "image/png" };
  } catch {
    return null;
  }
}

export async function htmlToPdf(html, title) {
  const { PDFLib, fontkit, fonts } = await libs();
  const { PDFDocument, rgb } = PDFLib;
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  if (title) doc.setTitle(title);
  const [regular, bold, italic, boldItalic, mono] = await Promise.all(fonts.map((f) => doc.embedFont(new Uint8Array(f), { subset: true })));
  const charsets = new Map([regular, bold, italic, boldItalic, mono].map((f) => [f, new Set(f.getCharacterSet())]));

  const pick = (r) => (r.code ? mono : r.bold && r.italic ? boldItalic : r.bold ? bold : r.italic ? italic : regular);
  const clean = (text, font) => {
    const cs = charsets.get(font);
    let out = "";
    for (const ch of text.replace(/\t/g, "    ").replace(/[\r\u0000-\u0008\u000b-\u001f]/g, "")) out += ch === "\n" || cs.has(ch.codePointAt(0)) ? ch : "?";
    return out;
  };
  const TEXT = rgb(0.1, 0.1, 0.12);
  const MUTED = rgb(0.45, 0.45, 0.5);
  const LINK = rgb(0.1, 0.33, 0.8);
  const RULE = rgb(0.85, 0.85, 0.88);

  let page, y;
  const newPage = () => { page = doc.addPage([PAGE_W, PAGE_H]); y = PAGE_H - MARGIN; };
  const ensure = (h) => { if (y - h < MARGIN) newPage(); };
  newPage();

  // Word-wraps styled runs into the content column, drawing as it goes.
  const flow = (runs, { size, indent = 0, marker = null, quote = 0 }) => {
    const x0 = MARGIN + indent + quote * 14;
    const maxW = CONTENT_W - indent - quote * 14;
    const lh = size * 1.45;
    const tokens = [];
    for (const r of runs) {
      const font = pick(r);
      for (const part of clean(r.text, font).split(/(\n| +)/)) {
        if (!part) continue;
        tokens.push({ text: part, font, run: r, w: part === "\n" ? 0 : font.widthOfTextAtSize(part, size) });
      }
    }
    let line = [];
    let lineW = 0;
    let first = true;
    const emit = () => {
      while (line.length && line[line.length - 1].text.trim() === "") line.pop();
      ensure(lh);
      y -= lh;
      const base = y + lh * 0.28;
      if (first && marker) page.drawText(clean(marker, regular), { x: x0 - 16, y: base, size, font: regular, color: TEXT });
      for (let q = 0; q < quote; q++) page.drawLine({ start: { x: MARGIN + q * 14 + 3, y }, end: { x: MARGIN + q * 14 + 3, y: y + lh }, thickness: 2, color: RULE });
      let x = x0;
      for (const t of line) {
        page.drawText(t.text, { x, y: base, size, font: t.font, color: t.run.link ? LINK : quote ? MUTED : TEXT });
        x += t.w;
      }
      first = false;
      line = [];
      lineW = 0;
    };
    for (const tok of tokens) {
      if (tok.text === "\n") { emit(); continue; }
      const isSpace = tok.text.trim() === "";
      if (isSpace && !line.length) continue;
      if (lineW + tok.w > maxW && line.length && !isSpace) emit();
      if (tok.w > maxW) {
        let chunk = "";
        for (const ch of tok.text) {
          const w = tok.font.widthOfTextAtSize(chunk + ch, size);
          if (w > maxW - lineW && (chunk || line.length)) {
            if (chunk) line.push({ ...tok, text: chunk, w: tok.font.widthOfTextAtSize(chunk, size) });
            emit();
            chunk = "";
          }
          chunk += ch;
        }
        if (chunk) { const w = tok.font.widthOfTextAtSize(chunk, size); line.push({ ...tok, text: chunk, w }); lineW += w; }
        continue;
      }
      line.push(tok);
      lineW += tok.w;
    }
    if (line.length || first) emit();
  };

  const blocks = collectBlocks(new DOMParser().parseFromString(html, "text/html").body);
  const HEAD = { 1: 22, 2: 18, 3: 15, 4: 13, 5: 12, 6: 11 };

  for (const b of blocks) {
    const quote = b.quote || 0;
    const depth = b.depth || 0;
    if (b.type === "h") {
      const size = HEAD[b.level];
      ensure(size * 3);
      y -= size * 0.7;
      flow(b.runs, { size, quote });
      y -= size * 0.25;
    } else if (b.type === "p") {
      flow(b.runs, { size: 11, quote, indent: depth * 18 });
      y -= 6;
    } else if (b.type === "li") {
      flow(b.runs.length ? b.runs : [{ text: " " }], { size: 11, quote, indent: depth * 18, marker: b.marker });
      y -= 2;
    } else if (b.type === "code") {
      const size = 9;
      const lh = size * 1.5;
      const x0 = MARGIN + depth * 18 + quote * 14;
      const maxChars = Math.max(10, Math.floor((CONTENT_W - (x0 - MARGIN) - 12) / mono.widthOfTextAtSize("M", size)));
      y -= 4;
      for (const raw of clean(b.text, mono).split("\n")) {
        const pieces = raw.length ? raw.match(new RegExp(`.{1,${maxChars}}`, "g")) : [""];
        for (const piece of pieces) {
          ensure(lh);
          y -= lh;
          page.drawRectangle({ x: x0, y, width: PAGE_W - MARGIN - x0, height: lh, color: rgb(0.955, 0.955, 0.965) });
          page.drawText(piece, { x: x0 + 6, y: y + lh * 0.3, size, font: mono, color: TEXT });
        }
      }
      y -= 10;
    } else if (b.type === "hr") {
      ensure(16);
      y -= 8;
      page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_W - MARGIN, y }, thickness: 1, color: RULE });
      y -= 8;
    } else if (b.type === "img") {
      const img = await imageBytes(b.src);
      if (!img) continue;
      const embedded = img.type === "image/png" ? await doc.embedPng(img.bytes) : await doc.embedJpg(img.bytes);
      const k = Math.min(1, CONTENT_W / embedded.width, (PAGE_H * 0.6) / embedded.height);
      const w = embedded.width * k;
      const h = embedded.height * k;
      ensure(h + 8);
      y -= h;
      page.drawImage(embedded, { x: MARGIN, y, width: w, height: h });
      y -= 8;
    } else if (b.type === "table") {
      const cols = Math.max(...b.rows.map((r) => r.length));
      const size = cols > 6 ? 7.5 : 9;
      const colW = CONTENT_W / cols;
      const lh = size * 1.35;
      y -= 4;
      b.rows.forEach((row, ri) => {
        const isHead = b.header && ri === 0;
        const font = isHead ? bold : regular;
        const cells = Array.from({ length: cols }, (_, ci) => {
          const words = clean(row[ci] || "", font).split(" ");
          const lines = [];
          let cur = "";
          for (const w of words) {
            const next = cur ? cur + " " + w : w;
            if (font.widthOfTextAtSize(next, size) > colW - 8 && cur) { lines.push(cur); cur = w; }
            else cur = next;
          }
          lines.push(cur);
          return lines.map((l) => {
            while (l && font.widthOfTextAtSize(l, size) > colW - 8) l = l.slice(0, -1);
            return l;
          });
        });
        const rowH = Math.max(...cells.map((c) => c.length)) * lh + 6;
        ensure(rowH);
        y -= rowH;
        cells.forEach((lines, ci) => {
          const x = MARGIN + ci * colW;
          page.drawRectangle({ x, y, width: colW, height: rowH, borderColor: RULE, borderWidth: 0.75, color: isHead ? rgb(0.95, 0.95, 0.97) : undefined });
          lines.forEach((l, li) => page.drawText(l, { x: x + 4, y: y + rowH - 3 - lh * (li + 1) + lh * 0.3, size, font, color: TEXT }));
        });
      });
      y -= 10;
    }
  }
  return new Blob([await doc.save()], { type: "application/pdf" });
}
