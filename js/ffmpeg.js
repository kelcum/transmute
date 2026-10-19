import { CDN, lazy, moduleWorkerURL } from "./util.js";

const FF = CDN + "@ffmpeg/ffmpeg@0.12.15/dist/esm";
const CORE = CDN + "@ffmpeg/core@0.12.10/dist/esm";

export const getFfmpeg = lazy(async () => {
  const { FFmpeg } = await import(FF + "/index.js");
  const ff = new FFmpeg();
  await ff.load({ classWorkerURL: moduleWorkerURL(FF + "/worker.js"), coreURL: CORE + "/ffmpeg-core.js", wasmURL: CORE + "/ffmpeg-core.wasm" });
  return ff;
});

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
