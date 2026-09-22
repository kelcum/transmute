import { CDN, lazy, UserError } from "../util.js";
import { FORMATS } from "../formats.js";
import { htmlToPdf } from "../pdfwriter.js";
import { htmlPage } from "./document.js";

const xlsxLib = lazy(() => import(CDN + "xlsx@0.18.5/xlsx.mjs"));

const SHEETS = ["xlsx", "xls", "ods", "csv", "tsv"];
const OUTPUTS = ["xlsx", "xls", "ods", "csv", "tsv", "json", "html", "pdf"];

async function readWorkbook(XLSX, file, inExt) {
  if (inExt === "json") {
    let data;
    try { data = JSON.parse(await file.text()); } catch { throw new UserError("This isn't valid JSON."); }
    if (!Array.isArray(data)) {
      const arr = Object.values(data).find(Array.isArray);
      data = arr || [data];
    }
    const rows = data.map((r) => (r && typeof r === "object" && !Array.isArray(r) ? flatten(r) : { value: r }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), "Sheet1");
    return wb;
  }
  if (inExt === "csv" || inExt === "tsv") {
    return XLSX.read(await file.text(), { type: "string", FS: inExt === "tsv" ? "\t" : undefined, raw: false });
  }
  return XLSX.read(new Uint8Array(await file.arrayBuffer()), { type: "array", cellDates: true });
}

function flatten(obj, prefix = "", out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date)) flatten(v, key, out);
    else out[key] = Array.isArray(v) ? JSON.stringify(v) : v;
  }
  return out;
}

export default {
  id: "spreadsheet",
  outputs(inExt) {
    if (SHEETS.includes(inExt)) return OUTPUTS.filter((o) => o !== inExt);
    if (inExt === "json") return ["xlsx", "xls", "ods", "html", "pdf"];
    return [];
  },
  async convert({ file, inExt, outExt, base, status }) {
    status("Loading spreadsheet engine…");
    const XLSX = await xlsxLib();
    const wb = await readWorkbook(XLSX, file, inExt);
    const names = wb.SheetNames;
    const mime = FORMATS[outExt].mime;

    if (["xlsx", "xls", "ods"].includes(outExt)) {
      const data = XLSX.write(wb, { bookType: outExt === "xls" ? "biff8" : outExt, type: "array", compression: true });
      return [{ name: `${base}.${outExt}`, blob: new Blob([data], { type: mime }) }];
    }
    if (outExt === "csv" || outExt === "tsv") {
      const FS = outExt === "tsv" ? "\t" : ",";
      return names.map((n) => ({
        name: names.length > 1 ? `${base} - ${n}.${outExt}` : `${base}.${outExt}`,
        blob: new Blob([XLSX.utils.sheet_to_csv(wb.Sheets[n], { FS, blankrows: false })], { type: mime }),
      }));
    }
    if (outExt === "json") {
      const toRows = (n) => XLSX.utils.sheet_to_json(wb.Sheets[n], { defval: null });
      const data = names.length > 1 ? Object.fromEntries(names.map((n) => [n, toRows(n)])) : toRows(names[0]);
      return [{ name: `${base}.json`, blob: new Blob([JSON.stringify(data, null, 2) + "\n"], { type: mime }) }];
    }
    const body = names
      .map((n) => (names.length > 1 ? `<h2>${n.replace(/</g, "&lt;")}</h2>` : "") + XLSX.utils.sheet_to_html(wb.Sheets[n], { header: "", footer: "" }))
      .join("\n");
    if (outExt === "html") return [{ name: `${base}.html`, blob: new Blob([htmlPage(base, body)], { type: mime }) }];
    status("Laying out PDF…");
    return [{ name: `${base}.pdf`, blob: await htmlToPdf(body, base) }];
  },
};
