// Tour UI: use cases on the left, stacked panes per function, changed files on the right.
const $ = (id) => document.getElementById(id);
const LANG_MAP = { ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript", py: "python", go: "go", java: "java", cs: "csharp", rb: "ruby", php: "php", kt: "kotlin", rs: "rust", sql: "sql", json: "json", yml: "yaml", yaml: "yaml", css: "css", scss: "scss", html: "xml", vue: "xml", sh: "bash", md: "markdown", swift: "swift", scala: "scala" };

// ---------- UI text ----------
const S = {
  layers: { critical: "1 · Critical", support: "2 · Support", errors: "3 · Errors and validations", tests: "4 · Tests and config" },
  starting: "Starting…", account: "Claude account:", offline: "No connection to lazy-reviewer (was the terminal closed?)",
  empty: "The tour came out empty.", files: "{0} files", generated: "Generated with {0}", unanchoredFoot: " · {0} explanations without a verified quote (⚠)",
  claude: "Claude:", accNow: "Current account: {0}", accGen: "This tour was generated with: {0}", accCache: "Tour loaded from cache (generated before the account was recorded)",
  progress: "Case {0}/{1} · {2}% read", triggered: "Triggered by:", outsidePr: "outside the PR", noFile: "(file not available)",
  noSteps: "This function has no steps. Press → to go back.", result: "Result:", step: "Step {0} of {1} · lines {2}–{3}",
  unanchored: "⚠ this explanation does not quote the code literally; double-check it",
  enter: "↓ Enter {0}", enterNext: " (next)", enterOpt: " (optional)", prev: "← Previous", next: "Next →",
  keys: "<kbd>→</kbd> next <kbd>←</kbd> back <kbd>↓</kbd> enter <kbd>↑</kbd> exit <kbd>C</kbd> comments <kbd>D</kbd> deleted <kbd>F</kbd> files",
  comments: "Comments", filesTitle: "Changed files", notCovered: "Not covered by the tour", skipped: "Skipped (lock file or binary)",
  status: { added: "Added", modified: "Modified", deleted: "Deleted", renamed: "Renamed" },
  deleted: "Deleted lines", removedHint: "{0} removed lines (this tour was cached before they were stored: run with --fresh to see them)",
  instrTitle: "Reviewer settings", instrBtn: "Reviewer settings",
  instrHelp: "Saved settings apply to new tours; regenerating this one spends tokens.",
  deepLabel: "Deep analysis", deepHelp: "Sends the full changed files, more definitions and the places that call the changed functions. More detailed on large refactors; uses about 2-3x more tokens.",
  layersLabel: "Layers to generate (turning one off saves tokens; turning off tests also skips the test files)",
  instrLabel: "Instructions: how the reviewer explains the code and what it flags. The fixed rules (quote the code, ⚠ for risks, the tour format) always apply.",
  hideLayer: "Hide this layer (no tokens: the tour stays as it is)", showLayer: "Show this layer", modeDeep: "deep", modeFocused: "focused",
  instrCustom: "Custom instructions", instrDefault: "Default instructions", restore: "Restore default", cancel: "Cancel", save: "Save", saveRegen: "Save and regenerate",
  saved: "Saved. It applies to the next tour.", busy: "A tour is being generated. Try again when it finishes.", tooLong: "Too long (max {0} characters).",
};
const tr = (key, ...v) => String(S[key] ?? key).replace(/\{(\d)\}/g, (_, i) => String(v[i] ?? ""));
function applyLabels() {
  $("keys").innerHTML = tr("keys");
  $("files-title").textContent = tr("filesTitle");
  $("toggle-comments").title = `${tr("comments")} (C)`;
  $("toggle-files").title = `${tr("filesTitle")} (F)`;
  $("toggle-deleted").title = `${tr("deleted")} (D)`;
  $("open-instr").title = tr("instrBtn");
  $("instr-title").textContent = tr("instrTitle");
  $("instr-help").textContent = tr("instrHelp");
  $("opt-deep-label").textContent = tr("deepLabel");
  $("opt-deep-help").textContent = tr("deepHelp");
  $("opt-layers-label").textContent = tr("layersLabel");
  $("instr-label").textContent = tr("instrLabel");
  [["instr-default", "restore"], ["instr-cancel", "cancel"], ["instr-save", "save"], ["instr-regen", "saveRegen"]].forEach(([id, k]) => { $(id).textContent = tr(k); });
}

// ---------- state ----------
let data, F = {}, allUseCases = [], useCases = [], totalSteps = 0, framesByFile = {};
let pos = null, navHistory = [];
const done = new Set(), seen = new Set(), hlCache = {}, collapsedDirs = new Set();
let storageKey = "";
const prefs = { comments: true, files: true, deleted: false, hiddenLayers: [] };
const ucKey = (u) => `${u.layer}:${u.id}`;

// ---------- loading ----------
async function poll() {
  try {
    const s = await (await fetch("/api/status")).json();
    if (s.phase === "error") { $("loading").classList.add("error"); $("loading-msg").textContent = "✗ " + s.error; return; }
    $("loading-msg").textContent = s.message;
    if (s.account) $("loading-account").innerHTML = `${esc(tr("account"))} <b>${esc(s.account.label)}</b>`;
    if (s.phase === "ready") return start(await (await fetch("/api/tour")).json());
  } catch { $("loading-msg").textContent = tr("offline"); }
  setTimeout(poll, 800);
}

function start(payload) {
  data = payload;
  const { tour, pr } = data;
  tour.frames.forEach((f) => { F[f.id] = f; totalSteps += f.steps.length; (framesByFile[f.file] ??= []).push(f); });
  const roleOrder = { core: 0, helper: 1, trivial: 2 };
  Object.values(framesByFile).forEach((list) => list.sort((a, b) => (roleOrder[a.role] - roleOrder[b.role]) || (a.startLine - b.startLine)));
  tour.sections.forEach((s) => s.useCases.forEach((u) => allUseCases.push({ ...u, layer: s.layer })));
  storageKey = `lazy-reviewer:${pr.owner}/${pr.repo}#${pr.number}`;

  $("pr-link").textContent = `#${pr.number} ${pr.title}`;
  $("pr-link").href = pr.url;
  $("pr-meta").textContent = `${pr.author} · ${pr.head} → ${pr.base} · +${pr.additions} −${pr.deletions} · ${tr("files", pr.changedFiles)}`;
  $("tour-title").textContent = tour.title;
  $("tour-summary").innerHTML = fmt(tour.summary);
  $("tour-foot").textContent = tr("generated", tour.model) + (data.settings ? ` · ${tr(data.settings.deep ? "modeDeep" : "modeFocused")}` : "") + (tour.unanchored ? tr("unanchoredFoot", tour.unanchored) : "");
  document.title = `Lazy Reviewer · #${pr.number}`;
  const acc = data.currentAccount, gen = tour.account;
  $("account").innerHTML = `${esc(tr("claude"))} <b>${esc(acc?.email ?? acc?.label ?? "?")}</b>${acc?.org ? ` · ${esc(acc.org)}` : ""}`;
  $("account").title = tr("accNow", acc?.label ?? "?") + "\n" + (gen ? tr("accGen", gen.label) : tr("accCache"));

  if (!allUseCases.length) { $("loading").classList.add("error"); $("loading-msg").textContent = tr("empty"); return; }
  loadPrefs();
  filterUseCases();
  restore();
  pos ??= startOf(0);
  $("loading").hidden = true;
  $("app").hidden = false;
  render();
}

// ---------- navigation ----------
const startOf = (uc) => ({ uc, stack: [{ frameId: useCases[uc].rootFrame, step: 0, returned: false }] });
const clone = (p) => JSON.parse(JSON.stringify(p));
const cur = () => pos.stack[pos.stack.length - 1];
const curStep = () => F[cur().frameId].steps[cur().step];
const inStack = (id) => pos.stack.some((s) => s.frameId === id);

function next() {
  navHistory.push(clone(pos));
  const t = cur(), step = curStep();
  if (step?.enters && step.autoEnter && !t.returned && !inStack(step.enters)) {
    pos.stack.push({ frameId: step.enters, step: 0, returned: false });
    return render();
  }
  advance();
  render();
}

function advance() {
  while (true) {
    const t = cur();
    if (t.step + 1 < F[t.frameId].steps.length) { t.step++; t.returned = false; return; }
    if (pos.stack.length > 1) { pos.stack.pop(); cur().returned = true; continue; }
    done.add(ucKey(useCases[pos.uc]));
    if (pos.uc + 1 < useCases.length) { pos = startOf(pos.uc + 1); return; }
    navHistory.pop(); // already at the very end
    return;
  }
}

function prev() { if (navHistory.length) { pos = navHistory.pop(); render(); } }

function enter() {
  const step = curStep();
  if (!step?.enters || inStack(step.enters)) return;
  navHistory.push(clone(pos));
  pos.stack.push({ frameId: step.enters, step: 0, returned: false });
  render();
}

function exitTo(level) {
  if (level < 0 || level >= pos.stack.length - 1) return;
  navHistory.push(clone(pos));
  pos.stack.length = level + 1;
  cur().returned = true;
  render();
}

function jump(uc) { navHistory.push(clone(pos)); pos = startOf(uc); render(); }

// Clicking a file opens its first frame; clicking it again cycles through its frames.
function openFile(path) {
  const frames = framesByFile[path];
  if (!frames?.length) return;
  const curFrame = F[cur().frameId];
  const i = curFrame.file === path ? (frames.indexOf(curFrame) + 1) % frames.length : 0;
  const target = frames[i];
  if (target.id === curFrame.id) return;
  const uc = useCases.findIndex((u) => u.rootFrame === target.id);
  if (uc >= 0) return jump(uc);
  const level = pos.stack.findIndex((s) => s.frameId === target.id);
  if (level >= 0) return exitTo(level);
  navHistory.push(clone(pos));
  pos.stack.push({ frameId: target.id, step: 0, returned: false });
  render();
}

// ---------- hiding layers (view only, no tokens) ----------
function filterUseCases() {
  let visible = allUseCases.filter((u) => !prefs.hiddenLayers.includes(u.layer));
  if (!visible.length) { prefs.hiddenLayers = []; visible = allUseCases; }
  useCases = visible;
}
function toggleLayer(layer) {
  const hidden = new Set(prefs.hiddenLayers);
  hidden.has(layer) ? hidden.delete(layer) : hidden.add(layer);
  if (allUseCases.every((u) => hidden.has(u.layer))) return; // keep at least one layer visible
  const current = pos && useCases[pos.uc];
  prefs.hiddenLayers = [...hidden];
  savePrefs();
  filterUseCases();
  navHistory = []; // indexes changed
  const i = current ? useCases.findIndex((u) => ucKey(u) === ucKey(current)) : -1;
  if (i >= 0) pos.uc = i; else pos = startOf(0);
  render();
}

// ---------- preferences ----------
function savePrefs() { try { localStorage.setItem("lazy-reviewer:prefs", JSON.stringify(prefs)); } catch { /* no storage */ } }
function loadPrefs() {
  try { Object.assign(prefs, JSON.parse(localStorage.getItem("lazy-reviewer:prefs")) ?? {}); } catch { /* no storage */ }
  applyPrefs();
}
function togglePref(name) {
  prefs[name] = !prefs[name];
  savePrefs();
  applyPrefs();
  render();
}
function applyPrefs() {
  $("toggle-comments").classList.toggle("on", prefs.comments);
  $("toggle-files").classList.toggle("on", prefs.files);
  $("toggle-deleted").classList.toggle("on", prefs.deleted);
  $("files").hidden = !prefs.files;
}

// ---------- reviewer instructions ----------
let instr = null;
async function openInstructions() {
  instr = await (await fetch("/api/config")).json();
  $("instr-text").value = instr.text;
  $("opt-deep").checked = instr.settings.deep;
  const box = $("opt-layers");
  box.innerHTML = "";
  for (const layer of Object.keys(S.layers)) {
    const label = el("label", "chk");
    label.innerHTML = `<input type="checkbox" value="${layer}"${instr.settings.layers.includes(layer) ? " checked" : ""}${layer === "critical" ? " disabled" : ""}> ${esc(S.layers[layer])}`;
    box.append(label);
  }
  $("instr-text").maxLength = instr.max;
  updateInstrState();
  $("instr").hidden = false;
  $("instr-text").focus();
}
function updateInstrState(message) {
  const isDefault = $("instr-text").value.trim() === instr.defaultText.trim();
  $("instr-state").textContent = message ?? tr(isDefault ? "instrDefault" : "instrCustom");
}
async function saveInstructions(regenerate) {
  const settings = { deep: $("opt-deep").checked, layers: [...$("opt-layers").querySelectorAll("input:checked")].map((i) => i.value) };
  const res = await fetch("/api/config", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: $("instr-text").value, settings, regenerate }) });
  if (res.status === 409) return updateInstrState(tr("busy"));
  if (res.status === 413) return updateInstrState(tr("tooLong", instr.max));
  if (!res.ok) return updateInstrState(`✗ ${(await res.json()).error}`);
  if (regenerate) { try { localStorage.removeItem(storageKey); } catch { /* no storage */ } return location.reload(); }
  instr = { ...instr, ...(await res.json()) };
  updateInstrState(tr("saved"));
}

