import { CDN, lazy, loadScript, classicWorkerURL, makeCanvas, UserError } from "../util.js";

const INPUTS = ["png", "jpg", "webp", "gif", "bmp", "ico", "tiff", "avif", "svg", "heic"];
const OUTPUTS = ["png", "jpg", "webp", "gif", "bmp", "ico", "tiff", "pdf"];

const heicLib = lazy(() => import(CDN + "heic-to@1.5.2/dist/heic-to.js"));
const utifLib = lazy(async () => { const m = await import(CDN + "utif2@4.1.0/+esm"); return m.default || m; });
const pdfLib = lazy(() => import(CDN + "pdf-lib@1.17.1/dist/pdf-lib.esm.min.js"));
const gifLib = lazy(async () => {
  await loadScript(CDN + "gif.js@0.2.0/dist/gif.js");
  return classicWorkerURL(CDN + "gif.js@0.2.0/dist/gif.worker.js");
});

async function viaImageElement(blob) {
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.src = url;
  try {
    await img.decode();
  } catch {
    URL.revokeObjectURL(url);
    throw new UserError("This image couldn't be read. It may be corrupted or use an unsupported variant.");
  }
  return { source: img, width: img.naturalWidth, height: img.naturalHeight, cleanup: () => URL.revokeObjectURL(url) };
}

async function viaBitmap(blob) {
  const b = await createImageBitmap(blob);
  return { source: b, width: b.width, height: b.height, cleanup: () => b.close() };
}

export async function decodeImage(file, ext, status) {
  if (ext === "heic") {
    status("Loading HEIC decoder…");
    const { heicTo } = await heicLib();
    status("Decoding HEIC…");
    return viaBitmap(await heicTo({ blob: file, type: "image/png" }));
  }
  if (ext === "tiff") {
    const UTIF = await utifLib();
    const buf = await file.arrayBuffer();
    const ifds = UTIF.decode(buf);
    if (!ifds.length) throw new UserError("No image found in this TIFF.");
    UTIF.decodeImage(buf, ifds[0]);
    const rgba = UTIF.toRGBA8(ifds[0]);
    const { width, height } = ifds[0];
    const [c, ctx] = makeCanvas(width, height);
    ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, width * height * 4), width, height), 0, 0);
    return { source: c, width, height, cleanup() {} };
  }
  if (ext === "svg") {
    const r = await viaImageElement(file);
    if (!r.width || !r.height) { r.width = 1024; r.height = 1024; }
    return r;
  }
  try {
    return await viaBitmap(file);
  } catch {
    return viaImageElement(file);
  }
}

function fitSize(w, h, opts) {
  const mw = +opts.width || 0, mh = +opts.height || 0;
  if (!mw && !mh) return [w, h];
  const s = mw && mh ? Math.min(mw / w, mh / h) : mw ? mw / w : mh / h;
  return [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))];
}

function encodeBmp({ width: w, height: h, data }) {
  const row = Math.ceil((w * 3) / 4) * 4;
  const size = 54 + row * h;
  const buf = new ArrayBuffer(size);
  const dv = new DataView(buf);
  dv.setUint16(0, 0x4d42, true);
  dv.setUint32(2, size, true);
  dv.setUint32(10, 54, true);
  dv.setUint32(14, 40, true);
  dv.setInt32(18, w, true);
  dv.setInt32(22, h, true);
  dv.setUint16(26, 1, true);
  dv.setUint16(28, 24, true);
  dv.setUint32(34, row * h, true);
  dv.setInt32(38, 2835, true);
  dv.setInt32(42, 2835, true);
  const px = new Uint8Array(buf);
  for (let y = 0; y < h; y++) {
    let o = 54 + (h - 1 - y) * row;
    for (let x = 0, i = y * w * 4; x < w; x++, i += 4) {
      px[o++] = data[i + 2];
      px[o++] = data[i + 1];
      px[o++] = data[i];
    }
  }
  return new Blob([buf], { type: "image/bmp" });
}

