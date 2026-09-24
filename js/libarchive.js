import { CDN, lazy, moduleWorkerURL, UserError } from "./util.js";

// Reads RAR, 7z and other archive formats via libarchive (WASM). Read-only:
// libarchive can't write RAR (proprietary), so this is only ever the input side.
const BASE = `${CDN}libarchive.js@2.0.2/dist/`;

export const getArchiveClass = lazy(async () => {
  const { Archive } = await import(BASE + "libarchive.js");
  // Worker construction requires a same-origin URL; a blob that just re-imports
  // the CDN script satisfies that while still loading the real worker from jsdelivr.
  Archive.init({ workerUrl: moduleWorkerURL(BASE + "worker-bundle.js") });
  return Archive;
});

// libarchive.js returns a nested {name: File | {...}} tree; flatten it into
// plain {name, data} entries matching the shape the zip/tar writers expect.
async function flatten(node, prefix, out) {
  for (const [name, value] of Object.entries(node)) {
    if (value instanceof File) out.push({ name: prefix + name, data: new Uint8Array(await value.arrayBuffer()) });
    else await flatten(value, prefix + name + "/", out);
  }
  return out;
}

export async function extractArchiveEntries(file) {
  const Archive = await getArchiveClass();
  let archive;
  try {
    archive = await Archive.open(file);
  } catch {
    throw new UserError("This file couldn't be read as an archive.");
  }
  try {
    // Not all formats can report this reliably; a "no" answer isn't a guarantee,
    // but a "yes" always is, so a genuinely unrecoverable case is caught below anyway.
    if ((await archive.hasEncryptedData().catch(() => false)) === true) {
      throw new UserError("This archive is password-protected and can't be converted.");
    }
    let tree;
    try {
      tree = await archive.extractFiles();
    } catch (e) {
      throw new UserError(/passphrase/i.test(e?.message || "") ? "This archive is password-protected and can't be converted." : "This archive couldn't be extracted. It may be damaged or use an unsupported compression method.");
    }
    const entries = await flatten(tree, "", []);
    if (!entries.length) throw new UserError("No files could be found in this archive.");
    return entries;
  } finally {
    await archive.close();
  }
}