// ---------- render ----------
function render() {
  const t = cur(), step = curStep();
  if (step) seen.add(`${t.frameId}:${t.step}`);
  save();

  // left sidebar
  const box = $("sections");
  box.innerHTML = "";
  let idx = 0;
  for (const s of data.tour.sections) {
    const hidden = prefs.hiddenLayers.includes(s.layer);
    const sec = el("div", `section ${s.layer}${hidden ? " off" : ""}`);
    const h = el("h3", "", S.layers[s.layer]);
    const eye = el("button", "eye", hidden ? "○" : "●");
    eye.title = tr(hidden ? "showLayer" : "hideLayer");
    eye.onclick = () => toggleLayer(s.layer);
    h.append(eye);
    sec.append(h);
    if (!hidden) for (const u of s.useCases) {
      const i = idx++, d = done.has(ucKey(u));
      const row = el("div", `uc${i === pos.uc ? " active" : ""}${d ? " done" : ""}`);
      row.innerHTML = `<span class="check">${d ? "✓" : i === pos.uc ? "▸" : "○"}</span><span>${esc(u.title)}</span>`;
      row.onclick = () => jump(i);
      sec.append(row);
    }
    box.append(sec);
  }

  const pct = totalSteps ? Math.round((seen.size / totalSteps) * 100) : 0;
  $("progress-text").textContent = tr("progress", pos.uc + 1, useCases.length, pct);
  $("progress-bar").style.width = pct + "%";

  const uc = useCases[pos.uc];
  $("usecase-head").innerHTML = `<div class="t">${esc(uc.title)}</div><div class="trigger">${esc(tr("triggered"))} ${fmt(uc.trigger)}</div>`;

  const bc = $("breadcrumb");
  bc.innerHTML = "";
  pos.stack.forEach((s, i) => {
    if (i) bc.append(" › ");
    const sp = el("span", i === pos.stack.length - 1 ? "cur" : "", F[s.frameId].name);
    if (i < pos.stack.length - 1) sp.onclick = () => exitTo(i);
    bc.append(sp);
  });

  const panes = $("panes");
  panes.innerHTML = "";
  pos.stack.forEach((s, i) => panes.append(pane(s, i, i === pos.stack.length - 1)));
  requestAnimationFrame(() => panes.querySelectorAll(".pane").forEach((p) => {
    const f = p.querySelector(".ln.focus");
    if (f) { const c = p.querySelector(".code"); c.scrollTop = f.offsetTop - c.clientHeight / 3; }
  }));

  if (prefs.files) renderFiles();
}