async function encodeIco(img, opts) {
  const requested = +opts.width || +opts.height;
  const sizes = requested ? [Math.min(256, requested)] : [16, 32, 48, 64, 128, 256];
  const pngs = [];
  for (const s of sizes) {
    const [c, ctx] = makeCanvas(s, s);
    ctx.imageSmoothingQuality = "high";
    const k = Math.min(s / img.width, s / img.height);
    const w = img.width * k, h = img.height * k;
    ctx.drawImage(img.source, (s - w) / 2, (s - h) / 2, w, h);
    pngs.push(new Uint8Array(await (await c.convertToBlob({ type: "image/png" })).arrayBuffer()));
  }
  const header = new DataView(new ArrayBuffer(6 + 16 * sizes.length));
  header.setUint16(2, 1, true);
  header.setUint16(4, sizes.length, true);
  let offset = header.byteLength;
  sizes.forEach((s, i) => {
    const e = 6 + i * 16;
    header.setUint8(e, s >= 256 ? 0 : s);
    header.setUint8(e + 1, s >= 256 ? 0 : s);
    header.setUint16(e + 4, 1, true);
    header.setUint16(e + 6, 32, true);
    header.setUint32(e + 8, pngs[i].length, true);
    header.setUint32(e + 12, offset, true);
    offset += pngs[i].length;
  });
  return new Blob([header.buffer, ...pngs], { type: "image/x-icon" });
}

// GIF has no alpha channel, only one "transparent" palette entry, so removed
// pixels are painted with a rare key color that gif.js maps to that entry.
const GIF_KEY = [255, 0, 220];
async function encodeGif(imageData) {
  const workerScript = await gifLib();
  const d = imageData.data;
  let transparent = null;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 128) {
      d[i] = GIF_KEY[0]; d[i + 1] = GIF_KEY[1]; d[i + 2] = GIF_KEY[2];
      transparent = 0xff00dc;
    }
    d[i + 3] = 255;
  }
  return new Promise((resolve, reject) => {
    const gif = new window.GIF({ workers: 2, quality: 10, workerScript, width: imageData.width, height: imageData.height, transparent });
    gif.on("finished", resolve);
    gif.on("abort", () => reject(new Error("GIF encoding aborted")));
    gif.addFrame(imageData, { delay: 100 });
    gif.render();
  });
}

async function encodePdf(canvas, keepAlpha) {
  const { PDFDocument } = await pdfLib();
  const doc = await PDFDocument.create();
  const blob = await canvas.convertToBlob(keepAlpha ? { type: "image/png" } : { type: "image/jpeg", quality: 0.92 });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const embedded = keepAlpha ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
  const page = doc.addPage([canvas.width, canvas.height]);
  page.drawImage(embedded, { x: 0, y: 0, width: canvas.width, height: canvas.height });
  return new Blob([await doc.save()], { type: "application/pdf" });
}

export default {
  id: "image",
  outputs(inExt) {
    return INPUTS.includes(inExt) ? OUTPUTS : [];
  },
  async convert({ file, inExt, outExt, opts, status, base }) {
    const o = opts.image;
    const img = await decodeImage(file, inExt, status);
    status("Converting…");
    try {
      if (outExt === "ico") return [{ name: `${base}.ico`, blob: await encodeIco(img, o) }];

      const [w, h] = fitSize(img.width, img.height, o);
      const [canvas, ctx] = makeCanvas(w, h);
      const opaque = outExt === "jpg" || outExt === "bmp" || (outExt === "pdf" && ["jpg", "heic", "bmp"].includes(inExt));
      if (opaque) {
        ctx.fillStyle = o.background || "#ffffff";
        ctx.fillRect(0, 0, w, h);
      }
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img.source, 0, 0, w, h);

      let blob;
      switch (outExt) {
        case "png": blob = await canvas.convertToBlob({ type: "image/png" }); break;
        case "jpg": blob = await canvas.convertToBlob({ type: "image/jpeg", quality: +o.quality }); break;
        case "webp": blob = await canvas.convertToBlob({ type: "image/webp", quality: +o.quality }); break;
        case "bmp": blob = encodeBmp(ctx.getImageData(0, 0, w, h)); break;
        case "gif": blob = await encodeGif(ctx.getImageData(0, 0, w, h)); break;
        case "tiff": {
          const UTIF = await utifLib();
          blob = new Blob([UTIF.encodeImage(ctx.getImageData(0, 0, w, h).data.buffer, w, h)], { type: "image/tiff" });
          break;
        }
        case "pdf": blob = await encodePdf(canvas, !opaque); break;
      }
      return [{ name: `${base}.${outExt}`, blob }];
    } finally {
      img.cleanup();
    }
  },
};
