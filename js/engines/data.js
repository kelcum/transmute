import { CDN, lazy, UserError } from "../util.js";
import { FORMATS } from "../formats.js";

const yamlLib = lazy(async () => { const m = await import(CDN + "js-yaml@5.4.2/+esm"); return m.load ? m : m.default; });
const xmlLib = lazy(() => import(CDN + "fast-xml-parser@5.11.1/+esm"));
const tomlLib = lazy(() => import(CDN + "smol-toml@1.9.0/+esm"));
const papaLib = lazy(async () => (await import(CDN + "papaparse@5.7.0/+esm")).default);

const TYPES = ["json", "yaml", "xml", "toml", "csv"];
const XML_OPTS = { ignoreAttributes: false, attributeNamePrefix: "@", format: true, indentBy: "  ", suppressEmptyNode: true };

async function parse(text, ext) {
  try {
    switch (ext) {
      case "json": return JSON.parse(text);
      case "yaml": return (await yamlLib()).load(text);
      case "toml": return (await tomlLib()).parse(text);
      case "xml": return new (await xmlLib()).XMLParser({ ...XML_OPTS, parseTagValue: true }).parse(text);
      case "csv": return (await papaLib()).parse(text.trim(), { header: true, dynamicTyping: true, skipEmptyLines: true }).data;
    }
  } catch (e) {
    throw new UserError(`This isn't valid ${FORMATS[ext].label}: ${e.message.split("\n")[0]}`);
  }
}

// TOML and XML need a single object at the root; CSV needs a list of flat records.
function asRecords(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    const keys = Object.keys(data);
    if (keys.length === 1 && Array.isArray(data[keys[0]])) return data[keys[0]];
    if (keys.length === 1 && data[keys[0]] && typeof data[keys[0]] === "object") return asRecords(data[keys[0]]);
  }
  return [data];
}

function flatten(obj, prefix = "", out = {}) {
  if (obj === null || typeof obj !== "object") { out[prefix || "value"] = obj; return out; }
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date)) flatten(v, key, out);
    else out[key] = Array.isArray(v) ? JSON.stringify(v) : v;
  }
  return out;
}

async function serialize(data, ext) {
  switch (ext) {
    case "json": return JSON.stringify(data, null, 2) + "\n";
    case "yaml": return (await yamlLib()).dump(data, { lineWidth: 120, noRefs: true });
    case "toml": {
      const root = Array.isArray(data) ? { items: data } : data && typeof data === "object" ? data : { value: data };
      try { return (await tomlLib()).stringify(root) + "\n"; }
      catch (e) { throw new UserError("This data can't be represented in TOML: " + e.message); }
    }
    case "xml": {
      // XML allows exactly one root element; an array under the only key would repeat it.
      const keys = data && typeof data === "object" && !Array.isArray(data) ? Object.keys(data).filter((k) => !k.startsWith("?")) : [];
      let root = data;
      if (Array.isArray(data)) root = { root: { item: data } };
      else if (keys.length !== 1 || Array.isArray(data[keys[0]])) root = { root: data };
      return '<?xml version="1.0" encoding="UTF-8"?>\n' + new (await xmlLib()).XMLBuilder(XML_OPTS).build(root);
    }
    case "csv": return (await papaLib()).unparse(asRecords(data).map((r) => flatten(r)), { newline: "\n" }) + "\n";
  }
}

export default {
  id: "data",
  outputs(inExt) {
    if (inExt === "csv") return ["yaml", "xml", "toml"];
    return TYPES.includes(inExt) ? TYPES.filter((t) => t !== inExt) : [];
  },
  async convert({ file, inExt, outExt, base }) {
    let data = await parse(await file.text(), inExt);
    if (inExt === "xml" && data && data["?xml"]) delete data["?xml"];
    const text = await serialize(data, outExt);
    return [{ name: `${base}.${outExt}`, blob: new Blob([text], { type: FORMATS[outExt].mime }) }];
  },
};
