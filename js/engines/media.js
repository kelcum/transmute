import { CDN, lazy, moduleWorkerURL, UserError } from "../util.js";
import { FORMATS } from "../formats.js";

const MB_READABLE = ["mp4", "m4v", "mov", "webm", "mkv", "ts", "mp3", "wav", "ogg", "opus", "flac", "aac", "m4a"];
const VIDEO_OUT = ["mp4", "webm", "mkv", "mov", "avi", "gif"];
const AUDIO_OUT = ["mp3", "wav", "ogg", "opus", "flac", "aac", "m4a", "aiff"];

// Output formats Mediabunny can write, with the codecs we want in them.
const MB_OUT = {
  mp4: { cls: "Mp4OutputFormat", video: ["avc"], audio: "aac" },
  mov: { cls: "MovOutputFormat", video: ["avc"], audio: "aac" },
  mkv: { cls: "MkvOutputFormat" },
  webm: { cls: "WebMOutputFormat", video: ["vp9", "vp8", "av1"], audio: "opus" },
  m4a: { cls: "Mp4OutputFormat", audioOnly: true, audio: "aac" },
  mp3: { cls: "Mp3OutputFormat", audioOnly: true, audio: "mp3" },
  wav: { cls: "WavOutputFormat", audioOnly: true, audio: "pcm-s16" },
  ogg: { cls: "OggOutputFormat", audioOnly: true, audio: "opus" },
  opus: { cls: "OggOutputFormat", audioOnly: true, audio: "opus" },
  flac: { cls: "FlacOutputFormat", audioOnly: true, audio: "flac" },
  aac: { cls: "AdtsOutputFormat", audioOnly: true, audio: "aac" },
};

const mediabunny = lazy(() => import("mediabunny"));

const EXTRA_ENCODERS = {
  mp3: ["mp3-encoder", "registerMp3Encoder"],
  flac: ["flac-encoder", "registerFlacEncoder"],
  aac: ["aac-encoder", "registerAacEncoder"],
};
const registered = new Set();
async function ensureAudioEncoder(MB, codec) {
  if (registered.has(codec) || !EXTRA_ENCODERS[codec] || (await MB.canEncodeAudio(codec))) return;
  const [pkg, fn] = EXTRA_ENCODERS[codec];
  const mod = await import(`${CDN}@mediabunny/${pkg}@1.59.0/dist/bundles/mediabunny-${pkg}.min.mjs`);
  mod[fn]();
  registered.add(codec);
}

