// Language of the analysis (the tour Claude writes). The app itself is always in English.
// Order: --lang <code> > LAZY_REVIEWER_LANG > `lazy-reviewer config --lang` > the system locale.
import { existsSync, readFileSync } from "node:fs";
import { SETTINGS_FILE } from "./settings.js";

const args = process.argv.slice(2);
const langIndex = args.findIndex((a) => a === "--lang" || a.startsWith("--lang="));
const langArg = langIndex < 0 ? null : args[langIndex].includes("=") ? args[langIndex].split("=")[1] : args[langIndex + 1];
const isConfigCommand = args[0] === "config"; // there --lang changes the saved value instead
const savedLang = (() => { try { return existsSync(SETTINGS_FILE) ? JSON.parse(readFileSync(SETTINGS_FILE, "utf8")).lang : null; } catch { return null; } })();
const systemLocale = Intl.DateTimeFormat().resolvedOptions().locale || "en";
const base = (code) => code.toLowerCase().split(/[-_]/)[0];

export const SYSTEM_LANG = base(systemLocale);
export const ENV_LANG = process.env.LAZY_REVIEWER_LANG ? base(process.env.LAZY_REVIEWER_LANG) : null;
export const LANG = base((!isConfigCommand && langArg) || ENV_LANG || savedLang || systemLocale);

export const languageName = (code) => {
  try { return new Intl.DisplayNames(["en"], { type: "language" }).of(code) || code; } catch { return code; }
};
export const LANGUAGE_NAME = languageName(LANG);
