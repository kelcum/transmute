<p align="center"><img src="logo.svg" width="88" alt="Transmute logo"></p>

<h1 align="center">Transmute</h1>

<p align="center">Convert any file, right in your browser. Free, private, no uploads, no sign-up.</p>

<p align="center"><b><a href="https://kelcum.github.io/transmute/">kelcum.github.io/transmute</a></b></p>

---

Transmute is a file converter that runs entirely on your device. Files are never uploaded: every conversion happens in the browser tab, so it works offline once loaded, has no size caps or daily limits, and costs nothing to run.

## What it converts

| Category | From | To |
|---|---|---|
| Images | PNG, JPG, WEBP, GIF, BMP, ICO, TIFF, AVIF, SVG, HEIC | PNG, JPG, WEBP, GIF, BMP, ICO, TIFF, PDF, and GIF → MP4/WEBM/MKV/MOV/AVI |
| Video | MP4, WEBM, MKV, MOV, AVI, M4V, WMV, FLV, 3GP, MPG, OGV, TS | MP4, WEBM, MKV, MOV, AVI, GIF, plus any audio format |
| Audio | MP3, WAV, OGG, OPUS, FLAC, AAC, M4A, AIFF, WMA, AMR | MP3, WAV, OGG, OPUS, FLAC, AAC, M4A, AIFF |
| Documents | PDF, DOCX, Markdown, HTML, TXT | PDF, HTML, Markdown, TXT, and PDF → PNG/JPG/WEBP |
| Spreadsheets | XLSX, XLS, ODS, CSV, TSV | XLSX, XLS, ODS, CSV, TSV, JSON, HTML, PDF |
| Data | JSON, YAML, XML, TOML, CSV | JSON, YAML, XML, TOML, CSV, XLSX |
| Archives | ZIP, TAR, TAR.GZ, RAR, 7Z, ISO, CAB | ZIP, TAR, TAR.GZ |

## PDF tools

At [kelcum.github.io/transmute/#pdf](https://kelcum.github.io/transmute/#pdf):

- **Merge**: combine PDFs and images into one file, drag to set the order
- **Split**: every page as its own PDF, custom ranges (`1-3, 5, 8-10`), or pick pages by clicking
- **Organize**: reorder, rotate and delete pages, and pull in pages from other PDFs
- **Compress**: *Recommended* re-encodes the photos inside the PDF and leaves text as sharp, selectable vectors; *Strong* flattens pages to images for the smallest size
- **Sign & add text**: draw, type or upload a signature, add text and dates, then drag and resize them onto any page (rotated pages included)
- **Fill forms**: fill text fields, checkboxes, radio buttons and dropdowns right on the page, optionally flattening the result

## Screenshots

At [kelcum.github.io/transmute/#shots](https://kelcum.github.io/transmute/#shots): pull screenshots out of a video, either evenly spaced across the whole thing or one every N seconds. Download individually or as a zip. For MP4, MOV, WebM, MKV and TS this reads exact frames at exact timestamps (verified against a test video, frame by frame); other formats fall back to FFmpeg.wasm.

## How it works

Each category has its own engine, loaded only the first time you need it:

- **Video & audio:** [Mediabunny](https://mediabunny.dev) uses the browser's WebCodecs API, so encoding runs on your GPU's hardware encoders. Anything it can't read (AVI, WMV, FLV, video → GIF…) falls back to [FFmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm).
- **Images:** Canvas, plus [heic-to](https://github.com/hoppergee/heic-to) for iPhone photos, [UTIF](https://github.com/photopea/UTIF.js) for TIFF and [gif.js](https://github.com/jnordberg/gif.js) for GIF.
- **Documents:** [pdf.js](https://mozilla.github.io/pdf.js/) renders PDFs; [mammoth](https://github.com/mwilliamson/mammoth.js), [marked](https://marked.js.org) and [Turndown](https://github.com/mixmark-io/turndown) handle Word/Markdown/HTML; a small layout engine on top of [pdf-lib](https://pdf-lib.js.org) writes PDFs with embedded DejaVu fonts, so accented, Greek and Cyrillic text renders correctly.
- **Spreadsheets & data:** [SheetJS](https://sheetjs.com), [js-yaml](https://github.com/nodeca/js-yaml), [fast-xml-parser](https://github.com/NaturalIntelligence/fast-xml-parser), [smol-toml](https://github.com/squirrelchat/smol-toml), [Papa Parse](https://www.papaparse.com).
- **Archives:** [fflate](https://github.com/101arrowz/fflate) plus a small TAR reader/writer for ZIP/TAR/TAR.GZ; [libarchive.js](https://github.com/nika-begiashvili/libarchivejs) (libarchive compiled to WASM) reads RAR, 7Z, ISO and CAB — useful on a Mac, which can't open those natively.
- **PDF tools:** [pdf-lib](https://pdf-lib.js.org) edits the documents, pdf.js draws the page previews, and [SortableJS](https://sortablejs.github.io/Sortable/) handles drag-to-reorder.
- **Screenshots:** Mediabunny's `CanvasSink` decodes exact frames at exact timestamps; FFmpeg.wasm is the fallback for formats Mediabunny can't demux.

## Limitations

- Word → PDF rebuilds the document with clean typography (headings, lists, tables, images, bold/italic); it isn't a pixel-perfect copy of Word's layout. CJK characters and emoji aren't in the embedded font and show as `?`.
- Old binary `.doc` files aren't supported; save them as `.docx` first.
- Password-protected or encrypted PDFs can't be edited; remove the password first.
- Very large files are limited by your device's memory.

## Running locally

```
python serve.py
```

Then open http://localhost:8750. A local server is needed because the app uses ES modules; any static server works.