async function convertWithMediabunny({ file, outExt, opts, progress, signal }) {
  const MB = await mediabunny();
  const spec = MB_OUT[outExt];
  const input = new MB.Input({ source: new MB.BlobSource(file), formats: MB.ALL_FORMATS });
  try {
    await input.getFormat();
  } catch {
    return null;
  }
  const hasAudio = !!(await input.getPrimaryAudioTrack());
  if (spec.audioOnly && !hasAudio) throw new UserError("This file has no audio track to extract.");

  let vcodec = null;
  for (const c of spec.video || []) {
    if (await MB.canEncodeVideo(c)) { vcodec = c; break; }
  }
  if (spec.audio) await ensureAudioEncoder(MB, spec.audio);

  const vq = opts.video.quality !== "original" ? new MB.Quality(opts.video.quality) : null;
  const maxH = +opts.video.maxHeight || 0;
  const bitrate = +opts.audio.bitrate || 0;

  const output = new MB.Output({ format: new MB[spec.cls](), target: new MB.BufferTarget() });
  const conversion = await MB.Conversion.init({
    input,
    output,
    video: spec.audioOnly ? { discard: true } : async (track) => {
      const o = {};
      if (vcodec) o.codec = vcodec;
      if (vq) o.quality = vq;
      if (maxH && (await track.getDisplayHeight()) > maxH) o.height = maxH;
      return o;
    },
    audio: {
      ...(spec.audio ? { codec: spec.audio } : {}),
      ...(bitrate && spec.audio !== "pcm-s16" && spec.audio !== "flac" ? { quality: new MB.Quality({ bitrate: bitrate * 1000 }) } : {}),
    },
  });

  // Tracks the browser can't decode would silently vanish from the output;
  // hand those files to ffmpeg instead.
  const lost = conversion.discardedTracks.filter((d) => d.reason !== "discarded_by_user" && !d.reason.startsWith("max_track"));
  if (!conversion.isValid || lost.length || !conversion.utilizedTracks.length) return null;

  conversion.onProgress = progress;
  const onAbort = () => conversion.cancel();
  signal.addEventListener("abort", onAbort);
  try {
    await conversion.execute();
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  return new Blob([output.target.buffer], { type: FORMATS[outExt].mime });
}

const FF = CDN + "@ffmpeg/ffmpeg@0.12.15/dist/esm";
const CORE = CDN + "@ffmpeg/core@0.12.10/dist/esm";
const ffmpegLib = lazy(async () => {
  const { FFmpeg } = await import(FF + "/index.js");
  const ff = new FFmpeg();
  await ff.load({ classWorkerURL: moduleWorkerURL(FF + "/worker.js"), coreURL: CORE + "/ffmpeg-core.js", wasmURL: CORE + "/ffmpeg-core.wasm" });
  return ff;
});

function ffmpegArgs(inPath, outPath, outExt, opts) {
  const maxH = +opts.video.maxHeight || 0;
  const crf = { high: 20, medium: 25, low: 31 }[opts.video.quality] ?? 22;
  const ab = opts.audio.bitrate ? `${opts.audio.bitrate}k` : null;
  const evenScale = maxH
    ? `scale=-2:'trunc(min(${maxH},ih)/2)*2'`
    : "scale='trunc(iw/2)*2':'trunc(ih/2)*2'";
  const x264 = ["-vf", evenScale, "-c:v", "libx264", "-preset", "veryfast", "-crf", String(crf), "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", ab || "160k"];
  const args = ["-i", inPath];
  switch (outExt) {
    case "mp4": args.push(...x264, "-movflags", "+faststart"); break;
    case "mov": case "mkv": args.push(...x264); break;
    case "webm": args.push("-vf", evenScale, "-c:v", "libvpx", "-deadline", "realtime", "-cpu-used", "8", "-crf", String(Math.max(4, crf - 12)), "-b:v", "3M", "-c:a", "libopus", "-b:a", ab || "128k"); break;
    case "avi": args.push("-vf", evenScale, "-c:v", "mpeg4", "-q:v", String(Math.round(crf / 6)), "-c:a", "libmp3lame", "-b:a", ab || "192k"); break;
    case "gif": {
      const w = maxH ? `-2:'min(${maxH},ih)'` : "'min(480,iw)':-2";
      args.push("-an", "-vf", `fps=12,scale=${w}:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4`, "-loop", "0");
      break;
    }
    case "mp3": args.push("-vn", "-c:a", "libmp3lame", "-b:a", ab || "192k"); break;
    case "wav": args.push("-vn", "-c:a", "pcm_s16le"); break;
    case "aiff": args.push("-vn", "-c:a", "pcm_s16be"); break;
    case "flac": args.push("-vn", "-c:a", "flac"); break;
    case "ogg": case "opus": args.push("-vn", "-c:a", "libopus", "-b:a", ab || "128k"); break;
    case "aac": case "m4a": args.push("-vn", "-c:a", "aac", "-b:a", ab || "192k"); break;
  }
  args.push("-y", outPath);
  return args;
}

async function convertWithFfmpeg({ file, inExt, outExt, opts, progress, status, signal }) {
  status("Loading video engine (≈30 MB, first time only)…");
  const ff = await ffmpegLib();
  if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
  status("Converting…");

  const dir = "/in";
  const outPath = `/out.${outExt === "opus" ? "opus" : outExt}`;
  let inPath;
  let mounted = false;
  try {
    await ff.createDir(dir).catch(() => {});
    await ff.mount("WORKERFS", { files: [file] }, dir);
    mounted = true;
    inPath = `${dir}/${file.name}`;
  } catch {
    inPath = `/input.${inExt}`;
    await ff.writeFile(inPath, new Uint8Array(await file.arrayBuffer()));
  }

  const onProgress = ({ progress: p }) => { if (p >= 0 && p <= 1) progress(p); };
  const logs = [];
  const onLog = ({ message }) => { logs.push(message); if (logs.length > 30) logs.shift(); };
  const onAbort = () => { ff.terminate(); ffmpegLib.reset(); };
  ff.on("progress", onProgress);
  ff.on("log", onLog);
  signal.addEventListener("abort", onAbort);
  try {
    const code = await ff.exec(ffmpegArgs(inPath, outPath, outExt, opts));
    if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
    if (code !== 0) {
      const hint = logs.filter((l) => /error|invalid|not found|unsupported/i.test(l)).pop();
      throw new UserError("Conversion failed" + (hint ? `: ${hint.trim()}` : "."));
    }
    const data = await ff.readFile(outPath);
    await ff.deleteFile(outPath).catch(() => {});
    return new Blob([data], { type: FORMATS[outExt].mime });
  } finally {
    signal.removeEventListener("abort", onAbort);
    if (!signal.aborted) {
      ff.off("progress", onProgress);
      ff.off("log", onLog);
      if (mounted) await ff.unmount(dir).catch(() => {});
      else await ff.deleteFile(inPath).catch(() => {});
    }
  }
}

export default {
  id: "media",
  heavy: true,
  outputs(inExt) {
    const cat = FORMATS[inExt]?.cat;
    if (inExt === "gif") return ["mp4", "webm", "mkv", "mov", "avi"];
    if (cat === "video") return [...VIDEO_OUT, ...AUDIO_OUT];
    if (cat === "audio") return AUDIO_OUT;
    return [];
  },
  async convert(job) {
    const { inExt, outExt, base, status } = job;
    let blob = null;
    if (MB_READABLE.includes(inExt) && MB_OUT[outExt]) {
      status("Converting…");
      try {
        blob = await convertWithMediabunny(job);
      } catch (e) {
        if (e instanceof UserError || job.signal.aborted) throw e;
        console.warn("Mediabunny failed, falling back to ffmpeg", e);
        blob = null;
      }
    }
    if (!blob) blob = await convertWithFfmpeg(job);
    return [{ name: `${base}.${outExt}`, blob }];
  },
};
