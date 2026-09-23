import { UserError, formatBytes } from "./util.js";

// Generic DOM/UI helpers shared by the PDF tools and other multi-tool views.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "html") el.innerHTML = v;
    else if (v !== false && v != null) el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c);
  return el;
}

// A drop/choose area scoped to one tool. Page-level drops are routed here too.
export function picker({ multiple, accept, label, hint, onFiles }) {
  const input = h("input", { type: "file", accept, hidden: true, multiple });
  input.addEventListener("change", () => { onFiles([...input.files]); input.value = ""; });
  const el = h("div", { class: "picker" },
    input,
    h("button", { class: "btn primary", onclick: () => input.click() }, label),
    h("span", { class: "muted" }, hint || "or drop files anywhere on the page"),
  );
  return { el, open: () => input.click() };
}

export function statusBar() {
  const msg = h("span", { class: "tool-msg", role: "status" });
  return {
    el: msg,
    set(text, kind = "") { msg.textContent = text; msg.dataset.kind = kind; },
    fail(e) {
      if (!(e instanceof UserError)) console.error(e);
      this.set(e instanceof UserError ? e.message : `Something went wrong: ${e.message}`, "error");
    },
  };
}

export const sizeChange = (before, after) => {
  const pct = Math.round((1 - after / before) * 100);
  return `${formatBytes(before)} → ${formatBytes(after)}${pct > 0 ? ` (−${pct}%)` : ""}`;
};

export function card({ label, sub = "Loading…", actions = [] }) {
  const img = h("img", { alt: "", draggable: "false" });
  const meta = h("span", { class: "tc-meta" }, sub);
  const el = h("div", { class: "tcard" },
    h("div", { class: "tc-thumb" }, img),
    h("div", { class: "tc-info" }, h("span", { class: "tc-name", title: label }, label), meta),
    actions.length ? h("div", { class: "tc-actions" }, ...actions) : null);
  return {
    el,
    img,
    setThumb(url) { img.src = url; },
    setMeta(text) { meta.textContent = text; },
    setError(text) { el.classList.add("err"); meta.textContent = text; },
  };
}

export function iconButton(label, paths, onclick) {
  return h("button", {
    class: "icon-btn", type: "button", title: label, "aria-label": label, onclick,
    html: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`,
  });
}
export const ICONS = {
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  rotL: '<path d="M3 12a9 9 0 109-9 9.7 9.7 0 00-6.7 2.7L3 8"/><path d="M3 3v5h5"/>',
  rotR: '<path d="M21 12a9 9 0 11-9-9 9.7 9.7 0 016.7 2.7L21 8"/><path d="M21 3v5h-5"/>',
};

export function segmented(options, value, onChange) {
  const el = h("div", { class: "seg", role: "radiogroup" });
  const set = (v) => {
    value = v;
    for (const b of el.children) b.setAttribute("aria-checked", String(b.dataset.v === v));
  };
  for (const [v, text] of options) {
    el.append(h("button", { type: "button", role: "radio", "data-v": v, onclick: () => { set(v); onChange(v); } }, text));
  }
  set(value);
  return { el, get value() { return value; }, set };
}
