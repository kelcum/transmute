import { downloadBlob, formatBytes } from "./util.js";
import { h, picker, statusBar, segmented } from "./ui.js";

const UNITS = { KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 };
// Matches our own "name.ext.007" convention, and loosely enough to pick up
// other splitters' numbered parts too (padded or not).
const PART_RE = /^(.*)\.(\d{1,5})$/;

// Blob.slice() is a lazy view, not a copy, so this is instant regardless of file size.
function planParts(file, partSize) {
  const total = Math.max(1, Math.ceil(file.size / partSize));
  const pad = Math.max(3, String(total).length);
  const parts = [];
  for (let i = 0; i < total; i++) {
    const start = i * partSize;
    const end = Math.min(start + partSize, file.size);
    parts.push({ name: `${file.name}.${String(i + 1).padStart(pad, "0")}`, blob: file.slice(start, end), size: end - start });
  }
  return parts;
}

function detectGroups(files) {
  const byBase = new Map();
  const leftovers = [];
  for (const file of files) {
    const m = file.name.match(PART_RE);
    if (!m) { leftovers.push(file); continue; }
    if (!byBase.has(m[1])) byBase.set(m[1], new Map());
    byBase.get(m[1]).set(parseInt(m[2], 10), file);
  }
  const groups = [...byBase.entries()].map(([base, partMap]) => {
    const nums = [...partMap.keys()].sort((a, b) => a - b);
    const missing = [];
    for (let i = nums[0]; i <= nums[nums.length - 1]; i++) if (!partMap.has(i)) missing.push(i);
    const parts = nums.map((n) => partMap.get(n));
    return { base, parts, missing, size: parts.reduce((s, f) => s + f.size, 0) };
  });
  return { groups, leftovers };
}

const resultRow = (name, sizeText, btnLabel, onClick) => {
  const btn = h("button", { class: "btn primary small", onclick: onClick }, btnLabel);
  return { el: h("div", { class: "result-row" }, h("span", { class: "tc-name", title: name }, name), h("span", { class: "muted" }, sizeText), btn), btn };
};