function pane(s, level, active) {
  const frame = F[s.frameId], file = data.files[frame.file], step = frame.steps[s.step];
  const p = el("div", `pane ${active ? "active" : "parent"}`);
  if (!active) p.onclick = () => exitTo(level);

  const head = el("div", "pane-head");
  head.innerHTML = `<span class="fn">${esc(frame.name)}</span><span class="loc">${esc(frame.file)}:${frame.startLine}-${frame.endLine}</span><span class="role">${frame.role}</span>${file && !file.inPr ? `<span class="ext">${esc(tr("outsidePr"))}</span>` : ""}<div class="sum">${fmt(frame.summary)}</div>`;
  p.append(head);

  const code = el("div", "code");
  if (!file) { code.textContent = tr("noFile"); p.append(code); return p; }
  const lines = highlighted(frame.file);
  const added = new Set(file.added);
  const deletedAt = new Set(file.deletedAt ?? []);
  const from = Math.max(1, frame.startLine - 2), to = Math.min(file.lines.length, frame.endLine + 2);
  const seenLines = new Set();
  frame.steps.forEach((st, i) => { if (seen.has(`${s.frameId}:${i}`)) for (let n = st.startLine; n <= st.endLine; n++) seenLines.add(n); });
  const lang = LANG_MAP[frame.file.split(".").pop().toLowerCase()];

  // Removed lines sit right before the new-file line they are keyed by.
  const removedRows = (n) => {
    if (!prefs.deleted || n < frame.startLine || n > frame.endLine + 1 || !deletedAt.has(n)) return;
    const focus = step && n > step.startLine && n <= step.endLine ? " focus" : "";
    const removed = file.removed?.[n];
    if (!removed) { code.append(htmlEl("div", `ln del hint${focus}`, `<span class="num"></span><span class="mark">−</span><span class="src">${esc(tr("removedHint", "…"))}</span>`)); return; }
    for (const r of removed) {
      code.append(htmlEl("div", `ln del${focus}`, `<span class="num">${r.old}</span><span class="mark">−</span><span class="src">${hlLine(r.text, lang) || " "}</span>`));
    }
  };

  for (let n = from; n <= to; n++) {
    removedRows(n);
    const inFocus = step && n >= step.startLine && n <= step.endLine;
    const delMark = !prefs.deleted && deletedAt.has(n) && n >= frame.startLine && n <= frame.endLine + 1 ? " has-del" : "";
    const row = el("div", `ln${added.has(n) ? " added" : ""}${n < frame.startLine || n > frame.endLine ? " ctx" : ""}${inFocus ? " focus" : ""}${seenLines.has(n) ? " seen" : ""}${delMark}`);
    row.innerHTML = `<span class="num">${n}</span><span class="mark">${added.has(n) ? "+" : ""}</span><span class="src">${lines[n - 1] || " "}</span>`;
    code.append(row);
    if (active && prefs.comments && step && n === step.endLine) code.append(card(frame, s, step));
  }
  if (to === file.lines.length) removedRows(to + 1);
  if (active && !step) code.append(el("div", "outro", tr("noSteps")));
  const isLast = active && pos.stack.length === 1 && s.step === frame.steps.length - 1;
  if (isLast && prefs.comments && useCases[pos.uc].outro) code.append(htmlEl("div", "outro", `<b>${esc(tr("result"))}</b> ` + fmt(useCases[pos.uc].outro)));
  p.append(code);
  return p;
}

