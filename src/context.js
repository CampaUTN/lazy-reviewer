// Builds what the model sees.
//  - focused (default): for each change, the whole function that contains it, plus the
//    definitions of the functions the new code calls (inside or outside the PR).
//  - deep: the full changed files, twice as many external definitions, and the places in
//    the repo that call the functions the PR changes.
// Removed lines are sent once, in their own section; added lines are marked with "+".
import { git } from "./github.js";
import { t } from "./messages.js";

export const LAYERS = ["critical", "support", "errors", "tests"];

const MAX_FILE_LINES = 1500;        // in deep mode, longer files still go as focused windows
const MAX_DEF_LINES = 120;          // longest definition added as context
const MAX_ENCLOSING_LINES = 250;    // longest function sent whole around a change
const FALLBACK_LINES = 40;          // ± lines when no enclosing function is found
const TEXT_FILE_LINES = 12;         // ± lines around changes in docs/config
const MAX_REMOVED_PER_FILE = 200;
const CHAR_BUDGET = 900_000;        // ~225k input tokens at most

const SKIP_FILE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|go\.sum|Cargo\.lock|poetry\.lock)$|\.(min\.js|map|snap|svg|png|jpe?g|gif|ico|pdf|woff2?)$/i;
const CODE_FILE = /\.(m?[jt]sx?|cjs|py|go|java|cs|rb|php|kt|kts|rs|swift|scala|vue|svelte|c|cc|cpp|h|hpp|dart)$/i;
export const TEST_FILE = /(^|\/)(tests?|__tests__|specs?|fixtures?)\/|\.(test|spec)\.[^/]+$|_test\.(go|py|rb)$|(^|\/)test_[^/]+\.py$/i;
const KEYWORDS = new Set("if for while switch catch return function typeof new await async super this import export require console log map filter find some every reduce forEach push pop slice splice join split includes indexOf keys values entries toString parseInt parseFloat String Number Boolean Array Object Promise JSON Math Date Set Map Error assert expect describe it test beforeEach afterEach len print range isinstance str int dict list set tuple def class self make append fmt sizeof elif with lambda not and or in is".split(" "));