export default function mountSplitJoin(root) {
  const status = statusBar();
  let splitFile = null;
  let splitResults = [];

  // ---------- split ----------
  const splitInfo = h("p", { class: "tool-file", hidden: true });
  const sizeMode = segmented([["size", "Max size per part"], ["count", "Number of parts"]], "size", () => syncSizeMode());
  const sizeIn = h("input", { type: "number", class: "text-in", min: "1", value: "500" });
  const unitSel = h("select", {}, new Option("KB", "KB"), new Option("MB", "MB", true, true), new Option("GB", "GB"));
  const countIn = h("input", { type: "number", class: "text-in", min: "2", max: "999", value: "4" });
  const sizeRow = h("label", { class: "field" }, "Max size per part", h("div", { class: "tool-row" }, sizeIn, unitSel));
  const countRow = h("label", { class: "field", hidden: true }, "Number of parts", countIn);
  const preview = h("p", { class: "tool-hint" });
  const splitList = h("div", { class: "result-list" });
  const splitAll = h("button", { class: "btn ghost", hidden: true, onclick: downloadAllSplit }, "Download all parts");
  const splitGo = h("button", { class: "btn primary", disabled: true, onclick: runSplit }, "Split file");
  const splitWork = h("div", { class: "tool-work", hidden: true },
    splitInfo, h("div", { class: "tool-row" }, sizeMode.el), h("div", { class: "tool-row" }, sizeRow, countRow), preview);
  const splitPick = picker({ multiple: false, label: "Choose a file", onFiles: addSplitFile });
  const splitPane = h("div", { class: "sj-pane" },
    splitPick.el, splitWork, splitList, h("div", { class: "tool-actions" }, status.el, splitAll, splitGo));

  for (const el of [sizeIn, unitSel, countIn]) el.addEventListener("input", updatePreview);

  function syncSizeMode() {
    sizeRow.hidden = sizeMode.value !== "size";
    countRow.hidden = sizeMode.value !== "count";
    updatePreview();
  }

  function currentPartSize() {
    if (!splitFile) return 0;
    if (sizeMode.value === "count") return Math.max(1, Math.ceil(splitFile.size / Math.max(2, +countIn.value || 2)));
    return Math.max(1, +sizeIn.value || 1) * UNITS[unitSel.value];
  }

  function updatePreview() {
    if (!splitFile) return;
    const partSize = currentPartSize();
    const n = Math.max(1, Math.ceil(splitFile.size / partSize));
    if (n <= 1) {
      preview.textContent = "This file is already smaller than that — it doesn't need to be split.";
      splitGo.disabled = true;
      return;
    }
    const last = splitFile.size - partSize * (n - 1);
    preview.textContent = last === partSize
      ? `This makes ${n} equal parts of ${formatBytes(partSize)} each.`
      : `This makes ${n} parts: ${n - 1} of ${formatBytes(partSize)} and one of ${formatBytes(last)}.`;
    splitGo.disabled = false;
  }

  function addSplitFile(files) {
    const file = files[0];
    if (!file) return;
    splitFile = file;
    splitList.replaceChildren();
    splitResults = [];
    splitAll.hidden = true;
    splitInfo.textContent = `${file.name} · ${formatBytes(file.size)}`;
    splitInfo.hidden = false;
    splitWork.hidden = false;
    status.set("");
    updatePreview();
  }

  function runSplit() {
    splitGo.disabled = true;
    splitList.replaceChildren();
    try {
      splitResults = planParts(splitFile, currentPartSize());
      for (const p of splitResults) {
        const { el } = resultRow(p.name, formatBytes(p.size), "Download", () => downloadBlob(p.blob, p.name));
        splitList.append(el);
      }
      splitAll.hidden = splitResults.length < 2;
      status.set(`Done · ${splitResults.length} parts ready`, "ok");
    } catch (e) {
      status.fail(e);
    }
    splitGo.disabled = false;
  }

  async function downloadAllSplit() {
    splitAll.disabled = true;
    for (const p of splitResults) {
      downloadBlob(p.blob, p.name);
      await new Promise((r) => setTimeout(r, 200));
    }
    splitAll.disabled = false;
  }

  // ---------- join ----------
  const joinList = h("div", { class: "result-list" });
  const joinNote = h("p", { class: "tool-hint", hidden: true });
  const joinWork = h("div", { class: "tool-work", hidden: true }, joinList, joinNote);
  const joinPick = picker({ multiple: true, label: "Choose the part files", onFiles: addJoinFiles });
  const joinPane = h("div", { class: "sj-pane", hidden: true }, joinPick.el, joinWork);

  function addJoinFiles(files) {
    const { groups, leftovers } = detectGroups(files);
    joinList.replaceChildren();
    if (!groups.length) {
      status.set("These don't look like split parts (expected names like \"file.ext.001\").", "error");
      joinWork.hidden = true;
      return;
    }
    status.set("");
    for (const g of groups) {
      const complete = g.missing.length === 0;
      const sub = complete
        ? `${g.parts.length} parts · ${formatBytes(g.size)}`
        : `${g.parts.length} parts, missing #${g.missing.join(", #")} · ${formatBytes(g.size)}`;
      const { el, btn } = resultRow(g.base, sub, "Join", () => joinGroup(g, el, btn));
      if (!complete) { btn.disabled = true; btn.title = "Add the missing part(s) first."; }
      joinList.append(el);
    }
    joinNote.hidden = !leftovers.length;
    if (leftovers.length) joinNote.textContent = `Ignored (not part of a numbered sequence): ${leftovers.map((f) => f.name).join(", ")}`;
    joinWork.hidden = false;
  }

  function joinGroup(g, row, btn) {
    btn.disabled = true;
    btn.textContent = "Joining…";
    try {
      const blob = new Blob(g.parts);
      row.replaceWith(resultRow(g.base, formatBytes(blob.size), "Download", () => downloadBlob(blob, g.base)).el);
      status.set(`Done · ${g.base} reassembled`, "ok");
    } catch (e) {
      status.fail(e);
      btn.disabled = false;
      btn.textContent = "Join";
    }
  }

  // ---------- mode switch ----------
  const modeToggle = segmented([["split", "Split a file"], ["join", "Join parts"]], "split", (v) => {
    splitPane.hidden = v !== "split";
    joinPane.hidden = v !== "join";
    status.set("");
  });
  root.append(h("div", { class: "tool-row" }, modeToggle.el), splitPane, joinPane);

  return {
    addFiles(files) {
      if (modeToggle.value === "join") addJoinFiles(files);
      else addSplitFile(files);
    },
  };
}
