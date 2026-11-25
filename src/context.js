// Builds what the model sees: the diff, the full changed files, and the definitions
// of the functions the new code calls (even when they live outside the PR).
import { git } from "./github.js";
import { t } from "./i18n.js";

const MAX_FILE_LINES = 1500;        // longer files are cut to windows around the changes
const MAX_EXTERNAL_DEFS = 40;       // definitions outside the PR added as context
const MAX_DEF_LINES = 120;
const CHAR_BUDGET = 900_000;        // ~225k input tokens at most

const SKIP_FILE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|go\.sum|Cargo\.lock|poetry\.lock)$|\.(min\.js|map|snap|svg|png|jpe?g|gif|ico|pdf|woff2?)$/i;
const KEYWORDS = new Set("if for while switch catch return function typeof new await async super this import export require console log map filter find some every reduce forEach push pop slice splice join split includes indexOf keys values entries toString parseInt parseFloat String Number Boolean Array Object Promise JSON Math Date Set Map Error assert expect describe it test beforeEach afterEach len print range isinstance str int dict list set tuple def class self make append fmt sizeof elif with lambda not and or in is".split(" "));

// Parses `git diff` → per file: added lines (head numbering), counts and the diff text.
export function parseDiff(diffText) {
  const files = new Map();
  let cur = null, newLine = 0;
  for (const line of diffText.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const m = line.match(/ b\/(.+)$/);
      cur = { path: m ? m[1] : "", added: new Set(), deletedAt: new Set(), dels: 0, status: "modified", diff: [] };
      files.set(cur.path, cur);
      cur.diff.push(line);
      continue;
    }
    if (!cur) continue;
    cur.diff.push(line);
    if (line.startsWith("new file")) cur.status = "added";
    else if (line.startsWith("deleted file")) cur.status = "deleted";
    else if (line.startsWith("rename from")) cur.status = "renamed";
    else if (line.startsWith("+++ b/")) { const p = line.slice(6); if (p !== cur.path) { files.delete(cur.path); cur.path = p; files.set(p, cur); } }
    else if (line.startsWith("@@")) { const m = line.match(/\+(\d+)/); newLine = m ? Number(m[1]) : 0; }
    else if (line.startsWith("+") && !line.startsWith("+++")) { cur.added.add(newLine); newLine++; }
    else if (line.startsWith("-") && !line.startsWith("---")) { cur.deletedAt.add(newLine); cur.dels++; }
    else if (line.startsWith(" ")) newLine++;
  }
  return [...files.values()];
}

function numbered(lines, added, from = 1, to = lines.length) {
  const out = [];
  for (let n = from; n <= to; n++) out.push(`${String(n).padStart(5)}${added.has(n) ? " +" : "  "}| ${lines[n - 1]}`);
  return out.join("\n");
}

// ±60-line windows around the changes, for very long files.
function windows(lines, added) {
  const ranges = [];
  for (const n of [...added].sort((a, b) => a - b)) {
    const s = Math.max(1, n - 60), e = Math.min(lines.length, n + 60);
    const last = ranges[ranges.length - 1];
    if (last && s <= last[1] + 1) last[1] = Math.max(last[1], e); else ranges.push([s, e]);
  }
  return ranges.map(([s, e]) => numbered(lines, added, s, e)).join("\n  ...\n");
}

// Finds the end of a function body from its definition line (braces or indentation).
export function extractBody(lines, startLine) {
  const first = lines[startLine - 1] ?? "";
  const isPy = /^\s*(async\s+)?def\s/.test(first);
  if (isPy) {
    const indent = first.match(/^\s*/)[0].length;
    let end = startLine;
    for (let n = startLine + 1; n <= lines.length && n - startLine < MAX_DEF_LINES; n++) {
      const l = lines[n - 1];
      if (l.trim() === "") continue;
      if (l.match(/^\s*/)[0].length <= indent) break;
      end = n;
    }
    return end;
  }
  let depth = 0, opened = false;
  for (let n = startLine; n <= lines.length && n - startLine < MAX_DEF_LINES; n++) {
    for (const ch of lines[n - 1]) {
      if (ch === "{") { depth++; opened = true; }
      else if (ch === "}") depth--;
    }
    if (opened && depth <= 0) return n;
  }
  return Math.min(lines.length, startLine + 30);
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

async function findDefinitions(repoDir, head, names, changedPaths, readFile) {
  const defs = [];
  for (const name of names) {
    if (defs.length >= MAX_EXTERNAL_DEFS) break;
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
      defs.push({ name, path, start, end: extractBody(lines, start), lines });
      break;
    }
  }
  return defs;
}

export async function buildContext({ dir, head, mergeBase }, log) {
  log(t("diffing"));
  const diffText = await git(dir, ["diff", "--no-color", "-U3", "--find-renames", `${mergeBase}`, `${head}`]);
  const parsed = parseDiff(diffText);
  const changed = parsed.map((f) => ({ path: f.path, status: f.status, additions: f.added.size, deletions: f.dels, skipped: SKIP_FILE.test(f.path) }));
  const files = parsed.filter((f) => !SKIP_FILE.test(f.path));

  const cache = new Map();
  const readFile = async (path) => {
    if (cache.has(path)) return cache.get(path);
    let lines = null;
    try { lines = (await git(dir, ["show", `${head}:${path}`])).replace(/\r/g, "").split("\n"); } catch { /* deleted or binary */ }
    cache.set(path, lines);
    return lines;
  };

  log(t("readingFiles", files.length));
  const changedPaths = new Set(files.map((f) => f.path));
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

  // Names defined inside the PR files don't need to be looked up elsewhere.
  const allChangedText = files.map((f) => (f.lines ?? []).join("\n")).join("\n");
  const external = [...callCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([n]) => n)
    .filter((n) => !new RegExp(defRegex(n), "m").test(allChangedText));
  log(t("findingDefs", Math.min(external.length, MAX_EXTERNAL_DEFS)));
  const defs = await findDefinitions(dir, head, external.slice(0, 80), changedPaths, readFile);

  // Text for the model
  let prompt = "";
  const fileViews = {};
  for (const f of files) {
    const header = `\n=== FILE ${f.path} (${f.status}) ===\n`;
    if (!f.lines) { prompt += header + f.diff.join("\n") + "\n"; continue; }
    const body = f.lines.length > MAX_FILE_LINES ? windows(f.lines, f.added) : numbered(f.lines, f.added);
    prompt += header + body + "\n";
    fileViews[f.path] = { lines: f.lines, added: [...f.added], deletedAt: [...f.deletedAt], inPr: true };
  }
  prompt += "\n\n##### ORIGINAL DIFF (to see what was removed) #####\n" + files.map((f) => f.diff.join("\n")).join("\n");
  let extra = "";
  for (const d of defs) {
    extra += `\n=== EXTERNAL DEFINITION ${d.name} in ${d.path} (not changed by the PR) ===\n${numbered(d.lines, new Set(), d.start, d.end)}\n`;
    fileViews[d.path] ??= { lines: d.lines, added: [], deletedAt: [], inPr: false };
  }
  prompt += "\n\n##### EXTERNAL FUNCTIONS CALLED BY THE NEW CODE #####\n" + extra;

  if (prompt.length > CHAR_BUDGET) {
    throw new Error(t("tooBig", Math.round(prompt.length / 1000), CHAR_BUDGET / 1000));
  }
  return { prompt, fileViews, changed, stats: { files: files.length, externalDefs: defs.length, chars: prompt.length } };
}