// Lines that open a function-like unit (classes and describe blocks are too coarse).
const FN_START = new RegExp([
  /^\s*(export\s+)?(default\s+)?(async\s+)?function\b/,
  /^\s*(export\s+)?(const|let|var)\s+[\w$]+\s*(:[^=]+)?=\s*(async\s+)?(function\b|\([^)]*\)\s*(:[^=]+)?=>|[\w$]+\s*=>)/,
  /^\s*(async\s+)?def\s/,
  /^func\s/,
  /^\s*((public|private|protected|internal|static|async|override|virtual|final|abstract)\s+)+[\w<>\[\],? ]*\(/,
  /^\s*(it|test)(\.\w+)?\s*\(/,
  /^\s*(async\s+)?(get\s+|set\s+)?[\w$]+\s*\([^)]*\)\s*(:\s*[^{]+)?\{\s*$/,
].map((r) => r.source).join("|"));

const NAME_DEF = /(?:function\*?\s+|def\s+|func\s+(?:\([^)]*\)\s*)?)([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function|\(|[A-Za-z_$][\w$]*\s*=>)|^\s*(?:(?:public|private|protected|static|async|override)\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{]+)?\{\s*$/;

// Parses `git diff` → per file: added lines (head numbering), removed lines and counts.
export function parseDiff(diffText) {
  const files = new Map();
  let cur = null, newLine = 0, oldLine = 0;
  for (const line of diffText.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const m = line.match(/ b\/(.+)$/);
      cur = { path: m ? m[1] : "", added: new Set(), deletedAt: new Set(), removed: {}, dels: 0, status: "modified" };
      files.set(cur.path, cur);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("new file")) cur.status = "added";
    else if (line.startsWith("deleted file")) cur.status = "deleted";
    else if (line.startsWith("rename from")) cur.status = "renamed";
    else if (line.startsWith("+++ b/")) { const p = line.slice(6); if (p !== cur.path) { files.delete(cur.path); cur.path = p; files.set(p, cur); } }
    else if (line.startsWith("@@")) { const m = line.match(/-(\d+)(?:,\d+)? \+(\d+)/); oldLine = m ? Number(m[1]) : 0; newLine = m ? Number(m[2]) : 0; }
    else if (line.startsWith("+") && !line.startsWith("+++")) { cur.added.add(newLine); newLine++; }
    else if (line.startsWith("-") && !line.startsWith("---")) {
      // removed lines are keyed by the new-file line they sit before
      cur.deletedAt.add(newLine);
      (cur.removed[newLine] ??= []).push({ old: oldLine, text: line.slice(1).replace(/\r$/, "") });
      oldLine++;
      cur.dels++;
    }
    else if (line.startsWith(" ")) { newLine++; oldLine++; }
  }
  return [...files.values()];
}

// "12|code" for context lines, "13+|code" for lines the PR added or changed.
function numbered(lines, added, from = 1, to = lines.length) {
  const out = [];
  for (let n = from; n <= to; n++) out.push(`${n}${added.has(n) ? "+" : ""}|${lines[n - 1]}`);
  return out.join("\n");
}

// Finds the end of a function body from its definition line (braces or indentation).
export function extractBody(lines, startLine, maxLines = MAX_DEF_LINES) {
  const first = lines[startLine - 1] ?? "";
  if (/^\s*(async\s+)?def\s/.test(first)) {
    const indent = first.match(/^\s*/)[0].length;
    let end = startLine;
    for (let n = startLine + 1; n <= lines.length && n - startLine < maxLines; n++) {
      const l = lines[n - 1];
      if (l.trim() === "") continue;
      if (l.match(/^\s*/)[0].length <= indent) break;
      end = n;
    }
    return end;
  }
  let depth = 0, opened = false;
  for (let n = startLine; n <= lines.length && n - startLine < maxLines; n++) {
    for (const ch of lines[n - 1]) {
      if (ch === "{") { depth++; opened = true; }
      else if (ch === "}") depth--;
    }
    if (opened && depth <= 0) return n;
  }
  return -1; // did not close within maxLines
}

// The outermost function (up to MAX_ENCLOSING_LINES) that contains line n, as [start, end].
function enclosingFn(lines, n) {
  let best = null;
  for (let s = n; s >= Math.max(1, n - MAX_ENCLOSING_LINES); s--) {
    if (!FN_START.test(lines[s - 1] ?? "")) continue;
    const e = extractBody(lines, s, MAX_ENCLOSING_LINES);
    if (e >= n) best = [s, e];
  }
  return best;
}

function enclosing(lines, n) {
  const fn = enclosingFn(lines, n);
  return fn ? [fn[0] - 2, fn[1] + 1] : [n - FALLBACK_LINES, n + FALLBACK_LINES];
}

function mergeRanges(ranges, max) {
  const sorted = ranges.map(([s, e]) => [Math.max(1, s), Math.min(max, e)]).filter(([s, e]) => s <= e).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1] + 4) last[1] = Math.max(last[1], r[1]); else out.push([...r]);
  }
  return out;
}

function focusRanges(f) {
  const code = CODE_FILE.test(f.path);
  const ranges = [];
  for (const n of [...f.added, ...f.deletedAt].sort((a, b) => a - b)) {
    if (ranges.some(([s, e]) => n >= s && n <= e)) continue;
    ranges.push(code ? enclosing(f.lines, n) : [n - TEXT_FILE_LINES, n + TEXT_FILE_LINES]);
  }
  return ranges;
}

function defRegex(name) {
  const n = name.replace(/[$]/g, "\\$");
  return [
    `function\\*?\\s+${n}\\b`,
    `\\b${n}\\s*[:=]\\s*(async\\s+)?(function|\\([^)]*\\)\\s*(:[^=]+)?=>|[A-Za-z_]\\w*\\s*=>)`,
    `^\\s*(async\\s+)?def\\s+${n}\\b`,
    `^func\\s+(\\([^)]*\\)\\s*)?${n}\\b`,
    `^\\s*((public|private|protected|internal|static|async|override|virtual|readonly|export|default|final|abstract)\\s+)*([A-Za-z_<>\\[\\],?]+\\s+)?${n}\\s*(<[^>]*>)?\\s*\\([^;]*$`,
  ].join("|");
}