function card(frame, s, step) {
  const c = el("div", "card");
  const [main, ...warns] = step.explanation.split("⚠");
  c.innerHTML = `<div class="meta">${esc(tr("step", s.step + 1, frame.steps.length, step.startLine, step.endLine))}</div><div>${fmt(main)}</div>` +
    warns.map((w) => `<div class="warn">⚠ ${fmt(w)}</div>`).join("") +
    (step.anchored === false ? `<div class="unanchored">${esc(tr("unanchored"))}</div>` : "");
  const actions = el("div", "actions");
  if (step.enters && F[step.enters] && !inStack(step.enters)) {
    const b = el("button", step.autoEnter ? "primary" : "", tr("enter", F[step.enters].name) + (step.autoEnter ? tr("enterNext") : tr("enterOpt")));
    b.onclick = enter;
    actions.append(b);
  }
  const bp = el("button", "", tr("prev")); bp.onclick = prev;
  const bn = el("button", "", tr("next")); bn.onclick = next;
  actions.append(bp, bn);
  c.append(actions);
  return c;
}

// ---------- changed files (right panel) ----------
function changedFiles() {
  if (data.changed) return data.changed;
  // tours cached before the file list existed: rebuild it from the files the tour uses
  return Object.entries(data.files).filter(([, v]) => v.inPr)
    .map(([path, v]) => ({ path, status: "modified", additions: v.added.length, deletions: v.deletedAt.length }));
}

