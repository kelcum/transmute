export const CDN = "https://cdn.jsdelivr.net/npm/";

export class UserError extends Error {}

// Memoizes an async loader, but forgets a failed attempt so it can be retried.
export function lazy(loader) {
  let p = null;
  const get = () => (p ??= loader().catch((e) => { p = null; throw e; }));
  get.reset = () => { p = null; };
  return get;
}

const scripts = new Map();
export function loadScript(url) {
  if (!scripts.has(url)) {
    scripts.set(url, new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = url;
      s.onload = resolve;
      s.onerror = () => { scripts.delete(url); reject(new Error("Failed to load " + url)); };
      document.head.appendChild(s);
    }));
  }
  return scripts.get(url);
}

// Workers can't be constructed from a cross-origin URL, but a same-origin
// blob module that imports the CDN script can.
export function moduleWorkerURL(url) {
  return URL.createObjectURL(new Blob([`import ${JSON.stringify(url)};`], { type: "text/javascript" }));
}

export async function classicWorkerURL(url) {
  const src = await (await fetch(url)).text();
  return URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
}

export function formatBytes(n) {
  if (n < 1024) return n + " B";
  const units = ["KB", "MB", "GB"];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
  return n.toFixed(n < 10 ? 1 : 0) + " " + units[i];
}

export function makeCanvas(w, h) {
  const c = new OffscreenCanvas(w, h);
  return [c, c.getContext("2d", { willReadFrequently: true })];
}

export function uniqueName(name, taken) {
  if (!taken.has(name)) { taken.add(name); return name; }
  const dot = name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let i = 2; ; i++) {
    const n = `${stem} (${i})${ext}`;
    if (!taken.has(n)) { taken.add(n); return n; }
  }
}

const fflateLib = lazy(() => import(CDN + "fflate@0.8.3/esm/browser.js"));
export const getFflate = fflateLib;

export async function zipFiles(files) {
  const fflate = await fflateLib();
  const taken = new Set();
  const entries = {};
  for (const f of files) {
    const compressible = /^(text\/|application\/(json|xml|yaml|toml))/.test(f.blob.type);
    entries[uniqueName(f.name, taken)] = [new Uint8Array(await f.blob.arrayBuffer()), { level: compressible ? 6 : 0 }];
  }
  const data = await new Promise((res, rej) => fflate.zip(entries, (err, out) => (err ? rej(err) : res(out))));
  return new Blob([data], { type: "application/zip" });
}

export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