async function findDefinitions(repoDir, head, names, changedPaths, readFile, max) {
  const defs = [];
  for (const name of names) {
    if (defs.length >= max) break;
    let out = "";
    try { out = await git(repoDir, ["grep", "-n", "-P", "-I", "--max-count=3", defRegex(name), head, "--"]); } catch { continue; }
    for (const row of out.split("\n").filter(Boolean).slice(0, 2)) {
      const m = row.match(/^[^:]+:(.+?):(\d+):(.*)$/);
      if (!m) continue;
      const [, path, lineStr, text] = m;
      if (changedPaths.has(path) || SKIP_FILE.test(path)) continue;
      if (/;\s*$/.test(text) || /^\s*(return|await|if|else)\b/.test(text)) continue;
      const lines = await readFile(path);
      if (!lines) continue;
      const start = Number(lineStr);
      const end = extractBody(lines, start);
      defs.push({ name, path, start, end: end > 0 ? end : Math.min(lines.length, start + 30), lines });
      break;
    }
  }
  return defs;
}

// Deep mode: call sites of the functions the PR defines or changes, outside the PR.
async function findCallers(repoDir, head, files, changedPaths, readFile) {
  const names = new Set();
  for (const f of files) {
    if (!f.lines || !CODE_FILE.test(f.path)) continue;
    for (const n of [...f.added, ...f.deletedAt]) {
      // the function defined on this line, or the one that contains it
      const at = NAME_DEF.test(f.lines[n - 1] ?? "") ? n : enclosingFn(f.lines, n)?.[0];
      const m = at && (f.lines[at - 1] ?? "").match(NAME_DEF);
      const name = m && (m[1] || m[2] || m[3]);
      if (name && name.length > 2 && !KEYWORDS.has(name)) names.add(name);
    }
  }
  const sites = [];
  for (const name of [...names].slice(0, 30)) {
    if (sites.length >= 40) break;
    let out = "";
    try { out = await git(repoDir, ["grep", "-n", "-I", "-w", "-F", "--max-count=5", name, head, "--"]); } catch { continue; }
    // a plain call (not obj.name(...)); names found in too many files are too generic to help
    const call = new RegExp(`(^|[^.\\w$])${name.replace(/[$]/g, "\\$")}\\s*\\(`);
    const rows = out.split("\n").filter(Boolean);
    if (new Set(rows.map((r) => r.split(":")[1])).size > 15) continue;
    let found = 0;
    for (const row of rows) {
      const m = row.match(/^[^:]+:(.+?):(\d+):(.*)$/);
      if (!m || found >= 3) continue;
      const [, path, lineStr, text] = m;
      if (changedPaths.has(path) || SKIP_FILE.test(path) || !call.test(text) || new RegExp(defRegex(name)).test(text)) continue;
      const lines = await readFile(path);
      if (!lines) continue;
      const at = Number(lineStr);
      sites.push({ name, path, from: Math.max(1, at - 4), to: Math.min(lines.length, at + 4), lines });
      found++;
    }
  }
  return sites;
}

function removedText(f) {
  const out = [];
  let count = 0;
  for (const [at, rows] of Object.entries(f.removed).sort((a, b) => a[0] - b[0])) {
    out.push(`before line ${at}:`);
    for (const r of rows) {
      if (count++ >= MAX_REMOVED_PER_FILE) break;
      out.push(`-${r.text}`);
    }
    if (count > MAX_REMOVED_PER_FILE) { out.push(`… ${f.dels - MAX_REMOVED_PER_FILE} more removed lines`); break; }
  }
  return out.join("\n");
}

