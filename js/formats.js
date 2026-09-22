export const CATEGORIES = {
  image: { label: "Images", short: "IMG" },
  video: { label: "Video", short: "VID" },
  audio: { label: "Audio", short: "AUD" },
  document: { label: "Documents", short: "DOC" },
  spreadsheet: { label: "Spreadsheets", short: "XLS" },
  data: { label: "Data", short: "DATA" },
  archive: { label: "Archives", short: "ZIP" },
};

const F = (label, cat, mime) => ({ label, cat, mime });

export const FORMATS = {
  png: F("PNG", "image", "image/png"),
  jpg: F("JPG", "image", "image/jpeg"),
  webp: F("WEBP", "image", "image/webp"),
  gif: F("GIF", "image", "image/gif"),
  bmp: F("BMP", "image", "image/bmp"),
  ico: F("ICO", "image", "image/x-icon"),
  tiff: F("TIFF", "image", "image/tiff"),
  avif: F("AVIF", "image", "image/avif"),
  svg: F("SVG", "image", "image/svg+xml"),
  heic: F("HEIC", "image", "image/heic"),

  mp4: F("MP4", "video", "video/mp4"),
  webm: F("WEBM", "video", "video/webm"),
  mkv: F("MKV", "video", "video/x-matroska"),
  mov: F("MOV", "video", "video/quicktime"),
  avi: F("AVI", "video", "video/x-msvideo"),
  m4v: F("M4V", "video", "video/x-m4v"),
  wmv: F("WMV", "video", "video/x-ms-wmv"),
  flv: F("FLV", "video", "video/x-flv"),
  "3gp": F("3GP", "video", "video/3gpp"),
  mpg: F("MPG", "video", "video/mpeg"),
  ogv: F("OGV", "video", "video/ogg"),
  ts: F("TS", "video", "video/mp2t"),

  mp3: F("MP3", "audio", "audio/mpeg"),
  wav: F("WAV", "audio", "audio/wav"),
  ogg: F("OGG", "audio", "audio/ogg"),
  opus: F("OPUS", "audio", "audio/opus"),
  flac: F("FLAC", "audio", "audio/flac"),
  aac: F("AAC", "audio", "audio/aac"),
  m4a: F("M4A", "audio", "audio/mp4"),
  aiff: F("AIFF", "audio", "audio/aiff"),
  wma: F("WMA", "audio", "audio/x-ms-wma"),
  amr: F("AMR", "audio", "audio/amr"),

  pdf: F("PDF", "document", "application/pdf"),
  docx: F("DOCX", "document", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
  md: F("Markdown", "document", "text/markdown"),
  html: F("HTML", "document", "text/html"),
  txt: F("TXT", "document", "text/plain"),

  xlsx: F("XLSX", "spreadsheet", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
  xls: F("XLS", "spreadsheet", "application/vnd.ms-excel"),
  ods: F("ODS", "spreadsheet", "application/vnd.oasis.opendocument.spreadsheet"),
  csv: F("CSV", "spreadsheet", "text/csv"),
  tsv: F("TSV", "spreadsheet", "text/tab-separated-values"),

  json: F("JSON", "data", "application/json"),
  yaml: F("YAML", "data", "application/yaml"),
  xml: F("XML", "data", "application/xml"),
  toml: F("TOML", "data", "application/toml"),

  zip: F("ZIP", "archive", "application/zip"),
  tar: F("TAR", "archive", "application/x-tar"),
  "tar.gz": F("TAR.GZ", "archive", "application/gzip"),
};

const ALIASES = {
  jpeg: "jpg", jpe: "jpg", jfif: "jpg", tif: "tiff", heif: "heic",
  htm: "html", markdown: "md", yml: "yaml", tgz: "tar.gz", aif: "aiff",
  mpeg: "mpg", oga: "ogg", text: "txt", qt: "mov",
};

const MIME_TO_EXT = Object.fromEntries(Object.entries(FORMATS).map(([ext, f]) => [f.mime, ext]));
Object.assign(MIME_TO_EXT, { "image/jpg": "jpg", "audio/x-wav": "wav", "audio/mp3": "mp3", "image/heif": "heic" });

export function detectExt(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith(".tar.gz")) return "tar.gz";
  const m = name.match(/\.([a-z0-9]+)$/);
  if (m) {
    const ext = ALIASES[m[1]] || m[1];
    if (FORMATS[ext]) return ext;
  }
  return MIME_TO_EXT[file.type] || null;
}

export function baseName(name) {
  if (/\.tar\.gz$/i.test(name)) return name.slice(0, -7);
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(0, i) : name;
}

export const DEFAULT_OUT = {
  png: "jpg", jpg: "png", webp: "png", gif: "png", bmp: "png", ico: "png", tiff: "png", avif: "png", svg: "png", heic: "jpg",
  mp4: "mp3", webm: "mp4", mkv: "mp4", mov: "mp4", avi: "mp4", m4v: "mp4", wmv: "mp4", flv: "mp4", "3gp": "mp4", mpg: "mp4", ogv: "mp4", ts: "mp4",
  mp3: "wav", wav: "mp3", ogg: "mp3", opus: "mp3", flac: "mp3", aac: "mp3", m4a: "mp3", aiff: "mp3", wma: "mp3", amr: "mp3",
  pdf: "png", docx: "pdf", md: "html", html: "pdf", txt: "pdf",
  xlsx: "csv", xls: "xlsx", ods: "xlsx", csv: "xlsx", tsv: "xlsx",
  json: "yaml", yaml: "json", xml: "json", toml: "json",
  zip: "tar.gz", tar: "zip", "tar.gz": "zip",
};
