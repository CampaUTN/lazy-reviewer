// Reviewer instructions: the part of the prompt users can customize. The default lives
// here; a custom version is saved in ~/.lazy-reviewer/instructions.md.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { HOME_DIR } from "./github.js";

export const MAX_INSTRUCTIONS = 20_000;
export const INSTRUCTIONS_FILE = join(HOME_DIR, "instructions.md");
const FILE = INSTRUCTIONS_FILE;

export const DEFAULT_INSTRUCTIONS = `- Keep each explanation to 1-3 direct sentences.
- Explain the CONCRETE meaning in this code, never the generic semantics of the language.
  BAD: "Uses find to search for an element in the list."
  GOOD: "Picks the first coupon with \`c.expiresAt > now\` for the current \`cartId\`: it is the discount applied at checkout."
  BAD: "Validates the input."  GOOD: "Rejects the request if \`items.length === 0\` or any \`qty <= 0\`."
- Say which condition, which values, and what effect it has on the use case.
- If a line changed from the previous version (see REMOVED LINES), say what it did before and why the change matters.
- Flag possible bugs, race conditions, security issues and missing error handling.
- title: short PR title in business language. summary: 3-5 sentences on what the PR changes and why.
- Use case trigger: what fires it (e.g. "POST /orders from checkout"). outro: 1-2 sentences with the final result of the flow.`;

export function loadInstructions() {
  const text = existsSync(FILE) ? readFileSync(FILE, "utf8").trim() : "";
  return text ? { text, custom: true } : { text: DEFAULT_INSTRUCTIONS, custom: false };
}

// Saving the default (or an empty text) removes the custom file.
export function saveInstructions(text) {
  const clean = String(text ?? "").replace(/\r/g, "").trim();
  if (!clean || clean === DEFAULT_INSTRUCTIONS) {
    rmSync(FILE, { force: true });
    return loadInstructions();
  }
  mkdirSync(HOME_DIR, { recursive: true });
  writeFileSync(FILE, clean + "\n");
  return loadInstructions();
}

// Cache suffix: default tours keep the plain name, custom ones get a short hash.
export const instructionsTag = ({ text, custom }) =>
  custom ? createHash("sha256").update(text).digest("hex").slice(0, 8) : "";