function buildTree(files) {
  const root = { name: "", path: "", dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split("/");
    let node = root;
    parts.slice(0, -1).forEach((part, i) => {
      if (!node.dirs.has(part)) node.dirs.set(part, { name: part, path: parts.slice(0, i + 1).join("/"), dirs: new Map(), files: [] });
      node = node.dirs.get(part);
    });
    node.files.push({ ...f, name: parts[parts.length - 1] });
  }
  // compact folders with a single child folder and no files, like VS Code does
  const compact = (node) => {
    for (const [key, d] of node.dirs) {
      let dir = d;
      while (dir.files.length === 0 && dir.dirs.size === 1) {
        const only = [...dir.dirs.values()][0];
        dir = { ...only, name: `${dir.name}/${only.name}` };
      }
      node.dirs.set(key, dir);
      compact(dir);
    }
  };
  compact(root);
  return root;
}

function fileSeen(path) {
  const frames = framesByFile[path];
  return frames?.length && frames.every((f) => f.steps.every((_, i) => seen.has(`${f.id}:${i}`)));
}

function renderFiles() {
  const box = $("file-tree");
  const scroll = box.scrollTop;
  box.innerHTML = "";
  const activeFile = F[cur().frameId].file;
  const STATUS = { added: "A", modified: "M", deleted: "D", renamed: "R" };

  const walk = (node, depth) => {
    const dirs = [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
    for (const d of dirs) {
      const closed = collapsedDirs.has(d.path);
      const row = el("div", "tree-row dir");
      row.style.paddingLeft = `${8 + depth * 12}px`;
      row.innerHTML = `<span class="caret">${closed ? "›" : "⌄"}</span><span class="name">${esc(d.name)}</span>`;
      row.title = d.path;
      row.onclick = () => { closed ? collapsedDirs.delete(d.path) : collapsedDirs.add(d.path); renderFiles(); };
      box.append(row);
      if (!closed) walk(d, depth + 1);
    }
    for (const f of [...node.files].sort((a, b) => a.name.localeCompare(b.name))) {
      const covered = !!framesByFile[f.path]?.length;
      const cls = ["tree-row", "file", f.status, covered ? "covered" : "uncovered", f.path === activeFile ? "active" : "", fileSeen(f.path) ? "seen" : ""].join(" ");
      const row = el("div", cls);
      row.style.paddingLeft = `${8 + depth * 12 + 14}px`;
      row.innerHTML = `<span class="name">${esc(f.name)}</span><span class="delta"><span class="plus">+${f.additions}</span> <span class="minus">−${f.deletions}</span></span><span class="st">${STATUS[f.status] ?? "M"}</span>`;
      row.title = `${f.path}\n${S.status[f.status] ?? S.status.modified}` + (f.skipped ? `\n${tr("skipped")}` : covered ? "" : `\n${tr("notCovered")}`);
      if (covered) row.onclick = () => openFile(f.path);
      box.append(row);
    }
  };
  walk(buildTree(changedFiles()), 0);
  box.scrollTop = scroll;
  box.querySelector(".active")?.scrollIntoView({ block: "nearest" });
}

// ---------- utils ----------
function highlighted(path) {
  if (hlCache[path]) return hlCache[path];
  const src = data.files[path].lines.join("\n");
  const lang = LANG_MAP[path.split(".").pop().toLowerCase()];
  let html;
  try { html = lang && hljs.getLanguage(lang) ? hljs.highlight(src, { language: lang }).value : esc(src); } catch { html = esc(src); }
  return (hlCache[path] = splitHtmlLines(html));
}

function hlLine(text, lang) {
  try { return lang && hljs.getLanguage(lang) ? hljs.highlight(text, { language: lang }).value : esc(text); } catch { return esc(text); }
}

// Splits highlight.js HTML into lines, closing and reopening any open <span>.
function splitHtmlLines(html) {
  const out = [], open = [];
  let cur = "";
  for (const m of html.matchAll(/(<span[^>]*>)|(<\/span>)|(\n)|([^<\n]+)/g)) {
    if (m[1]) { open.push(m[1]); cur += m[1]; }
    else if (m[2]) { open.pop(); cur += m[2]; }
    else if (m[3]) { out.push(cur + "</span>".repeat(open.length)); cur = open.join(""); }
    else cur += m[4];
  }
  out.push(cur + "</span>".repeat(open.length));
  return out;
}

function esc(s) { return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function fmt(s) { return esc(s).replace(/`([^`]+)`/g, "<code>$1</code>"); }
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function htmlEl(tag, cls, html) { const e = el(tag, cls); e.innerHTML = html; return e; }

function save() {
  try { localStorage.setItem(storageKey, JSON.stringify({ pos, uc: ucKey(useCases[pos.uc]), done: [...done], seen: [...seen], v: 2 })); } catch { /* no storage */ }
}
function restore() {
  try {
    const s = JSON.parse(localStorage.getItem(storageKey));
    if (s?.v !== 2 || !s.pos.stack.every((x) => F[x.frameId])) return;
    s.done.forEach((d) => done.add(d)); s.seen.forEach((d) => seen.add(d));
    const i = useCases.findIndex((u) => ucKey(u) === s.uc);
    if (i >= 0) pos = { ...s.pos, uc: i };
  } catch { /* no storage */ }
}

document.addEventListener("keydown", (e) => {
  if (!$("instr").hidden) { if (e.key === "Escape") $("instr").hidden = true; return; }
  if (!pos || e.metaKey || e.ctrlKey || e.altKey || /^(TEXTAREA|INPUT)$/.test(e.target.tagName)) return;
  const up = () => exitTo(pos.stack.length - 2);
  const map = { ArrowRight: next, l: next, " ": next, ArrowLeft: prev, h: prev, ArrowDown: enter, j: enter, ArrowUp: up, k: up, Escape: up,
    c: () => togglePref("comments"), C: () => togglePref("comments"), f: () => togglePref("files"), F: () => togglePref("files"),
    d: () => togglePref("deleted"), D: () => togglePref("deleted") };
  const fn = map[e.key];
  if (fn) { e.preventDefault(); fn(); }
});
$("toggle-comments").onclick = () => togglePref("comments");
$("toggle-files").onclick = () => togglePref("files");
$("toggle-deleted").onclick = () => togglePref("deleted");
$("open-instr").onclick = openInstructions;
$("instr-cancel").onclick = () => { $("instr").hidden = true; };
$("instr-default").onclick = () => {
  $("instr-text").value = instr.defaultText;
  $("opt-deep").checked = instr.defaultSettings.deep;
  $("opt-layers").querySelectorAll("input").forEach((i) => { i.checked = instr.defaultSettings.layers.includes(i.value); });
  updateInstrState();
};
$("instr-save").onclick = () => saveInstructions(false);
$("instr-regen").onclick = () => saveInstructions(true);
$("instr-text").oninput = () => updateInstrState();
$("instr").onclick = (e) => { if (e.target === $("instr")) $("instr").hidden = true; };

applyLabels();
poll();
