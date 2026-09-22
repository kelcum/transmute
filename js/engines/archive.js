import { getFflate, UserError } from "../util.js";
import { FORMATS } from "../formats.js";

const TYPES = ["zip", "tar", "tar.gz"];
const enc = new TextEncoder();
const dec = new TextDecoder();

const cb = (fn, ...args) => new Promise((res, rej) => fn(...args, (err, out) => (err ? rej(err) : res(out))));

function readTar(buf) {
  const entries = [];
  let off = 0;
  let longName = null;
  let paxPath = null;
  const str = (a, b) => dec.decode(buf.subarray(a, b)).replace(/\0.*$/s, "");
  while (off + 512 <= buf.length) {
    if (buf.subarray(off, off + 512).every((b) => b === 0)) break;
    const size = parseInt(str(off + 124, off + 136).trim() || "0", 8);
    const type = String.fromCharCode(buf[off + 156] || 48);
    const prefix = str(off + 345, off + 500);
    let name = str(off, off + 100);
    if (prefix && str(off + 257, off + 263).startsWith("ustar")) name = `${prefix}/${name}`;
    const data = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === "L") { longName = dec.decode(data).replace(/\0.*$/s, ""); continue; }
    if (type === "x") {
      const m = dec.decode(data).match(/\d+ path=([^\n]*)\n/);
      if (m) paxPath = m[1];
      continue;
    }
    if (type === "g") continue;
    name = paxPath || longName || name;
    paxPath = longName = null;
    if (type === "5" || name.endsWith("/")) entries.push({ name: name.replace(/\/?$/, "/"), data: new Uint8Array(0), dir: true });
    else if (type === "0" || type === "\0" || type === "7") entries.push({ name, data: data.slice() });
  }
  return entries;
}

function tarHeader(name, size, dir) {
  const h = new Uint8Array(512);
  const put = (s, off, len) => h.set(enc.encode(s).subarray(0, len), off);
  const oct = (n, len) => n.toString(8).padStart(len - 1, "0") + "\0";
  put(name, 0, 100);
  put(oct(dir ? 0o755 : 0o644, 8), 100, 8);
  put(oct(0, 8), 108, 8);
  put(oct(0, 8), 116, 8);
  put(oct(size, 12), 124, 12);
  put(oct(Math.floor(Date.now() / 1000), 12), 136, 12);
  h.fill(32, 148, 156);
  h[156] = dir ? 53 : 48;
  put("ustar\0" + "00", 257, 8);
  let sum = 0;
  for (const b of h) sum += b;
  put(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
  return h;
}

function writeTar(entries) {
  const parts = [];
  for (const e of entries) {
    const nameBytes = enc.encode(e.name);
    if (nameBytes.length > 99) {
      const rec = ` path=${e.name}\n`;
      let len = rec.length + 1;
      while (String(len).length + enc.encode(rec).length !== len) len = String(len).length + enc.encode(rec).length;
      const pax = enc.encode(`${len}${rec}`);
      const hdr = tarHeader("PaxHeader", pax.length, false);
      hdr[156] = 120;
      let sum = 0;
      hdr.fill(32, 148, 156);
      for (const b of hdr) sum += b;
      hdr.set(enc.encode(sum.toString(8).padStart(6, "0") + "\0 "), 148);
      parts.push(hdr, pax, new Uint8Array((512 - (pax.length % 512)) % 512));
    }
    parts.push(tarHeader(e.name.slice(0, 99), e.data.length, e.dir));
    parts.push(e.data, new Uint8Array((512 - (e.data.length % 512)) % 512));
  }
  parts.push(new Uint8Array(1024));
  return parts;
}

export default {
  id: "archive",
  outputs(inExt) {
    return TYPES.includes(inExt) ? TYPES.filter((t) => t !== inExt) : [];
  },
  async convert({ file, inExt, outExt, base, status }) {
    const fflate = await getFflate();
    let buf = new Uint8Array(await file.arrayBuffer());
    status("Reading archive…");
    let entries;
    try {
      if (inExt === "zip") {
        const files = await cb(fflate.unzip, buf);
        entries = Object.entries(files).map(([name, data]) => ({ name, data, dir: name.endsWith("/") }));
      } else {
        if (inExt === "tar.gz") buf = await cb(fflate.gunzip, buf);
        entries = readTar(buf);
      }
    } catch {
      throw new UserError("This archive couldn't be read. It may be damaged or encrypted.");
    }
    status("Writing archive…");
    let out;
    if (outExt === "zip") {
      const tree = {};
      for (const e of entries) if (!e.dir) tree[e.name] = [e.data, { level: 6 }];
      out = await cb(fflate.zip, tree);
    } else {
      const tarParts = writeTar(entries);
      out = outExt === "tar.gz" ? await cb(fflate.gzip, new Uint8Array(await new Blob(tarParts).arrayBuffer()), { level: 6 }) : tarParts;
    }
    return [{ name: `${base}.${outExt}`, blob: new Blob(Array.isArray(out) ? out : [out], { type: FORMATS[outExt].mime }) }];
  },
};
