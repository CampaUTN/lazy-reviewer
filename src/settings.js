// Saved settings: deep mode, which layers to generate and the analysis language.
// Stored in ~/.lazy-reviewer/settings.json; `lazy-reviewer config` and the ✎ panel edit them.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { LAYERS } from "./context.js";

const HOME_DIR = join(homedir(), ".lazy-reviewer");
export const SETTINGS_FILE = join(HOME_DIR, "settings.json");
export const DEFAULT_SETTINGS = { deep: false, layers: [...LAYERS] };

// "critical" is always generated: a tour without it has no main flow.
export function cleanSettings(raw) {
  const layers = LAYERS.filter((l) => l === "critical" || (Array.isArray(raw?.layers) ? raw.layers.includes(l) : true));
  const s = { deep: raw?.deep === true, layers };
  if (typeof raw?.lang === "string" && /^[a-z]{2,3}$/.test(raw.lang)) s.lang = raw.lang;
  return s;
}

const isDefault = (s) => !s.deep && s.layers.length === LAYERS.length && !s.lang;

export function loadSettings() {
  try { return existsSync(SETTINGS_FILE) ? cleanSettings(JSON.parse(readFileSync(SETTINGS_FILE, "utf8"))) : { ...DEFAULT_SETTINGS }; } catch { return { ...DEFAULT_SETTINGS }; }
}

export function saveSettings(raw) {
  const s = cleanSettings(raw);
  if (isDefault(s)) rmSync(SETTINGS_FILE, { force: true });
  else { mkdirSync(HOME_DIR, { recursive: true }); writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2) + "\n"); }
  return s;
}

// Cache suffix for non-default analysis settings (the language has its own suffix).
export const settingsTag = ({ deep, layers }) =>
  !deep && layers.length === LAYERS.length ? "" : createHash("sha256").update(JSON.stringify({ deep, layers })).digest("hex").slice(0, 8);
