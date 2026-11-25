// Interactive `lazy-reviewer config`: a menu to change the saved settings before a review.
import { readFileSync } from "node:fs";
import { select, checkbox, input, editor, confirm, Separator } from "@inquirer/prompts";
import { LAYERS } from "./context.js";
import { loadSettings, saveSettings, DEFAULT_SETTINGS } from "./settings.js";
import { loadInstructions, saveInstructions, DEFAULT_INSTRUCTIONS } from "./instructions.js";
import { ENV_LANG, SYSTEM_LANG, languageName } from "./language.js";

const LAYER_NAMES = { critical: "Critical", support: "Support", errors: "Errors and validations", tests: "Tests and config" };
const LAYER_HINTS = {
  critical: "the business logic the PR adds or changes (always on)",
  support: "helpers, utilities, refactors",
  errors: "error handling, validations, retries, logging",
  tests: "tests, fixtures, config, types (off also skips test files)",
};
const COMMON_LANGS = ["en", "es", "pt", "fr", "de", "it"];

const describeLang = (s) => (s.lang ? `${languageName(s.lang)} (${s.lang})` : `system locale: ${languageName(SYSTEM_LANG)} (${SYSTEM_LANG})`);
const describeLayers = (s) => (s.layers.length === LAYERS.length ? "all" : s.layers.map((l) => LAYER_NAMES[l]).join(", "));

// `context` lets tests drive the prompts with their own streams.
export async function interactiveConfig(context) {
  const settings = loadSettings();
  let instructions = loadInstructions().text;
  const original = JSON.stringify({ settings, instructions });
  const changed = () => JSON.stringify({ settings, instructions }) !== original;

  console.log("Lazy Reviewer settings. They apply to every new tour. Use ↑ ↓ and Enter; Ctrl+C quits without saving.\n");
  if (ENV_LANG) console.log(`Note: LAZY_REVIEWER_LANG=${ENV_LANG} is set and wins over the saved language.\n`);

  let last = "mode";
  try {
    while (true) {
      const isDefaultInstr = instructions.trim() === DEFAULT_INSTRUCTIONS.trim();
      const action = await select({
        message: changed() ? "Settings (unsaved changes)" : "Settings",
        pageSize: 12,
        default: last,
        choices: [
          { name: `Analysis mode   ${settings.deep ? "deep" : "focused"}`, value: "mode" },
          { name: `Layers          ${describeLayers(settings)}`, value: "layers" },
          { name: `Language        ${describeLang(settings)}`, value: "lang" },
          { name: `Instructions    ${isDefaultInstr ? "default" : "custom"}`, value: "instructions" },
          new Separator(),
          { name: "Save and exit", value: "save" },
          { name: "Reset everything to the defaults", value: "reset" },
          { name: "Exit without saving", value: "quit" },
        ],
      }, context);
      last = action;

      if (action === "mode") {
        settings.deep = await select({
          message: "Analysis mode",
          default: settings.deep,
          choices: [
            { name: "Focused", value: false, description: "Each change with its whole function, the definitions it calls and the removed lines." },
            { name: "Deep", value: true, description: "Full changed files, more definitions and the callers of the changed functions. More detailed; about 2-3x more tokens." },
          ],
        }, context);
      }

      if (action === "layers") {
        const picked = await checkbox({
          message: "Layers to generate (Space toggles, Enter confirms)",
          choices: LAYERS.map((l) => ({
            name: `${LAYER_NAMES[l].padEnd(24)} ${LAYER_HINTS[l]}`,
            value: l,
            checked: settings.layers.includes(l),
            disabled: l === "critical" ? "(always on)" : false,
          })),
        }, context);
        settings.layers = LAYERS.filter((l) => l === "critical" || picked.includes(l));
      }

      if (action === "lang") {
        const choice = await select({
          message: "Language of the analysis (the app itself stays in English)",
          default: settings.lang ?? "system",
          choices: [
            { name: `System locale (${languageName(SYSTEM_LANG)})`, value: "system" },
            ...COMMON_LANGS.map((code) => ({ name: `${languageName(code)} (${code})`, value: code })),
            { name: "Other…", value: "other" },
          ],
        }, context);
        if (choice === "system") delete settings.lang;
        else if (choice === "other") {
          settings.lang = (await input({
            message: "Language code (ISO 639-1, e.g. ja, nl, pl)",
            validate: (v) => /^[a-z]{2,3}$/i.test(v.trim()) || "Use a 2 or 3 letter code",
          }, context)).trim().toLowerCase();
        } else settings.lang = choice;
      }

      if (action === "instructions") {
        const what = await select({
          message: "Reviewer instructions: how the reviewer explains the code and what it flags",
          choices: [
            { name: "Edit in your editor", value: "edit" },
            { name: "Load from a file", value: "file" },
            { name: "Show the current instructions", value: "show" },
            { name: "Restore the default instructions", value: "default", disabled: isDefaultInstr ? "(already default)" : false },
            { name: "Back", value: "back" },
          ],
        }, context);
        if (what === "edit") instructions = (await editor({ message: "Opening your editor…", default: instructions, postfix: ".md", waitForUserInput: false }, context)).trim() || DEFAULT_INSTRUCTIONS;
        if (what === "file") {
          const path = await input({ message: "Path to the file", validate: (p) => { try { readFileSync(p.trim()); return true; } catch { return "Can't read that file"; } } }, context);
          instructions = readFileSync(path.trim(), "utf8").trim() || DEFAULT_INSTRUCTIONS;
        }
        if (what === "show") console.log(`\n${instructions}\n`);
        if (what === "default") instructions = DEFAULT_INSTRUCTIONS;
      }

      if (action === "reset" && await confirm({ message: "Reset mode, layers, language and instructions to the defaults?", default: false }, context)) {
        Object.assign(settings, { ...DEFAULT_SETTINGS, layers: [...DEFAULT_SETTINGS.layers] });
        delete settings.lang;
        instructions = DEFAULT_INSTRUCTIONS;
      }

      if (action === "save") {
        saveSettings(settings);
        saveInstructions(instructions);
        console.log("Saved.");
        return;
      }

      if (action === "quit") {
        if (changed() && !(await confirm({ message: "Discard the unsaved changes?", default: false }, context))) continue;
        console.log("Nothing saved.");
        return;
      }
    }
  } catch (err) {
    if (err?.name === "ExitPromptError") { console.log("\nNothing saved."); return; }
    throw err;
  }
}
