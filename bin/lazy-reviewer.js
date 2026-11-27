#!/usr/bin/env node
// lazy-reviewer <pr-url> [options] · lazy-reviewer config [options] · lazy-reviewer --help
import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { exec } from "node:child_process";
import { parsePrUrl, checkGh, fetchPrMeta, prepareRepo, HOME_DIR } from "../src/github.js";
import { buildContext } from "../src/context.js";
import { prepareLocal } from "../src/local.js";
import { generateTour, getAccount } from "../src/tour.js";
import { LANG } from "../src/language.js";
import { t } from "../src/messages.js";
import { HELP, parseArgs, settingsForRun, configCommand, CONFIG_FLAGS } from "../src/cli.js";
import { interactiveConfig } from "../src/interactive.js";
import { loadInstructions, saveInstructions, instructionsTag, DEFAULT_INSTRUCTIONS, MAX_INSTRUCTIONS } from "../src/instructions.js";
import { loadSettings, saveSettings, settingsTag, DEFAULT_SETTINGS } from "../src/settings.js";

let opts, runSettings, mode;
try {
  opts = parseArgs(process.argv.slice(2));
  mode = opts.staged ? "staged" : opts.branch || opts.base ? "branch" : "pr";
  if (opts.help || (mode === "pr" && !opts._.length)) { console.log(HELP); process.exit(opts.help ? 0 : 1); }
  if ((opts.staged && (opts.branch || opts.base)) || (mode !== "pr" && opts._.length && opts._[0] !== "config")) throw new Error(t("modeConflict"));
  if (opts._[0] === "config") {
    const flags = Object.keys(opts).some((k) => CONFIG_FLAGS.has(k));
    if (!flags && process.stdin.isTTY && process.stdout.isTTY) await interactiveConfig(); else configCommand(opts);
    process.exit(0);
  }
  runSettings = settingsForRun(opts);
} catch (err) {
  console.error(`✗ ${err.message}`);
  process.exit(1);
}
const url = opts._[0];
const fresh = !!opts.fresh;
const noOpen = !!opts["no-open"];
let port = opts.port ? Number(opts.port) : 4321;
// Flags only apply to the first tour; a regenerate from the page uses the saved settings.
let firstRun = true;

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..", "web");
const state = { phase: "starting", message: t("starting"), error: null, tour: null };
const log = (message) => { state.message = message; console.log(`· ${message}`); };

async function prepare(force = false) {
  const instructions = loadInstructions();
  const settings = firstRun ? runSettings : loadSettings();
  firstRun = false;
  state.account = await getAccount();
  console.log(`· ${t("claudeAccount", state.account.label)}`);
  const source = mode === "pr" ? await prSource() : await localSource();

  const cacheDir = join(HOME_DIR, "tours");
  mkdirSync(cacheDir, { recursive: true });
  const tag = [instructionsTag(instructions), settingsTag(settings)].filter(Boolean).join("-");
  const cacheFile = join(cacheDir, `${source.key}__${LANG}${tag ? `__${tag}` : ""}.json`);
  // Tours cached before the language suffix existed were written in Spanish.
  const legacyFile = mode === "pr" ? join(cacheDir, `${source.key}.json`) : null;
  const cached = [cacheFile, LANG === "es" && !tag ? legacyFile : null].find((f) => f && existsSync(f));
  if (!fresh && !force && cached) {
    log(t("cached"));
    return JSON.parse(readFileSync(cached, "utf8"));
  }
  const repo = await source.repo();
  const context = await buildContext(repo, log, settings);
  state.phase = "generating";
  const tour = await generateTour({ meta: source.meta, context, instructions: instructions.text, layers: settings.layers }, log);
  // Only send the browser the files the tour uses.
  const used = new Set(tour.frames.map((f) => f.file));
  const files = Object.fromEntries(Object.entries(context.fileViews).filter(([p]) => used.has(p)));
  const payload = { pr: source.pr(context), tour, files, changed: context.changed, settings };
  writeFileSync(cacheFile, JSON.stringify(payload));
  return payload;
}

