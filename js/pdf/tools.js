import { h, isPdf } from "./common.js";
import merge from "./merge.js";
import split from "./split.js";
import organize from "./organize.js";
import compress from "./compress.js";
import sign from "./sign.js";
import forms from "./forms.js";

const TOOLS = [merge, split, organize, compress, sign, forms];
const svg = (paths) => `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

const grid = document.getElementById("pdfGrid");
const pane = document.getElementById("pdfTool");
const body = document.getElementById("toolBody");
const title = document.getElementById("toolTitle");
const mounted = new Map();
let current = null;

grid.append(...TOOLS.map((t) =>
  h("a", { class: "tool-card", href: `#pdf/${t.id}` },
    h("div", { class: "tool-ico", html: svg(t.icon) }),
    h("h3", {}, t.title),
    h("p", {}, t.desc))));

export function routePdf(id) {
  const tool = TOOLS.find((t) => t.id === id);
  grid.hidden = !!tool;
  pane.hidden = !tool;
  for (const [key, m] of mounted) m.el.hidden = key !== id;
  current = tool ? id : null;
  if (!tool) return;
  title.textContent = tool.title;
  if (!mounted.has(id)) {
    const el = h("div", { class: "tool-root" });
    body.append(el);
    mounted.set(id, { el, api: tool.mount(el) });
  }
}

function open(id, files) {
  location.hash = `#pdf/${id}`;
  routePdf(id);
  mounted.get(id).api.addFiles(files);
}

export function pdfFiles(files) {
  if (current) return mounted.get(current).api.addFiles(files);
  const pdfs = files.filter(isPdf);
  if (pdfs.length) open(pdfs.length > 1 ? "merge" : "organize", pdfs);
}

body.addEventListener("open-tool", (e) => open(e.detail.tool, e.detail.files));