export async function buildContext({ dir, head, mergeBase }, log, { deep = false, layers = LAYERS } = {}) {
  log(t("diffing"));
  const diffText = await git(dir, ["diff", "--no-color", "-U3", "--find-renames", `${mergeBase}`, `${head}`]);
  const parsed = parseDiff(diffText);
  const skipTests = !layers.includes("tests");
  const excluded = (p) => SKIP_FILE.test(p) || (skipTests && TEST_FILE.test(p));
  const changed = parsed.map((f) => ({ path: f.path, status: f.status, additions: f.added.size, deletions: f.dels, skipped: excluded(f.path) }));
  const files = parsed.filter((f) => !excluded(f.path));

  const cache = new Map();
  const readFile = async (path) => {
    if (cache.has(path)) return cache.get(path);
    let lines = null;
    try { lines = (await git(dir, ["show", `${head}:${path}`])).replace(/\r/g, "").split("\n"); } catch { /* deleted or binary */ }
    cache.set(path, lines);
    return lines;
  };

  log(t("readingFiles", files.length));
  const changedPaths = new Set(parsed.map((f) => f.path));
  const callCounts = new Map();
  for (const f of files) {
    f.lines = f.status === "deleted" ? null : await readFile(f.path);
    if (!f.lines) continue;
    for (const n of f.added) {
      for (const m of (f.lines[n - 1] ?? "").matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) {
        if (!KEYWORDS.has(m[1]) && m[1].length > 2) callCounts.set(m[1], (callCounts.get(m[1]) ?? 0) + 1);
      }
    }
  }
  const called = [...callCounts.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n).slice(0, 80);

  // Which part of each changed file goes to the model.
  for (const f of files) {
    if (!f.lines) continue;
    if (deep && f.lines.length <= MAX_FILE_LINES) { f.ranges = [[1, f.lines.length]]; continue; }
    f.ranges = focusRanges(f);
  }
  if (!deep) {
    // Functions the new code calls that live in a changed file, outside the shown ranges.
    for (const name of called) {
      const re = new RegExp(defRegex(name));
      for (const f of files) {
        if (!f.lines || !CODE_FILE.test(f.path)) continue;
        const at = f.lines.findIndex((l) => re.test(l)) + 1;
        if (!at || f.ranges.some(([s, e]) => at >= s && at <= e) || /;\s*$/.test(f.lines[at - 1])) continue;
        const end = extractBody(f.lines, at);
        if (end > 0) f.ranges.push([at - 1, end]);
        break;
      }
    }
  }
  for (const f of files) if (f.lines) f.ranges = mergeRanges(f.ranges, f.lines.length);

  const allChangedText = files.map((f) => (f.lines ?? []).join("\n")).join("\n");
  const external = called.filter((n) => !new RegExp(defRegex(n), "m").test(allChangedText));
  const maxDefs = deep ? 80 : 40;
  log(t("findingDefs", Math.min(external.length, maxDefs)));
  const defs = await findDefinitions(dir, head, external, changedPaths, readFile, maxDefs);
  const callers = deep ? await findCallers(dir, head, files, changedPaths, readFile) : [];

  // Text for the model
  let prompt = "";
  const fileViews = {};
  for (const f of files) {
    const header = `\n=== FILE ${f.path} (${f.status}) ===\n`;
    if (!f.lines) { prompt += header + "(deleted: see REMOVED LINES)\n"; continue; }
    const body = f.ranges.length ? f.ranges.map(([s, e]) => numbered(f.lines, f.added, s, e)).join("\n...\n") : "(no content changes)";
    prompt += header + body + "\n";
    fileViews[f.path] = { lines: f.lines, added: [...f.added], deletedAt: [...f.deletedAt], removed: f.removed, inPr: true };
  }
  const removed = files.filter((f) => f.dels).map((f) => `\n=== ${f.path} ===\n${removedText(f)}`).join("\n");
  if (removed) prompt += "\n\n##### REMOVED LINES (what the PR deleted, keyed by the new-file line they sat before) #####\n" + removed;
  if (defs.length) {
    prompt += "\n\n##### EXTERNAL FUNCTIONS CALLED BY THE NEW CODE #####\n";
    for (const d of defs) {
      prompt += `\n=== EXTERNAL DEFINITION ${d.name} in ${d.path} (not changed by the PR) ===\n${numbered(d.lines, new Set(), d.start, d.end)}\n`;
      fileViews[d.path] ??= { lines: d.lines, added: [], deletedAt: [], inPr: false };
    }
  }
  if (callers.length) {
    prompt += "\n\n##### CALLERS OF THE CHANGED FUNCTIONS (outside the PR, context only) #####\n";
    for (const c of callers) prompt += `\n=== ${c.name} called in ${c.path} ===\n${numbered(c.lines, new Set(), c.from, c.to)}\n`;
  }

  if (prompt.length > CHAR_BUDGET) {
    throw new Error(t("tooBig", Math.round(prompt.length / 1000), CHAR_BUDGET / 1000));
  }
  return { prompt, fileViews, changed, stats: { files: files.length, externalDefs: defs.length, callers: callers.length, chars: prompt.length, deep } };
}