// A GitHub PR: metadata from gh, code from a cached bare clone.
async function prSource() {
  const pr = parsePrUrl(url);
  await checkGh();
  log(t("readingPr", `${pr.owner}/${pr.repo}#${pr.number}`));
  const meta = await fetchPrMeta(pr);
  return {
    key: `${pr.owner}__${pr.repo}__${pr.number}__${meta.headRefOid.slice(0, 12)}`,
    meta,
    repo: () => prepareRepo(pr, meta, log),
    pr: () => ({ ...pr, title: meta.title, url: meta.url, author: meta.author?.login, head: meta.headRefName, base: meta.baseRefName, additions: meta.additions, deletions: meta.deletions, changedFiles: meta.changedFiles }),
  };
}

// Staged changes or the current branch vs its base, read from the local repo.
async function localSource() {
  const path = opts.repo ?? process.cwd();
  log(t("readingLocal", path));
  const local = await prepareLocal({ mode, path, base: opts.base }, log);
  const sum = (ctx, k) => ctx.changed.reduce((n, f) => n + f[k], 0);
  return {
    key: local.key,
    meta: local.meta,
    repo: async () => local.repo,
    pr: (ctx) => ({ ...local.pr, additions: sum(ctx, "additions"), deletions: sum(ctx, "deletions"), changedFiles: ctx.changed.length }),
  };
}

let running = false;
function run(force = false) {
  running = true;
  Object.assign(state, { phase: "starting", message: t("starting"), error: null, tour: null });
  prepare(force)
    .then((payload) => { state.tour = payload; state.phase = "ready"; log(t("ready")); })
    .catch((err) => { state.phase = "error"; state.error = err.message; console.error(`✗ ${err.message}`); })
    .finally(() => { running = false; });
}

const json = (res, code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };

// Only the page itself may change settings: same origin and a JSON body (which forces a CORS preflight).
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const origin = req.headers.origin;
    if (origin && origin !== `http://localhost:${server.address().port}` && origin !== `http://127.0.0.1:${server.address().port}`) return reject(new Error("forbidden origin"));
    if (!String(req.headers["content-type"]).startsWith("application/json")) return reject(new Error("expected JSON"));
    let body = "";
    req.on("data", (d) => { body += d; if (body.length > MAX_INSTRUCTIONS * 2) req.destroy(); });
    req.on("end", () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const server = createServer((req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  if (path === "/api/status") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ phase: state.phase, message: state.message, error: state.error, account: state.account }));
  }
  if (path === "/api/config" && req.method === "GET") {
    return json(res, 200, { ...loadInstructions(), defaultText: DEFAULT_INSTRUCTIONS, max: MAX_INSTRUCTIONS, settings: loadSettings(), defaultSettings: DEFAULT_SETTINGS });
  }
  if (path === "/api/config" && req.method === "POST") {
    readJsonBody(req).then((body) => {
      if (String(body.text ?? "").length > MAX_INSTRUCTIONS) return json(res, 413, { error: "too long" });
      if (body.regenerate && running) return json(res, 409, { error: "busy" });
      const saved = { ...saveInstructions(body.text), settings: saveSettings({ ...loadSettings(), ...body.settings }) };
      if (body.regenerate) run(true);
      json(res, 200, saved);
    }).catch((err) => json(res, 403, { error: err.message }));
    return;
  }
  if (path === "/api/tour") {
    if (!state.tour) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ...state.tour, currentAccount: state.account }));
  }
  const file = path === "/" ? "index.html" : path.slice(1);
  if (!/^[\w.-]+$/.test(file) || !existsSync(join(WEB, file))) { res.writeHead(404); return res.end("not found"); }
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "text/plain" });
  res.end(readFileSync(join(WEB, file)));
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") { port++; server.listen(port, "127.0.0.1"); } else throw err;
});
server.listen(port, "127.0.0.1", () => {
  const link = `http://localhost:${server.address().port}`;
  console.log(`\n${t("openAt", link)}\n`);
  if (!noOpen) exec(process.platform === "win32" ? `start "" "${link}"` : process.platform === "darwin" ? `open ${link}` : `xdg-open ${link}`);
});

run();
