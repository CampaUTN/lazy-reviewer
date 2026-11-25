#!/usr/bin/env node
// lazy-reviewer <pr-link> [--fresh] [--port 4321] [--no-open] [--lang en]
import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { exec } from "node:child_process";
import { parsePrUrl, checkGh, fetchPrMeta, prepareRepo, HOME_DIR } from "../src/github.js";
import { buildContext } from "../src/context.js";
import { generateTour, getAccount } from "../src/tour.js";
import { LANG, t } from "../src/i18n.js";

const args = process.argv.slice(2);
const VALUE_FLAGS = new Set(["--port", "--lang"]);
const url = args.find((a, i) => !a.startsWith("--") && !VALUE_FLAGS.has(args[i - 1]));
const fresh = args.includes("--fresh");
const noOpen = args.includes("--no-open");
const portArg = args.indexOf("--port");
let port = portArg >= 0 ? Number(args[portArg + 1]) : 4321;

if (!url) {
  console.log(t("usage"));
  process.exit(1);
}

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..", "web");
const state = { phase: "starting", message: t("starting"), error: null, tour: null };
const log = (message) => { state.message = message; console.log(`· ${message}`); };

async function prepare() {
  const pr = parsePrUrl(url);
  await checkGh();
  state.account = await getAccount();
  console.log(`· ${t("claudeAccount", state.account.label)}`);
  log(t("readingPr", `${pr.owner}/${pr.repo}#${pr.number}`));
  const meta = await fetchPrMeta(pr);
  const cacheDir = join(HOME_DIR, "tours");
  mkdirSync(cacheDir, { recursive: true });
  const base = `${pr.owner}__${pr.repo}__${pr.number}__${meta.headRefOid.slice(0, 12)}`;
  const cacheFile = join(cacheDir, `${base}__${LANG}.json`);
  // Tours cached before the language suffix existed were written in Spanish.
  const legacyFile = join(cacheDir, `${base}.json`);
  const cached = [cacheFile, LANG === "es" ? legacyFile : null].find((f) => f && existsSync(f));
  if (!fresh && cached) {
    log(t("cached"));
    return JSON.parse(readFileSync(cached, "utf8"));
  }
  const repo = await prepareRepo(pr, meta, log);
  const context = await buildContext(repo, log);
  state.phase = "generating";
  const tour = await generateTour({ meta, context }, log);
  // Only send the browser the files the tour uses.
  const used = new Set(tour.frames.map((f) => f.file));
  const files = Object.fromEntries(Object.entries(context.fileViews).filter(([p]) => used.has(p)));
  const payload = { pr: { ...pr, title: meta.title, url: meta.url, author: meta.author?.login, head: meta.headRefName, base: meta.baseRefName, additions: meta.additions, deletions: meta.deletions, changedFiles: meta.changedFiles }, tour, files, changed: context.changed };
  writeFileSync(cacheFile, JSON.stringify(payload));
  return payload;
}

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const server = createServer((req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  if (path === "/api/status") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ phase: state.phase, message: state.message, error: state.error, account: state.account, lang: LANG }));
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

prepare()
  .then((payload) => { state.tour = payload; state.phase = "ready"; log(t("ready")); })
  .catch((err) => { state.phase = "error"; state.error = err.message; console.error(`✗ ${err.message}`); });
