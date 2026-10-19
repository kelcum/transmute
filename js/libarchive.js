import { CDN, lazy, moduleWorkerURL, UserError } from "./util.js";

const BASE = `${CDN}libarchive.js@2.0.2/dist/`;

export const getArchiveClass = lazy(async () => {
  const { Archive } = await import(BASE + "libarchive.js");
  Archive.init({ workerUrl: moduleWorkerURL(BASE + "worker-bundle.js") });
  return Archive;
});

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
