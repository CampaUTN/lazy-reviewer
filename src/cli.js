// Command-line parsing, help, and the `config` subcommand.
import { readFileSync } from "node:fs";
import { LAYERS } from "./context.js";
import { loadSettings, saveSettings, DEFAULT_SETTINGS, SETTINGS_FILE } from "./settings.js";
import { loadInstructions, saveInstructions, INSTRUCTIONS_FILE } from "./instructions.js";
import { ENV_LANG, SYSTEM_LANG, languageName } from "./language.js";

const VALUE_FLAGS = new Set(["port", "lang", "layers", "instructions", "base", "repo"]);
export const CONFIG_FLAGS = new Set(["deep", "no-deep", "layers", "lang", "instructions", "default-instructions", "show-instructions", "reset", "list"]);

export const HELP = `Lazy Reviewer: an AI-guided walk through a GitHub Pull Request or your local changes.

Usage
  lazy-reviewer <pr-url> [options]   Build the tour for a PR and open it
  lazy-reviewer --staged [options]   Tour of the staged changes (git add) in the current repo
  lazy-reviewer --branch [options]   Tour of the current branch (its commits plus anything staged)
                                     compared to its base: the base of its open PR, or origin's
                                     default branch (change it with --base)
  lazy-reviewer config               Interactive menu to change the saved settings (applies to every new tour)
  lazy-reviewer config [options]     Change the saved settings without the menu

Local options
  --base <branch>          Base branch for --branch (implies --branch)
  --repo <path>            Repository to read (default: the current folder)

Run options (this run only; they override the saved settings)
  --deep, --no-deep        Deep analysis: full changed files, more definitions and the callers
                           of the changed functions. More detailed; about 2-3x more tokens.
  --layers <list>          Layers to generate, comma-separated: ${LAYERS.join(",")}
                           (critical is always included; leaving out tests also skips test files)
  --lang <code>            Language of the analysis, e.g. en, es, pt
  --fresh                  Regenerate even if a cached tour exists
  --port <n>               Port for the local page (default 4321)
  --no-open                Don't open the browser

Config options
  --list                   Print the current settings
  --deep, --no-deep        Turn deep analysis on or off
  --layers <list>          Layers to generate
  --lang <code>            Language of the analysis (--lang system: follow the system locale)
  --instructions <file>    Use the text in <file> as the reviewer instructions
  --default-instructions   Go back to the default instructions
  --show-instructions      Print the current instructions
  --reset                  Reset every setting to its default

Examples
  lazy-reviewer config --layers critical,support --lang es
  lazy-reviewer https://github.com/owner/repo/pull/123 --deep
  lazy-reviewer --branch --base develop`;

export function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h") { opts.help = true; continue; }
    if (!a.startsWith("--")) { opts._.push(a); continue; }
    const [key, inline] = a.slice(2).split(/=(.*)/s);
    if (VALUE_FLAGS.has(key)) {
      const value = inline ?? argv[++i];
      if (value === undefined || value.startsWith("--")) throw new Error(`--${key} needs a value`);
      opts[key] = value;
    } else opts[key] = true;
  }
  return opts;
}

export function parseLayers(value) {
  const list = value.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const unknown = list.filter((l) => !LAYERS.includes(l));
  if (unknown.length) throw new Error(`Unknown layer: ${unknown.join(", ")}. Valid layers: ${LAYERS.join(", ")}`);
  return list;
}

// Saved settings plus this run's flags.
export function settingsForRun(opts) {
  const s = loadSettings();
  if (opts.deep) s.deep = true;
  if (opts["no-deep"]) s.deep = false;
  if (opts.layers) s.layers = LAYERS.filter((l) => l === "critical" || parseLayers(opts.layers).includes(l));
  return s;
}

export function configCommand(opts) {
  if (opts.reset) { saveSettings(DEFAULT_SETTINGS); saveInstructions(""); }
  const s = loadSettings();
  if (opts.deep) s.deep = true;
  if (opts["no-deep"]) s.deep = false;
  if (opts.layers) s.layers = parseLayers(opts.layers);
  if (opts.lang) {
    if (opts.lang === "system") delete s.lang;
    else if (/^[a-z]{2,3}$/i.test(opts.lang)) s.lang = opts.lang.toLowerCase();
    else throw new Error(`--lang expects a language code like en, es or pt (or "system")`);
  }
  const saved = saveSettings(s);
  if (opts.instructions) saveInstructions(readFileSync(opts.instructions, "utf8"));
  if (opts["default-instructions"]) saveInstructions("");
  const instructions = loadInstructions();

  if (opts["show-instructions"]) { console.log(instructions.text); return; }
  const lang = ENV_LANG ?? saved.lang ?? SYSTEM_LANG;
  const source = ENV_LANG ? " from LAZY_REVIEWER_LANG" : saved.lang ? "" : " from the system locale";
  console.log(`Saved settings (${SETTINGS_FILE})
  Analysis mode:  ${saved.deep ? "deep (full files, more definitions, callers; about 2-3x more tokens)" : "focused"}
  Layers:         ${saved.layers.join(", ")}
  Language:       ${languageName(lang)} (${lang})${source}
  Instructions:   ${instructions.custom ? `custom (${INSTRUCTIONS_FILE})` : "default"}

Run "lazy-reviewer --help" to see how to change them.`);
}
