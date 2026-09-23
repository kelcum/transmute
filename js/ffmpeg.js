import { CDN, lazy, moduleWorkerURL } from "./util.js";

// Shared across the media conversion engine and the screenshots tool, so the
// ~30 MB core is only ever downloaded once per session.
const FF = CDN + "@ffmpeg/ffmpeg@0.12.15/dist/esm";
const CORE = CDN + "@ffmpeg/core@0.12.10/dist/esm";

export const getFfmpeg = lazy(async () => {
  const { FFmpeg } = await import(FF + "/index.js");
  const ff = new FFmpeg();
  await ff.load({ classWorkerURL: moduleWorkerURL(FF + "/worker.js"), coreURL: CORE + "/ffmpeg-core.js", wasmURL: CORE + "/ffmpeg-core.wasm" });
  return ff;
});

// Writes a file the way media.js does: mounted from disk when possible (avoids
// copying large files into the wasm heap), falling back to an in-memory write.
export async function ffmpegWriteInput(ff, file, fallbackName) {
  const dir = "/in";
  try {
    await ff.createDir(dir).catch(() => {});
    await ff.mount("WORKERFS", { files: [file] }, dir);
    return { path: `${dir}/${file.name}`, mounted: true };
  } catch {
    const path = `/${fallbackName}`;
    await ff.writeFile(path, new Uint8Array(await file.arrayBuffer()));
    return { path, mounted: false };
  }
}

export async function ffmpegCleanupInput(ff, { path, mounted }) {
  if (mounted) await ff.unmount("/in").catch(() => {});
  else await ff.deleteFile(path).catch(() => {});
}
